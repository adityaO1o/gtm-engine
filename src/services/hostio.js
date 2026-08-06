// host.io — reverse-redirect lookup. Given a seed domain, returns every domain that redirects INTO
// it, straight from host.io's crawled index. This replaces the permutation-guesser + DNS + HTTP
// pipeline: instead of generating ~24k candidate names and checking which are live and redirect back
// (seconds of work, and only finds names we can guess), host.io hands us the real, complete set —
// including ones no permutation could produce (e.g. "newsamrossgroupbrand.co").
//
// Plan note: on this token's tier a list page returns at most 5 domains, so a domain with 506
// redirects needs ~102 page requests. `total` comes back on page 1, so pages 2..N are fetched in a
// concurrency pool (not one-by-one) to keep the whole pull to a few seconds. Each request counts
// against host.io's monthly query quota — cheap for a handful of seeds, expensive at 1000-seed scale
// (that needs a paid host.io plan or the permutation path).
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import { runPool } from "../lib/pool.js";
import { log } from "../lib/logger.js";

const PER_PAGE = 5; // this tier's hard cap per list page, regardless of any `limit` param
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared spacer across host.io API calls so a big campaign's count burst (800 rapid calls) doesn't
// trip host.io's rate limit — that dropped 424/800 domains to a null count in one run, wrongly
// gating them out. ~250ms ≈ 240/min.
const HOSTIO_MIN_GAP_MS = parseInt(process.env.HOSTIO_MIN_GAP_MS || "250", 10);
let hostioNextSlot = 0;
async function hostioSlot() {
  const now = Date.now();
  const wait = Math.max(0, hostioNextSlot - now);
  hostioNextSlot = Math.max(now, hostioNextSlot) + HOSTIO_MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
}

async function fetchPage(seed, page) {
  const r = await axios.get(`https://host.io/api/domains/redirects/${encodeURIComponent(seed)}`, {
    params: { token: config.hostio.token, page },
    timeout: 20000, validateStatus: () => true,
  });
  if (r.status >= 300) {
    const err = new Error(`hostio ${r.status}`);
    err.status = r.status;
    err.body = typeof r.data === "string" ? r.data.slice(0, 200) : JSON.stringify(r.data || {}).slice(0, 200);
    throw err;
  }
  return { total: r.data?.total ?? 0, domains: r.data?.domains || [] };
}

// -> { total, domains }. onBatch(domains[]) fires per page as fresh domains arrive, so the caller can
// stream them into the blacklist stage instead of waiting for the whole pull.
export async function fetchRedirectDomains(seed, { onBatch } = {}) {
  if (!config.hostio.token) throw new Error("HOSTIO_TOKEN not set");

  const first = await fetchPage(seed, 1);
  const total = first.total || 0;
  const seen = new Set();
  const take = async (domains) => {
    const fresh = domains.map((d) => d.toLowerCase()).filter((d) => d && !seen.has(d));
    fresh.forEach((d) => seen.add(d));
    if (fresh.length && onBatch) await onBatch(fresh);
  };
  await take(first.domains);

  const pages = Math.ceil(total / PER_PAGE);
  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);

  await runPool(rest, async (page) => {
    try { await take((await fetchPage(seed, page)).domains); }
    catch (e) {
      // host.io's `total` slightly over-counts, so the last computed page can overshoot the real
      // list and 404 — that's expected end-of-list, not a failure. Only warn on real errors.
      if (e.status !== 404) log.warn("hostio page failed", { seed, page, status: e.status, err: e.message });
    }
  }, { concurrency: config.hostio.pageConcurrency });

  return { total, domains: [...seen] };
}

// Stage-1 cheap gate: how many domains redirect into `seed`, in ONE API call. limit=0 makes host.io
// return just the `total` count with an empty domains array — the cheapest possible signal (1 call,
// no name-pull), used to rank/triage seeds before spending any discovery/enrichment work on them.
// Returns the count, or null if host.io errored (so the caller can tell "0 redirects" from "failed").
export async function redirectCount(seed) {
  if (!config.hostio.token) throw new Error("HOSTIO_TOKEN not set");
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await hostioSlot();
      const r = await axios.get(`https://host.io/api/domains/redirects/${encodeURIComponent(seed)}`, {
        params: { token: config.hostio.token, limit: 0 },
        timeout: 15000, validateStatus: () => true,
      });
      if (r.status === 429) { await sleep(1500 * 2 ** attempt); continue; } // rate limit — back off + retry
      if (r.status >= 300) { log.warn("hostio count failed", { seed, status: r.status }); return null; }
      return r.data?.total ?? 0;
    } catch (e) {
      log.warn("hostio count threw", { seed, attempt, err: e.message });
    }
  }
  log.warn("hostio count gave up after retries", { seed });
  return null;
}

// ── host.io WEBSITE scrape (free, no API quota) ────────────────────────────────────────────────
// The public page https://host.io/redirects/<domain> lists ~48 REAL redirect domains in its HTML —
// including generic, non-brand names (findleadsnext.info, teamscaleupadvertise.co) that permutation
// guessing can never produce. This is the campaign's discovery source: free, no host.io API token/
// quota, and 15x the coverage of permutation (coldoutbound.com: 48 scraped vs 3 guessed).
//
// Requests route through a rotating pool of proxies so host.io sees fresh IPs and won't rate-limit
// us: the residential pool (HOSTIO_SCRAPE_PROXIES) plus the Webshare rotating endpoint if configured.
// Round-robin; a proxy that errors is benched for a cooldown and the next one is tried; if the whole
// pool fails the scrape falls back to a DIRECT request, so a dead pool never blocks discovery.

// One-time build of the pool: the residential proxy URLs + (optionally) the Webshare endpoint.
const SCRAPE_POOL = (() => {
  const pool = [...config.hostio.scrapeProxies];
  const w = config.webshare;
  if (w.username && w.host) pool.push(`http://${encodeURIComponent(w.username)}:${encodeURIComponent(w.password)}@${w.host}:${w.port}`);
  return pool;
})();
let poolCursor = 0;
const benchedUntil = new Map(); // proxyUrl -> timestamp it becomes usable again
const agentCache = new Map();   // proxyUrl -> HttpsProxyAgent (reused)

function agentFor(url) {
  let a = agentCache.get(url);
  if (!a) { a = new HttpsProxyAgent(url); agentCache.set(url, a); }
  return a;
}

// Next live proxy url (round-robin, skipping benched ones), or null if none available right now.
function nextProxy() {
  const now = Date.now();
  for (let i = 0; i < SCRAPE_POOL.length; i++) {
    const url = SCRAPE_POOL[poolCursor % SCRAPE_POOL.length];
    poolCursor++;
    if ((benchedUntil.get(url) || 0) <= now) return url;
  }
  return null;
}

export function scrapePoolSize() { return SCRAPE_POOL.length; }

// The page returns a 404 status but a fully-populated body; parse regardless of status. Returns BOTH
// the total count ("There are 756 domains redirecting to...") and the ~48 domains listed — so one
// free fetch covers the Stage-1 count gate AND the first page of domains, zero API quota.
function parseRedirectPage(html) {
  const s = String(html || "");
  const out = new Set();
  const re = /<a\s+href="\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})"[^>]*border-gray-400[^>]*>/gi;
  let m;
  while ((m = re.exec(s))) out.add(m[1].toLowerCase());
  const text = s.replace(/<[^>]+>/g, " ");
  const cm = text.match(/There\s+are\s+([0-9,]+)\s+domains?\s+redirecting/i);
  const total = cm ? parseInt(cm[1].replace(/,/g, ""), 10) : (out.size || null);
  return { total, domains: [...out] };
}

async function fetchScrape(seed, agent) {
  const r = await axios.get(`https://host.io/redirects/${encodeURIComponent(seed)}`, {
    // short timeout: a dead proxy should fail fast and get benched, not stall the whole pipeline for
    // 20s per bad IP (that was the main discovery bottleneck at 800-seed scale).
    timeout: agent ? 8000 : 15000, validateStatus: () => true,
    ...(agent ? { httpsAgent: agent, proxy: false } : {}),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" },
  });
  const page = parseRedirectPage(r.data);
  // A real host.io page always renders the "domains redirecting to <seed>" sentence, even at zero.
  // Without it we didn't get a usable page (block/captcha/error body) — say so rather than let the
  // caller read it as "this company has no redirects".
  page.ok = page.total != null || page.domains.length > 0;
  return page;
}

// FREE web scrape of page 1 -> { ok, total, domains }. Tries up to 4 pool proxies (benching dead
// ones ~2 min), then one direct attempt. Never throws. `ok:false` means we could not READ the page —
// distinct from a genuine zero, so the caller can retry instead of recording a false verdict.
// ── adaptive throttle ────────────────────────────────────────────────────────────────────────────
// host.io doesn't block outright, it starts refusing under load — and once it does, every in-flight
// seed burns its whole proxy list against a wall. A 6,140-seed run lost 4,730 seeds that way while
// host.io was answering fine minutes later. So watch the recent success rate and, when it collapses,
// make every scrape wait: the run gets slower instead of shredding itself, and recovers on its own.
const THROTTLE_WINDOW = 40;
let recent = [];                 // trailing booleans: did the scrape read a page?
let cooldownUntil = 0;
let cooldownMs = 0;

function noteScrape(ok) {
  recent.push(ok);
  if (recent.length > THROTTLE_WINDOW) recent.shift();
  if (recent.length < THROTTLE_WINDOW) return;
  const failRate = recent.filter((v) => !v).length / recent.length;
  if (failRate > 0.5) {
    // back off harder each time it re-trips, capped, and let the window re-fill before re-judging
    cooldownMs = Math.min(cooldownMs ? cooldownMs * 2 : 5_000, 60_000);
    cooldownUntil = Date.now() + cooldownMs;
    recent = [];
    log.warn("hostio failing in bulk — throttling", { failRate: failRate.toFixed(2), cooldownMs });
  } else if (failRate < 0.2) {
    cooldownMs = 0;               // healthy again — drop the penalty
  }
}

async function throttleGate() {
  for (let i = 0; i < 20 && Date.now() < cooldownUntil; i++) {
    await sleep(Math.min(2000, cooldownUntil - Date.now()));
  }
}

export async function scrapeRedirectPage(seed) {
  await throttleGate();
  const page = await scrapeOnce(seed);
  noteScrape(page.ok);
  return page;
}

async function scrapeOnce(seed) {
  // Two passes with a pause between them. A 2,319-seed run at concurrency 30 gave up on 14% of seeds
  // after only 4 proxies and no backoff — host.io pushes back in bursts, and most of those recover a
  // second later on a different exit. A seed we can't read costs a retry later, so it's worth trying
  // harder here than failing fast.
  const perPass = Math.min(6, SCRAPE_POOL.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < perPass; i++) {
      const url = nextProxy();
      if (!url) break;
      try {
        const page = await fetchScrape(seed, agentFor(url));
        if (page.ok) return page;
        benchedUntil.set(url, Date.now() + 120_000); // reachable but unusable — soft block; rotate
      } catch (e) {
        benchedUntil.set(url, Date.now() + 120_000);
        log.warn("hostio scrape proxy failed — rotating", { seed, proxy: url.split("@")[1], err: e.message });
      }
    }
    try { const direct = await fetchScrape(seed, null); if (direct.ok) return direct; } catch { /* fall through */ }
    if (pass === 0) await sleep(1500 + Math.floor(Math.random() * 1500)); // let a burst-limit clear
  }
  log.warn("hostio scrape failed after retries", { seed });
  return { ok: false, total: null, domains: [] };
}

// back-compat: just the domains (used by the old Domain Prospecting hostio mode).
export async function scrapeRedirectDomains(seed) {
  return (await scrapeRedirectPage(seed)).domains;
}

// ── PAID API page (Basic plan: 50 domains/page) — used ONLY when page-1 (free) didn't yield enough
// blacklisted domains, fetched lazily page by page. Every call is spaced + 429-retried + LOGGED via
// the onApiCall callback so usage is trackable. Returns { domains, ok }.
export async function apiRedirectPage(seed, page, { onApiCall } = {}) {
  if (!config.hostio.token) return { domains: [], ok: false };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await hostioSlot();
      const r = await axios.get(`https://host.io/api/domains/redirects/${encodeURIComponent(seed)}`, {
        params: { token: config.hostio.token, limit: 50, page },
        timeout: 15000, validateStatus: () => true,
      });
      if (r.status === 429) { await sleep(1500 * 2 ** attempt); continue; }
      if (r.status >= 300) { log.warn("hostio api page failed", { seed, page, status: r.status }); return { domains: [], ok: false }; }
      const domains = (r.data?.domains || []).map((d) => String(d).toLowerCase());
      if (onApiCall) await onApiCall({ seed, page, count: domains.length });
      return { domains, ok: true };
    } catch (e) {
      log.warn("hostio api page threw", { seed, page, attempt, err: e.message });
    }
  }
  return { domains: [], ok: false };
}

// Config/connectivity self-test for the diag endpoint — is the token set and does a live call work,
// without exposing the token.
export async function diagnose() {
  const tokenSet = !!config.hostio.token;
  if (!tokenSet) return { tokenSet: false, error: "HOSTIO_TOKEN not set" };
  try {
    const r = await axios.get("https://host.io/api/domains/redirects/numeral.com", {
      params: { token: config.hostio.token, page: 1 }, timeout: 15000, validateStatus: () => true,
    });
    if (r.status >= 300) return { tokenSet: true, ok: false, status: r.status };
    return { tokenSet: true, ok: true, status: r.status, sampleTotal: r.data?.total ?? null, perPage: (r.data?.domains || []).length };
  } catch (e) {
    return { tokenSet: true, ok: false, error: e.code || e.message };
  }
}
