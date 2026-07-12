// Sync = reconcile Mongo "verified" leads with SendKit reality:
//   1. migrate the legacy "Smartlead LinkedIn" campaign name to the real "- InboxKit" one
//   2. re-find email_method for old verified leads that predate method tracking
//   3. (idempotently) push every verified lead into its CORRECT SendKit campaign
// Runs in the background; poll syncStatus().

import { leads } from "../db/mongo.js";
import { findEmailWaterfall } from "./enrichLead.js";
import { upsertLead, addToCampaign } from "../services/sendkit.js";
import { resolveKey, campaignByKey } from "../services/campaigns.js";
import { log } from "../lib/logger.js";

let running = false;
let status = { running: false, processed: 0, total: 0, reFound: 0, pushed: 0, startedAt: null, finishedAt: null };
export function syncStatus() { return status; }

const tagsFor = (d) => [
  "gtm-auto", ...(d.categories || []).map((c) => "cat:" + c),
  "score:" + d.score, "seen:" + d.times_seen, d.status + "-lead",
];

async function syncOne(d) {
  // re-find the method for old verified leads (so the "Found by" column is never blank)
  if (!d.email_method && d.email) {
    const w = await findEmailWaterfall({ name: d.name, headline: d.headline, linkedin_url: d.linkedin_url });
    if (w.em.found && w.em.email) {
      await leads().updateOne({ linkedin_url: d.linkedin_url },
        { $set: { email_method: w.emailMethod, email_source: w.emailSource, updated_at: new Date() } });
      status.reFound++;
    }
  }
  // push into the correct SendKit campaign (idempotent, free)
  const key = resolveKey((d.campaigns || [])[0] || "");
  const cid = campaignByKey(key)?.sendkitId || "";
  const [first, ...rest] = (d.name || "").split(" ");
  await upsertLead({ email: d.email, firstName: first, lastName: rest.join(" "), companyName: d.company || "", jobTitle: d.headline || "", linkedinUrl: d.linkedin_url, tags: tagsFor(d) });
  if (cid) await addToCampaign(cid, d.email);
  status.pushed++;
}

export async function syncVerified({ campaign = "" } = {}) {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  // migrate legacy campaign name on lead docs
  await leads().updateMany({ campaigns: "Smartlead LinkedIn" }, { $set: { "campaigns.$": "Smartlead LinkedIn Engagers - InboxKit" } });

  const q = { email_status: "verified" };
  if (campaign) q.campaigns = campaign;
  const docs = await leads().find(q).toArray();
  status = { running: true, processed: 0, total: docs.length, reFound: 0, pushed: 0, startedAt: new Date(), finishedAt: null };

  let idx = 0;
  const worker = async () => {
    while (idx < docs.length) {
      const d = docs[idx++];
      try { await syncOne(d); } catch (e) { log.warn("sync one failed", { err: e.message }); }
      status.processed++;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  status = { ...status, running: false, finishedAt: new Date() };
  running = false;
  log.info("sync done", { pushed: status.pushed, reFound: status.reFound });
  return { processed: status.processed, reFound: status.reFound, pushed: status.pushed };
}
