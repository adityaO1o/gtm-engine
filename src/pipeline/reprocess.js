// Reprocess "no-email" hand-off leads through the current (Enrich-first) waterfall.
// Uses each lead's stored name/headline/linkedin_url — no Trigify re-scrape needed.

import { leads } from "../db/mongo.js";
import { findEmailWaterfall, verifyEmailWaterfall, companyFromHeadline } from "./enrichLead.js";
import { isRoleBased } from "../services/enrich.js";
import { upsertLead, addToCampaign } from "../services/sendkit.js";
import { bumpUsage } from "../services/usage.js";
import { CAMPAIGN_ID, isCompetitor } from "../services/campaigns.js";
import { isPersonalDomain, nameMatchesEmail, emailDomain } from "../services/quality.js";
import { log } from "../lib/logger.js";

let running = false;
let status = { running: false, processed: 0, total: 0, newlyFound: 0, startedAt: null, finishedAt: null };
export function reprocessStatus() { return status; }

const tagsFor = (d) => [
  "gtm-auto", ...(d.categories || []).map((c) => "cat:" + c),
  "score:" + d.score, "seen:" + d.times_seen, d.status + "-lead",
];

async function reprocessOne(d) {
  const w = await findEmailWaterfall({ name: d.name, headline: d.headline, linkedin_url: d.linkedin_url });
  const { em, emailSource, emailMethod, preVerified } = w;
  const campaign = (d.campaigns || [])[0] || "";
  const company = companyFromHeadline(d.headline || "");
  await bumpUsage(campaign, { prospeo_calls: w.prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
  if (!em.found || !em.email) return false; // still no email — leave as hand-off

  const email = em.email;
  const base = {
    email, email_source: emailSource, email_method: emailMethod,
    personal_email: isPersonalDomain(email), needs_email: false, updated_at: new Date(),
  };

  // competitor employee — save, never send
  if (isCompetitor({ company, emailDomain: emailDomain(email) })) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "competitor", is_competitor: true } });
    return false;
  }
  if (isRoleBased(email)) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "role-based", role_based: true } });
    return false;
  }
  // reputation guard — wrong-person email held for review
  if (!nameMatchesEmail(d.name || "", email)) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "review", email_low_confidence: true } });
    return false;
  }

  const vr = await verifyEmailWaterfall(email, preVerified);
  if (vr.prospeoCalls) await bumpUsage(campaign, { prospeo_calls: vr.prospeoCalls });
  base.verified_by = vr.verifiedBy; base.verify_detail = vr.verifyLabel;

  if (!vr.verified) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "unverified", unverified: true } });
    return false;
  }

  const tags = tagsFor(d);
  const [first, ...rest] = (d.name || "").split(" ");
  await upsertLead({ email, firstName: first, lastName: rest.join(" "), companyName: d.company || "", jobTitle: d.headline || "", linkedinUrl: d.linkedin_url, tags });
  const cid = (d.campaign_ids || [])[0] || CAMPAIGN_ID[campaign] || "";
  if (cid) await addToCampaign(cid, email);
  await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "verified", unverified: false, tags, recovered: true } });
  await bumpUsage(campaign, { sendkit_pushed: 1 });
  return true;
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
  status = { running: true, processed: 0, total: list.length, newlyFound: 0, campaigns, startedAt: new Date(), finishedAt: null };

  let idx = 0;
  const worker = async () => {
    while (idx < list.length) {
      const d = list[idx++];
      try { if (await reprocessOne(d)) status.newlyFound++; }
      catch (e) { log.warn("reprocess one failed", { err: e.message }); }
      status.processed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  status = { ...status, running: false, finishedAt: new Date() };
  running = false;
  log.info("reprocess done", { processed: status.processed, newlyFound: status.newlyFound });
  return { processed: status.processed, newlyFound: status.newlyFound, total: status.total };
}
