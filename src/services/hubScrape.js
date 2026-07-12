// Scrape a public LinkedIn "top-content" hub page through the proxy pool and pull out the
// individual post URLs + author /in/ profile links. Post URLs feed the pipeline directly;
// authors are harvested as influencer sources (robust even when post extraction is thin).

import axios from "axios";
import { nextWorkingAgent } from "../lib/proxies.js";
import { log } from "../lib/logger.js";

export async function hubScrape(hubUrl) {
  const agent = await nextWorkingAgent();
  const cfg = {
    timeout: 25000, validateStatus: () => true,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" },
  };
  if (agent) { cfg.httpsAgent = agent; cfg.proxy = false; }

  let html = "";
  try {
    const r = await axios.get(hubUrl, cfg);
    html = typeof r.data === "string" ? r.data : JSON.stringify(r.data || "");
  } catch (e) {
    log.warn("hubScrape threw", { err: e.message });
  }

  const posts = [...new Set(html.match(/https:\/\/www\.linkedin\.com\/(?:posts\/[^"'\s\\)]+|feed\/update\/urn:li:activity:\d+)/g) || [])]
    .map((u) => u.replace(/[",]+$/, ""));
  const authors = [...new Set(html.match(/https:\/\/www\.linkedin\.com\/in\/[a-zA-Z0-9\-_%]{3,}/g) || [])]
    .filter((u) => !/\/in\/ACoAA/i.test(u));

  return { posts, authors, ok: !!html };
}
