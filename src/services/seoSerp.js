// Tier-1 URN resolver: the self-hosted SEO SERP API (wraps Jina + its own proxies).
//   POST {seoApiBase}/api/serp  { query }  ->  { results: [{ title, url, description }] }
// A 500 (the host's Jina key momentarily exhausted/erroring) or a network wobble is a temporary
// COOLDOWN — never a permanent retire. A long scrape runs for hours; disabling the primary tier
// forever on one blip (the old bug) dumped everything onto Serper/proxies. It always self-heals.

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

let coolUntil = 0; // tier paused until this time (500 / 429 / network) — then it retries on its own

export function seoSerpDead() { return false; }           // no permanent death — the tier self-heals
export function seoSerpCoolingDown() { return Date.now() < coolUntil; }

// The SEO host shares one Jina key across callers — space requests so we never burst it.
const MIN_GAP_MS = 1500;
let nextSlot = 0;
async function slot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// rows[] on success/empty · null when the tier is cooling down (caller falls through to Serper)
export async function seoSerp(query) {
  if (Date.now() < coolUntil) return null;
  try {
    await slot();
    const r = await axios.post(`${config.seoApiBase}/api/serp`, { query },
      { headers: { "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true });
    // The SEO host turns Jina's 422 ("no results") into a 500 — but "nobody matched this query" is a
    // NORMAL, common outcome, NOT a broken tier. Treating it as a failure cooled the tier for 120s on
    // every obscure name, which is why SEO resolved ~6 while proxies did 335. Only a REAL error cools.
    if (r.status === 500) {
      const body = typeof r.data === "string" ? r.data : JSON.stringify(r.data || "");
      if (/\b422\b/.test(body)) return [];               // no results — just fall through for THIS query
      coolUntil = Date.now() + 120_000;
      log.warn("seo serp 500 — cooling 120s (host jina key?)", { body: body.slice(0, 120) });
      return null;
    }
    if (r.status === 429) { coolUntil = Date.now() + 20_000; return null; }
    if (r.status !== 200) { log.warn("seo serp non-200", { status: r.status }); return []; }
    return (r.data?.results || []).map((x) => ({ url: x.url, title: x.title, description: x.description }));
  } catch (e) {
    coolUntil = Date.now() + 20_000;
    log.warn("seo serp threw — cooling 20s", { err: e.message });
    return null;
  }
}
