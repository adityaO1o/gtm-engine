// Tier-1 URN resolver: the self-hosted SEO SERP API (wraps Jina + its own proxies).
//   POST {seoApiBase}/api/serp  { query }  ->  { results: [{ title, url, description }] }
// A 500 means the SEO server's JINA_API_KEY is missing/exhausted — retire this tier for the rest
// of the run (fall through to Serper -> proxies). A 429 / network wobble is a brief cooldown only.

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

let dead = false;       // permanent-this-run (500: Jina key missing/exhausted on the SEO host)
let coolUntil = 0;      // temporary (429 / network error)

export function seoSerpDead() { return dead; }
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

// rows[] on success/empty · null when the tier is unusable this run (caller moves to Serper)
export async function seoSerp(query) {
  if (dead || Date.now() < coolUntil) return null;
  try {
    await slot();
    const r = await axios.post(`${config.seoApiBase}/api/serp`, { query },
      { headers: { "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true });
    if (r.status === 500) { dead = true; log.warn("seo serp 500 (jina key on host?) — retiring tier this run"); return null; }
    if (r.status === 429) { coolUntil = Date.now() + 20_000; return null; }
    if (r.status !== 200) { log.warn("seo serp non-200", { status: r.status }); return []; }
    return (r.data?.results || []).map((x) => ({ url: x.url, title: x.title, description: x.description }));
  } catch (e) {
    coolUntil = Date.now() + 20_000;
    log.warn("seo serp threw — cooling 20s", { err: e.message });
    return null;
  }
}
