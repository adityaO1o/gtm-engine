// Sources orchestrator: scrape influencer posts + hub pages, classify each post by topic,
// route its engagers into the Influencer/Hub SendKit campaigns with the classified category.

import { sources, processedPosts } from "../db/mongo.js";
import { getProfilePosts, getPostEngagements, getPostComments, trigifyOutOfCredits } from "../services/trigifyScrape.js";
import { hubScrape } from "../services/hubScrape.js";
import { classifyPost } from "../services/classify.js";
import { routeSourceEngager } from "../services/campaigns.js";
import { scrapePostEngagers, rapidScrapeOutOfCredits } from "../services/rapidScrape.js";
import { enrichLead } from "./enrichLead.js";
import { meterFlush } from "../services/apiMeter.js";
import { log } from "../lib/logger.js";

// Master switch for AUTO scraping (the daily influencer/hub sweep). Paused by default while we
// evaluate the RapidAPI post-scraper on the $10 plan — the manual "Scrape via post" still works.
let autoPaused = true;
export function setAutoScrape(paused) { autoPaused = !!paused; return autoPaused; }
export function isAutoScrapePaused() { return autoPaused; }

// No business cap on posts/engagers — the user tops up Trigify to scrape unlimited. These are
// per-RUN batch sizes purely for durability: a run finishes in bounded time and persists its
// progress (processed_posts dedup + per-influencer lastRun), so a container restart resumes
// instead of losing everything. The scheduler fires often and grinds through the backlog.
const MAX_POSTS_PER_RUN = 1200;       // process up to this many NEW posts per run, then stop
const MAX_INFLUENCERS_PER_RUN = 400;  // list posts for up to this many profiles per run
const MAX_HARVEST_AUTHORS = 20;

let running = false;
let status = { running: false, phase: "idle", postsProcessed: 0, totalPosts: 0, engagers: 0, uniqueEngagers: 0, newlyFound: 0, influencersDone: 0, startedAt: null, finishedAt: null };
export function sourcesStatus() { return status; }

// Same person often engages with several posts — count them ONCE for the unique tally.
let seenEngagers = new Set();

// The text we classify + route on: the post body, or the URL slug when the body is thin
// (hub posts arrive as just a URL; LinkedIn slugs carry the keywords).
function routeText(text, postUrl) {
  const slug = decodeURIComponent(postUrl || "").replace(/^.*\/posts\//, "").replace(/[-/_]+/g, " ");
  return text && text.length > 20 ? text : slug;
}

// Scrape one post's engagers + commenters and route each through the pipeline.
// Returns "done" | "skip" (already processed) | "error" (Trigify fetch failed — NOT marked
// processed, so it will be retried after a credit top-up).
async function processPost(postUrl, text, sourceType, sourceList) {
  if (!postUrl) return "skip";
  if (await processedPosts().findOne({ postUrl })) return "skip";

  // Fetch FIRST. Only mark the post processed once we actually got its engagers — otherwise a
  // credit-exhausted fetch would permanently skip a post we never really scraped.
  let engagers;
  try {
    engagers = [...(await getPostEngagements(postUrl)), ...(await getPostComments(postUrl))];
  } catch (e) {
    return "error";
  }
  await processedPosts().insertOne({ postUrl, at: new Date() });

  // Classify the post, then route its engagers to the campaign whose EMAIL fits the topic
  // (infra post -> Infrastructure email, Smartlead post -> Smartlead email, etc.).
  const rt = routeText(text, postUrl);
  const category = classifyPost(rt);
  const camp = routeSourceEngager(rt, category);
  for (const e of engagers) {
    try {
      const r = await enrichLead({ ...e, campaign: camp.key, campaign_id: camp.sendkitId, category, source: sourceType, source_list: sourceList, post_url: postUrl });
      status.engagers++;
      const id = (e.linkedin_url || e.name || "").toLowerCase();
      if (id && !seenEngagers.has(id)) { seenEngagers.add(id); status.uniqueEngagers++; }
      if (r?.outcome === "sent") status.newlyFound++;
    } catch (err) { log.warn("source enrich failed", { err: err.message }); }
  }
  status.postsProcessed++;
  return "done";
}

// Scrape ONE specific post's engagers (all pages) into a chosen campaign — for a high-value
// post you want fully harvested (e.g. a 5k-impression Instantly post -> Instantly campaign).
let scrapeOneRunning = false;
let scrapeOneStatus = { running: false, postUrl: "", campaign: "", engagers: 0, sent: 0, startedAt: null, finishedAt: null };
export function scrapePostStatus() { return scrapeOneStatus; }

// Scrape ONE post's engagers via the RapidAPI scraper (fresh host — 1 credit/page), classify the
// post, and route each engager to the topic campaign. This is the "Scrape via post" feature.
export async function scrapeOnePost({ postUrl, campaignKey = "" }) {
  const { routeSourceEngager } = await import("../services/campaigns.js");
  if (!postUrl) return { ok: false, error: "postUrl required" };
  if (scrapeOneRunning) return { ok: false, error: "already running", ...scrapeOneStatus };
  scrapeOneRunning = true;
  scrapeOneStatus = { running: true, postUrl, campaign: "", engagers: 0, sent: 0, outOfCredits: false, startedAt: new Date(), finishedAt: null };
  (async () => {
    try {
      const { engagers, error } = await scrapePostEngagers(postUrl);
      if (error) log.warn("scrapeOnePost", { error });
      // classify the post from its slug (no text here) and route accordingly; if the caller
      // forced a campaign (e.g. the Instantly post), honour it.
      const rt = routeText("", postUrl);
      const category = classifyPost(rt);
      const forced = campaignKey ? (await import("../services/campaigns.js")).campaignByKey(campaignKey) : null;
      const camp = forced || routeSourceEngager(rt, category);
      scrapeOneStatus.campaign = camp.label;
      for (const e of engagers) {
        try {
          const r = await enrichLead({ ...e, campaign: camp.key, campaign_id: camp.sendkitId, category, source: "influencer", source_list: "manual-post", post_url: postUrl });
          scrapeOneStatus.engagers++;
          if (r?.outcome === "sent") scrapeOneStatus.sent++;
        } catch (err) { log.warn("scrapeOnePost enrich failed", { err: err.message }); }
      }
      scrapeOneStatus.outOfCredits = rapidScrapeOutOfCredits();
    } catch (e) { log.error("scrapeOnePost error", { err: e.message }); }
    await meterFlush(); // persist Fresh/web-scrape/resolver consumption this scrape spent
    scrapeOneStatus = { ...scrapeOneStatus, running: false, finishedAt: new Date() };
    scrapeOneRunning = false;
    log.info("scrapeOnePost done", { postUrl, engagers: scrapeOneStatus.engagers, sent: scrapeOneStatus.sent });
  })();
  return { ok: true, started: true };
}

export async function runSources({ force = false } = {}) {
  if (autoPaused && !force) return { paused: true, ...status };
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  seenEngagers = new Set();
  status = { running: true, phase: "starting", postsProcessed: 0, totalPosts: 0, engagers: 0, uniqueEngagers: 0, newlyFound: 0, influencersDone: 0, startedAt: new Date(), finishedAt: null };
  try {
    // Hubs first — they may harvest brand-new influencer profiles into the collection.
    const hubs = await sources().find({ type: "hub", active: { $ne: false } }).toArray();
    for (const s of hubs) {
      status.phase = "hub:" + (s.label || s.url);
      const { posts, authors } = await hubScrape(s.url);
      for (const a of authors.slice(0, MAX_HARVEST_AUTHORS)) {
        await sources().updateOne({ url: a },
          { $setOnInsert: { url: a, type: "influencer", label: (a.split("/in/")[1] || "").replace(/\/$/, ""), active: true, harvestedFrom: s.url, addedAt: new Date() } },
          { upsert: true });
      }
      for (const p of posts) {
        if (status.postsProcessed >= MAX_POSTS_PER_RUN) break;
        await processPost(p, "", "hub", s.label || s.url);
      }
      await sources().updateOne({ _id: s._id }, { $set: { lastRun: new Date() } });
    }

    // Influencers, LEAST-RECENTLY-SCRAPED FIRST (nulls first). We process each profile fully
    // before moving on and persist lastRun immediately, so across many runs the scheduler
    // cycles through the entire ~5k backlog fairly and a restart never redoes finished work.
    status.phase = "processing";
    const infls = await sources().find({ type: "influencer", active: { $ne: false } })
      .sort({ lastRun: 1 }).limit(MAX_INFLUENCERS_PER_RUN).toArray();

    for (const s of infls) {
      if (status.postsProcessed >= MAX_POSTS_PER_RUN || trigifyOutOfCredits) break;
      status.phase = "influencer:" + (s.label || s.url);
      // where this influencer came from — the CSV list(s), or their own label if hand-added
      const sourceList = s.lists?.length ? s.lists.join(", ") : (s.harvestedFrom ? "harvested" : (s.label || "influencer"));
      let posts = [];
      try { posts = await getProfilePosts(s.url); }
      catch (e) { if (trigifyOutOfCredits) break; log.warn("profile posts failed", { url: s.url, err: e.message }); continue; }
      for (const p of posts) {
        if (status.postsProcessed >= MAX_POSTS_PER_RUN) break;
        const r = await processPost(p.postUrl, p.text, "influencer", sourceList);
        if (r === "error" && trigifyOutOfCredits) break; // credits gone — stop, leave rest un-marked
      }
      // Only mark this profile fully scraped if we didn't stop early on a credit outage.
      if (!trigifyOutOfCredits) await sources().updateOne({ _id: s._id }, { $set: { lastRun: new Date(), lastPosts: posts.length } });
      status.influencersDone++;
    }
    status.totalPosts = status.postsProcessed; // bounded run — denominator == what we did
    if (trigifyOutOfCredits) { status.phase = "stopped: trigify out of credits"; log.warn("sources run stopped — trigify out of credits"); }
  } catch (e) {
    log.error("runSources error", { err: e.message });
  }
  status = { ...status, running: false, phase: "done", finishedAt: new Date() };
  running = false;
  await meterFlush(); // persist the API consumption this run spent
  log.info("sources run done", { posts: status.postsProcessed, engagers: status.engagers, sent: status.newlyFound, influencers: status.influencersDone });
  return { postsProcessed: status.postsProcessed, engagers: status.engagers, newlyFound: status.newlyFound };
}
