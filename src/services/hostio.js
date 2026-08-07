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
const benchedUntil = new Map(); // proxyUrl -> timestamp it becomes usable again
const agentCache = new Map();   // proxyUrl -> HttpsProxyAgent (reused)

function agentFor(url) {
  let a = agentCache.get(url);
  if (!a) { a = new HttpsProxyAgent(url); agentCache.set(url, a); }
  return a;
}

// ── exit leasing ─────────────────────────────────────────────────────────────────────────────────
// Round-robin let any number of seeds hit the same address at once, which is how a 75-exit pool got
// itself permanently 429'd — every one of those exits now refuses, none recovered. host.io limits per
// IP, so the only durable protection is a hard per-IP rate: an exit serves ONE request at a time and
// then rests. The pool therefore also becomes the concurrency limit, whatever the campaign asks for.
const MIN_GAP_PER_EXIT_MS = parseInt(process.env.HOSTIO_PROXY_MIN_GAP_MS || "2000", 10);
const exitBusy = new Set();
const exitFreeAt = new Map();   // proxyUrl -> earliest timestamp it may be used again

// Wait for an exit that is neither busy, benched, nor still resting. null if none frees up in time.
async function acquireExit(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = Date.now();
    let best = null, bestAt = Infinity;
    for (const url of SCRAPE_POOL) {
      if (exitBusy.has(url)) continue;
      if ((benchedUntil.get(url) || 0) > now) continue;
      const at = Math.max(exitFreeAt.get(url) || 0, now);
      if (at < bestAt) { bestAt = at; best = url; }
    }
    if (best && bestAt <= now) { exitBusy.add(best); return best; }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(300, Math.max(50, bestAt - now)));
  }
}

function releaseExit(url) {
  exitBusy.delete(url);
  exitFreeAt.set(url, Date.now() + MIN_GAP_PER_EXIT_MS);
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
  // 429 is host.io rate-limiting THIS IP, not a broken exit. Measured direct: 15 concurrent is
  // clean, 30 gives 25/30 429s, 60 gives 60/60. The caller must not bench the proxy for two
  // minutes over it — that shrank the pool until every seed fell through to the single direct IP,
  // which 429s instantly. That cascade is what turned a transient limit into 4,730 dead seeds.
  page.limited = r.status === 429;
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
// Once an IP is genuinely rate-limited the penalty is not seconds: after a 60-concurrent burst, the
// same address still 429'd on single sequential requests 100s later. So a limited exit is rested for
// a minute, doubling while it keeps coming back limited — long enough to actually clear, and reset
// the moment it serves a page again.
const limitHits = new Map();     // proxyUrl -> consecutive 429s
function benchLimited(url) {
  const hits = (limitHits.get(url) || 0) + 1;
  limitHits.set(url, hits);
  benchedUntil.set(url, Date.now() + Math.min(60_000 * 2 ** (hits - 1), 600_000));
}

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
  // A small pool must be spent carefully: three leased exits, each rate-limited to one request at a
  // time, then give up. A seed we can't read stays a retryable error, which costs far less than
  // burning the pool trying harder — the previous 6-exits-times-2-passes ladder is exactly how 75
  // addresses ended up permanently refused.
  let limited = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = await acquireExit();
    if (!url) break;                       // whole pool busy, resting or benched
    try {
      const page = await fetchScrape(seed, agentFor(url));
      if (page.ok) { limitHits.delete(url); return page; }   // healthy again — clear its penalty
      // A rate-limited exit is not a broken one, but it does need real rest before we touch it again.
      if (page.limited) { limited = true; benchLimited(url); }
      else benchedUntil.set(url, Date.now() + 120_000);
    } catch (e) {
      benchedUntil.set(url, Date.now() + 120_000);
      log.warn("hostio scrape proxy failed — rotating", { seed, proxy: url.split("@")[1], err: e.message });
    } finally { releaseExit(url); }
    if (limited) await sleep(2000 + Math.floor(Math.random() * 3000));
  }

  // The server's own address is a single shared IP: usable as a last resort when nothing is being
  // limited, but never while a limit is in play — that is what turned a proxy problem into a total
  // outage, every seed piling onto one address that 429s instantly.
  if (!limited && SCRAPE_POOL.length === 0) {
    try { const direct = await fetchScrape(seed, null); if (direct.ok) return direct; } catch { /* fall through */ }
  }

  log.warn("hostio scrape failed after retries", { seed, limited });
  return { ok: false, total: null, domains: [], limited };
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
      // 404 is host.io saying it holds no redirect record for this domain — a real answer (zero),
      // not a failure. Treating it as an error buried ~20% of a 5,270-domain list in "error".
      if (r.status === 404) return { domains: [], ok: true, total: 0, status: 404 };
      if (r.status >= 300) {
        const body = typeof r.data === "string" ? r.data.slice(0, 120) : JSON.stringify(r.data || {}).slice(0, 120);
        log.warn("hostio api page failed", { seed, page, status: r.status, body });
        return { domains: [], ok: false, status: r.status, body };
      }
      const domains = (r.data?.domains || []).map((d) => String(d).toLowerCase());
      if (onApiCall) await onApiCall({ seed, page, count: domains.length });
      // `total` is the full redirect count for the seed and comes free with any page — the caller
      // that only ever fetches page 1 needs it, and re-deriving it would cost a second call.
      return { domains, ok: true, total: r.data?.total ?? null };
    } catch (e) {
      log.warn("hostio api page threw", { seed, page, attempt, err: e.message });
    }
  }
  return { domains: [], ok: false };
}

// Config/connectivity self-test for the diag endpoint — is the token set and does a live call work,
// without exposing the token.
// Health of the FREE scrape path: pool size, how much of it is currently rested, whether the global
// throttle is engaged, and one live fetch through a proxy. Without this the only signal that the
// scrape lane is wedged is seeds sitting in "scraping" — which looks identical to it being slow.
export async function scrapeDiagnose() {
  const now = Date.now();
  const benched = [...benchedUntil.values()].filter((t) => t > now).length;
  const out = {
    poolSize: SCRAPE_POOL.length,
    benched,
    usable: SCRAPE_POOL.length - benched,
    rateLimitedExits: limitHits.size,
    busy: exitBusy.size,
    resting: SCRAPE_POOL.filter((u) => (exitFreeAt.get(u) || 0) > now).length,
    minGapPerExitMs: MIN_GAP_PER_EXIT_MS,
    maxReqPerSec: SCRAPE_POOL.length ? +(SCRAPE_POOL.length / (MIN_GAP_PER_EXIT_MS / 1000)).toFixed(1) : null,
    throttled: now < cooldownUntil,
    cooldownMsLeft: Math.max(0, cooldownUntil - now),
    recentWindow: recent.length,
    recentFailRate: recent.length ? +(recent.filter((v) => !v).length / recent.length).toFixed(2) : null,
  };
  // Probe several DIFFERENT exits plus the server's own address. If the proxies are limited but
  // direct is clean, skipping the direct fallback while limited (which this file does) is actively
  // throwing away the one working path.
  const probe = async (label, agent) => {
    const t = Date.now();
    try {
      const p = await fetchScrape("sopro.io", agent);
      return { via: label, ok: p.ok, total: p.total, limited: !!p.limited, ms: Date.now() - t };
    } catch (e) { return { via: label, err: e.code || e.message, ms: Date.now() - t }; }
  };
  out.probes = [];
  for (let i = 0; i < Math.min(3, SCRAPE_POOL.length); i++) {
    out.probes.push(await probe(`proxy[${i}]`, agentFor(SCRAPE_POOL[i])));
  }
  out.probes.push(await probe("direct", null));

  // The pool is only worth its size if the exits are distinct ADDRESSES. host.io limits per IP, so
  // 75 credentials sharing a handful of egress IPs buys no headroom at all — and would explain a
  // 429 arriving in 200ms on a freshly started process with nothing benched.
  const sample = SCRAPE_POOL.slice(0, 12);
  const ips = await Promise.all(sample.map(async (u) => {
    try {
      const r = await axios.get("https://api.ipify.org?format=json",
        { httpsAgent: agentFor(u), proxy: false, timeout: 10000, validateStatus: () => true });
      return r.data?.ip || `status${r.status}`;
    } catch (e) { return e.code || "ERR"; }
  }));
  out.exitIps = { probed: sample.length, distinct: new Set(ips.filter((v) => /^\d+\./.test(v))).size, ips };
  return out;
}

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
