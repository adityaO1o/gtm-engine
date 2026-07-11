// Resolve a LinkedIn engager to a usable vanity URL — FREE, no paid SERP API.
//
// Likers come back from the scraper with an OBFUSCATED URN url:
//   https://www.linkedin.com/in/ACoAAD-xehoBx5E5fNGslIkeVhcIM00znK6taKo
// Prospeo rejects those. Commenters already have a real vanity url and skip this.
//
// Every free search engine (Bing, DDG Lite, Brave) bot-detects our residential proxy IPs
// PER REQUEST — a given IP is "trusted" (real results) or "flagged" (soft-block/429) and it
// flips each time. So we rotate BOTH the engine AND the proxy every attempt and take the
// first hit from any of them. Empirically this resolves ~80% of people. Whoever we can't
// resolve is saved to the hand-off list — never dropped.

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
    const slug = u.split("/in/")[1]?.split(/[/?#]/)[0];
    if (slug && !/^ACoAA/i.test(slug)) return "https://www.linkedin.com/in/" + slug;
  }
  return null;
}

// direct linkedin.com/in/<slug> matches (Brave, Bing)
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
    } catch {}
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

// Resolve name (+company) to a real vanity URL, rotating engine+proxy each try. Null if none.
export async function resolveVanity({ name, company }) {
  const query = company ? `${name} ${company}` : name;
  const tries = Math.max(config.scrapeRetries, ENGINES.length * 2); // give each engine ~2 shots

  for (let i = 0; i < tries; i++) {
    const engine = ENGINES[i % ENGINES.length];
    try {
      const hit = await attempt(engine, query, UAS[i % UAS.length]);
      if (hit) {
        log.info("resolved vanity", { name, url: hit, engine: engine.name, attempt: i });
        return hit;
      }
    } catch (e) {
      // proxy dead / engine 429 — just rotate to the next combo
    }
  }
  log.warn("resolve miss", { name, company });
  return null;
}
