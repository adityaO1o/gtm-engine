// Engine-side Trigify scraping (the engine holds TRIGIFY_KEY). These REST endpoints use
// camelCase bodies and a curl User-Agent (Cloudflare blocks the default axios UA).

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const BASE = "https://api.trigify.io/v1";
const H = () => ({ "x-api-key": config.trigifyKey, "Content-Type": "application/json", "User-Agent": "curl/8.4.0", Accept: "*/*" });

// Set once Trigify reports no credits, so callers can stop marking posts "processed" (a post
// marked done with 0 engagers because credits ran out would never be re-scraped after top-up).
export let trigifyOutOfCredits = false;
export function trigifyStatus() { return { outOfCredits: trigifyOutOfCredits }; }

class TrigifyError extends Error {}

async function postJson(path, body) {
  const r = await axios.post(BASE + path, body, { headers: H(), timeout: 45000, validateStatus: () => true });
  if (r.status === 200 && r.data?.success !== false) return r.data;
  // out of credits — flip the flag and throw so the run stops cleanly instead of silently
  // marking thousands of posts done with no engagers.
  const msg = JSON.stringify(r.data || {}).toLowerCase();
  if (r.status === 402 || /credit|insufficient|quota|payment/.test(msg)) {
    trigifyOutOfCredits = true;
    log.warn("trigify out of credits", { path, status: r.status });
  } else {
    log.warn("trigify scrape non-200", { path, status: r.status });
  }
  throw new TrigifyError(`trigify ${path} -> ${r.status}`);
}

// activity id out of a post URL (…activity-7481414449061449728 or …activity:…)
export function postUrn(postUrl = "") {
  const m = (postUrl || "").match(/activity[-:](\d{15,25})/);
  return m ? m[1] : null;
}

const mapPost = (p) => ({
  postUrl: p.postUrl || p.shareUrl || p.url || "",
  text: p.text || "",
  likes: p.numLikes || p.likes || p.totalReactionCount || 0,
  comments: p.numComments || p.comments || p.commentCount || 0,
});

// A person's posts. Trigify pages ~47/page (0-based) with no total in the body, so we page
// until an empty page or `maxPages`. maxPages is a runaway guard, not a business cap — set it
// high (a prolific poster still finishes; a mega-account won't loop forever).
export async function getProfilePosts(profileUrl, { maxPages = 30 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    let d;
    try { d = await postJson("/profile/posts", { profileUrl, page }); }
    catch (e) { if (page === 0) throw e; break; } // first page failed = real error; later = just stop
    const items = (d?.data || []).map(mapPost).filter((p) => p.postUrl);
    if (!items.length) break;
    out.push(...items);
  }
  return out;
}

// Everyone who LIKED/reacted to a post. Response carries total + totalPages, so we fetch them
// all (a viral post can run to dozens of pages). maxPages caps a runaway mega-post.
export async function getPostEngagements(postUrl, { maxPages = 60 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    let d;
    try { d = await postJson("/post/engagements", { postUrl, page }); }
    catch (e) { if (page === 1) throw e; break; }
    const items = d?.data?.items || [];
    for (const e of items) {
      out.push({ name: e.fullName || "", linkedin_url: e.profileUrl || e.url || "", headline: e.headline || "", engagement_type: "like" });
    }
    const totalPages = d?.totalPages || d?.data?.totalPages || 1;
    if (!items.length || page >= totalPages) break;
  }
  return out;
}

// Everyone who COMMENTED (needs the numeric urn). Paged the same way.
export async function getPostComments(postUrl, { maxPages = 40 } = {}) {
  const urn = postUrn(postUrl);
  if (!urn) return [];
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    let d;
    try { d = await postJson("/post/comments", { postUrn: urn, page }); }
    catch (e) { if (page === 1) throw e; break; }
    const items = d?.data?.comments || [];
    for (const c of items) {
      const row = {
        name: c.author?.name || "",
        linkedin_url: c.author?.linkedinUrl || "",
        headline: c.author?.title || c.author?.headline || "",
        engagement_type: "comment",
        comment_text: c.text || "",
      };
      if (row.linkedin_url || row.name) out.push(row);
    }
    const totalPages = d?.totalPages || d?.data?.totalPages || 1;
    if (!items.length || page >= totalPages) break;
  }
  return out;
}
