// Resolve a LinkedIn engager to a usable vanity URL.
//
// Likers come back from the scraper with an OBFUSCATED URN url:
//   https://www.linkedin.com/in/ACoAAD-xehoBx5E5fNGslIkeVhcIM00znK6taKo
// Prospeo/Enrich reject those. Commenters already have a real vanity url and skip this.
//
// TWO TIERS:
//  1. Jina SERP (s.jina.ai) — a real search API. Fast, reliable, and it hands back the result
//     TITLE, so we can check the profile actually belongs to this person before we go and buy
//     their email. Costs ~10k tokens per query, so the quota is finite.
//  2. Free engines (Brave / DDG Lite / Bing) through the rotating residential proxies. They
//     bot-detect our proxy IPs PER REQUEST — an IP is "trusted" or "flagged" and it flips each
//     time — so we rotate BOTH engine and proxy every attempt. ~80% hit rate on its own.
//
// Tier 2 is not just a backstop for outages: it is what carries the volume once Jina's token
// balance runs out. A quota/auth error trips a circuit breaker so we stop paying the latency
// cost of a doomed Jina call on every single lead.

import axios from "axios";
import { nextWorkingAgent } from "../lib/proxies.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

export function isUrn(url = "") {
  return /\/in\/ACoAA/i.test(url);
}

function pickVanity(urls) {
  for (const u of urls) {
    const slug = (u || "").split("/in/")[1]?.split(/[/?#]/)[0];
    if (slug && !/^ACoAA/i.test(slug)) return "https://www.linkedin.com/in/" + slug;
  }
  return null;
}

// ── stats (surfaced on the dashboard so you can see which tier is doing the work)
const stats = { jina: 0, proxy: 0, miss: 0, jinaDisabled: false };
export function resolveStats() { return { ...stats }; }

// ── Tier 1: Jina SERP ────────────────────────────────────────────────────────
let jinaDead = false; // circuit breaker: flipped once the token balance / auth is gone

const alpha = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

// Does this hit actually look like the person we searched for? Resolving to the WRONG profile
// is worse than not resolving at all — we'd go on to buy the wrong person's email, which is
// exactly what fills the Review bucket. Require at least one real name token to appear.
function matchesPerson(name, row) {
  const toks = String(name || "").split(/\s+/).map(alpha).filter((t) => t.length >= 3);
  if (!toks.length) return true;
  const hay = alpha(row.title) + alpha(row.url) + alpha(row.description);
  return toks.some((t) => hay.includes(t));
}

// Returns: rows[] on success · [] when the query simply had no results · null when Jina itself
// is unusable (out of tokens / bad key / throttled), which trips the breaker.
async function jinaSearch(query) {
  if (!config.jinaKey || jinaDead) return null;
  const r = await axios.get("https://s.jina.ai/", {
    params: { q: query },
    headers: {
      Authorization: `Bearer ${config.jinaKey}`,
      Accept: "application/json",
      "X-Respond-With": "no-content", // titles + urls only — don't pay to fetch page bodies
    },
    timeout: 30000,
    validateStatus: () => true,
  });
  // 402 out of tokens · 401 bad key · 429 throttled -> stop calling Jina, let the proxies work
  if (r.status === 402 || r.status === 401 || r.status === 429) {
    jinaDead = true;
    stats.jinaDisabled = true;
    log.warn("jina disabled — falling back to proxy engines for the rest of this run", { status: r.status });
    return null;
  }
  // 422 = "No search results available for query". NOT an error and NOT a quota problem —
  // the query was just too specific. Report it as empty so the caller can widen and retry.
  if (r.status === 422) return [];
  if (r.status !== 200) {
    log.warn("jina non-200", { status: r.status });
    return [];
  }
  return r.data?.data || [];
}

// Headlines give us junk like "Mission Hills CC Dinah Shore Tournament Course" — long tails
// make the query so specific that Jina finds nothing. Keep it to the leading words.
const cleanCompany = (c) =>
  String(c || "").replace(/[^\w\s&.-]/g, " ").trim().split(/\s+/).slice(0, 3).join(" ");

async function resolveViaJina({ name, company }) {
  // Two shots, narrow then wide. A name+company query that returns nothing used to fall
  // straight through to a ~2-minute proxy miss, even though name-only finds the person.
  const co = cleanCompany(company);
  const queries = co
    ? [`"${name}" ${co} site:linkedin.com/in`, `"${name}" site:linkedin.com/in`]
    : [`"${name}" site:linkedin.com/in`];

  for (const q of queries) {
    const rows = await jinaSearch(q);
    if (rows === null) return null;   // Jina unusable -> proxies
    if (!rows.length) continue;       // no results -> widen the query
    const hits = rows.filter((r) => /linkedin\.com\/in\//i.test(r.url || ""));
    if (!hits.length) continue;
    const good = hits.filter((r) => matchesPerson(name, r));
    // prefer a name-matched hit; only take the top LinkedIn result if nothing matched
    const pick = pickVanity((good.length ? good : hits).map((r) => r.url));
    if (pick) return pick;
  }
  return null;
}

// ── Tier 2: free engines behind rotating proxies ─────────────────────────────
function parseDirect(html) {
  return pickVanity(html.match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/gi) || []);
}
// DDG Lite wraps result links as ...uddg=<urlencoded destination>
function parseDdg(html) {
  const found = [];
  for (const m of html.match(/uddg=[^"&]+/g) || []) {
    try {
      const dec = decodeURIComponent(m.slice(5));
      const lm = dec.match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
      if (lm) found.push(lm[0]);
    } catch { /* not a url */ }
  }
  return pickVanity(found) || parseDirect(html);
}

const ENGINES = [
  { name: "brave", url: (q) => "https://search.brave.com/search?q=" + encodeURIComponent(q + " linkedin"), parse: parseDirect },
  { name: "ddg", url: (q) => "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q + " linkedin"), parse: parseDdg },
  { name: "bing", url: (q) => "https://www.bing.com/search?q=" + encodeURIComponent(q + " linkedin"), parse: parseDirect },
];

async function attempt(engine, query, ua) {
  const { agent } = await nextWorkingAgent();
  const r = await axios.get(engine.url(query), {
    httpsAgent: agent,
    timeout: config.proxyTimeoutMs,
    headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" },
    validateStatus: () => true,
  });
  if (typeof r.data !== "string") return null;
  return engine.parse(r.data);
}

async function resolveViaProxies({ name, company }) {
  const query = company ? `${name} ${company}` : name;
  const tries = Math.max(config.scrapeRetries, ENGINES.length * 2); // ~2 shots per engine
  for (let i = 0; i < tries; i++) {
    const engine = ENGINES[i % ENGINES.length];
    try {
      const hit = await attempt(engine, query, UAS[i % UAS.length]);
      if (hit) {
        log.info("resolved vanity (proxy)", { name, url: hit, engine: engine.name, attempt: i });
        return hit;
      }
    } catch {
      // proxy dead / engine 429 — rotate to the next engine+proxy combo
    }
  }
  return null;
}

// ── public: Jina first, proxies as fallback ──────────────────────────────────
export async function resolveVanity({ name, company }) {
  if (!name) return null;

  try {
    const hit = await resolveViaJina({ name, company });
    if (hit) {
      stats.jina++;
      log.info("resolved vanity (jina)", { name, url: hit });
      return hit;
    }
  } catch (e) {
    log.warn("jina resolve threw", { err: e.message });
  }

  const hit = await resolveViaProxies({ name, company });
  if (hit) { stats.proxy++; return hit; }

  stats.miss++;
  log.warn("resolve miss (jina + proxies)", { name, company });
  return null;
}
