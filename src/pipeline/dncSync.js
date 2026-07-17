// Reconcile SendKit's DNC list onto our leads. SendKit is the source of truth for who can never
// be emailed — whether we DNC'd them, you did it by hand, or a bounce did it. Our dnc flag is only
// a mirror, and it drifts: an audit found 49 leads (supersend.io, masterinbox.com, leadify.ai —
// competitors) that SendKit was blocking while our DB still said dnc:false.
//
// Safety rule: a truncated read of SendKit's list must NEVER clear a block. "Not in the page I
// managed to read" and "not blocked" look identical, and getting that wrong un-blocks a lead
// SendKit is deliberately holding back.

import { leads } from "../db/mongo.js";
import { fetchDncEmails } from "../services/sendkit.js";
import { log } from "../lib/logger.js";

export async function reconcileDnc() {
  const { emails, truncated } = await fetchDncEmails();
  if (!emails.size) return { emails, truncated, marked: 0, cleared: 0 };
  const list = [...emails];

  const marked = (await leads().updateMany(
    { email: { $in: list }, dnc: { $ne: true } },
    { $set: { dnc: true, dnc_at: new Date() } }
  )).modifiedCount;

  // Only ever clear blocks when we know we saw the WHOLE list.
  let cleared = 0;
  if (!truncated) {
    cleared = (await leads().updateMany(
      { dnc: true, email: { $nin: list } },
      { $set: { dnc: false }, $unset: { dnc_reason: "" } }
    )).modifiedCount;
  }

  log.info("dnc reconciled", { dncEmails: emails.size, marked, cleared, truncated });
  return { emails, truncated, marked, cleared };
}
