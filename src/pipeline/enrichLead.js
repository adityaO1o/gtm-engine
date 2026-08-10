// The orchestration. Trigify calls /enrich once per engager with the raw scrape data;
// everything else happens here, and this NEVER throws a non-200 back to Trigify.
//
//   find email (Enrich-first waterfall) -> verify (BounceBan, and only BounceBan)
//   -> score (deterministic) -> Mongo + SendKit
//
// Nobody is dropped: no-email and unverified people are still written to Mongo so you
// can reprocess them later. A repeat engager accumulates categories and climbs cold->hot.

import { leads, engagements } from "../db/mongo.js";
import { resolveVanity, isUrn } from "../services/resolve.js";
import { findEmail } from "../services/prospeo.js";  // finding only — BounceBan is the sole verifier
import { isRoleBased, findEmailByLinkedin, findEmailByNameDomain } from "../services/enrich.js";
import { companyDomainGuarded } from "../services/clearbit.js";
import { profileCompany } from "../services/linkedinProfile.js";
import { pndExactDomain } from "../services/pnd.js";
import { bouncebanVerify } from "../services/bounceban.js";
import { meter } from "../services/apiMeter.js";
import { findOurLead, upsertLead, addToDnc } from "../services/sendkit.js";
import { enrollOnce } from "./campaignLocks.js";
import { scoreFromHistory } from "../services/score.js";
import { CAMPAIGN_CATEGORY, CAMPAIGN_ID, isCompetitor, sendkitIdsFor, desiredCampaignId } from "../services/campaigns.js";
import { isOutOfIcp } from "../services/icp.js";
import { isCompanyPage, isPersonalDomain, nameMatchesEmail, emailDomain } from "../services/quality.js";
import { bumpUsage } from "../services/usage.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

// How long a failed email lookup stands before the live path will spend on that person again.
// Matches the retry pipeline's own backoff so the two agree on what "recently tried" means.
const NO_EMAIL_BACKOFF_MS = 6 * 3600 * 1000;

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
  // scoreFromHistory only reads category + engagement, so fetch only those. A repeat engager can
  // have dozens of engagement docs (each carrying name/headline/comment_text/post_url); pulling the
  // whole document on every engagement moved a lot of dead BSON — the comment bodies especially.
  const history = await engagements().find({ linkedin_url: key }, { projection: { category: 1, engagement: 1, _id: 0 } }).toArray();
  return scoreFromHistory(history.map((h) => ({ category: h.category, engagement: h.engagement })));
}

// ── Email FIND waterfall. ONE flow, every source (live scrape + retry) runs it identically:
//   1. company from headline -> GUARDED Clearbit domain -> Enrich name+domain   (free, fast)
//   2. URN? resolve via SEO API/Serper/proxy, grab company from snippet         (free)
//   3. STILL no domain? PAID get-personal-profile -> company+domain             (LIVE last resort;
//      ~1 credit, auto-stops when the RapidAPI plan runs out, then degrades to free — never blocks.
//      Its LinkedIn domain is TRUSTED over a Clearbit guess.)
//   4. Enrich linkedin-to-email by url, then Prospeo url / name+domain
// No "run a retry to get emails" split — the email is found here, in the scrape itself.
//
// `skipPaid`  : the retry pass sets this once a lead has already had a paid profile lookup, so
//               hopeless leads don't get re-charged every run (deep retry overrides it).
// `domainSource` returned: clearbit | webscrape | prospeo — how we got the winning domain.
// `guardRejected` returned: Clearbit returned a DIFFERENT company and the guard blocked it.
// `knownVanity`: the resolved vanity URL we ALREADY hold for this person (from their lead document).
// Passing it lets the waterfall skip re-resolving a URL we've already bought, without losing the
// company-recovery half of that same call — see the resolve branch below.
export async function findEmailWaterfall({ name = "", headline = "", linkedin_url = "", knownVanity = "", skipPaid = false }) {
  let prospeoCalls = 0, emailSource = null, emailMethod = null, preVerified = false;
  let vanity = knownVanity || linkedin_url;
  let company = companyFromHeadline(headline);
  const [firstName, ...restName] = name.split(" ");
  const lastName = restName.join(" ");
  let domain = null, domainSource = null, guardRejected = false, paidTried = false;
  const paidOn = !!config.linkedinApiKey && !skipPaid; // LIVE last-resort; self-limits by credits

  // guarded name -> domain: a similar-but-different company (Refine Labs -> Refine Restaurant)
  // is rejected, so we never build an email on the wrong domain. It just falls through to the
  // paid LinkedIn lookup, which returns the TRUE domain.
  const clearbitDomain = async (co) => {
    const g = await companyDomainGuarded(co);
    if (g.rejected) guardRejected = true;
    if (g.domain) { domain = g.domain; domainSource = "clearbit"; }
  };
  if (company) await clearbitDomain(company);

  let em = { found: false };
  const tryNameDomain = async (method) => {
    if (em.found || !domain || !firstName || !lastName) return;
    const f = await findEmailByNameDomain(firstName, lastName, domain);
    if (f.found && f.email) { em = { found: true, email: f.email, company_domain: domain }; emailSource = "enrich"; emailMethod = method; preVerified = f.verified; }
  };

  // (a) Enrich email-finder by name + domain — no url needed, so even unresolved likers get covered
  await tryNameDomain("enrich:name+domain");

  // resolve liker URN -> vanity (FREE tiers first: SEO API/Serper/proxy). The SERP tiers also hand
  // back the person's COMPANY from the result snippet — if the headline had none, recover it here.
  //
  // TWO reasons to run this, and only skipping when BOTH are already satisfied is what makes the
  // "reuse the stored vanity" optimisation safe:
  //   1. we need the URL   -> vanity is still an obfuscated URN
  //   2. we need a COMPANY -> the headline had no "at <Company>", and the SERP snippet is the only
  //                           FREE source for it. Skipping this for a repeat engager whose vanity we
  //                           already knew pushed those leads straight onto the PAID PND tier — or,
  //                           when skipPaid was set, left them permanently no-email.
  // So a known-vanity lead that ALSO already has a company skips the call (the real saving); a
  // known-vanity lead with no company still pays one SERP call, exactly as it did before.
  // `knownVanity &&` keeps this scoped to the case the optimisation touched. Without it, a BRAND-NEW
  // lead that arrives with a real vanity URL and no company (most commenters) would start paying for
  // a SERP call it never used to make.
  if (!em.found && (isUrn(vanity) || (knownVanity && !company))) {
    const resolved = await resolveVanity({ name, company });
    // Never downgrade a vanity we already trust: only adopt the SERP's URL when ours is still a URN.
    if (resolved?.url && isUrn(vanity)) vanity = resolved.url;
    if (!company && resolved?.company) { company = resolved.company; await clearbitDomain(company); await tryNameDomain("enrich:name+domain"); }
  }

  // ── URL-BASED FINDERS FIRST (before the paid PND tier). These take the vanity URL directly and
  // need NO domain, so when they work the lead never touches PND. They used to run AFTER PND, which
  // meant a lead findable straight from its URL still burned a PND profile+company lookup (2 credits)
  // first — PND was the "last resort" in the comment but the second-to-last in the code. On a big
  // share-post scrape that misordering was a large share of the PND bill. A URN that the free tiers
  // couldn't resolve stays a URN here, so these skip and PND (below) still handles it — PND accepts
  // the raw URN, which is exactly why it belongs after, not before.

  // (b) Enrich linkedin-to-email by url
  if (!em.found && vanity && !isUrn(vanity)) {
    const lte = await findEmailByLinkedin(vanity);
    if (lte.found && lte.email) { em = { found: true, email: lte.email, company_domain: domain }; emailSource = "enrich"; emailMethod = "enrich:url"; }
  }
  // (c) Prospeo by url
  if (!em.found && vanity && !isUrn(vanity)) {
    const p = await findEmail({ linkedin_url: vanity, full_name: name }); prospeoCalls++;
    if (p.found && p.email) { em = p; emailSource = "prospeo"; emailMethod = "prospeo:url"; }
    if (!domain && p.company_domain) { domain = p.company_domain; domainSource = "prospeo"; }
  }

  // (a2) PAID LAST RESORT — now genuinely last among the finders: only when the free name+domain,
  // SERP resolve, and the URL-based finders above ALL failed to produce an email or a domain.
  // PND accepts the raw obfuscated URN directly, so it works even when the SERP resolve missed
  // entirely, and it returns the EXACT company website (no Clearbit guessing). Both hops are cached,
  // so repeat leads at the same company — and any later retry of this lead — cost nothing.
  if (!em.found && !domain && !skipPaid && (vanity || linkedin_url)) {
    // paidTried means "a lookup was actually BOUGHT", not "we reached this branch". It used to be
    // set here, before the call — so when PND was out of credits (pndProfile returns null without
    // issuing a request) every lead still got stamped as already-paid, and skipPaid then suppressed
    // the paid tier for them FOREVER, even after a top-up. Set it only on a real result.
    const ex = await pndExactDomain(vanity || linkedin_url);
    if (ex) {
      paidTried = true;
      if (ex.vanity) vanity = ex.vanity;
      if (ex.company && !company) company = ex.company;
      if (ex.domain) { domain = ex.domain; domainSource = "pnd"; }
      await tryNameDomain("enrich:pnd");
    }
    // Secondary net: the old web-scrape host, if it still has quota (it self-limits when drained).
    if (!em.found && !domain && paidOn) {
      const pc = await profileCompany(!isUrn(vanity) ? vanity : linkedin_url);
      if (pc) {
        paidTried = true; // this host is paid too — a real answer here also counts as "bought"
        if (pc.vanity) vanity = pc.vanity;
        if (pc.company && !company) company = pc.company;
        if (pc.domain) { domain = pc.domain; domainSource = "webscrape"; }
        else if (company) await clearbitDomain(company);
        await tryNameDomain("enrich:linkedin-api");
      }
    }
  }
  // (d) Prospeo by name+domain — needs a domain, so it can only run once PND/Clearbit produced one.
  if (!em.found && domain && firstName) {
    const p = await findEmail({ first_name: firstName, last_name: lastName, company_domain: domain }); prospeoCalls++;
    if (p.found && p.email) { em = p; emailSource = "prospeo"; emailMethod = "prospeo:name+domain"; }
  }
  return { em, emailSource, emailMethod, preVerified, prospeoCalls, company, domain, domainSource, guardRejected, paidTried, vanity, key: vanity || linkedin_url };
}

// ── Email VERIFY — BounceBan and nothing else.
//
// Enrich and Prospeo used to get a second vote on anything BounceBan called ambiguous. The audit
// measured that vote against BounceBan across ~8.8k addresses they had called "verified": Enrich
// held up 83% of the time, Prospeo 59% — i.e. 2 in 5 Prospeo "verified" addresses would bounce.
// A second opinion that wrong isn't a second opinion, it's volume bought with deliverability.
//
// So the rule is now: BounceBan says deliverable, or the lead does not get emailed. Anything else —
// undeliverable, risky, unknown, or BounceBan itself being unusable — is unverified.
//
// This fails CLOSED on purpose. If BounceBan is down or out of credits, leads come out unverified
// rather than sent on a guess; the retry path picks them up once it's back.
//
// Note `preVerified` is now ignored (it was Enrich's finder saying "trust me"). Kept in the
// signature because callers pass it, and to make it obvious it is deliberately not consulted.
export async function verifyEmailWaterfall(email, _preVerified) {
  const b = await bouncebanVerify(email);
  if (b?.deliverable) {
    return { verified: true, verifiedBy: "bounceban", verifyLabel: `bounceban:${b.result}/${b.score}${b.acceptAll ? "/accept-all" : ""}`, acceptAll: b.acceptAll, prospeoCalls: 0 };
  }
  if (!b) log.warn("bounceban unusable — lead left unverified rather than sent on a guess", { email });
  return { verified: false, verifiedBy: null, verifyLabel: b ? `bounceban:${b.result}` : "bounceban:unusable", prospeoCalls: 0 };
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
    // Keep SendKit's copy of the person current — the score/category tags drive their segmentation
    // there. This refreshes the LEAD RECORD only; it does not touch campaign membership.
    if (known.email_status === "verified") {
      const [f, ...r] = (name || known.name || "").split(" ");
      await upsertLead({ email: known.email, firstName: f, lastName: r.join(" "), companyName: known.company || "", jobTitle: headline || known.headline || "", linkedinUrl: key, tags });

      // A repeat engager is BY DEFINITION already enrolled — this block used to re-push anyway, on
      // every single engagement ("make sure they are in EVERY campaign they now belong to"), and
      // that is what put 703 people into both 1.0 and 2.0. enrollOnce() pushes only when there is
      // no evidence of an active enrolment.
      //
      // The engagement itself is still fully recorded above (score, status, categories, times_seen,
      // campaigns[], posts_seen), so warm/hot/cold scoring is unaffected — only the redundant
      // SendKit write is skipped.
      const fresh = await leads().findOne({ linkedin_url: key });
      const desired = desiredCampaignId(campaign); // manual 1.0/2.0 pick wins, else default 2.0
      const { campaignId, pushed } = await enrollOnce(known.email, desired, fresh?.sendkit_campaigns);
      // ADD to the membership record, never overwrite: a transient push failure leaves this empty
      // and a $set would wipe a membership SendKit still holds (breaks the DNC safety net).
      if (pushed && campaignId) await leads().updateOne({ linkedin_url: key }, { $addToSet: { sendkit_campaigns: campaignId } });
    }
    await bumpUsage(campaign, { trigify_scraped: 1 }); // scraped only — zero email-provider spend
    log.info("repeat engager (email already known)", { name, email: known.email, status: known.email_status, seen: scored.timesSeen });
    return { outcome: "repeat", email: known.email, isRepeat: true, ...scored, name };
  }

  // ── SECOND FAST PATH: we already tried this person and came up empty, recently.
  //
  // The path above only spares people whose email is SETTLED. Anyone we failed on fell straight
  // through and re-ran the entire waterfall — and 77% of no-email leads get met more than once
  // (they engage with several posts), so the same hopeless lookup was paid for again and again.
  // PND itself is cached, so this isn't a PND saving; it's Enrich, Prospeo and BounceBan, which
  // have no such cache and were being charged on every repeat.
  //
  // The engagement is still recorded — score, categories, campaigns and posts_seen all update, so
  // nothing about the lead goes stale. Only the provider calls are skipped, and only inside the
  // same backoff the retry pipeline already uses, so a stale lead still gets fresh attempts later.
  // The Hand-off retry (and its "deep" mode) is untouched and remains the deliberate way to try again.
  // Both timestamps are consulted: the live path stamps last_email_attempt_at and the retry
  // pipeline stamps last_retry_at. Reading only our own field meant the two pipelines were blind to
  // each other — a lead the retry had just failed on would be re-bought in full by the next scrape.
  const lastTried = Math.max(
    known?.last_email_attempt_at ? new Date(known.last_email_attempt_at).getTime() : 0,
    known?.last_retry_at ? new Date(known.last_retry_at).getTime() : 0,
  );
  if (known && known.email_status === "no-email" && lastTried
      && Date.now() - lastTried < NO_EMAIL_BACKOFF_MS) {
    const key = known.linkedin_url;
    const scored = await recordEngagement(key, { name, headline, category, engagement_type, campaign, post_url, comment_text, now });
    const add = { campaigns: campaign, posts_seen: post_url };
    if (campaign_id) add.campaign_ids = campaign_id;
    if (linkedin_url && isUrn(linkedin_url) && linkedin_url !== key) add.urns = linkedin_url;
    await leads().updateOne({ linkedin_url: key }, {
      $set: {
        status: scored.status, score: scored.score, categories: scored.categories, times_seen: scored.timesSeen,
        last_comment: comment_text || null, last_engagement_at: now, updated_at: now,
      },
      $addToSet: add,
    });
    await bumpUsage(campaign, { trigify_scraped: 1 }); // scraped only — zero email-provider spend
    log.info("repeat engager (already tried, still no email)", { name, seen: scored.timesSeen });
    return { outcome: "repeat_no_email", isRepeat: true, ...scored, name };
  }

  // skipPaid: don't buy a paid profile lookup for someone a previous attempt already bought one
  // for. reprocess.js has always done this; the LIVE path never did — it didn't even record that
  // it had paid, so every fresh scrape of a repeat engager bought the same lookup again.
  //
  // Feed the waterfall the vanity URL we ALREADY resolved for this person, not the obfuscated URN
  // this particular post happened to hand us. Both identify the same human — `known` was matched on
  // `urns` precisely because we'd seen that URN before — but only the URN makes the waterfall call
  // resolveVanity() again, re-buying a SERP/proxy lookup whose answer is sitting in the document we
  // just read. Only leads WITHOUT a settled email get this far, so this is exactly the population
  // that kept paying to rediscover its own URL. reprocess.js already passes the stored key (its
  // `d.linkedin_url`); this makes the live path agree with it.
  const resolvedKnown = known?.linkedin_url && !isUrn(known.linkedin_url) ? known.linkedin_url : "";
  const w = await findEmailWaterfall({ name, headline, linkedin_url, knownVanity: resolvedKnown, skipPaid: !!known?.paid_profile_tried });
  const { em, emailSource, emailMethod, preVerified, company, domainSource, guardRejected } = w;
  let prospeoCalls = w.prospeoCalls;
  // If we already matched an existing lead (possibly via their remembered `urns`), that document's
  // linkedin_url IS the canonical key — use it. w.key falls back to the raw URN whenever the vanity
  // couldn't be resolved, and skipPaid now makes that far more likely because the paid lookup (which
  // used to resolve the URN as a side effect) is skipped. Keying on the URN would upsert a SECOND
  // document for someone already stored under their vanity URL, restarting times_seen at 1.
  const key = known?.linkedin_url || w.key;

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
    domain_source: domainSource || null,          // clearbit | webscrape | prospeo — how the domain came
    clearbit_guard_rejected: !!guardRejected,     // Clearbit returned a different company; guard blocked it
    personal_email: em.email ? isPersonalDomain(em.email) : false,
    source: source || null,
    ...(source_list ? { source_list } : {}),
    last_comment: comment_text || null, last_engagement_at: now, updated_at: now,
    // Remember that we DID run the finder for this person, and whether it cost a paid profile
    // lookup. Only the retry pipeline used to record this, so the live path kept re-buying the
    // same lookup every time a repeat engager turned up on another post.
    last_email_attempt_at: now,
    ...(w.paidTried ? { paid_profile_tried: true } : {}),
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

  // Out-of-ICP: employee of a big non-ICP company (Google, Microsoft, Amazon, Flipkart, TCS, …). Not
  // a prospect — save the record (so a repeat engagement doesn't re-pay to rediscover them) but never
  // send, and PIN status to "cold" so they don't pollute the hot/warm working set. Reversible: drop
  // the company from services/icp.js and their status recomputes on the next engagement.
  if (isOutOfIcp({ company, emailDomain: em.email ? emailDomain(em.email) : "" })) {
    await leads().updateOne({ linkedin_url: key },
      { $set: { ...setDoc, status: "cold", email: em.email || null, email_status: "out-of-icp", out_of_icp: true, needs_email: false }, $addToSet: addToSet, $setOnInsert: { created_at: now } }, { upsert: true });
    await dncIfAlreadyInSendkit(em.email);
    await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
    log.info("out-of-icp", { name, company, email: em.email });
    return { outcome: "out_of_icp", ...scored, name };
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

  let email = em.email;

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
  let vr = await verifyEmailWaterfall(email, preVerified);
  prospeoCalls += vr.prospeoCalls;

  // ── "Verification IS Clearbit's checker" ──────────────────────────────────────────────────────
  // A Clearbit-GUESSED domain that fails verification is almost always the WRONG company's domain
  // (agencyu.com vs the real agencyu.co). ONLY NOW — after the free path has actually failed — do we
  // spend a PND credit for the exact domain and retry. When the free guess was right (the common
  // case) this never runs, so it costs nothing.
  if (!vr.verified && domainSource === "clearbit" && !isRoleBased(email)) {
    const ex = await pndExactDomain(w.vanity || linkedin_url);
    const [f1, ...r1] = name.split(" ");
    const l1 = r1.join(" ");
    if (ex?.domain && ex.domain !== w.domain && f1 && l1) {
      const f2 = await findEmailByNameDomain(f1, l1, ex.domain);
      if (f2.found && f2.email && nameMatchesEmail(name, f2.email)) {
        const vr2 = await verifyEmailWaterfall(f2.email, f2.verified);
        prospeoCalls += vr2.prospeoCalls;
        if (vr2.verified) {
          log.info("recovered via PND exact domain", { name, wrong: w.domain, exact: ex.domain, email: f2.email });
          email = f2.email; vr = vr2;
          setDoc.email_method = "enrich:pnd-exact"; setDoc.domain_source = "pnd";
          setDoc.company_domain = ex.domain;
          setDoc.company = ex.company || setDoc.company;
          setDoc.personal_email = isPersonalDomain(email);
        }
      }
    }
  }
  meter.inc(domainSource === "pnd" || setDoc.domain_source === "pnd" ? "domain_paid" : "domain_free");

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
  const desired = desiredCampaignId(campaign); // manual 1.0/2.0 pick wins, else default 2.0
  // First enrolment for a freshly verified lead. Still routed through enrollOnce: the SAME email
  // can arrive from a second LinkedIn profile, and that must not open a second membership.
  const { campaignId, pushed } = await enrollOnce(email, desired, doc?.sendkit_campaigns);
  // ADD to the membership record, never overwrite: a transient push failure leaves this empty
  // and a $set would wipe a membership SendKit still holds (breaks the DNC safety net).
  if (pushed && campaignId) await leads().updateOne({ linkedin_url: key }, { $addToSet: { sendkit_campaigns: campaignId } });

  await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0, sendkit_pushed: isRepeat ? 0 : 1 });

  log.info("verified & synced", { name, email, method: emailMethod, verifiedBy, status: scored.status, score: scored.score, isRepeat });
  return { outcome: "sent", email, isRepeat, email_source: emailSource, email_method: emailMethod, verified_by: verifiedBy, ...scored, name };
}
