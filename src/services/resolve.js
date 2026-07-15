// Resolve a LinkedIn engager to a usable vanity URL.
//
// Likers arrive with an OBFUSCATED URN (/in/ACoAA...) that no email provider accepts, so we
// have to turn it into a real vanity URL before we can look up an email. This is the single
// slowest step in the pipeline and it gates the hand-off retry.
//
// THREE TIERS, each used until its quota runs out, then the next takes over:
//   1. SEO API     (/api/serp, self-hosted; wraps Jina + proxies on its own host)
//   2. Serper.dev  (google.serper.dev)  ~2,500 per key × N keys   (1 credit each)
//   3. proxies     (Brave/DDG/Bing through the rotating residential pool) — free, slow, ~80%
// (The old in-engine direct Jina tier is kept dormant behind config.jinaDirect — wallet drained.)
//
// The paid tiers hand back result TITLES, so we can check the profile actually belongs to this
// person before buying their email — resolving to the WRONG profile is worse than not
// resolving, because it feeds the Review bucket. A quota/auth error retires a tier for the rest
// of the run; a 429 is a temporary throttle and only pauses that tier briefly.

import axios from "axios";
import { nextWorkingAgent } from "../lib/proxies.js";
import { config } from "../config.js";
import { seoSerp, seoSerpDead, seoSerpCoolingDown } from "./seoSerp.js";
import { meter } from "./apiMeter.js";
import { log } from "../lib/logger.js";

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const alpha = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

// Does this hit actually look like the person we searched for? Require a real name token to
// appear in the title/url/snippet — otherwise we'd resolve to a stranger and buy their email.
function matchesPerson(name, hitStr) {
  const toks = String(name || "").split(/\s+/).map(alpha).filter((t) => t.length >= 3);
  if (!toks.length) return true;
  const hay = alpha(hitStr);
  return toks.some((t) => hay.includes(t));
}

// Headlines carry junk ("Mission Hills CC Dinah Shore Tournament Course") — long tails make the
// query so specific the SERP finds nothing. Keep the leading words only.
const cleanCompany = (c) =>
  String(c || "").replace(/[^\w\s&.-]/g, " ").trim().split(/\s+/).slice(0, 3).join(" ");

// narrow (name+company) then wide (name only). A name+company query that returns nothing used
// to fall straight through to a 2-minute proxy miss even though name-only finds the person.
function queriesFor(name, company) {
  const co = cleanCompany(company);
  const q = [];
  if (co) q.push(`"${name}" ${co} site:linkedin.com/in`);
  q.push(`"${name}" site:linkedin.com/in`);
  return q;
}

// Pull the company out of a LinkedIn SERP result. Titles/snippets read like
// "Jane Doe - VP Marketing at Acme Corp | LinkedIn" — the company is right there, which lets us
// find a domain (and an email) even when the person's own headline has no "at Company".
function companyFromHit(title = "", description = "") {
  for (const s of [title, description]) {
    const m = String(s || "").replace(/\s*\|\s*LinkedIn.*$/i, "")
      .match(/(?:\bat\b|@)\s+([A-Z][\w&.,'’\- ]{1,45})/);
    if (m) {
      const co = m[1].split(/[|·•]|\s[-–]\s/)[0].trim().replace(/[.,]+$/, "");
      if (co.length >= 2 && !/^linkedin$/i.test(co)) return co;
    }
  }
  return null;
}

// From a list of {url,title,description}, pick the best LinkedIn /in/ profile for this person,
// and return its company if the snippet exposes one. -> { url, company } | null
function bestHit(name, rows) {
  const hits = (rows || []).filter((r) => /linkedin\.com\/in\//i.test(r.url || ""));
  if (!hits.length) return null;
  const good = hits.filter((r) => matchesPerson(name, `${r.title} ${r.url} ${r.description}`));
  const pool = good.length ? good : hits;
  const url = pickVanity(pool.map((r) => r.url));
  if (!url) return null;
  const chosen = pool.find((r) => (r.url || "").includes(url.split("/in/")[1])) || pool[0];
  return { url, company: companyFromHit(chosen.title, chosen.description) };
}

// ── stats (surfaced on the dashboard so you can see which tier is doing the work) ────────────
const stats = { seo: 0, jina: 0, serper: 0, proxy: 0, miss: 0, jina429: 0, serper429: 0 };
export function resolveStats() {
  return {
    ...stats,
    seoDead: seoSerpDead(),
    seoCoolingDown: seoSerpCoolingDown(),
    jinaDead: jinaOutOfTokens,
    jinaCoolingDown: Date.now() < jinaCooldownUntil,
    serperKeysLive: SERPER.filter((k) => !k.dead).length,
    serperKeysTotal: SERPER.length,
    serperCreditsLeft: SERPER.reduce((a, k) => a + Math.max(0, k.left), 0),
  };
}

// ── Tier 1: SEO SERP API (self-hosted) ───────────────────────────────────────
async function resolveViaSeo({ name, company }) {
  for (const q of queriesFor(name, company)) {
    const rows = await seoSerp(q);
    if (rows === null) return null;   // SEO tier unusable this run -> next tier
    const pick = bestHit(name, rows);
    if (pick) return pick;
  }
  return null;
}

// ── Tier 1: Jina SERP ────────────────────────────────────────────────────────
let jinaOutOfTokens = false; // permanent (402/401)
let jinaCooldownUntil = 0;   // temporary (429)

const JINA_MIN_GAP_MS = 1600; // shared limiter: ~37 req/min across all workers, under the throttle
let jinaNextSlot = 0;
async function jinaSlot() {
  const now = Date.now();
  const wait = Math.max(0, jinaNextSlot - now);
  jinaNextSlot = Math.max(now, jinaNextSlot) + JINA_MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
}

// rows[] on success · [] when the query had no results · null when Jina is unusable this run
async function jinaSearch(query) {
  if (!config.jinaKey || jinaOutOfTokens || Date.now() < jinaCooldownUntil) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await jinaSlot();
    const r = await axios.get("https://s.jina.ai/", {
      params: { q: query },
      headers: { Authorization: `Bearer ${config.jinaKey}`, Accept: "application/json", "X-Respond-With": "no-content" },
      timeout: 30000, validateStatus: () => true,
    });
    if (r.status === 429) {
      stats.jina429++;
      if (attempt === 2) { jinaCooldownUntil = Date.now() + 30_000; log.warn("jina throttled — cooling 30s", { jina429: stats.jina429 }); return null; }
      await sleep(2000 * 2 ** attempt); continue;
    }
    if (r.status === 402 || r.status === 401) { jinaOutOfTokens = true; log.warn("jina out of tokens — moving to serper", { status: r.status }); return null; }
    if (r.status === 422) return [];           // "no results" — not an error, not a quota issue
    if (r.status !== 200) { log.warn("jina non-200", { status: r.status }); return []; }
    return (r.data?.data || []).map((x) => ({ url: x.url, title: x.title, description: x.description }));
  }
  return null;
}

async function resolveViaJina({ name, company }) {
  for (const q of queriesFor(name, company)) {
    const rows = await jinaSearch(q);
    if (rows === null) return null;   // Jina unusable -> next tier
    const pick = bestHit(name, rows);
    if (pick) return pick;
  }
  return null;
}

// ── Tier 2: Serper.dev (rotating keys) ───────────────────────────────────────
// Each key ~2,500 credits (1 per query). We drain key 0, then 1, ... marking a key dead on a
// 402/403/insufficient-credits and rotating to the next. 429 = throttle -> short cooldown.
const SERPER = (config.serperKeys || []).map((key) => ({ key, left: 2500, dead: false, coolUntil: 0 }));

const SERPER_MIN_GAP_MS = 120; // serper is generous; a light shared spacer avoids bursts
let serperNextSlot = 0;
async function serperSlot() {
  const now = Date.now();
  const wait = Math.max(0, serperNextSlot - now);
  serperNextSlot = Math.max(now, serperNextSlot) + SERPER_MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
}

function nextSerperKey() {
  return SERPER.find((k) => !k.dead && Date.now() >= k.coolUntil) || null;
}

// rows[] on success/empty · null when NO serper key is usable right now
async function serperSearch(query) {
  const k = nextSerperKey();
  if (!k) return null;
  await serperSlot();
  const r = await axios.post("https://google.serper.dev/search",
    { q: query, num: 5, gl: "us" },
    { headers: { "X-API-KEY": k.key, "Content-Type": "application/json" }, timeout: 20000, validateStatus: () => true });

  if (r.status === 429) {
    stats.serper429++;
    k.coolUntil = Date.now() + 15_000;      // brief pause on this key, try the next
    return serperSearch(query);
  }
  // 400/401/402/403 = the key is invalid, unauthorized, or out of credits. It will 400 on EVERY
  // call, so retire it (don't hammer Serper on every resolve) and rotate to the next key.
  if ([400, 401, 402, 403].includes(r.status)) {
    k.dead = true; k.left = 0;
    log.warn("serper key rejected — retiring", { status: r.status, key: k.key.slice(0, 8), liveKeys: SERPER.filter((x) => !x.dead).length });
    return serperSearch(query);            // retry immediately on the next key
  }
  if (r.status !== 200) { log.warn("serper non-200", { status: r.status }); return []; }
  k.left = Math.max(0, k.left - 1);
  if (k.left <= 0) k.dead = true;
  return (r.data?.organic || []).map((o) => ({ url: o.link, title: o.title, description: o.snippet }));
}

async function resolveViaSerper({ name, company }) {
  for (const q of queriesFor(name, company)) {
    const rows = await serperSearch(q);
    if (rows === null) return null;   // no serper key usable -> proxies
    const pick = bestHit(name, rows);
    if (pick) return pick;
  }
  return null;
}

// ── Tier 3: free engines behind rotating proxies ─────────────────────────────
function parseDirect(html) {
  return pickVanity(html.match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/gi) || []);
}
function parseDdg(html) {
  const found = [];
  for (const m of html.match(/uddg=[^"&]+/g) || []) {
    try {
      const lm = decodeURIComponent(m.slice(5)).match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
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
    httpsAgent: agent, timeout: config.proxyTimeoutMs,
    headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" }, validateStatus: () => true,
  });
  return typeof r.data === "string" ? engine.parse(r.data) : null;
}
async function resolveViaProxies({ name, company }) {
  const query = company ? `${name} ${company}` : name;
  const tries = Math.max(config.scrapeRetries, ENGINES.length * 2);
  for (let i = 0; i < tries; i++) {
    const engine = ENGINES[i % ENGINES.length];
    try {
      const hit = await attempt(engine, query, UAS[i % UAS.length]);
      if (hit) { log.info("resolved vanity (proxy)", { name, url: hit, engine: engine.name }); return { url: hit, company: null }; }
    } catch { /* proxy/engine dead — rotate */ }
  }
  return null;
}

// ── public: Jina -> Serper -> proxies. Returns { url, company } | null ────────
// company is a bonus the SERP tiers can expose from the result snippet (proxies can't); the
// caller uses it to find a domain when the person's own headline had no company.
export async function resolveVanity({ name, company }) {
  if (!name) return null;

  // Tier 1: SEO SERP API (wraps Jina + proxies on its own host).
  try {
    const hit = await resolveViaSeo({ name, company });
    if (hit) { stats.seo++; meter.inc("resolver_seo"); log.info("resolved vanity (seo)", { name, url: hit.url, company: hit.company }); return hit; }
  } catch (e) { log.warn("seo resolve threw", { err: e.message }); }

  // Tier 1b (dormant): in-engine direct Jina — only when explicitly re-enabled (wallet is drained).
  if (config.jinaDirect) {
    try {
      const hit = await resolveViaJina({ name, company });
      if (hit) { stats.jina++; log.info("resolved vanity (jina)", { name, url: hit.url, company: hit.company }); return hit; }
    } catch (e) { log.warn("jina resolve threw", { err: e.message }); }
  }

  // Tier 2: Serper.dev.
  try {
    const hit = await resolveViaSerper({ name, company });
    if (hit) { stats.serper++; meter.inc("resolver_serper"); log.info("resolved vanity (serper)", { name, url: hit.url, company: hit.company }); return hit; }
  } catch (e) { log.warn("serper resolve threw", { err: e.message }); }

  // Tier 3: free engines behind proxies.
  const hit = await resolveViaProxies({ name, company });
  if (hit) { stats.proxy++; meter.inc("resolver_proxy"); return hit; }

  stats.miss++; meter.inc("resolver_miss");
  log.warn("resolve miss (all tiers)", { name, company });
  return null;
}
