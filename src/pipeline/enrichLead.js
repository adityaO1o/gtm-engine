// The orchestration. Trigify calls /enrich once per engager with the raw scrape data;
// everything else happens here, and this NEVER throws a non-200 back to Trigify.
//
//   log engagement -> resolve vanity (likers) -> find email (Prospeo, 400-safe)
//   -> verify (Enrich.so, then Prospeo) -> score (deterministic) -> Mongo + SendKit
//
// Nobody is dropped: no-email and unverified people are still written to Mongo so you
// can hand that file to another provider. A repeat engager accumulates categories and
// climbs cold -> warm -> hot.

import { leads, engagements } from "../db/mongo.js";
import { resolveVanity, isUrn } from "../services/resolve.js";
import { findEmail, verifyEmail } from "../services/prospeo.js";
import { validateEmail, isRoleBased, findEmailByLinkedin } from "../services/enrich.js";
import { findOurLead, upsertLead, addToCampaign } from "../services/sendkit.js";
import { scoreFromHistory, CAMPAIGN_CATEGORY } from "../services/score.js";
import { bumpUsage } from "../services/usage.js";
import { log } from "../lib/logger.js";

// crude company extraction from a headline ("Founder @ Acme | ex-Google" -> "Acme")
function companyFromHeadline(headline = "") {
  const m = headline.match(/(?:@|at)\s+([A-Z0-9][\w&.\- ]{1,40})/);
  return m ? m[1].split(/[|·•\-]/)[0].trim() : null;
}

function buildTags({ status, score, timesSeen, categories }) {
  return [
    "gtm-auto",
    ...categories.map((c) => "cat:" + c),
    "score:" + score,
    "seen:" + timesSeen,
    status + "-lead",
  ];
}

export async function enrichLead(input) {
  const {
    name = "",
    headline = "",
    linkedin_url = "",
    engagement_type = "like", // like | comment
    comment_text = "",
    campaign = "",
    campaign_id = "",
    post_url = "",
  } = input;

  const category = CAMPAIGN_CATEGORY[campaign] || "cold-email";
  const now = new Date();
  let prospeoCalls = 0; // for per-campaign usage tracking
  let emailSource = null; // "prospeo" | "enrich"

  // 1) always log the engagement (audit + rescoring source of truth)
  //    we log by resolved identity later; for now use the raw url as a temp key
  let vanity = linkedin_url;
  let company = companyFromHeadline(headline);

  // 2) likers arrive as obfuscated URNs — resolve to a real vanity URL
  if (isUrn(linkedin_url)) {
    const resolved = await resolveVanity({ name, company });
    if (resolved) vanity = resolved;
  }

  // 3) find the work email — Prospeo first (400-safe), then Enrich.so as fallback
  let em = { found: false };
  if (vanity && !isUrn(vanity)) {
    em = await findEmail({ linkedin_url: vanity, full_name: name });
    prospeoCalls++;
  }
  // Prospeo name+domain retry if we have a company domain guess
  if (!em.found && em.company_domain) {
    const [first, ...rest] = name.split(" ");
    em = await findEmail({ first_name: first, last_name: rest.join(" "), company_domain: em.company_domain });
    prospeoCalls++;
  }
  if (em.found && em.email) emailSource = "prospeo";

  // FALLBACK: Prospeo missed -> Enrich.so linkedin-to-email (we already have the URL)
  if ((!em.found || !em.email) && vanity && !isUrn(vanity)) {
    const lte = await findEmailByLinkedin(vanity);
    if (lte.found && lte.email) {
      em = { found: true, email: lte.email, company_name: em.company_name, company_domain: em.company_domain };
      emailSource = "enrich";
    }
  }

  // identity key for dedup/accumulation: prefer the resolved vanity url, else raw
  const key = vanity || linkedin_url;

  // record the engagement now that we know the key
  await engagements().insertOne({
    linkedin_url: key,
    name,
    headline,
    category,
    engagement: engagement_type,
    campaign,
    post_url,
    comment_text,
    created_at: now,
  });

  // 4) recompute score from the full engagement history (always correct)
  const history = await engagements().find({ linkedin_url: key }).toArray();
  const scored = scoreFromHistory(
    history.map((h) => ({ category: h.category, engagement: h.engagement }))
  );

  // base lead doc fields we always know
  const setDoc = {
    linkedin_url: key,
    name,
    headline,
    company: em.company_name || company || null,
    company_domain: em.company_domain || null,
    status: scored.status,
    score: scored.score,
    categories: scored.categories,
    times_seen: scored.timesSeen,
    email_source: emailSource, // "prospeo" | "enrich" | null
    last_comment: comment_text || null,
    last_engagement_at: now,
    updated_at: now,
  };

  // no email found -> save for hand-off, stop here
  if (!em.found || !em.email) {
    setDoc.email = null;
    setDoc.email_status = "no-email";
    setDoc.needs_email = true;
    await leads().updateOne(
      { linkedin_url: key },
      { $set: setDoc, $addToSet: { campaigns: campaign, posts_seen: post_url }, $setOnInsert: { created_at: now } },
      { upsert: true }
    );
    await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls });
    log.info("no email", { name, key });
    return { outcome: "no_email", ...scored, name };
  }

  const email = em.email;

  // role-based inbox never replies -> save but don't send
  if (isRoleBased(email)) {
    await leads().updateOne(
      { linkedin_url: key },
      { $set: { ...setDoc, email, email_status: "role-based", role_based: true },
        $addToSet: { campaigns: campaign, posts_seen: post_url }, $setOnInsert: { created_at: now } },
      { upsert: true }
    );
    await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls });
    return { outcome: "role_based", email, ...scored, name };
  }

  // 5) verify: Enrich.so first, Prospeo as second opinion
  let verified = false;
  let verifiedBy = null;
  let verifyLabel = "";
  const v1 = await validateEmail(email);
  if (v1.good) {
    verified = true;
    verifiedBy = "enrich";
    verifyLabel = `enrichso:${v1.result}/${v1.confidence}`;
  } else {
    const v2 = await verifyEmail(email);
    prospeoCalls++;
    verified = v2.ok;
    if (v2.ok) verifiedBy = "prospeo";
    verifyLabel = `enrichso:${v1.result}|prospeo:${v2.status}`;
  }
  setDoc.email_source = emailSource;
  setDoc.verified_by = verifiedBy;

  if (!verified) {
    await leads().updateOne(
      { linkedin_url: key },
      { $set: { ...setDoc, email, email_status: "unverified", unverified: true, verify_detail: verifyLabel },
        $addToSet: { campaigns: campaign, posts_seen: post_url }, $setOnInsert: { created_at: now } },
      { upsert: true }
    );
    await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls });
    log.info("unverified", { name, email, verifyLabel });
    return { outcome: "unverified", email, ...scored, name };
  }

  // 6) verified & sendable — write to Mongo, sync to SendKit
  const tags = buildTags({ status: scored.status, score: scored.score, timesSeen: scored.timesSeen, categories: scored.categories });
  const existing = await findOurLead(email);
  const isRepeat = !!existing;

  const [first, ...rest] = name.split(" ");
  await upsertLead({
    email,
    firstName: first,
    lastName: rest.join(" "),
    companyName: em.company_name || company || "",
    jobTitle: headline,
    linkedinUrl: key,
    tags,
  });
  await addToCampaign(campaign_id, email); // SendKit auto-skips if already in this campaign

  await leads().updateOne(
    { linkedin_url: key },
    { $set: { ...setDoc, email, email_status: "verified", unverified: false, needs_email: false, verify_detail: verifyLabel, tags },
      $addToSet: { campaigns: campaign, posts_seen: post_url }, $setOnInsert: { created_at: now } },
    { upsert: true }
  );

  // count the SendKit push only on first insert into this campaign (avoid double-count on repeats)
  await bumpUsage(campaign, { trigify_scraped: 1, prospeo_calls: prospeoCalls, sendkit_pushed: isRepeat ? 0 : 1 });

  log.info("verified & synced", { name, email, source: emailSource, verifiedBy, status: scored.status, score: scored.score, isRepeat });
  return { outcome: "sent", email, isRepeat, email_source: emailSource, verified_by: verifiedBy, ...scored, name };
}
