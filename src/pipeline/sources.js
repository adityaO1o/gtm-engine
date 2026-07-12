// Sources orchestrator: scrape influencer posts + hub pages, classify each post by topic,
// route its engagers into the Influencer/Hub SendKit campaigns with the classified category.

import { sources, processedPosts } from "../db/mongo.js";
import { getProfilePosts, getPostEngagements, getPostComments } from "../services/trigifyScrape.js";
import { hubScrape } from "../services/hubScrape.js";
import { classifyPost } from "../services/classify.js";
import { SOURCE_CAMPAIGN } from "../services/campaigns.js";
import { enrichLead } from "./enrichLead.js";
import { log } from "../lib/logger.js";

const POSTS_PER_INFLUENCER = 8;   // credit control
const MAX_POSTS_PER_RUN = 120;    // enough to cover ~14 influencers x 8 posts + a hub in one sweep
const MAX_HARVEST_AUTHORS = 20;

let running = false;
let status = { running: false, phase: "idle", postsProcessed: 0, engagers: 0, newlyFound: 0, startedAt: null, finishedAt: null };
export function sourcesStatus() { return status; }

// classify from post text, falling back to the URL slug (LinkedIn slugs carry keywords)
function classifyFrom(text, postUrl) {
  const slug = decodeURIComponent(postUrl || "").replace(/^.*\/posts\//, "").replace(/[-/_]+/g, " ");
  return classifyPost(text && text.length > 20 ? text : slug);
}

async function processPost(postUrl, text, sourceType) {
  if (!postUrl) return;
  if (await processedPosts().findOne({ postUrl })) return;
  await processedPosts().insertOne({ postUrl, at: new Date() });

  const category = classifyFrom(text, postUrl);
  const sc = SOURCE_CAMPAIGN[sourceType];
  const engagers = [...(await getPostEngagements(postUrl)), ...(await getPostComments(postUrl))];
  for (const e of engagers) {
    try {
      const r = await enrichLead({ ...e, campaign: sc.key, campaign_id: sc.sendkitId, category, source: sourceType, post_url: postUrl });
      status.engagers++;
      if (r?.outcome === "sent") status.newlyFound++;
    } catch (err) { log.warn("source enrich failed", { err: err.message }); }
  }
  status.postsProcessed++;
}

export async function runSources() {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  status = { running: true, phase: "starting", postsProcessed: 0, engagers: 0, newlyFound: 0, startedAt: new Date(), finishedAt: null };
  try {
    const queue = []; // { postUrl, text, source }

    // Hubs first — they may harvest brand-new influencer profiles into the collection.
    const hubs = await sources().find({ type: "hub", active: { $ne: false } }).toArray();
    for (const s of hubs) {
      status.phase = "hub:" + (s.label || s.url);
      const { posts, authors } = await hubScrape(s.url);
      posts.forEach((p) => queue.push({ postUrl: p, text: "", source: "hub" }));
      for (const a of authors.slice(0, MAX_HARVEST_AUTHORS)) {
        await sources().updateOne({ url: a },
          { $setOnInsert: { url: a, type: "influencer", label: (a.split("/in/")[1] || "").replace(/\/$/, ""), active: true, harvestedFrom: s.url, addedAt: new Date() } },
          { upsert: true });
      }
      await sources().updateOne({ _id: s._id }, { $set: { lastRun: new Date() } });
    }

    // Re-query influencers AFTER harvest so the ones the hub just added (and any the user
    // added while a run was starting) are covered in this same sweep — not left "never".
    const infls = await sources().find({ type: "influencer", active: { $ne: false } }).toArray();
    for (const s of infls) {
      status.phase = "influencer:" + (s.label || s.url);
      const posts = await getProfilePosts(s.url);
      posts.slice(0, POSTS_PER_INFLUENCER).forEach((p) => queue.push({ postUrl: p.postUrl, text: p.text, source: "influencer" }));
      await sources().updateOne({ _id: s._id }, { $set: { lastRun: new Date(), lastPosts: posts.length } });
    }

    status.phase = "processing";
    for (const p of queue.slice(0, MAX_POSTS_PER_RUN)) {
      await processPost(p.postUrl, p.text, p.source);
    }
  } catch (e) {
    log.error("runSources error", { err: e.message });
  }
  status = { ...status, running: false, phase: "done", finishedAt: new Date() };
  running = false;
  log.info("sources run done", { posts: status.postsProcessed, engagers: status.engagers, sent: status.newlyFound });
  return { postsProcessed: status.postsProcessed, engagers: status.engagers, newlyFound: status.newlyFound };
}
