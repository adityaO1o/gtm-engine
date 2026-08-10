// Backfill company_domain on leads that don't have one. Two passes, cheapest first:
//   1. from the lead's OWN work email (the part after @) — free, reliable, skips free inboxes.
//   2. from the company NAME via guarded Clearbit — for leads with a name but no usable work email.
// Runs in the background; the Leads tab polls status and refetches when it finishes.
import { leads } from "../db/mongo.js";
import { emailDomain, isPersonalDomain } from "../services/quality.js";
import { companyDomainGuarded } from "../services/clearbit.js";
import { runPool } from "../lib/pool.js";
import { log } from "../lib/logger.js";

let running = false;
let last = null;

export function backfillDomainsStatus() { return { running, last }; }

const MISSING = { $or: [{ company_domain: { $in: [null, ""] } }, { company_domain: { $exists: false } }] };

export async function backfillCompanyDomains({ nameCap = 500 } = {}) {
  if (running) return { ok: false, error: "already running" };
  running = true;
  let fromEmail = 0, fromName = 0, scanned = 0;
  try {
    // Pass 1 — email domain. A work email's domain IS the company domain, and it's more reliable than
    // any name lookup, so this runs first and also covers leads that DO have a company name.
    const cur = leads().find({ ...MISSING, email: { $nin: [null, ""] } }, { projection: { linkedin_url: 1, email: 1 } });
    let batch = [];
    for await (const d of cur) {
      scanned++;
      if (d.email && !isPersonalDomain(d.email)) {
        const dom = emailDomain(d.email);
        if (dom) {
          batch.push({ updateOne: { filter: { linkedin_url: d.linkedin_url }, update: { $set: { company_domain: dom, updated_at: new Date() } } } });
          fromEmail++;
        }
      }
      if (batch.length >= 500) { await leads().bulkWrite(batch, { ordered: false }); batch = []; }
    }
    if (batch.length) await leads().bulkWrite(batch, { ordered: false });

    // Pass 2 — company name -> guarded Clearbit, capped so one run can't hammer the API. Only the
    // leads still missing a domain after pass 1 (personal-email / no-email) but that carry a name.
    const nameLeads = await leads().find(
      { ...MISSING, company: { $nin: [null, ""] } },
      { projection: { linkedin_url: 1, company: 1 } },
    ).limit(nameCap).toArray();
    await runPool(nameLeads, async (d) => {
      const g = await companyDomainGuarded(d.company).catch(() => null);
      if (g?.domain) {
        await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { company_domain: g.domain, updated_at: new Date() } });
        fromName++;
      }
    }, { concurrency: 5 });

    last = { at: new Date(), fromEmail, fromName, scanned, nameChecked: nameLeads.length };
    log.info("backfill company_domain done", last);
    return { ok: true, ...last };
  } catch (e) {
    log.error("backfill company_domain failed", { err: e.message });
    return { ok: false, error: e.message };
  } finally {
    running = false;
  }
}
