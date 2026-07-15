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
import { meter } from "./apiMeter.js";
import { log } from "../lib/logger.js";

// type=ALL is capped; these six cover every LinkedIn reaction and each paginates fully.
const REACTION_TYPES = ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION", "ENTERTAINMENT"];

let outOfCredits = false;
const stats = { reactionPages: 0, commentPages: 0, engagers: 0, throttled: 0 };
export function rapidScrapeStats() { return { ...stats, outOfCredits, host: config.scrapeApiHost }; }
export function rapidScrapeOutOfCredits() { return outOfCredits; }
export function resetRapidScrape() { outOfCredits = false; stats.reactionPages = 0; stats.commentPages = 0; stats.engagers = 0; stats.throttled = 0; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// activity id out of any post URL / urn
export function activityUrn(postUrl = "") {
  const m = String(postUrl).match(/activity[-:](\d{15,25})/);
  return m ? m[1] : null;
}

// Shared rate limiter — space calls so we don't burst the plan's per-minute cap and trip 429s.
const MIN_GAP_MS = config.scrapeMinGapMs;
let nextSlot = 0;
async function slot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
}

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
    if (r.status === 402 || r.status === 403) {
      outOfCredits = true;
      log.warn("rapid scrape host out of credits — stopping (no auto-switch)", { host: config.scrapeApiHost, status: r.status });
      return null;
    }
    if (r.status === 429) { // rate limit — back off and retry, do NOT mark out-of-credits
      stats.throttled++;
      if (attempt < retries) { await sleep(3000 * 2 ** attempt); continue; }
      log.warn("rapid scrape 429 — retries exhausted, pausing this page", { path });
      return null;
    }
    if (r.status !== 200) {
      if (attempt < retries) { await sleep(1500 * 2 ** attempt); continue; }
      log.warn("rapid scrape non-200 — giving up this page", { path, status: r.status });
      return null;
    }
    return r.data;
  }
  return null;
}

function pushReactor(out, it) {
  const r = it.reactor || it;
  if (r?.name || r?.linkedin_url) {
    out.push({ name: r.name || "", linkedin_url: r.linkedin_url || r.urn || "", headline: r.headline || "", engagement_type: "like" });
  }
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
