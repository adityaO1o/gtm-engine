// Reprocess "no-email" hand-off leads through the current (Enrich-first) waterfall.
// Uses each lead's stored name/headline/linkedin_url — no Trigify re-scrape needed.

import { leads, reprocessRuns } from "../db/mongo.js";
import { findEmailWaterfall, verifyEmailWaterfall, companyFromHeadline } from "./enrichLead.js";
import { isRoleBased } from "../services/enrich.js";
import { upsertLead, addToCampaign } from "../services/sendkit.js";
import { bumpUsage } from "../services/usage.js";
import { CAMPAIGN_ID, isCompetitor, sendkitIdsFor } from "../services/campaigns.js";
import { isPersonalDomain, nameMatchesEmail, emailDomain } from "../services/quality.js";
import { isUrn } from "../services/resolve.js";
import { log } from "../lib/logger.js";

let running = false;
let status = { running: false, processed: 0, total: 0, newlyFound: 0, reasons: {}, startedAt: null, finishedAt: null };
export function reprocessStatus() { return status; }

// Human-readable reasons a lead can't be recovered — shown in the hand-off run log so you can
// see WHY leads are still stuck, not just that they are.
export const MISS_REASONS = {
  recovered: "Recovered — email found, verified & sent",
  no_company_urn: "No company in the headline AND an obfuscated URL — nothing to search on",
  unresolved: "Couldn't resolve the LinkedIn profile (Jina/Serper/proxies all missed)",
  no_email_found: "Profile resolved, but no email provider has this person",
  unverified: "Email found but it failed verification (likely invalid/dead)",
  review: "Email found but the name didn't match — held for your review",
  competitor: "Works at a competitor — saved, never sent",
  role_based: "Role inbox (info@, sales@…) — saved, never sent",
};

const tagsFor = (d) => [
  "gtm-auto", ...(d.categories || []).map((c) => "cat:" + c),
  "score:" + d.score, "seen:" + d.times_seen, d.status + "-lead",
];

// returns a MISS_REASONS key describing the outcome
async function reprocessOne(d) {
  const hadUrn = isUrn(d.linkedin_url || "");
  const company = companyFromHeadline(d.headline || "");
  const w = await findEmailWaterfall({ name: d.name, headline: d.headline, linkedin_url: d.linkedin_url, usePaidProfile: true });
  const { em, emailSource, emailMethod, preVerified } = w;
  const campaign = (d.campaigns || [])[0] || "";
  await bumpUsage(campaign, { prospeo_calls: w.prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });

  if (!em.found || !em.email) {
    // Distinguish "we never had anything to search on" from "we searched and came up empty".
    if (!company && hadUrn && isUrn(w.vanity || d.linkedin_url)) return "no_company_urn"; // URN never resolved, no domain either
    if (hadUrn && isUrn(w.vanity || d.linkedin_url)) return "unresolved";                 // still a URN -> resolve failed
    return "no_email_found";                                                              // resolved / had url, providers had nothing
  }

  const email = em.email;
  const base = {
    email, email_source: emailSource, email_method: emailMethod,
    personal_email: isPersonalDomain(email), needs_email: false, updated_at: new Date(),
  };

  if (isCompetitor({ company, emailDomain: emailDomain(email) })) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "competitor", is_competitor: true } });
    return "competitor";
  }
  if (isRoleBased(email)) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "role-based", role_based: true } });
    return "role_based";
  }
  if (!nameMatchesEmail(d.name || "", email)) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "review", email_low_confidence: true } });
    return "review";
  }

  const vr = await verifyEmailWaterfall(email, preVerified);
  if (vr.prospeoCalls) await bumpUsage(campaign, { prospeo_calls: vr.prospeoCalls });
  base.verified_by = vr.verifiedBy; base.verify_detail = vr.verifyLabel;

  if (!vr.verified) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "unverified", unverified: true } });
    return "unverified";
  }

  const tags = tagsFor(d);
  const [first, ...rest] = (d.name || "").split(" ");
  await upsertLead({ email, firstName: first, lastName: rest.join(" "), companyName: d.company || "", jobTitle: d.headline || "", linkedinUrl: d.linkedin_url, tags });
  const landed = [];
  for (const cid of sendkitIdsFor(d.campaigns)) { if (await addToCampaign(cid, email)) landed.push(cid); }
  await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "verified", unverified: false, tags, recovered: true, recovered_at: new Date(), sendkit_campaigns: landed } });
  await bumpUsage(campaign, { sendkit_pushed: 1 });
  return "recovered";
}

// `campaigns` is the exact set the user ticked. Leads are matched with $in, so a person who
// sits in two selected campaigns is retried ONCE — the per-campaign totals overlap and must
// never be summed.
export function noEmailQuery(campaigns = []) {
  const q = { email_status: "no-email" };
  if (campaigns.length) q.campaigns = { $in: campaigns };
  return q;
}

export async function reprocessNoEmail({ limit = 0, concurrency = 4, campaigns = [] } = {}) {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  // Invariant: a lead with no email cannot also be flagged "recovered". Older builds could
  // demote a recovered lead back to no-email without clearing the flag; heal that here.
  await leads().updateMany({ email_status: "no-email", recovered: true }, { $set: { recovered: false } });
  const docs = await leads().find(noEmailQuery(campaigns)).toArray();
  const list = limit ? docs.slice(0, limit) : docs;
  const reasons = {};
  status = { running: true, processed: 0, total: list.length, newlyFound: 0, reasons, campaigns, startedAt: new Date(), finishedAt: null };

  let idx = 0;
  const worker = async () => {
    while (idx < list.length) {
      const d = list[idx++];
      let reason = "no_email_found";
      try { reason = await reprocessOne(d); }
      catch (e) { reason = "error"; log.warn("reprocess one failed", { err: e.message }); }
      reasons[reason] = (reasons[reason] || 0) + 1;
      if (reason === "recovered") status.newlyFound++;
      status.processed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));

  const finishedAt = new Date();
  status = { ...status, running: false, finishedAt };
  running = false;

  // Persist the run so the hand-off tab can show a history: how many recovered per run, and why
  // the rest missed. `at` is stamped by the route (workflow scripts can't call Date.now()).
  try {
    await reprocessRuns().insertOne({
      startedAt: status.startedAt, finishedAt,
      processed: status.processed, recovered: status.newlyFound,
      campaigns, reasons,
    });
  } catch (e) { log.warn("reprocess run log failed", { err: e.message }); }

  log.info("reprocess done", { processed: status.processed, recovered: status.newlyFound, reasons });
  return { processed: status.processed, newlyFound: status.newlyFound, total: status.total, reasons };
}
