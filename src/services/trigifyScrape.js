// Engine-side Trigify scraping (the engine holds TRIGIFY_KEY). These REST endpoints use
// camelCase bodies and a curl User-Agent (Cloudflare blocks the default axios UA).

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const BASE = "https://api.trigify.io/v1";
const H = () => ({ "x-api-key": config.trigifyKey, "Content-Type": "application/json", "User-Agent": "curl/8.4.0", Accept: "*/*" });

async function postJson(path, body) {
  try {
    const r = await axios.post(BASE + path, body, { headers: H(), timeout: 45000, validateStatus: () => true });
    if (r.status === 200 && r.data?.success !== false) return r.data;
    log.warn("trigify scrape non-200", { path, status: r.status });
    return null;
  } catch (e) {
    log.warn("trigify scrape threw", { path, err: e.message });
    return null;
  }
}

// activity id out of a post URL (…activity-7481414449061449728 or …activity:…)
export function postUrn(postUrl = "") {
  const m = (postUrl || "").match(/activity[-:](\d{15,25})/);
  return m ? m[1] : null;
}

// A person's recent posts -> [{ postUrl, text, likes, comments }]
export async function getProfilePosts(profileUrl) {
  const d = await postJson("/profile/posts", { profileUrl });
  const items = d?.data || [];
  return items.map((p) => ({
    postUrl: p.postUrl || p.shareUrl || p.url || "",
    text: p.text || "",
    likes: p.numLikes || p.likes || 0,
    comments: p.numComments || p.comments || 0,
  })).filter((p) => p.postUrl);
}

// Everyone who LIKED a post -> engager objects (fullName, profileUrl, headline, urn)
export async function getPostEngagements(postUrl) {
  const d = await postJson("/post/engagements", { postUrl });
  return (d?.data?.items || []).map((e) => ({
    name: e.fullName || "",
    linkedin_url: e.profileUrl || e.url || "",
    headline: e.headline || "",
    engagement_type: "like",
  }));
}

// Everyone who COMMENTED -> engager objects (needs the numeric urn)
export async function getPostComments(postUrl) {
  const urn = postUrn(postUrl);
  if (!urn) return [];
  const d = await postJson("/post/comments", { postUrn: urn });
  return (d?.data?.comments || []).map((c) => ({
    name: c.author?.name || "",
    linkedin_url: c.author?.linkedinUrl || "",
    headline: c.author?.title || c.author?.headline || "",
    engagement_type: "comment",
    comment_text: c.text || "",
  })).filter((c) => c.linkedin_url || c.name);
}
