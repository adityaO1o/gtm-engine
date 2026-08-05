// Sync = reconcile Mongo "verified" leads with SendKit reality:
//   1. migrate the legacy "Smartlead LinkedIn" campaign name to the real "- InboxKit" one
//   2. re-find email_method for old verified leads that predate method tracking
//   3. (idempotently) push every verified lead into its CORRECT SendKit campaign
// Runs in the background; poll syncStatus().

import { leads } from "../db/mongo.js";
import { findEmailWaterfall } from "./enrichLead.js";
import { upsertLeads, addLeadsToCampaign, addToDnc } from "../services/sendkit.js";
import { planEnrolment } from "./campaignLocks.js";
import { reconcileDnc } from "./dncSync.js";
import { resolveKey, campaignByKey, isCompetitor, sendkitIdsFor, INTAKE_SENDKIT_ID } from "../services/campaigns.js";
import { nameMatchesEmail, emailDomain } from "../services/quality.js";
import { log } from "../lib/logger.js";

let running = false;
let status = { running: false, phase: "idle", processed: 0, total: 0, reFound: 0, pushed: 0, alreadyIn: 0, moved: 0, failed: 0, dnc: 0, uniqueEmails: 0, startedAt: null, finishedAt: null };
export function syncStatus() { return status; }

const tagsFor = (d) => [
  "gtm-auto", ...(d.categories || []).map((c) => "cat:" + c),
  "score:" + d.score, "seen:" + d.times_seen, d.status + "-lead",
];

// A lead that was pushed to SendKit and is only NOW being blocked cannot be pulled back out —
// SendKit has no remove-from-campaign endpoint. DNC is the guarantee: campaigns run
// skipDNC:true, so a DNC'd address is skipped at send time.
async function blockLead(d, patch) {
  await leads().updateOne({ linkedin_url: d.linkedin_url },
    { $set: { ...patch, dnc: true, dnc_at: new Date(), updated_at: new Date() } });
  await addToDnc([d.email]);
  status.moved++;
  status.dnc++;
  log.info("blocked + DNC'd (was already in SendKit)", { email: d.email, status: patch.email_status });
}

async function syncOne(d) {
  // Cleanup pre-guard data: existing "verified" leads that are actually competitors or
  // name-mismatched emails get moved out of the send list (no credits — uses stored fields).
  if (d.email) {
    if (isCompetitor({ company: d.company || "", emailDomain: emailDomain(d.email) })) {
      await blockLead(d, { email_status: "competitor", is_competitor: true });
      return;
    }
    if (!nameMatchesEmail(d.name || "", d.email)) {
      await blockLead(d, { email_status: "review", email_low_confidence: true });
      return;
    }
  }
  // re-find the method for old verified leads (so the "Found by" column is never blank)
  if (!d.email_method && d.email) {
    const w = await findEmailWaterfall({ name: d.name, headline: d.headline, linkedin_url: d.linkedin_url });
    if (w.em.found && w.em.email) {
      await leads().updateOne({ linkedin_url: d.linkedin_url },
        { $set: { email_method: w.emailMethod, email_source: w.emailSource, updated_at: new Date() } });
      status.reFound++;
    }
  }
  return true;   // survived cleanup -> this lead should be in SendKit
}

export async function syncVerified({ campaign = "" } = {}) {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  // migrate legacy campaign name on lead docs
  await leads().updateMany({ campaigns: "Smartlead LinkedIn" }, { $set: { "campaigns.$": "Smartlead LinkedIn Engagers - InboxKit" } });

  // Reconcile SendKit's DNC list onto our leads, so the dashboard tells the truth about who
  // can never be emailed (whether we DNC'd them or you did it by hand in SendKit).
  try { await reconcileDnc(); } catch (e) { log.warn("dnc reconcile failed", { err: e.message }); }

  const q = { email_status: "verified" };
  if (campaign) q.campaigns = campaign;
  const docs = await leads().find(q).toArray();
  status = { running: true, phase: "cleanup", processed: 0, total: docs.length, reFound: 0, pushed: 0, alreadyIn: 0, moved: 0, failed: 0, dnc: 0, uniqueEmails: 0, startedAt: new Date(), finishedAt: null };

  // Phase 1 — per-lead cleanup (competitor / name-mismatch / missing method), collect keepers.
  const keep = [];
  let idx = 0;
  const worker = async () => {
    while (idx < docs.length) {
      const d = docs[idx++];
      try { if (await syncOne(d)) keep.push(d); } catch (e) { log.warn("sync one failed", { err: e.message }); }
      status.processed++;
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));

  // Phase 2 — BULK upsert every keeper (100 per call). Firing one HTTP call per lead got us
  // rate-limited: a 5.4k-call sync came back mostly non-2xx and the leads never landed.
  status.phase = "upserting";
  const byEmail = new Map();   // dedupe: two LinkedIn profiles can resolve to the SAME email,
  for (const d of keep) {      // and SendKit stores ONE lead per email
    const [first, ...rest] = (d.name || "").split(" ");
    if (!d.email) continue;
    const e = d.email.trim().toLowerCase();
    if (!byEmail.has(e)) byEmail.set(e, { email: e, firstName: first, lastName: rest.join(" "), companyName: d.company || "", jobTitle: d.headline || "", linkedinUrl: d.linkedin_url, tags: tagsFor(d) });
  }
  const up = await upsertLeads([...byEmail.values()]);
  status.failed += up.failed;

  // Phase 3 — group by campaign, then add each campaign's emails in batches of 100.
  status.phase = "adding to campaigns";
  // Sync is idempotent by design and runs over EVERY verified lead, so almost everyone here is
  // already a campaign member. Only the ones with no active enrolment are pushed — re-adding the
  // rest is what let a bulk sync scatter an email into a second campaign.
  const { toPush, skipped } = await planEnrolment(
    keep.filter((d) => d.email).map((d) => ({ email: d.email, sendkitCampaigns: d.sendkit_campaigns })),
    INTAKE_SENDKIT_ID,
  );
  status.alreadyEnrolled = skipped;
  for (const [cid, set] of toPush) {
    const r = await addLeadsToCampaign(cid, [...set]);
    status.pushed += r.added;        // genuinely new members
    status.alreadyIn += r.skipped;   // already in that campaign — success, not a failure
    status.failed += r.failed;
  }
  status.uniqueEmails = byEmail.size;

  status = { ...status, running: false, phase: "done", finishedAt: new Date() };
  running = false;
  log.info("sync done", { added: status.pushed, alreadyIn: status.alreadyIn, failed: status.failed, uniqueEmails: status.uniqueEmails, docs: docs.length });
  return { processed: status.processed, added: status.pushed, alreadyIn: status.alreadyIn, failed: status.failed };
}
