// Cumulative API-consumption meter. Services call `meter.inc(field)` on every paid/metered call
// (zero-latency: it only mutates an in-memory delta). A timer + end-of-run hooks flush the delta
// into the `api_usage` Mongo doc with $inc, so the totals SURVIVE deploys — unlike the per-module
// in-memory stats, which reset to 0 on every restart (that's why the dashboard used to show 0).
//
// Fields (flat, namespaced):
//   rapid_pages / rapid_engagers      — Fresh scraper (get-post-reactions + get-post-comments)
//   webscrape_calls / webscrape_hits  — web-scraping-api2 get-personal-profile (company lookup)
//   resolver_seo / _serper / _proxy / _miss — URN->URL resolver tier that won
//   prospeo_calls / prospeo_finds     — Prospeo email finder
//   clearbit_calls / clearbit_rejects — Clearbit name->domain, and guard rejections

import { apiUsage } from "../db/mongo.js";
import { log } from "../lib/logger.js";

export const METER_FIELDS = [
  "rapid_pages", "rapid_engagers",
  "webscrape_calls", "webscrape_hits",
  "resolver_seo", "resolver_serper", "resolver_proxy", "resolver_miss",
  "prospeo_calls", "prospeo_finds",
  "clearbit_calls", "clearbit_rejects",
  // PND (professional-network-data): scrape pages + the PAID enrichment tier + cache savings.
  // pnd_cache_hits = lookups served from the company/profile caches, i.e. credits NOT spent.
  "pnd_scrape_pages", "pnd_engagers", "pnd_profile_calls", "pnd_company_calls", "pnd_cache_hits",
  // How each lead's domain was obtained — proves the free tiers are doing the work.
  "domain_free", "domain_paid",
];
const zero = () => Object.fromEntries(METER_FIELDS.map((f) => [f, 0]));

let delta = zero();       // counted since the last successful flush (not yet in Mongo)
let sinceBoot = zero();   // everything this process counted (the "live since restart" view)
const known = new Set(METER_FIELDS);

function inc(field, n = 1) {
  if (!known.has(field) || !n) return;
  delta[field] += n;
  sinceBoot[field] += n;
}
export const meter = { inc };

// The live, this-process view (resets on deploy) — handy for run-scoped displays.
export function meterSinceBoot() { return { ...sinceBoot }; }

let flushing = false;
export async function meterFlush() {
  if (flushing) return;
  const pending = delta;
  if (!METER_FIELDS.some((f) => pending[f] > 0)) return; // nothing to write
  flushing = true;
  delta = zero();
  try {
    const $inc = {};
    for (const f of METER_FIELDS) if (pending[f]) $inc[f] = pending[f];
    await apiUsage().updateOne({ _id: "global" }, { $inc, $set: { updated_at: new Date() } }, { upsert: true });
  } catch (e) {
    for (const f of METER_FIELDS) delta[f] += pending[f]; // failed — fold the counts back for the next flush
    log.warn("api meter flush failed", { err: e.message });
  } finally {
    flushing = false;
  }
}

// RapidAPI returns the plan's TRUE remaining in every response's rate-limit headers (even on a
// 429). We snapshot the latest into the api_usage doc so the dashboard shows the real balance —
// not a "plan − metered" estimate (the meter started mid-life, so that estimate over-counts what's
// left). Persisted, so it survives restarts and reflects usage from before the meter existed.
export async function recordBalance(provider, bal) {
  try {
    await apiUsage().updateOne({ _id: "global" }, { $set: { [`balance_${provider}`]: { ...bal, at: new Date() } } }, { upsert: true });
  } catch { /* best effort */ }
}
export async function readBalances() {
  try {
    const doc = (await apiUsage().findOne({ _id: "global" })) || {};
    return { fresh: doc.balance_fresh || null, webscrape: doc.balance_webscrape || null, pnd: doc.balance_pnd || null };
  } catch { return { fresh: null, webscrape: null, pnd: null }; }
}

// Persisted cumulative total + the delta we haven't flushed yet = the true running total.
export async function meterCumulative() {
  try {
    const doc = (await apiUsage().findOne({ _id: "global" })) || {};
    const out = {};
    for (const f of METER_FIELDS) out[f] = (doc[f] || 0) + delta[f];
    out.updated_at = doc.updated_at || null;
    return out;
  } catch {
    return { ...sinceBoot };
  }
}
