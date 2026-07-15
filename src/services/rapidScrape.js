// Post-engager scraping via the RapidAPI LinkedIn scraper (fresh-linkedin-profile-data by
// default, so its $10/500 credits get drained first). 1 credit per PAGE (~48 people), NOT per
// person — far cheaper than Trigify's per-engager billing.
//
// Endpoints: get-post-reactions (likers) + get-post-comments (commenters). A 402/403/429 flips
// outOfCredits so the run STOPS (no auto-switch to another host — the user drains fresh, then
// deliberately turns on web-scraping-api2).

import axios from "axios";
import { config } from "../config.js";
import { meter } from "./apiMeter.js";
import { log } from "../lib/logger.js";

let outOfCredits = false;
const stats = { reactionPages: 0, commentPages: 0, engagers: 0 };
export function rapidScrapeStats() { return { ...stats, outOfCredits, host: config.scrapeApiHost }; }
export function rapidScrapeOutOfCredits() { return outOfCredits; }
export function resetRapidScrape() { outOfCredits = false; stats.reactionPages = 0; stats.commentPages = 0; stats.engagers = 0; }

// activity id out of any post URL / urn
export function activityUrn(postUrl = "") {
  const m = String(postUrl).match(/activity[-:](\d{15,25})/);
  return m ? m[1] : null;
}

async function get(path, params) {
  if (!config.linkedinApiKey || outOfCredits) return null;
  const r = await axios.get(`https://${config.scrapeApiHost}/${path}`, {
    params, headers: { "x-rapidapi-host": config.scrapeApiHost, "x-rapidapi-key": config.linkedinApiKey },
    timeout: 45000, validateStatus: () => true,
  });
  if (r.status === 402 || r.status === 403 || r.status === 429) {
    outOfCredits = true;
    log.warn("rapid scrape host out of credits — stopping (no auto-switch)", { host: config.scrapeApiHost, status: r.status });
    return null;
  }
  if (r.status !== 200) { log.warn("rapid scrape non-200", { path, status: r.status }); return null; }
  return r.data;
}

// Everyone who reacted to a post -> engager objects. Pages until empty / total reached.
async function reactions(urn, maxPages = 60) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await get("get-post-reactions", { urn, type: "ALL", page });
    if (d === null) break;
    const items = d?.data || [];
    stats.reactionPages++; meter.inc("rapid_pages");
    for (const it of items) {
      const r = it.reactor || it;
      if (r?.name || r?.linkedin_url) out.push({ name: r.name || "", linkedin_url: r.linkedin_url || r.urn || "", headline: r.headline || "", engagement_type: "like" });
    }
    const total = d?.total || 0;
    if (!items.length || (total && page * items.length >= total)) break;
  }
  return out;
}

// Everyone who commented -> engager objects.
async function comments(urn, maxPages = 40) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await get("get-post-comments", { urn, page });
    if (d === null) break;
    const items = d?.data || d?.comments || [];
    stats.commentPages++; meter.inc("rapid_pages");
    for (const it of items) {
      const a = it.commenter || it.author || it;
      const name = a?.name || a?.full_name || "";
      const url = a?.linkedin_url || a?.profile_url || a?.urn || "";
      if (name || url) out.push({ name, linkedin_url: url, headline: a?.headline || a?.title || "", engagement_type: "comment", comment_text: it.text || it.comment || "" });
    }
    const total = d?.total || 0;
    if (!items.length || (total && page * items.length >= total)) break;
  }
  return out;
}

// All reactors + commenters for a post. -> [{name, linkedin_url, headline, engagement_type}]
export async function scrapePostEngagers(postUrl) {
  const urn = activityUrn(postUrl);
  if (!urn) return { engagers: [], error: "no activity id in url" };
  const engagers = [...(await reactions(urn)), ...(await comments(urn))];
  stats.engagers += engagers.length; meter.inc("rapid_engagers", engagers.length);
  return { engagers, outOfCredits };
}
