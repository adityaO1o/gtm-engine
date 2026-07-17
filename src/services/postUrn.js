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

  // The id in the URL, so we can prove the page we got back is actually THIS post.
  const urlId = (String(postUrl).match(/-(?:share|ugcPost)-(\d{15,25})/) || [])[1] || null;

  for (let attempt = 0; attempt < 3; attempt++) {
    // nextWorkingAgent returns {agent, proxyUrl} and THROWS when the pool is dry — it never
    // returns null. Passing the wrapper straight to httpsAgent silently breaks every request.
    let agent;
    try { ({ agent } = await nextWorkingAgent()); }
    catch (e) { log.warn("no working proxy to resolve post urn", { err: e.message }); break; }

    try {
      const r = await axios.get(postUrl, {
        httpsAgent: agent, proxy: false, headers: { "User-Agent": UA },
        timeout: 25000, maxRedirects: 5, validateStatus: () => true,
      });
      const html = typeof r.data === "string" ? r.data : "";

      // Guard: the page must carry the SAME share/ugcPost id the URL asked for. Without this a
      // redirect (login wall, "post unavailable", a feed) could hand us some other post's activity
      // urn, and we'd scrape a stranger's commenters into this post — the exact failure mode that
      // made the naive regex dangerous. Verified round-trip on a real post: page ugcPost
      // 7481005455813709825 -> activity 7482426125793722368, whose shareUrn is that same ugcPost.
      const pageId = (html.match(/urn:li:(?:share|ugcPost):(\d{15,25})/) || [])[1] || null;
      if (urlId && pageId && urlId !== pageId) {
        log.warn("post page is not the post we asked for — ignoring", { postUrl, urlId, pageId });
        continue;
      }

      const m = html.match(/urn:li:activity:(\d{15,25})/);
      if (m) {
        await scrapedPosts().updateOne({ postUrl }, { $set: { activity_urn: m[1] } }).catch(() => {});
        log.info("resolved post URL to its activity urn", { postUrl, urn: m[1] });
        return m[1];
      }
      // A 200 with no activity urn is a login wall, not a missing post — retry on another IP.
      log.warn("post page had no activity urn", { status: r.status, bytes: html.length, attempt });
    } catch (e) {
      log.warn("post urn resolve attempt failed", { err: e.message, attempt });
    }
  }
  return null;
}
