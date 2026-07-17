// Scrape a public LinkedIn "top-content" hub page and pull out the individual post URLs +
// author /in/ profile links. Post URLs feed the pipeline directly; authors are harvested as
// influencer sources (robust even when post extraction is thin).
//
// LinkedIn serves the FULL public hub HTML to a plain datacenter fetch, but shows a login wall
// to many residential-proxy IPs — so we fetch DIRECT first and only fall back to the proxy pool
// if the direct fetch is blocked or empty.

import axios from "axios";
import { nextWorkingAgent } from "../lib/proxies.js";
import { log } from "../lib/logger.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function extract(html) {
  const posts = [...new Set(html.match(/https:\/\/www\.linkedin\.com\/(?:posts\/[^"'\s\\)]+|feed\/update\/urn:li:activity:\d+)/g) || [])]
    .map((u) => u.replace(/[",]+$/, ""));
  const authors = [...new Set((html.match(/https:\/\/www\.linkedin\.com\/in\/[a-zA-Z0-9\-_%]{3,}/g) || [])
    .map((u) => u.replace(/\?.*$/, "")))]        // drop ?trk= tracking query so upserts dedup cleanly
    .filter((u) => !/\/in\/ACoAA/i.test(u));
  return { posts, authors };
}

async function fetchHtml(hubUrl, useProxy) {
  const cfg = { timeout: 25000, validateStatus: () => true, headers: { "User-Agent": UA } };
  if (useProxy) {
    // nextWorkingAgent returns {agent, proxyUrl} and THROWS when the pool is dry — it never returns
    // null, so the old `const agent = ...; if (!agent)` handed axios the WRAPPER as its httpsAgent
    // and every proxied fetch here failed. That is why hub post-URL extraction always looked "thin
    // against LinkedIn's bot HTML": it was never reaching LinkedIn at all.
    try {
      const { agent } = await nextWorkingAgent();
      cfg.httpsAgent = agent; cfg.proxy = false;
    } catch (e) { log.warn("hubScrape: no working proxy", { err: e.message }); return ""; }
  }
  try {
    const r = await axios.get(hubUrl, cfg);
    return typeof r.data === "string" ? r.data : JSON.stringify(r.data || "");
  } catch (e) {
    log.warn("hubScrape fetch threw", { proxy: !!useProxy, err: e.message });
    return "";
  }
}

export async function hubScrape(hubUrl) {
  // Direct first — the public hub page returns full HTML (authors + posts) to a datacenter IP.
  let html = await fetchHtml(hubUrl, false);
  let out = extract(html);
  if (!out.authors.length && !out.posts.length) {
    log.info("hubScrape direct empty, retrying via proxy", { hubUrl });
    html = await fetchHtml(hubUrl, true);
    out = extract(html);
  }
  log.info("hubScrape done", { hubUrl, posts: out.posts.length, authors: out.authors.length });
  return { ...out, ok: !!html };
}
