// Resolve a LinkedIn post URL to its ACTIVITY urn — free, via the proxy pool we already run.
//
// Why this exists: LinkedIn's share button emits ".../posts/x_slug-share-7430459358192369664-lwwr".
// That number is a urn:li:share id, NOT the activity id the comment API needs. Verified on a real
// post: share 7430459358192369664 -> activity 7434175678457081857. Completely different numbers, so
// the ids cannot be used interchangeably — and because they share a numeric space, passing a share
// id off as an activity id can silently land on an UNRELATED post and scrape its commenters into
// yours. That is why this does a real lookup rather than a regex.
//
// Nothing we buy resolves it: PND's get-post rejects the share id and the raw URL, the fresh API
// answers "Wrong post url provided", Trigify is out of credits. The public post page HTML does
// carry urn:li:activity though, and we already proxy LinkedIn HTML for hub pages — so this costs
// no credits at all. Cached permanently on the post: a post's urn never changes.

import axios from "axios";
import { nextWorkingAgent } from "../lib/proxies.js";
import { scrapedPosts } from "../db/mongo.js";
import { activityUrn } from "./rapidScrape.js";
import { log } from "../lib/logger.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export async function resolveActivityUrn(postUrl) {
  if (!postUrl) return null;
  const direct = activityUrn(postUrl); // already an activity URL — free and certain
  if (direct) return direct;

  const cached = await scrapedPosts().findOne({ postUrl }, { projection: { activity_urn: 1 } }).catch(() => null);
  if (cached?.activity_urn) return cached.activity_urn;

  for (let attempt = 0; attempt < 3; attempt++) {
    const agent = await nextWorkingAgent();
    if (!agent) break; // no proxy available — caller decides what to do about it
    try {
      const r = await axios.get(postUrl, {
        httpsAgent: agent, proxy: false, headers: { "User-Agent": UA },
        timeout: 25000, maxRedirects: 5, validateStatus: () => true,
      });
      const html = typeof r.data === "string" ? r.data : "";
      const m = html.match(/urn:li:activity:(\d{15,25})/);
      if (m) {
        await scrapedPosts().updateOne({ postUrl }, { $set: { activity_urn: m[1] } }).catch(() => {});
        log.info("resolved share-link to its activity urn", { postUrl, urn: m[1] });
        return m[1];
      }
      // A 200 with no activity urn is a login wall, not a missing post — worth retrying on another IP.
      log.warn("post page had no activity urn", { status: r.status, bytes: html.length, attempt });
    } catch (e) {
      log.warn("post urn resolve attempt failed", { err: e.message, attempt });
    }
  }
  return null;
}
