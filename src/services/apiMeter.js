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
