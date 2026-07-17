// Post-engager scraping via the RapidAPI LinkedIn scraper (fresh-linkedin-profile-data by
// default). 1 credit per PAGE — far cheaper than Trigify's per-engager billing.
//
// TWO hard-won quirks of this host (both silently truncated the scrape before):
//   • REACTIONS: `type=ALL` dead-ends at ~1,750 rows (returns empty pages after ~page 35) even
//     when `total` says 5k. Paginating EACH reaction type separately (LIKE, PRAISE, …) returns
//     the full set — LIKE alone pages to its own 4k+ total. So we loop the types, never ALL.
//   • COMMENTS: paginate by `pagination_token` (token-based), NOT by `page` — the page param
//     doesn't advance reliably.
//
// Robustness: a transient error (429 / 5xx / timeout / empty blip) is RETRIED with backoff, not
// treated as the end. Only a real 402/403 (out of credits) flips `outOfCredits` and stops the run
// (no auto-switch — the user drains fresh, then deliberately turns on web-scraping-api2). A 429 is
// a rate-limit, NOT out-of-credits — it just backs off.

import axios from "axios";
import { config } from "../config.js";
import { meter, recordBalance } from "./apiMeter.js";
import { log } from "../lib/logger.js";

// Latest plan balance seen in a RapidAPI rate-limit header (the real remaining, incl. on 429s).
let freshBal = null;
const hnum = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
function captureFreshBalance(r) {
  const h = r?.headers || {};
  const b = { creditsRemaining: hnum(h["x-ratelimit-credits-remaining"]), creditsLimit: hnum(h["x-ratelimit-credits-limit"]),
              requestsRemaining: hnum(h["x-ratelimit-requests-remaining"]), requestsLimit: hnum(h["x-ratelimit-requests-limit"]) };
  if (b.creditsRemaining !== null || b.requestsRemaining !== null) { freshBal = b; recordBalance("fresh", b).catch(() => {}); }
}

// type=ALL is capped; these six cover every LinkedIn reaction and each paginates fully.
const REACTION_TYPES = ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION", "ENTERTAINMENT"];

let outOfCredits = false;
const stats = { reactionPages: 0, commentPages: 0, engagers: 0, throttled: 0 };
export function rapidScrapeStats() { return { ...stats, outOfCredits, gapMs: dynamicGap, balance: freshBal, host: config.scrapeApiHost }; }
export function rapidScrapeOutOfCredits() { return outOfCredits; }
export function resetRapidScrape() { outOfCredits = false; dynamicGap = config.scrapeMinGapMs; stats.reactionPages = 0; stats.commentPages = 0; stats.engagers = 0; stats.throttled = 0; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// activity id out of any post URL / urn
// Pull the numeric post id out of any LinkedIn post URL.
//
// LinkedIn shifted the share-link slug from "...-activity-7430459358192369664-lwwr" to
// "...-share-7430459358192369664-lwwr". Matching only "activity" meant every post copied from the
// modern share button resolved to null — which silently cost us the ENTIRE comments phase
// (pndCommentPage needs the urn; reactions take the raw URL, so scrapes looked like they worked)
// and every post title. Both came back the moment this matched "share" too.
export function activityUrn(postUrl = "") {
  const m = String(postUrl).match(/(?:activity|share|ugcPost)[-:](\d{15,25})/);
  return m ? m[1] : null;
}

// ADAPTIVE shared rate limiter — starts at the configured gap and AUTO-SLOWS on 429s (×1.5, up to
// 8s) so it self-tunes to whatever the plan's per-minute cap actually is, then slowly decays back
// on sustained success. This is why a too-small configured gap no longer causes a 429 storm.
const BASE_GAP_MS = config.scrapeMinGapMs;
let dynamicGap = BASE_GAP_MS;
let nextSlot = 0;
async function slot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + dynamicGap;
  if (wait > 0) await sleep(wait);
}
const onThrottle = () => { stats.throttled++; dynamicGap = Math.min(Math.round(dynamicGap * 1.5), 8000); };
const onSuccess = () => { if (dynamicGap > BASE_GAP_MS) dynamicGap = Math.max(BASE_GAP_MS, Math.round(dynamicGap * 0.97)); };

// GET with retry. Returns parsed body, or null when the tier is done (out of credits / gave up).
// 402/403 -> out of credits (permanent, stop). 429/5xx/timeout/network -> transient, retry w/ backoff.
async function get(path, params, { retries = 3 } = {}) {
  if (!config.linkedinApiKey || outOfCredits) return null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await slot();
    let r;
    try {
      r = await axios.get(`https://${config.scrapeApiHost}/${path}`, {
        params, headers: { "x-rapidapi-host": config.scrapeApiHost, "x-rapidapi-key": config.linkedinApiKey },
        timeout: 45000, validateStatus: () => true,
      });
    } catch (e) { // timeout / network — transient
      if (attempt < retries) { await sleep(1500 * 2 ** attempt); continue; }
      log.warn("rapid scrape network error — giving up this page", { path, err: e.message });
      return null;
    }
    captureFreshBalance(r); // record the plan's real remaining from the response headers (even on 429)
    if (r.status === 402 || r.status === 403) {
      outOfCredits = true;
      log.warn("rapid scrape host out of credits — stopping (no auto-switch)", { host: config.scrapeApiHost, status: r.status });
      return null;
    }
    // RapidAPI returns 429 for BOTH the per-minute rate AND a drained MONTHLY quota. Tell them apart:
    // quota-exhausted (requests-remaining 0 / "exceeded … quota") is terminal → stop like out-of-credits
    // (retrying is futile until the plan is upgraded/renewed); a plain rate 429 just needs backoff.
    if (r.status === 429) {
      const remaining = r.headers?.["x-ratelimit-requests-remaining"];
      const body = typeof r.data === "string" ? r.data : JSON.stringify(r.data || "");
      if (remaining === "0" || /exceeded .*quota|quota.*exceeded|monthly quota/i.test(body)) {
        outOfCredits = true;
        log.warn("rapid scrape MONTHLY QUOTA exhausted — stopping (upgrade/renew the plan to continue)", { host: config.scrapeApiHost });
        return null;
      }
      onThrottle();
      if (attempt < retries) { await sleep(3000 * 2 ** attempt); continue; }
      log.warn("rapid scrape 429 (rate) — retries exhausted this page", { path, gapMs: dynamicGap });
      return null;
    }
    if (r.status !== 200) {
      if (attempt < retries) { await sleep(1500 * 2 ** attempt); continue; }
      log.warn("rapid scrape non-200 — giving up this page", { path, status: r.status });
      return null;
    }
    onSuccess();
    // Proactively stop once the plan's monthly requests hit 0 — the next call would 429-quota anyway.
    if (r.headers?.["x-ratelimit-requests-remaining"] === "0") { outOfCredits = true; log.warn("rapid scrape plan credits exhausted after this call", { host: config.scrapeApiHost }); }
    return r.data;
  }
  return null;
}

// Post metadata (poster + text + expected reaction/comment counts) — one cheap call, used to
// show a readable, clickable title in the "Scraped posts" history and an "X of ~Y" completeness.
export async function postDetails(urn) {
  if (!urn) return null;
  const d = await get("get-post-details", { urn }, { retries: 2 });
  if (!d?.data) return null;
  meter.inc("rapid_pages"); // this detail call costs 1 credit too
  const p = d.data, poster = p.poster || {};
  const name = [poster.first, poster.last].filter(Boolean).join(" ").trim();
  const text = String(p.text || "").replace(/\s+/g, " ").trim();
  const title = [name, text].filter(Boolean).join(" — ").slice(0, 120) || null;
  return {
    title, posterName: name || null, posterUrl: poster.linkedin_url || null, text: text.slice(0, 300) || null,
    postUrl: p.post_url || null, numReactions: p.num_reactions ?? null, numComments: p.num_comments ?? null, posted: p.posted || null,
  };
}

function pushReactor(out, it) {
  const r = it.reactor || it;
  if (r?.name || r?.linkedin_url) {
    out.push({ name: r.name || "", linkedin_url: r.linkedin_url || r.urn || "", headline: r.headline || "", engagement_type: "like" });
  }
}

export { REACTION_TYPES };

// ── Page-level scrapers (used by the RESUMABLE queue-based scrape runner) ─────────────────────
// Each returns the page's engagers + enough info to checkpoint. null => stop (out of credits / hard
// fail after retries) — the caller saves the checkpoint and can resume later from the same spot.
export async function reactionPage(urn, type, page) {
  const d = await get("get-post-reactions", { urn, type, page });
  if (d === null) return null;
  const items = d?.data || [];
  stats.reactionPages++; meter.inc("rapid_pages");
  const engagers = [];
  for (const it of items) pushReactor(engagers, it);
  return { engagers, count: items.length, total: typeof d?.total === "number" ? d.total : null };
}
export async function commentPage(urn, token) {
  const d = await get("get-post-comments", token ? { urn, pagination_token: token } : { urn, page: 1 });
  if (d === null) return null;
  const items = d?.data || d?.comments || [];
  stats.commentPages++; meter.inc("rapid_pages");
  const engagers = [];
  for (const it of items) pushCommenter(engagers, it);
  return { engagers, count: items.length, token: d?.pagination_token || null };
}

// All reactors -> engager objects. Loop each reaction TYPE (ALL is capped), page each to its total.
async function reactions(urn) {
  const out = [];
  for (const type of REACTION_TYPES) {
    let collected = 0, total = Infinity;
    for (let page = 1; page <= 250; page++) {
      const d = await get("get-post-reactions", { urn, type, page });
      if (d === null) return out;                 // out of credits / hard fail — stop the whole scrape
      const items = d?.data || [];
      if (typeof d?.total === "number") total = d.total;
      stats.reactionPages++; meter.inc("rapid_pages");
      for (const it of items) pushReactor(out, it);
      collected += items.length;
      if (!items.length || collected >= total) break; // this reaction type is fully drained
    }
  }
  return out;
}

function pushCommenter(out, it) {
  const a = it.commenter || it.author || it;
  const name = a?.name || a?.full_name || "";
  const url = a?.linkedin_url || a?.profile_url || a?.urn || "";
  if (name || url) out.push({ name, linkedin_url: url, headline: a?.headline || a?.title || "", engagement_type: "comment", comment_text: it.text || it.comment || "" });
}

// All commenters -> engager objects. Token-paginated: follow pagination_token until it runs out.
async function comments(urn) {
  const out = [];
  let token = null;
  for (let i = 0; i < 400; i++) { // safety cap (~4k comments)
    const d = await get("get-post-comments", token ? { urn, pagination_token: token } : { urn, page: 1 });
    if (d === null) return out;
    const items = d?.data || d?.comments || [];
    stats.commentPages++; meter.inc("rapid_pages");
    for (const it of items) pushCommenter(out, it);
    token = d?.pagination_token || null;
    if (!token || !items.length) break;
  }
  return out;
}

// All reactors + commenters for a post, DEDUPED (same person liking+commenting is enriched once,
// so we don't pay to resolve/find them twice). -> [{name, linkedin_url, headline, engagement_type}]
export async function scrapePostEngagers(postUrl) {
  const urn = activityUrn(postUrl);
  if (!urn) return { engagers: [], error: "no activity id in url" };
  const raw = [...(await reactions(urn)), ...(await comments(urn))];
  const seen = new Set();
  const engagers = [];
  for (const e of raw) {
    const k = (e.linkedin_url || e.name || "").toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    engagers.push(e);
  }
  stats.engagers += engagers.length; meter.inc("rapid_engagers", engagers.length);
  log.info("scraped post engagers", { urn, raw: raw.length, unique: engagers.length, reactionPages: stats.reactionPages, commentPages: stats.commentPages });
  return { engagers, outOfCredits, scraped: raw.length };
}
