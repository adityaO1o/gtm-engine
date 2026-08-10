// One-time (re-runnable) sweep over EXISTING leads: anything now matching the non-ICP list (big tech,
// banks, …) that was scored/sent before the exclusion existed gets moved out of the hot/warm set —
// email_status "out-of-icp", status "cold", never-send. Any that already sit in a SendKit campaign are
// DNC'd so they stop receiving mail (SendKit has no remove-from-campaign, DNC is the guarantee).
// Runs in the background; the UI polls status and refetches when it finishes.
import { leads } from "../db/mongo.js";
import { emailDomain } from "../services/quality.js";
import { isOutOfIcp } from "../services/icp.js";
import { addToDnc } from "../services/sendkit.js";
import { log } from "../lib/logger.js";

let running = false;
let last = null;

export function reclassifyIcpStatus() { return { running, last }; }

export async function reclassifyIcp() {
  if (running) return { ok: false, error: "already running" };
  running = true;
  let scanned = 0, flagged = 0;
  try {
    // Skip leads already handled (out_of_icp / competitor). Only need company or email to judge.
    const cur = leads().find(
      { out_of_icp: { $ne: true }, is_competitor: { $ne: true }, $or: [{ company: { $nin: [null, ""] } }, { email: { $nin: [null, ""] } }] },
      { projection: { linkedin_url: 1, company: 1, email: 1, sendkit_campaigns: 1 } },
    );
    let batch = [];
    const toDnc = [];
    for await (const d of cur) {
      scanned++;
      if (!isOutOfIcp({ company: d.company || "", emailDomain: emailDomain(d.email || "") })) continue;
      flagged++;
      batch.push({ updateOne: { filter: { linkedin_url: d.linkedin_url }, update: { $set: {
        email_status: "out-of-icp", out_of_icp: true, status: "cold", needs_email: false, updated_at: new Date(),
      } } } });
      if (d.email && d.sendkit_campaigns?.length) toDnc.push(d.email);
      if (batch.length >= 500) { await leads().bulkWrite(batch, { ordered: false }); batch = []; }
    }
    if (batch.length) await leads().bulkWrite(batch, { ordered: false });

    // DNC the flagged leads that were already in a campaign (chunked; best-effort).
    for (let i = 0; i < toDnc.length; i += 200) await addToDnc(toDnc.slice(i, i + 200)).catch(() => {});
    if (toDnc.length) await leads().updateMany({ email: { $in: toDnc } }, { $set: { dnc: true, dnc_at: new Date() } }).catch(() => {});

    last = { at: new Date(), scanned, flagged, dnc: toDnc.length };
    log.info("reclassify ICP done", last);
    return { ok: true, ...last };
  } catch (e) {
    log.error("reclassify ICP failed", { err: e.message });
    return { ok: false, error: e.message };
  } finally {
    running = false;
  }
}
