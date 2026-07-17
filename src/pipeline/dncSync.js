// Reconcile SendKit's DNC list onto our leads. SendKit is the source of truth for who can never
// be emailed — whether we DNC'd them, you did it by hand, or a bounce did it. Our dnc flag is only
// a mirror, and it drifts: an audit found 49 leads (supersend.io, masterinbox.com, leadify.ai —
// competitors) that SendKit was blocking while our DB still said dnc:false.
//
// Safety rule: a truncated read of SendKit's list must NEVER clear a block. "Not in the page I
// managed to read" and "not blocked" look identical, and getting that wrong un-blocks a lead
// SendKit is deliberately holding back.

import { leads } from "../db/mongo.js";
import { fetchDncEmails, isBlockedBy } from "../services/sendkit.js";
import { log } from "../lib/logger.js";

export async function reconcileDnc() {
  const dnc = await fetchDncEmails();
  const { emails, domains, truncated } = dnc;
  if (!emails.size && !domains.size) return { ...dnc, marked: 0, cleared: 0 };

  // Decide blocked/not in JS rather than in the query: a lead is blocked by its address OR by its
  // whole domain, and a $in over 1.5k domain regexes would be a collection scan anyway.
  const docs = await leads().find({ email: { $nin: [null, ""] } }, { projection: { email: 1, dnc: 1 } }).toArray();
  const blocked = [], unblocked = [];
  for (const d of docs) (isBlockedBy(dnc, d.email) ? blocked : unblocked).push(d.email);

  const marked = blocked.length
    ? (await leads().updateMany({ email: { $in: blocked }, dnc: { $ne: true } }, { $set: { dnc: true, dnc_at: new Date() } })).modifiedCount
    : 0;

  // Only ever clear blocks when we know we saw the WHOLE list.
  let cleared = 0;
  if (!truncated && unblocked.length) {
    cleared = (await leads().updateMany(
      { email: { $in: unblocked }, dnc: true },
      { $set: { dnc: false }, $unset: { dnc_reason: "" } }
    )).modifiedCount;
  }

  log.info("dnc reconciled", { dncEmails: emails.size, dncDomains: domains.size, marked, cleared, truncated });
  return { ...dnc, marked, cleared };
}
