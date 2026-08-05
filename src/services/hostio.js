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
  try {
    const r = await axios.get(`https://host.io/api/domains/redirects/${encodeURIComponent(seed)}`, {
      params: { token: config.hostio.token, limit: 0 },
      timeout: 15000, validateStatus: () => true,
    });
    if (r.status >= 300) { log.warn("hostio count failed", { seed, status: r.status }); return null; }
    return r.data?.total ?? 0;
  } catch (e) {
    log.warn("hostio count threw", { seed, err: e.message });
    return null;
  }
}

// ── host.io WEBSITE scrape (free, no API quota) ────────────────────────────────────────────────
// The public page https://host.io/redirects/<domain> lists ~48 REAL redirect domains in its HTML —
// including generic, non-brand names (findleadsnext.info, teamscaleupadvertise.co) that permutation
// guessing can never produce. This is the campaign's discovery source: free, no host.io API token/
// quota, and 15x the coverage of permutation (coldoutbound.com: 48 scraped vs 3 guessed).
//
// Requests optionally route through the Webshare rotating proxy so host.io sees fresh IPs and won't
// rate-limit us. Webshare keeps one exit IP per "session" (username-<id>); we bump the session id
// every `scrapePerProxy` requests so no single IP makes more than ~that many host.io hits. If the
// proxy is unset or errors (e.g. out of bandwidth), the scrape falls back to a direct request.
let scrapeSeq = 0;

function webshareAgent() {
  const w = config.webshare;
  if (!w.username || !w.host) return null;
  const session = Math.floor(scrapeSeq / Math.max(1, config.hostio.scrapePerProxy));
  scrapeSeq++;
  const user = `${w.username}-${session}`; // webshare sticky-session id -> stable IP per session
  return new HttpsProxyAgent(`http://${encodeURIComponent(user)}:${encodeURIComponent(w.password)}@${w.host}:${w.port}`);
}

// The page returns a 404 status but a fully-populated body; parse regardless of status.
function parseRedirectDomains(html) {
  const out = new Set();
  // Redirect links carry a distinctive class; match the href of any <a> in that list.
  const re = /<a\s+href="\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})"[^>]*border-gray-400[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) out.add(m[1].toLowerCase());
  return [...out];
}

async function fetchScrape(seed, agent) {
  const r = await axios.get(`https://host.io/redirects/${encodeURIComponent(seed)}`, {
    timeout: 20000, validateStatus: () => true,
    ...(agent ? { httpsAgent: agent, proxy: false } : {}),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" },
  });
  return parseRedirectDomains(r.data);
}

// -> string[] of redirect domains (deduped, lowercased). Never throws — returns [] on failure.
export async function scrapeRedirectDomains(seed) {
  const agent = webshareAgent();
  if (agent) {
    try {
      const domains = await fetchScrape(seed, agent);
      if (domains.length) return domains;
      // empty via proxy — could be a proxy hiccup; fall through to a direct retry.
    } catch (e) {
      log.warn("hostio scrape via proxy failed — retrying direct", { seed, err: e.message });
    }
  }
  try { return await fetchScrape(seed, null); }
  catch (e) { log.warn("hostio scrape failed", { seed, err: e.message }); return []; }
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
