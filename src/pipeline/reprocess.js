// Reprocess the "no-email" hand-off leads through the current (Enrich-first) waterfall.
// Uses each lead's stored name/headline/linkedin_url — no Trigify re-scrape needed.

import { leads } from "../db/mongo.js";
import { findEmailWaterfall, verifyEmailWaterfall } from "./enrichLead.js";
import { isRoleBased } from "../services/enrich.js";
import { upsertLead, addToCampaign } from "../services/sendkit.js";
import { bumpUsage } from "../services/usage.js";
import { CAMPAIGN_ID } from "../services/score.js";
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
  await bumpUsage(campaign, { prospeo_calls: w.prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
  if (!em.found || !em.email) return false; // still no email — leave as hand-off

  const email = em.email;
  const base = { email, email_source: emailSource, email_method: emailMethod, needs_email: false, updated_at: new Date() };

  if (isRoleBased(email)) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "role-based", role_based: true } });
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
  await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "verified", unverified: false, tags } });
  await bumpUsage(campaign, { sendkit_pushed: 1 });
  return true;
}

export async function reprocessNoEmail({ limit = 0, concurrency = 4 } = {}) {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  const docs = await leads().find({ email_status: "no-email" }).toArray();
  const list = limit ? docs.slice(0, limit) : docs;
  status = { running: true, processed: 0, total: list.length, newlyFound: 0, startedAt: new Date(), finishedAt: null };

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
