// Sources orchestrator: scrape influencer posts + hub pages, classify each post by topic,
// route its engagers into the Influencer/Hub SendKit campaigns with the classified category.

import { sources, processedPosts, scrapedPosts, scrapeEngagers } from "../db/mongo.js";
import { getProfilePosts, getPostEngagements, getPostComments, trigifyOutOfCredits } from "../services/trigifyScrape.js";
import { hubScrape } from "../services/hubScrape.js";
import { classifyPost } from "../services/classify.js";
import { routeSourceEngager } from "../services/campaigns.js";
import { rapidScrapeOutOfCredits, activityUrn, postDetails, REACTION_TYPES, reactionPage, commentPage } from "../services/rapidScrape.js";
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

// ── "Scrape via post": RESUMABLE · PAUSABLE · INCREMENTAL ─────────────────────────────────────
// Two durable phases, both survive restarts/pauses (state lives in Mongo, not memory):
//   PHASE 1 "scraping"  — page every reaction TYPE + comments into the scrape_engagers queue,
//                         checkpointing per page (scrape_cp) so we resume from the exact spot.
//   PHASE 2 "enriching" — drain the queue (enriched:false) through enrichLead. Leads appear AS
//                         THIS RUNS (incremental); a restart continues where it left off.
// Pause stops cleanly after the current page/lead; resume = call scrapeOnePost again (same URL).
let scrapeOneRunning = false;
let scrapeCtl = { postUrl: "", paused: false };
let scrapeOneStatus = { running: false, phase: "idle", postUrl: "", campaign: "", total: 0, enriched: 0, sent: 0, paused: false, outOfCredits: false, startedAt: null, finishedAt: null };
export function scrapePostStatus() { return scrapeOneStatus; }

// Ask the running job to pause. It checkpoints and stops after the current page/lead.
export function pauseScrapePost() {
  scrapeCtl.paused = true; scrapeOneStatus.paused = true;
  if (scrapeCtl.postUrl) scrapedPosts().updateOne({ postUrl: scrapeCtl.postUrl }, { $set: { paused: true } }).catch(() => {});
  return { paused: true, postUrl: scrapeCtl.postUrl };
}

const ekeyOf = (e) => (e.linkedin_url || e.name || "").toLowerCase();
async function queueUpsert(postUrl, engagers) {
  const ops = [];
  for (const e of engagers) {
    const ekey = ekeyOf(e);
    if (!ekey) continue;
    ops.push({ updateOne: { filter: { postUrl, ekey }, update: { $setOnInsert: {
      postUrl, ekey, name: e.name || "", linkedin_url: e.linkedin_url || "", headline: e.headline || "",
      engagement_type: e.engagement_type || "like", comment_text: e.comment_text || "", enriched: false, at: new Date(),
    } }, upsert: true } });
  }
  if (ops.length) await scrapeEngagers().bulkWrite(ops, { ordered: false }).catch((e) => log.warn("scrape queue upsert failed", { err: e.message }));
}
const saveCp = (postUrl, cp) => scrapedPosts().updateOne({ postUrl }, { $set: { scrape_cp: cp } }).catch(() => {});

// PHASE 1 — scrape into the queue, resuming from the saved checkpoint. -> "done" | "paused" | "stopped"
async function scrapeToQueue(postUrl) {
  const urn = activityUrn(postUrl);
  const rec = (await scrapedPosts().findOne({ postUrl })) || {};
  const cp = rec.scrape_cp || { typeIdx: 0, page: 1, token: null, commentsDone: false };

  for (let ti = cp.typeIdx; ti < REACTION_TYPES.length; ti++) {
    let page = ti === cp.typeIdx ? (cp.page || 1) : 1;
    let collected = 0, total = Infinity;
    for (; page <= 250; page++) {
      if (scrapeCtl.paused) { await saveCp(postUrl, { typeIdx: ti, page, token: null, commentsDone: false }); return "paused"; }
      const r = await reactionPage(urn, REACTION_TYPES[ti], page);
      if (r === null) { await saveCp(postUrl, { typeIdx: ti, page, token: null, commentsDone: false }); return "stopped"; }
      await queueUpsert(postUrl, r.engagers);
      collected += r.count;
      if (typeof r.total === "number") total = r.total;
      await saveCp(postUrl, { typeIdx: ti, page: page + 1, token: null, commentsDone: false });
      scrapeOneStatus.total = await scrapeEngagers().countDocuments({ postUrl });
      if (!r.count || collected >= total) break;
    }
  }
  // comments (token-paginated). typeIdx === REACTION_TYPES.length marks "reactions done".
  if (!cp.commentsDone) {
    let token = cp.typeIdx >= REACTION_TYPES.length ? (cp.token || null) : null;
    for (let i = 0; i < 400; i++) {
      if (scrapeCtl.paused) { await saveCp(postUrl, { typeIdx: REACTION_TYPES.length, page: 1, token, commentsDone: false }); return "paused"; }
      const r = await commentPage(urn, token);
      if (r === null) { await saveCp(postUrl, { typeIdx: REACTION_TYPES.length, page: 1, token, commentsDone: false }); return "stopped"; }
      await queueUpsert(postUrl, r.engagers);
      token = r.token;
      await saveCp(postUrl, { typeIdx: REACTION_TYPES.length, page: 1, token, commentsDone: !token || !r.count });
      scrapeOneStatus.total = await scrapeEngagers().countDocuments({ postUrl });
      if (!token || !r.count) break;
    }
  }
  return "done";
}

// PHASE 2 — drain the queue through enrichLead. Incremental + resumable (only enriched:false) + pausable.
async function enrichFromQueue(postUrl, camp, category) {
  while (true) {
    if (scrapeCtl.paused) return "paused";
    const batch = await scrapeEngagers().find({ postUrl, enriched: { $ne: true } }).limit(25).toArray();
    if (!batch.length) return "done";
    for (const e of batch) {
      if (scrapeCtl.paused) return "paused";
      let outcome = null;
      try {
        const r = await enrichLead({ name: e.name, linkedin_url: e.linkedin_url, headline: e.headline, engagement_type: e.engagement_type, comment_text: e.comment_text, campaign: camp.key, campaign_id: camp.sendkitId, category, source: "influencer", source_list: "manual-post", post_url: postUrl });
        outcome = r?.outcome || null;
        if (outcome === "sent") scrapeOneStatus.sent++;
      } catch (err) { outcome = "error"; log.warn("scrape enrich failed", { err: err.message }); }
      await scrapeEngagers().updateOne({ _id: e._id }, { $set: { enriched: true, outcome, enriched_at: new Date() } });
      scrapeOneStatus.enriched++;
    }
    await scrapedPosts().updateOne({ postUrl }, { $set: { enriched_count: scrapeOneStatus.enriched, sent: scrapeOneStatus.sent } });
    await meterFlush();
  }
}

async function finalizeScrape(postUrl, phase) {
  await meterFlush();
  const paused = phase === "paused";
  scrapeOneStatus = { ...scrapeOneStatus, running: false, phase, paused, finishedAt: new Date() };
  await scrapedPosts().updateOne({ postUrl }, { $set: {
    running: false, phase, paused, enriched_count: scrapeOneStatus.enriched, sent: scrapeOneStatus.sent,
    out_of_credits: rapidScrapeOutOfCredits(), finishedAt: new Date(),
  } }).catch(() => {});
  scrapeOneRunning = false;
  scrapeCtl.paused = false;
  log.info("scrapeOnePost " + phase, { postUrl, enriched: scrapeOneStatus.enriched, sent: scrapeOneStatus.sent });
}

// Start a NEW scrape, or RESUME a paused/interrupted one for the same postUrl.
export async function scrapeOnePost({ postUrl, campaignKey = "" }) {
  const { routeSourceEngager, campaignByKey } = await import("../services/campaigns.js");
  if (!postUrl) return { ok: false, error: "postUrl required" };
  if (scrapeOneRunning) return { ok: false, error: "already running", ...scrapeOneStatus };
  scrapeOneRunning = true;
  scrapeCtl = { postUrl, paused: false };

  (async () => {
    try {
      const rec = (await scrapedPosts().findOne({ postUrl })) || {};
      const rt = routeText("", postUrl);
      const category = rec.category || classifyPost(rt);
      const forced = campaignKey ? campaignByKey(campaignKey) : (rec.campaign_key ? campaignByKey(rec.campaign_key) : null);
      const camp = forced || routeSourceEngager(rt, category);

      const enrichedSoFar = await scrapeEngagers().countDocuments({ postUrl, enriched: true });
      scrapeOneStatus = {
        running: true, phase: rec.scrape_done ? "enriching" : "scraping", postUrl, campaign: camp.label,
        total: await scrapeEngagers().countDocuments({ postUrl }), enriched: enrichedSoFar, sent: rec.sent || 0,
        paused: false, outOfCredits: false, startedAt: new Date(), finishedAt: null,
      };
      await scrapedPosts().updateOne({ postUrl }, { $set: {
        postUrl, activityId: activityUrn(postUrl), campaign: camp.label, campaign_key: camp.key, category,
        running: true, paused: false, phase: scrapeOneStatus.phase, startedAt: rec.startedAt || new Date(),
      }, $unset: { backfilled: "", finishedAt: "" } }, { upsert: true });

      // title/expected counts (once)
      if (!rec.titleTried) postDetails(activityUrn(postUrl)).then((det) => {
        const set = det
          ? { title: det.title, poster_name: det.posterName, poster_url: det.posterUrl, text: det.text, expected_reactions: det.numReactions, expected_comments: det.numComments, posted: det.posted, titleTried: true }
          : { titleTried: true };
        scrapedPosts().updateOne({ postUrl }, { $set: set }).catch(() => {});
      }).catch(() => {});

      // PHASE 1 — scrape into the queue (skip if already fully scraped)
      if (!rec.scrape_done) {
        const res = await scrapeToQueue(postUrl);
        scrapeOneStatus.outOfCredits = rapidScrapeOutOfCredits();
        if (res !== "done") return await finalizeScrape(postUrl, res === "paused" ? "paused" : "stopped");
        await scrapedPosts().updateOne({ postUrl }, { $set: { scrape_done: true, engager_total: await scrapeEngagers().countDocuments({ postUrl }) } });
      }

      // PHASE 2 — enrich the queue
      scrapeOneStatus.phase = "enriching";
      await scrapedPosts().updateOne({ postUrl }, { $set: { phase: "enriching" } });
      const res2 = await enrichFromQueue(postUrl, camp, category);
      return await finalizeScrape(postUrl, res2 === "paused" ? "paused" : "done");
    } catch (e) {
      log.error("scrapeOnePost error", { err: e.message });
      return await finalizeScrape(postUrl, "error");
    }
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
