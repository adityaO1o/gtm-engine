// Paid LinkedIn profile lookup (RapidAPI). Used as a LAST-RESORT company getter: when we've
// resolved a person to a vanity URL but still have no employer (their headline had none and the
// SERP snippet didn't expose one), this returns their current company + often the company domain
// directly — which unlocks the name+domain email path.
//
// Cost control: only ever called when the free paths (headline, SERP snippet) failed AND we have
// a real vanity URL — so it fires on a minority of leads, not every one.

import axios from "axios";
import { config } from "../config.js";
import { meter } from "./apiMeter.js";
import { log } from "../lib/logger.js";

let outOfQuota = false; // TRUE only on a real monthly-quota exhaust (terminal until plan renews)
let coolUntil = 0;      // transient rate-limit (429) -> brief pause, NOT a permanent kill
const stats = { calls: 0, hits: 0, quota: 0 };
export function linkedinProfileStats() { return { ...stats, outOfQuota, coolingDown: Date.now() < coolUntil }; }

// Shared rate limiter — the Basic plan allows 20 req/min, but a hand-off retry runs many workers
// concurrently. Space calls ~3.3s apart (≈18/min) across all of them so we never trip a 429.
const MIN_GAP_MS = 3300;
let nextSlot = 0;
async function slot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// Confirmed shape (freshdata web-scraping-api2 /get-personal-profile): the person's current
// employer + domain sit at data.company / data.company_domain. We still check a few aliases in
// case the provider tweaks field names.
const clean = (v) => (typeof v === "string" && v.trim().length > 1 ? v.trim() : null);
function pickCompany(d) {
  return clean(d?.company) || clean(d?.company_name) || clean(d?.current_company) || clean(d?.current_company?.name) || null;
}
function pickDomain(d) {
  for (const v of [d?.company_domain, d?.company_website, d?.website, d?.company?.domain]) {
    if (typeof v === "string" && v.includes(".")) {
      const m = v.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
      if (/\.[a-z]{2,}$/i.test(m)) return m.toLowerCase();
    }
  }
  return null;
}

const clean2 = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
function pickVanityUrl(d) {
  const pid = clean2(d?.public_id) || clean2(d?.public_identifier) || clean2(d?.username);
  if (pid) return "https://www.linkedin.com/in/" + pid.replace(/\/$/, "");
  const u = clean2(d?.linkedin_url) || clean2(d?.profile_url);
  return u && /\/in\//.test(u) && !/\/in\/ACoAA/i.test(u) ? u : null;
}
function pickName(d) { return clean2(d?.full_name) || [clean2(d?.first_name), clean2(d?.last_name)].filter(Boolean).join(" ") || null; }

// The endpoint accepts a vanity URL OR an obfuscated liker URN (…/in/ACoAA…) directly, so we can
// feed the Trigify URN straight in and skip the whole resolve step.
// -> { company, domain, vanity, name } | null
export async function profileCompany(linkedinUrlOrUrn) {
  if (!config.linkedinApiKey || outOfQuota || Date.now() < coolUntil || !linkedinUrlOrUrn) return null;
  try {
    await slot();
    stats.calls++; meter.inc("webscrape_calls");
    const r = await axios.get(`https://${config.linkedinApiHost}/get-personal-profile`, {
      params: { linkedin_url: linkedinUrlOrUrn },
      headers: { "x-rapidapi-host": config.linkedinApiHost, "x-rapidapi-key": config.linkedinApiKey },
      timeout: 60000, validateStatus: () => true,
    });
    if (r.status === 402 || r.status === 403 || r.status === 429) {
      // Distinguish a drained MONTHLY quota (terminal) from a transient per-minute rate-limit.
      const remaining = r.headers?.["x-ratelimit-credits-remaining"];
      const body = typeof r.data === "string" ? r.data : JSON.stringify(r.data || "");
      const quotaGone = r.status === 402 || r.status === 403 || (remaining !== undefined && Number(remaining) <= 0) || /exceeded .*quota|quota.*exceeded|monthly quota/i.test(body);
      if (quotaGone) {
        outOfQuota = true; stats.quota++;
        log.warn("linkedin profile api MONTHLY quota exhausted — disabling (upgrade/renew to continue)", { status: r.status });
      } else {
        coolUntil = Date.now() + 30_000; // rate-limited — pause briefly, don't retire the tier
        log.warn("linkedin profile api rate-limited — cooling 30s", { status: r.status });
      }
      return null;
    }
    if (r.status !== 200) { log.warn("linkedin profile api non-200", { status: r.status }); return null; }
    const body = r.data?.data || r.data || {};
    const out = { company: pickCompany(body), domain: pickDomain(body), vanity: pickVanityUrl(body), name: pickName(body) };
    if (out.company || out.domain || out.vanity) { stats.hits++; meter.inc("webscrape_hits"); return out; }
    return null;
  } catch (e) {
    log.warn("linkedin profile api threw", { err: e.message });
    return null;
  }
}
