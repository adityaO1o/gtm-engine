// PND — professional-network-data (RapidAPI). ONE API that covers the whole pipeline:
//   • post reactions + comments  (50 engagers per credit — the scrape)
//   • profile by url OR obfuscated URN -> real vanity + current company + companyUsername
//   • company -> EXACT website domain (no Clearbit guessing)
//
// Credit discipline (every call = 1 credit):
//   • Scraping is cheap (~0.02 cr/engager) and always allowed.
//   • The PAID enrichment tier (profile/company) is a LAST RESORT — enrichLead only calls it when
//     the free tiers (headline, SERP snippet, comment vanity URL) couldn't produce a working domain.
//   • Two permanent Mongo caches make repeats free: a company's domain is bought ONCE and every
//     future lead there is free forever; a profile is never paid for twice (retries reuse it).
//   • A credit FLOOR switches the paid tier off before the plan can be drained — free tiers keep
//     running so leads never stop flowing.

import axios from "axios";
import { config } from "../config.js";
import { companyDomains, profileCache } from "../db/mongo.js";
import { meter, recordBalance } from "./apiMeter.js";
import { resolveActivityUrn } from "./postUrn.js";
import { log } from "../lib/logger.js";

const stats = { scrapePages: 0, engagers: 0, profileCalls: 0, companyCalls: 0, cacheHits: 0, throttled: 0 };
let bal = null;          // latest {creditsRemaining, creditsLimit, requestsRemaining, requestsLimit}
let outOfCredits = false;

export function pndStats() { return { ...stats, outOfCredits, balance: bal, paidBlocked: paidBlocked(), host: config.pndHost }; }
export function pndOutOfCredits() { return outOfCredits; }
// Paid enrichment stops at the floor; scraping + free tiers continue.
export function paidBlocked() {
  if (!config.pndKey || outOfCredits) return true;
  return bal?.creditsRemaining != null && bal.creditsRemaining <= config.pndCreditFloor;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hnum = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
function captureBalance(r) {
  const h = r?.headers || {};
  const b = { creditsRemaining: hnum(h["x-ratelimit-credits-remaining"]), creditsLimit: hnum(h["x-ratelimit-credits-limit"]),
              requestsRemaining: hnum(h["x-ratelimit-requests-remaining"]), requestsLimit: hnum(h["x-ratelimit-requests-limit"]) };
  if (b.creditsRemaining !== null || b.requestsRemaining !== null) { bal = b; recordBalance("pnd", b).catch(() => {}); }
}

// Shared limiter so we never burst the plan's per-minute cap.
let nextSlot = 0;
async function slot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + config.pndMinGapMs;
  if (wait > 0) await sleep(wait);
}

// -> body | null. 402/403 or a quota-429 = out of credits (terminal); a rate-429/5xx retries.
async function call(path, { method = "GET", params, body, retries = 2 } = {}) {
  if (!config.pndKey || outOfCredits) return null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await slot();
    let r;
    try {
      r = await axios({
        method, url: `https://${config.pndHost}/${path}`, params, data: body,
        headers: { "x-rapidapi-host": config.pndHost, "x-rapidapi-key": config.pndKey, "Content-Type": "application/json" },
        timeout: 45000, validateStatus: () => true,
      });
    } catch (e) {
      if (attempt < retries) { await sleep(1200 * 2 ** attempt); continue; }
      log.warn("pnd network error", { path, err: e.message });
      return null;
    }
    captureBalance(r);
    if (r.status === 402 || r.status === 403) { outOfCredits = true; log.warn("pnd out of credits/not subscribed", { status: r.status }); return null; }
    if (r.status === 429) {
      const txt = typeof r.data === "string" ? r.data : JSON.stringify(r.data || "");
      if (/exceeded .*quota|quota.*exceeded|monthly quota/i.test(txt) || bal?.creditsRemaining === 0) {
        outOfCredits = true; log.warn("pnd MONTHLY quota exhausted"); return null;
      }
      stats.throttled++;
      if (attempt < retries) { await sleep(2500 * 2 ** attempt); continue; }
      return null;
    }
    if (r.status !== 200) {
      if (attempt < retries) { await sleep(1200 * 2 ** attempt); continue; }
      log.warn("pnd non-200", { path, status: r.status });
      return null;
    }
    return r.data;
  }
  return null;
}

// ── SCRAPE ───────────────────────────────────────────────────────────────────
// Reactions paginate over ALL reactions (no per-type cap like the old host) — 50 per credit.
export async function pndReactionPage(postUrl, page) {
  const d = await call("get-post-reactions", { method: "POST", body: { url: postUrl, page } });
  if (!d) return null;
  stats.scrapePages++; meter.inc("pnd_scrape_pages");
  const items = d?.data?.items || [];
  const engagers = items.map((x) => ({
    name: x.fullName || "", headline: x.headline || "",
    linkedin_url: x.profileUrl || x.url || "", engagement_type: "like",
  })).filter((e) => e.name || e.linkedin_url);
  return { engagers, count: items.length, total: typeof d?.data?.total === "number" ? d.data.total : null };
}

// Comments are token-paginated and hand back the commenter's REAL vanity URL (no resolve needed).
export async function pndCommentPage(urn, { page = 1, token = "" } = {}) {
  const params = { urn, sort: "mostRecent", page: String(page) };
  if (token) params.paginationToken = token;
  const d = await call("get-profile-posts-comments", { params });
  if (!d) return null;
  stats.scrapePages++; meter.inc("pnd_scrape_pages");
  const items = d?.data?.comments || d?.data?.items || [];
  const engagers = items.map((c) => {
    const a = c.author || {};
    const name = [a.firstName, a.LastName || a.lastName].filter(Boolean).join(" ").trim();
    return { name, headline: a.title || a.headline || "", linkedin_url: a.linkedinUrl || (a.urn ? `https://www.linkedin.com/in/${a.urn}` : ""), engagement_type: "comment", comment_text: c.text || "" };
  }).filter((e) => e.name || e.linkedin_url);
  return { engagers, count: items.length, token: d?.data?.paginationToken || d?.paginationToken || "" };
}

// Takes a post URL or a bare activity urn. get-post only accepts an activity urn — it rejects both
// a share id and a raw share URL — so a share-link is resolved (free, via proxy) before we ask.
export async function pndPostInfo(urlOrUrn) {
  const s = String(urlOrUrn || "");
  if (!s) return null;
  const known = /^\d{15,25}$/.test(s) ? s : await resolveActivityUrn(s);
  if (!known) return null; // unresolvable — say nothing rather than guess an id
  const d = await call("get-post", { params: { urn: known } });
  const p = d?.data;
  if (!p) return null;
  const poster = p.poster || {};
  const text = String(p.text || "").replace(/\s+/g, " ").trim();
  return {
    urn: known,
    title: [[poster.first, poster.last].filter(Boolean).join(" "), text].filter(Boolean).join(" — ").slice(0, 120) || null,
    posterName: [poster.first, poster.last].filter(Boolean).join(" ") || null, posterUrl: poster.linkedin_url || null,
    text: text.slice(0, 300) || null, numReactions: p.num_reactions ?? null, numComments: p.num_comments ?? null, posted: p.posted || null,
  };
}

// ── PAID ENRICHMENT (last resort, both cached) ───────────────────────────────
// Profile by vanity URL OR raw obfuscated URN — the URN works directly, so no SERP resolve needed.
export async function pndProfile(urlOrUrn) {
  if (!urlOrUrn) return null;
  const key = String(urlOrUrn);
  const hit = await profileCache().findOne({ _id: key }).catch(() => null);
  if (hit) { stats.cacheHits++; meter.inc("pnd_cache_hits"); return hit; }
  if (paidBlocked()) return null;

  const d = await call("get-profile-data-by-url", { params: { url: key } });
  if (!d || d.message === "The url is not valid." || !d.username) return null;
  stats.profileCalls++; meter.inc("pnd_profile_calls");
  const pos = (d.position || [])[0] || {};
  const rec = {
    _id: key,
    vanity: d.username ? `https://www.linkedin.com/in/${d.username}` : null,
    name: [d.firstName, d.lastName].filter(Boolean).join(" ") || null,
    headline: d.headline || null,
    company: pos.companyName || null,
    companyUsername: pos.companyUsername || null,
    at: new Date(),
  };
  await profileCache().updateOne({ _id: key }, { $set: rec }, { upsert: true }).catch(() => {});
  return rec;
}

// companyUsername -> exact website domain. Bought ONCE per company, then free forever.
export async function pndCompanyDomain(companyUsername) {
  if (!companyUsername) return null;
  const hit = await companyDomains().findOne({ _id: companyUsername }).catch(() => null);
  if (hit) { stats.cacheHits++; meter.inc("pnd_cache_hits"); return hit.domain || null; }
  if (paidBlocked()) return null;

  const d = await call("get-company-details", { params: { username: companyUsername } });
  if (!d?.data) return null;
  stats.companyCalls++; meter.inc("pnd_company_calls");
  const domain = String(d.data.website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase() || null;
  await companyDomains().updateOne({ _id: companyUsername },
    { $set: { _id: companyUsername, domain, name: d.data.name || null, at: new Date() } }, { upsert: true }).catch(() => {});
  return domain;
}

// The paid last-resort: person -> { company, domain, vanity }. Both hops cached, so calling this
// twice for the same person (e.g. waterfall + a verify-fail retry) costs nothing extra.
export async function pndExactDomain(urlOrUrn) {
  const p = await pndProfile(urlOrUrn);
  if (!p) return null;
  const domain = p.companyUsername ? await pndCompanyDomain(p.companyUsername) : null;
  return { company: p.company, domain, vanity: p.vanity, headline: p.headline, name: p.name };
}
