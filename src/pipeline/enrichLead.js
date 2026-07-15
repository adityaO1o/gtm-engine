// The orchestration. Trigify calls /enrich once per engager with the raw scrape data;
// everything else happens here, and this NEVER throws a non-200 back to Trigify.
//
//   find email (Enrich-first waterfall) -> verify (Enrich, then Prospeo)
//   -> score (deterministic) -> Mongo + SendKit
//
// Nobody is dropped: no-email and unverified people are still written to Mongo so you
// can reprocess them later. A repeat engager accumulates categories and climbs cold->hot.

import { leads, engagements } from "../db/mongo.js";
import { resolveVanity, isUrn } from "../services/resolve.js";
import { findEmail, verifyEmail } from "../services/prospeo.js";
import { validateEmail, isRoleBased, findEmailByLinkedin, findEmailByNameDomain } from "../services/enrich.js";
import { companyDomain } from "../services/clearbit.js";
import { findOurLead, upsertLead, addToCampaign, addToDnc } from "../services/sendkit.js";
import { scoreFromHistory } from "../services/score.js";
import { CAMPAIGN_CATEGORY, CAMPAIGN_ID, isCompetitor, sendkitIdsFor } from "../services/campaigns.js";
import { isCompanyPage, isPersonalDomain, nameMatchesEmail, emailDomain } from "../services/quality.js";
import { bumpUsage } from "../services/usage.js";
import { log } from "../lib/logger.js";

// crude company extraction from a headline ("Founder @ Acme | ex-Google" -> "Acme")
export function companyFromHeadline(headline = "") {
  const m = headline.match(/(?:@|at)\s+([A-Z0-9][\w&.\- ]{1,40})/);
  return m ? m[1].split(/[|·•\-]/)[0].trim() : null;
}

function buildTags({ status, score, timesSeen, categories, source }) {
  return [
    "gtm-auto",
    ...categories.map((c) => "cat:" + c),
    "score:" + score,
    "seen:" + timesSeen,
    status + "-lead",
    ...(source ? ["source:" + source] : []),
  ];
}

// Log this engagement, then re-score from the person's FULL history (always correct,
// and a repeat engager accumulates categories and climbs cold -> hot).
async function recordEngagement(key, { name, headline, category, engagement_type, campaign, post_url, comment_text, now }) {
  await engagements().insertOne({
    linkedin_url: key, name, headline, category,
    engagement: engagement_type, campaign, post_url, comment_text, created_at: now,
  });
  const history = await engagements().find({ linkedin_url: key }).toArray();
  return scoreFromHistory(history.map((h) => ({ category: h.category, engagement: h.engagement })));
}

// ── Email FIND waterfall (Enrich-first; Prospeo last). Reused by /enrich and /reprocess.
export async function findEmailWaterfall({ name = "", headline = "", linkedin_url = "" }) {
  let prospeoCalls = 0, emailSource = null, emailMethod = null, preVerified = false;
  let vanity = linkedin_url;
  const company = companyFromHeadline(headline);
  const [firstName, ...restName] = name.split(" ");
  const lastName = restName.join(" ");
  let domain = company ? await companyDomain(company) : null;
  let em = { found: false };

  // (a) Enrich email-finder by name + domain — no url needed, so even unresolved likers get covered
  if (domain && firstName && lastName) {
    const f = await findEmailByNameDomain(firstName, lastName, domain);
    if (f.found && f.email) { em = { found: true, email: f.email, company_domain: domain }; emailSource = "enrich"; emailMethod = "enrich:name+domain"; preVerified = f.verified; }
  }
  // resolve liker URN -> vanity only when a url-based lookup is still needed
  if (!em.found && isUrn(linkedin_url)) {
    const resolved = await resolveVanity({ name, company });
    if (resolved) vanity = resolved;
  }
  // (b) Enrich linkedin-to-email by url
  if (!em.found && vanity && !isUrn(vanity)) {
    const lte = await findEmailByLinkedin(vanity);
    if (lte.found && lte.email) { em = { found: true, email: lte.email, company_domain: domain }; emailSource = "enrich"; emailMethod = "enrich:url"; }
  }
  // (c) Prospeo by url, then name+domain — last fallback
  if (!em.found && vanity && !isUrn(vanity)) {
    const p = await findEmail({ linkedin_url: vanity, full_name: name }); prospeoCalls++;
    if (p.found && p.email) { em = p; emailSource = "prospeo"; emailMethod = "prospeo:url"; }
    if (!domain && p.company_domain) domain = p.company_domain;
  }
  if (!em.found && domain && firstName) {
    const p = await findEmail({ first_name: firstName, last_name: lastName, company_domain: domain }); prospeoCalls++;
    if (p.found && p.email) { em = p; emailSource = "prospeo"; emailMethod = "prospeo:name+domain"; }
  }
  return { em, emailSource, emailMethod, preVerified, prospeoCalls, company, domain, vanity, key: vanity || linkedin_url };
}

// ── Email VERIFY waterfall (Enrich first, Prospeo second opinion).
export async function verifyEmailWaterfall(email, preVerified) {
  if (preVerified) return { verified: true, verifiedBy: "enrich", verifyLabel: "enrich:finder-verified", prospeoCalls: 0 };
  const v1 = await validateEmail(email);
  if (v1.good) return { verified: true, verifiedBy: "enrich", verifyLabel: `enrichso:${v1.result}/${v1.confidence}`, prospeoCalls: 0 };
  const v2 = await verifyEmail(email);
  return { verified: v2.ok, verifiedBy: v2.ok ? "prospeo" : null, verifyLabel: `enrichso:${v1.result}|prospeo:${v2.status}`, prospeoCalls: 1 };
}

export async function enrichLead(input) {
  const {
    name = "", headline = "", linkedin_url = "",
    engagement_type = "like", comment_text = "",
    campaign = "", campaign_id = "", post_url = "",
    category: categoryOverride = "", source = "", source_list = "",
  } = input;

  // classified sources pass an explicit category (their campaign isn't topic-named)
  const category = categoryOverride || CAMPAIGN_CATEGORY[campaign] || "cold-email";
  const now = new Date();

  // G1: LinkedIn company pages are not people — skip without saving or spending credits.
  if (isCompanyPage(linkedin_url)) {
    log.info("skip company page", { name, linkedin_url });
    return { outcome: "skipped_company", name };
  }

  // Do we already know this person? Match on their vanity url OR on an obfuscated liker URN
  // we resolved previously (we remember those in `urns`, so repeat likers are recognised too).
  const known = linkedin_url
    ? await leads().findOne({ $or: [{ linkedin_url }, { urns: linkedin_url }] })
    : null;

  // ── FAST PATH: this person's email is already settled. Do NOT re-run the waterfall.
  // Re-running it costs email-provider credits on EVERY repeat engagement, and — far worse —
  // a transient miss (blocked proxy, provider timeout, a headline with no "at Company") used
  // to overwrite the good address with email:null / "no-email", dumping a verified lead back
  // into hand-off. The next retry then "recovered" them again. That found -> lost -> recovered
  // churn is exactly why later retries kept turning up "new" emails.
  if (known && known.email && known.email_status !== "no-email") {
    const key = known.linkedin_url;
    const scored = await recordEngagement(key, { name, headline, category, engagement_type, campaign, post_url, comment_text, now });
    const tags = buildTags({ status: scored.status, score: scored.score, timesSeen: scored.timesSeen, categories: scored.categories, source: source || known.source });
    const add = { campaigns: campaign, posts_seen: post_url };
    if (campaign_id) add.campaign_ids = campaign_id;
    if (linkedin_url && isUrn(linkedin_url) && linkedin_url !== key) add.urns = linkedin_url;

    await leads().updateOne({ linkedin_url: key }, {
      $set: {
        status: scored.status, score: scored.score, categories: scored.categories, times_seen: scored.timesSeen,
        last_comment: comment_text || null, last_engagement_at: now, updated_at: now, tags,
      },
      $addToSet: add,
    });
    // keep SendKit in step with the new score / categories / campaign — and make sure they are
    // in EVERY campaign they now belong to (this engagement may have added a new one)
    if (known.email_status === "verified") {
      const [f, ...r] = (name || known.name || "").split(" ");
      await upsertLead({ email: known.email, firstName: f, lastName: r.join(" "), companyName: known.company || "", jobTitle: headline || known.headline || "", linkedinUrl: key, tags });
      const fresh = await leads().findOne({ linkedin_url: key });
      const landed = [];
      for (const cid of sendkitIdsFor(fresh?.campaigns || [campaign])) {
        if (await addToCampaign(cid, known.email)) landed.push(cid);
      }
      await leads().updateOne({ linkedin_url: key }, { $set: { sendkit_campaigns: landed } });
    }
    await bumpUsage(campaign, { trigify_scraped: 1 }); // scraped only — zero email-provider spend
    log.info("repeat engager (email already known)", { name, email: known.email, status: known.email_status, seen: scored.timesSeen });
    return { outcome: "repeat", email: known.email, isRepeat: true, ...scored, name };
  }

  const w = await findEmailWaterfall({ name, headline, linkedin_url });
  const { em, emailSource, emailMethod, preVerified, company } = w;
  let prospeoCalls = w.prospeoCalls;
  const key = w.key;

  // record the engagement now that we know the identity key
  const scored = await recordEngagement(key, { name, headline, category, engagement_type, campaign, post_url, comment_text, now });

  const addToSet = { campaigns: campaign, posts_seen: post_url };
  if (campaign_id) addToSet.campaign_ids = campaign_id;
  // Remember the obfuscated liker URN we just resolved, so the next time this same person
  // likes a post we recognise them immediately instead of re-resolving + re-buying their email.
  if (linkedin_url && isUrn(linkedin_url) && linkedin_url !== key) addToSet.urns = linkedin_url;

  const setDoc = {
    linkedin_url: key, name, headline,
    company: em.company_name || company || null,
    company_domain: em.company_domain || null,
    status: scored.status, score: scored.score, categories: scored.categories, times_seen: scored.timesSeen,
    email_source: emailSource, email_method: emailMethod,
    personal_email: em.email ? isPersonalDomain(em.email) : false,
    source: source || null,
    ...(source_list ? { source_list } : {}),
    last_comment: comment_text || null, last_engagement_at: now, updated_at: now,
  };

  // If this person ALREADY landed in a SendKit campaign and a guard is only blocking them now,
  // we cannot pull them back out — SendKit has no remove-from-campaign endpoint. DNC is the
  // guarantee: campaigns run skipDNC:true, so a DNC'd address is skipped at send time.
  const dncIfAlreadyInSendkit = async (addr) => {
    if (!addr || !known?.sendkit_campaigns?.length) return;
    await addToDnc([addr]);
    await leads().updateOne({ linkedin_url: key }, { $set: { dnc: true, dnc_at: new Date() } });
    log.info("blocked a lead that was already in SendKit -> DNC'd", { email: addr });
  };

  // Part B + G4: competitor employee (by company OR email domain) — save, never send to SendKit.
  if (isCompetitor({ company, emailDomain: em.email ? emailDomain(em.email) : "" })) {
    await leads().updateOne({ linkedin_url: key },
      { $set: { ...setDoc, email: em.email || null, email_status: "competitor", is_competitor: true, needs_email: false }, $addToSet: addToSet, $setOnInsert: { created_at: now } }, { upsert: true });
    await dncIfAlreadyInSendkit(em.email);
    await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
    log.info("competitor", { name, company, email: em.email });
    return { outcome: "competitor", ...scored, name };
  }

  // no email found this time
  if (!em.found || !em.email) {
    // NEVER clobber an address we already hold. The waterfall is non-deterministic (proxy /
    // search-engine soft-blocks, provider timeouts), so a miss now does NOT mean the stored
    // email is wrong. Overwriting it with null used to delete good emails and demote verified
    // leads back into hand-off. Keep every email_* field; only refresh score/engagement data.
    const prior = known || (key !== linkedin_url ? await leads().findOne({ linkedin_url: key }) : null);
    if (prior?.email) {
      const { email_source, email_method, personal_email, ...safe } = setDoc; // keep existing email fields
      await leads().updateOne({ linkedin_url: key }, { $set: safe, $addToSet: addToSet }, { upsert: false });
      await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
      log.info("waterfall missed but email already known — kept", { name, email: prior.email, status: prior.email_status });
      return { outcome: "repeat", email: prior.email, ...scored, name };
    }
    setDoc.email = null; setDoc.email_status = "no-email"; setDoc.needs_email = true; setDoc.recovered = false;
    await leads().updateOne({ linkedin_url: key }, { $set: setDoc, $addToSet: addToSet, $setOnInsert: { created_at: now } }, { upsert: true });
    await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
    log.info("no email", { name, key });
    return { outcome: "no_email", ...scored, name };
  }

  const email = em.email;

  // role-based inbox never replies -> save but don't send
  if (isRoleBased(email)) {
    await leads().updateOne({ linkedin_url: key },
      { $set: { ...setDoc, email, email_status: "role-based", role_based: true }, $addToSet: addToSet, $setOnInsert: { created_at: now } }, { upsert: true });
    await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
    return { outcome: "role_based", email, ...scored, name };
  }

  // G2 (REPUTATION GUARD): the email's local-part must plausibly belong to this person.
  // A wrong-person match (e.g. "Tayo Kolade" -> smogey@) is held for review, never auto-sent.
  if (!nameMatchesEmail(name, email)) {
    await leads().updateOne({ linkedin_url: key },
      { $set: { ...setDoc, email, email_status: "review", email_low_confidence: true, needs_email: false }, $addToSet: addToSet, $setOnInsert: { created_at: now } }, { upsert: true });
    await dncIfAlreadyInSendkit(email);
    await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
    log.info("held for review (name mismatch)", { name, email });
    return { outcome: "review", email, ...scored, name };
  }

  // verify
  const vr = await verifyEmailWaterfall(email, preVerified);
  prospeoCalls += vr.prospeoCalls;
  const { verified, verifiedBy, verifyLabel } = vr;
  setDoc.verified_by = verifiedBy;

  if (!verified) {
    await leads().updateOne({ linkedin_url: key },
      { $set: { ...setDoc, email, email_status: "unverified", unverified: true, verify_detail: verifyLabel }, $addToSet: addToSet, $setOnInsert: { created_at: now } }, { upsert: true });
    await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
    log.info("unverified", { name, email, verifyLabel });
    return { outcome: "unverified", email, ...scored, name };
  }

  // verified & sendable — write to Mongo FIRST (so the campaigns array is current), then push
  const tags = buildTags({ status: scored.status, score: scored.score, timesSeen: scored.timesSeen, categories: scored.categories, source });
  const existing = await findOurLead(email);
  const isRepeat = !!existing;

  await leads().updateOne({ linkedin_url: key },
    { $set: { ...setDoc, email, email_status: "verified", unverified: false, needs_email: false, verify_detail: verifyLabel, tags }, $addToSet: addToSet, $setOnInsert: { created_at: now } }, { upsert: true });

  const [first, ...rest] = name.split(" ");
  await upsertLead({ email, firstName: first, lastName: rest.join(" "), companyName: em.company_name || company || "", jobTitle: headline, linkedinUrl: key, tags });
  // push into EVERY campaign this person now belongs to — they may have engaged with posts
  // from more than one campaign, and the dashboard counts them as verified in each.
  const doc = await leads().findOne({ linkedin_url: key });
  const landed = [];
  for (const cid of sendkitIdsFor(doc?.campaigns || [campaign])) {
    if (await addToCampaign(cid, email)) landed.push(cid);
  }
  await leads().updateOne({ linkedin_url: key }, { $set: { sendkit_campaigns: landed } });

  await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0, sendkit_pushed: isRepeat ? 0 : 1 });

  log.info("verified & synced", { name, email, method: emailMethod, verifiedBy, status: scored.status, score: scored.score, isRepeat });
  return { outcome: "sent", email, isRepeat, email_source: emailSource, email_method: emailMethod, verified_by: verifiedBy, ...scored, name };
}
