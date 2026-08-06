// BounceBan — the PRIMARY email verifier (runs before Enrich/Prospeo).
//
// Why first: a huge credit pool (~228k), 100 req/sec, and it returns signals the others don't —
// is_accept_all (catch-all domains, the main reason leads used to land in "unverified"), is_role,
// is_disposable, is_free, plus an mx/smtp provider read.
//
// It also SAVES Enrich/Prospeo credits: an "undeliverable" verdict is terminal, so we stop there
// instead of paying two more providers to tell us the same thing. Only an ambiguous verdict
// (risky/unknown) falls through for a second opinion.

import axios from "axios";
import { config } from "../config.js";
import { meter } from "./apiMeter.js";
import { verifyCache } from "../db/mongo.js";
import { log } from "../lib/logger.js";

const BASE = "https://api.bounceban.com/v1";
const auth = () => ({ Authorization: `Bearer ${config.bouncebanKey}` });
const stats = { calls: 0, deliverable: 0, undeliverable: 0, ambiguous: 0 };
export function bouncebanStats() { return { ...stats, enabled: !!config.bouncebanKey }; }

// -> { result, score, deliverable, hardFail, acceptAll, role, free, disposable } | null (unusable)
export async function bouncebanVerify(email) {
  if (!config.bouncebanKey || !email) return null;
  const key = String(email).trim().toLowerCase();

  // Reuse a recent verdict instead of re-buying it. BounceBan is our paid verifier and the SAME
  // address is checked by the live path, reprocess and the audit — a lead stuck
  // "unverified" gets re-verified on every retry pass. Only real verdicts are cached; a null
  // (API down / out of credits) is never stored, so those retry live next time.
  if (config.bouncebanCacheMs > 0) {
    try {
      const hit = await verifyCache().findOne({ email: key });
      if (hit?.v && hit.at && Date.now() - new Date(hit.at).getTime() < config.bouncebanCacheMs) {
        meter.inc("bounceban_cache_hits");
        return hit.v;
      }
    } catch { /* cache is best-effort — fall through to a live call */ }
  }

  try {
    stats.calls++; meter.inc("bounceban_calls");
    const r = await axios.get(`${BASE}/verify/single`, {
      params: { email }, headers: auth(), timeout: 30000, validateStatus: () => true,
    });
    if (r.status !== 200 || !r.data) { log.warn("bounceban non-200", { status: r.status }); return null; }
    const d = r.data;
    const result = String(d.result || "").toLowerCase();
    const deliverable = result === "deliverable";
    const hardFail = result === "undeliverable";
    if (deliverable) { stats.deliverable++; meter.inc("bounceban_deliverable"); }
    else if (hardFail) { stats.undeliverable++; meter.inc("bounceban_undeliverable"); }
    else { stats.ambiguous++; meter.inc("bounceban_ambiguous"); }
    const verdict = {
      result, score: d.score ?? null, deliverable, hardFail,
      acceptAll: !!d.is_accept_all, role: !!d.is_role, free: !!d.is_free, disposable: !!d.is_disposable,
      remaining: d.credits_remaining ?? null,
    };
    if (config.bouncebanCacheMs > 0) {
      verifyCache().updateOne({ email: key }, { $set: { email: key, v: verdict, at: new Date() } }, { upsert: true }).catch(() => {});
    }
    return verdict;
  } catch (e) {
    log.warn("bounceban threw", { err: e.message });
    return null;
  }
}

// Live credit balance for the dashboard (cached 5 min).
let balCache = { at: 0, data: null };
export async function bouncebanBalance({ force = false } = {}) {
  if (!config.bouncebanKey) return null;
  if (!force && balCache.data && Date.now() - balCache.at < 5 * 60_000) return balCache.data;
  try {
    const r = await axios.get(`${BASE}/account`, { headers: auth(), timeout: 15000, validateStatus: () => true });
    if (r.status === 200 && r.data) balCache = { at: Date.now(), data: { remaining: r.data.available_credits ?? null } };
  } catch (e) { log.warn("bounceban balance threw", { err: e.message }); }
  return balCache.data;
}
