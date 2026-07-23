// Sources orchestrator: scrape influencer posts + hub pages, classify each post by topic,
// route its engagers into the Influencer/Hub SendKit campaigns with the classified category.

import { sources, processedPosts, scrapedPosts, scrapeEngagers } from "../db/mongo.js";
import { getProfilePosts, getPostEngagements, getPostComments, trigifyOutOfCredits } from "../services/trigifyScrape.js";
import { hubScrape } from "../services/hubScrape.js";
import { classifyPost } from "../services/classify.js";
import { routeSourceEngager } from "../services/campaigns.js";
import { activityUrn } from "../services/rapidScrape.js";
import { pndReactionPage, pndCommentPage, pndPostInfo, pndOutOfCredits, REACTION_TYPES } from "../services/pnd.js";
import { resolveActivityUrn } from "../services/postUrn.js";
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

const ENRICH_CONCURRENCY = 4; // per page — the provider rate-limiters cap the real API rate, so this never spikes

const ekeyOf = (e) => (e.linkedin_url || e.name || "").toLowerCase();
// Upsert a page's engagers into the queue; returns the ekeys seen (so we can enrich THIS page now).
async function queueUpsert(postUrl, engagers) {
  const ops = [], ekeys = [];
  for (const e of engagers) {
    const ekey = ekeyOf(e);
    if (!ekey) continue;
    ekeys.push(ekey);
    ops.push({ updateOne: { filter: { postUrl, ekey }, update: { $setOnInsert: {
      postUrl, ekey, name: e.name || "", linkedin_url: e.linkedin_url || "", headline: e.headline || "",
      engagement_type: e.engagement_type || "like", comment_text: e.comment_text || "", enriched: false, at: new Date(),
    } }, upsert: true } });
  }
  if (ops.length) await scrapeEngagers().bulkWrite(ops, { ordered: false }).catch((e) => log.warn("scrape queue upsert failed", { err: e.message }));
  return ekeys;
}
const saveCp = (postUrl, cp) => scrapedPosts().updateOne({ postUrl }, { $set: { scrape_cp: cp } }).catch(() => {});
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch a page resiliently. A transient null (429 storm / 5xx / timeout) is NOT the end — cool down
// and retry, so a rate-limit spike no longer terminates the whole scrape. Returns the page object,
// or a sentinel: "paused" | "credits" (truly out of credits) | "giveup" (still failing after ~7min).
async function pageWithBackoff(fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (scrapeCtl.paused) return "paused";
    const r = await fn();
    if (r !== null) return r;
    if (pndOutOfCredits()) return "credits";
    const wait = 30000 * (attempt + 1); // 30s, 60s, 90s… ride out a rate-limit storm
    log.warn("scrape page transient fail — cooling then retrying", { attempt, waitMs: wait });
    await sleepMs(wait);
  }
  return "giveup";
}

// Enrich a set of queued docs, small concurrency; each marked done as it finishes. Leads land here.
async function enrichDocs(docs, camp, category, postUrl) {
  let i = 0;
  const worker = async () => {
    while (i < docs.length && !scrapeCtl.paused) {
      const e = docs[i++];
      let outcome = null;
      try {
        const r = await enrichLead({ name: e.name, linkedin_url: e.linkedin_url, headline: e.headline, engagement_type: e.engagement_type, comment_text: e.comment_text, campaign: camp.key, campaign_id: camp.sendkitId, category, source: "influencer", source_list: "manual-post", post_url: postUrl });
        outcome = r?.outcome || null;
        if (outcome === "sent") scrapeOneStatus.sent++;
      } catch (err) { outcome = "error"; log.warn("scrape enrich failed", { err: err.message }); }
      await scrapeEngagers().updateOne({ _id: e._id }, { $set: { enriched: true, outcome, enriched_at: new Date() } });
      scrapeOneStatus.enriched++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, docs.length || 1) }, worker));
  await scrapedPosts().updateOne({ postUrl }, { $set: { enriched_count: scrapeOneStatus.enriched, sent: scrapeOneStatus.sent } });
}

// Enrich THIS page's engagers (the ones not already done). Called right after each page is scraped.
async function enrichPage(postUrl, ekeys, camp, category) {
  if (!ekeys.length) return;
  const docs = await scrapeEngagers().find({ postUrl, ekey: { $in: ekeys }, enriched: { $ne: true } }).toArray();
  if (docs.length) await enrichDocs(docs, camp, category, postUrl);
}

// Drain ALL still-pending queued engagers — used on resume to finish a half-processed page/queue.
async function enrichPending(postUrl, camp, category) {
  while (!scrapeCtl.paused) {
    const docs = await scrapeEngagers().find({ postUrl, enriched: { $ne: true } }).limit(50).toArray();
    if (!docs.length) break;
    await enrichDocs(docs, camp, category, postUrl);
    await meterFlush();
  }
}

// INTERLEAVED scrape + enrich: each page is scraped, then its engagers are enriched immediately —
// so leads flow from page 1 and the enrichment load is paced by scraping (no 5k-at-once spike).
// Fully resumable (checkpoint + queue) and pausable. -> "done" | "paused" | "stopped"
async function scrapeAndEnrich(postUrl, camp, category) {
  // On resume, first finish anything already scraped but not yet enriched.
  await enrichPending(postUrl, camp, category);
  if (scrapeCtl.paused) return "paused";

  const rec = (await scrapedPosts().findOne({ postUrl })) || {};

  // Checkpoint migration. Three eras have existed:
  //   • fresh-era  : {typeIdx,…}, no reactionsDone
  //   • PND-ALL    : {reactionsDone, page}, paged the whole-post ALL stream (topped out at 1,900)
  //   • per-type   : {mode:"per-type", reactionsDone, typeIdx, page}   ← current
  // Any pre-per-type checkpoint has its REACTIONS reset so they re-page per type — that's how a post
  // already "done" under ALL picks up the reactions the per-type budget can reach that ALL couldn't.
  // Comments are unaffected, so commentsDone is preserved. The queue dedups on ekey and enrichment
  // only touches enriched:false, so nobody already processed is re-charged; only scrape pages re-read.
  const saved = rec.scrape_cp;
  let cp, reactionsReset = false;
  if (saved && saved.mode === "per-type") {
    cp = saved;
  } else {
    reactionsReset = !!saved; // there was an old checkpoint we're upgrading
    cp = { mode: "per-type", typeIdx: 0, page: 1, token: "", reactionsDone: false, commentsDone: !!saved?.commentsDone };
    if (saved) log.info("migrating checkpoint to per-type reactions — re-paging reactions", { postUrl });
  }

  // A post fully done under the OLD scraper should still re-run reactions once, to gather the extra
  // per-type reactions; otherwise "done" means done.
  if (rec.scrape_done && !reactionsReset) return "done";

  // Absorb one scraped page: queue it, then enrich it immediately (interleaved), then checkpoint.
  const absorb = async (engagers, nextCp) => {
    const ekeys = await queueUpsert(postUrl, engagers);
    scrapeOneStatus.total = await scrapeEngagers().countDocuments({ postUrl });
    await enrichPage(postUrl, ekeys, camp, category);
    Object.assign(cp, nextCp);
    await saveCp(postUrl, { ...cp });
  };

  // REACTIONS — page each TYPE separately. PND caps every request at page 38 (1,900 reactions), but
  // that cap is PER reactionType, so LIKE/PRAISE/EMPATHY/… each get their own budget. type=ALL
  // topped out at 1,900 for the whole post; this reaches 1,900 of the dominant type PLUS every
  // reaction of every smaller type. typeIdx walks REACTION_TYPES so a pause/resume continues from
  // the exact (type, page) it stopped at.
  if (!cp.reactionsDone) {
    // search-posts hands us each post's per-emoji counts for free, so we can skip the types nobody
    // used. Paging all six on a likes-only post wasted five credits per post; now only the types
    // with a non-zero count are paged. Unknown counts (post came from a URL, not a search) fall
    // back to paging everything.
    const known = rec.type_counts || null;
    for (let ti = cp.typeIdx || 0; ti < REACTION_TYPES.length; ti++) {
      const rt = REACTION_TYPES[ti];
      if (known && !known[rt]) continue; // nobody reacted with this emoji — don't spend a credit
      let collected = 0, total = Infinity;
      const startPage = ti === (cp.typeIdx || 0) ? (cp.page || 1) : 1; // resume mid-type only for the saved type
      for (let page = startPage; page <= 38; page++) { // PND hard-caps at 38; no point paging past it
        if (scrapeCtl.paused) { await saveCp(postUrl, { ...cp, typeIdx: ti, page }); return "paused"; }
        const r = await pageWithBackoff(() => pndReactionPage(postUrl, page, rt));
        if (r === "paused") { await saveCp(postUrl, { ...cp, typeIdx: ti, page }); return "paused"; }
        if (r === "credits" || r === "giveup") { await saveCp(postUrl, { ...cp, typeIdx: ti, page }); return "stopped"; }
        await absorb(r.engagers, { typeIdx: ti, page: page + 1 });
        collected += r.count;
        if (typeof r.total === "number") total = r.total;
        if (!r.count || collected >= total) break;
      }
    }
    Object.assign(cp, { reactionsDone: true, typeIdx: 0, page: 1, token: "" });
    await saveCp(postUrl, { ...cp });
  }

  // COMMENTS — commenters arrive WITH their real vanity URL, so they never need a SERP resolve.
  //
  // Reactions above post the raw URL, so they work on any post and always did. Comments need the
  // ACTIVITY urn, which a share-link doesn't carry (it has urn:li:share — a different id for the
  // same post), so resolve it properly and record a skip rather than pretending the phase ran.
  if (!cp.commentsDone) {
    const urn = await resolveActivityUrn(postUrl);
    if (!urn) {
      log.warn("no activity urn for post — commenters NOT scraped", { postUrl });
      await scrapedPosts().updateOne({ postUrl }, { $set: { comments_skipped: true, comments_skip_reason: "could not resolve the post URL to an activity urn" } });
      Object.assign(cp, { commentsDone: true });
      await saveCp(postUrl, { ...cp });
      return "done";
    }
    await scrapedPosts().updateOne({ postUrl }, { $unset: { comments_skipped: "", comments_skip_reason: "" } });
    // Page-based, like reactions: the endpoint reports total/totalPage and has no pagination token.
    // The old loop broke as soon as the token came back empty — and it ALWAYS came back empty —
    // so even once the parser is fixed, this had to change or we'd only ever read page one.
    for (let page = cp.page || 1; page <= 400; page++) {
      if (scrapeCtl.paused) { await saveCp(postUrl, { ...cp, page }); return "paused"; }
      const r = await pageWithBackoff(() => pndCommentPage(urn, { page }));
      if (r === "paused") { await saveCp(postUrl, { ...cp, page }); return "paused"; }
      if (r === "credits" || r === "giveup") { await saveCp(postUrl, { ...cp, page }); return "stopped"; }
      // How many commenters are actually REACHABLE. LinkedIn's own comment count includes replies
      // to comments, which this endpoint doesn't return — a post showing "6 comments" hands back 3
      // top-level commenters. Using LinkedIn's number as the target made a COMPLETE scrape read as
      // "14 of 17", i.e. a permanent phantom shortfall.
      if (page === 1 && r.total != null) await scrapedPosts().updateOne({ postUrl }, { $set: { comments_available: r.total } });
      await absorb(r.engagers, { page: page + 1 });
      if (!r.count || (r.totalPage && page >= r.totalPage)) break;
    }
    Object.assign(cp, { commentsDone: true });
    await saveCp(postUrl, { ...cp });
  }
  return "done";
}

async function finalizeScrape(postUrl, phase) {
  await meterFlush();
  const paused = phase === "paused";
  scrapeOneStatus = { ...scrapeOneStatus, running: false, phase, paused, finishedAt: new Date() };
  await scrapedPosts().updateOne({ postUrl }, { $set: {
    running: false, phase, paused, enriched_count: scrapeOneStatus.enriched, sent: scrapeOneStatus.sent,
    out_of_credits: pndOutOfCredits(), finishedAt: new Date(),
  } }).catch(() => {});
  scrapeOneRunning = false;
  scrapeCtl.paused = false;
  log.info("scrapeOnePost " + phase, { postUrl, enriched: scrapeOneStatus.enriched, sent: scrapeOneStatus.sent });
}

// Start a NEW scrape, or RESUME a paused/interrupted one for the same postUrl.
// Fire-and-forget wrapper for the dashboard button.
export async function scrapeOnePost({ postUrl, campaignKey = "" }) {
  if (!postUrl) return { ok: false, error: "postUrl required" };
  if (scrapeOneRunning) return { ok: false, error: "already running", ...scrapeOneStatus };
  scrapeOneInner({ postUrl, campaignKey }).catch((e) => log.error("scrapeOnePost error", { err: e.message }));
  return { ok: true, started: true };
}

// The same job, but AWAITABLE — the keyword sweep runs posts one after another and needs to know
// when each finishes. Callers must not run two at once (scrapeOneRunning guards the button path).
export async function scrapeOneInner({ postUrl, campaignKey = "" }) {
  const { routeSourceEngager, campaignByKey } = await import("../services/campaigns.js");
  scrapeOneRunning = true;
  scrapeCtl = { postUrl, paused: false };
  {
    try {
      const rec = (await scrapedPosts().findOne({ postUrl })) || {};

      // Read the post BEFORE deciding where its engagers go. This used to route on the URL SLUG —
      // LinkedIn's first ~8 words — because the text was hardcoded empty here. Two consequences,
      // both measured: any post whose keywords appear after the slug fell through to the default
      // and landed in Cold Email (a post about 400 inboxes, Workspace/Azure tenants, warmup and
      // SPF/DKIM — the core pitch — routed to Cold Email instead of Infrastructure); and the slug
      // strips punctuation, so "Instantly.ai" became "instantlyai" and stopped matching
      // /\binstantly\b/, sending an Instantly post to the Smartlead campaign.
      //
      // This is the same get-post call the title already made — it just ran fire-and-forget AFTER
      // routing. Awaiting it here costs no extra credit and gives the router the real body.
      const det = await pndPostInfo(postUrl).catch(() => null);
      const rt = routeText(det?.text || rec.text || "", postUrl);
      const category = rec.category || classifyPost(rt);
      // A post already under way keeps its campaign: re-routing a resume mid-way would split one
      // post's engagers across two campaigns. Pass campaignKey to override deliberately.
      const forced = campaignKey ? campaignByKey(campaignKey) : (rec.campaign_key ? campaignByKey(rec.campaign_key) : null);
      const camp = forced || routeSourceEngager(rt, category);

      const enrichedSoFar = await scrapeEngagers().countDocuments({ postUrl, enriched: true });
      scrapeOneStatus = {
        running: true, phase: "working", postUrl, campaign: camp.label,
        total: await scrapeEngagers().countDocuments({ postUrl }), enriched: enrichedSoFar, sent: rec.sent || 0,
        paused: false, outOfCredits: false, startedAt: new Date(), finishedAt: null,
      };
      await scrapedPosts().updateOne({ postUrl }, { $set: {
        postUrl, activityId: activityUrn(postUrl), campaign: camp.label, campaign_key: camp.key, category,
        running: true, paused: false, phase: "working", startedAt: rec.startedAt || new Date(),
      }, $unset: { backfilled: "", finishedAt: "" } }, { upsert: true });

      // Same fetch as above — store what it told us (title, poster, the real expected counts).
      await scrapedPosts().updateOne({ postUrl }, { $set: det
        ? { title: det.title, poster_name: det.posterName, poster_url: det.posterUrl, text: (det.text || "").slice(0, 300),
            expected_reactions: det.numReactions, expected_comments: det.numComments, posted: det.posted,
            activity_urn: det.urn || null, titleTried: new Date() }
        : { titleTried: new Date() },
      }).catch(() => {});

      // INTERLEAVED: scrape a page -> enrich that page -> next page. Leads flow from the start.
      const res = await scrapeAndEnrich(postUrl, camp, category);
      scrapeOneStatus.outOfCredits = pndOutOfCredits();
      if (res === "done") await scrapedPosts().updateOne({ postUrl }, { $set: { scrape_done: true, engager_total: await scrapeEngagers().countDocuments({ postUrl }) } });
      return await finalizeScrape(postUrl, res === "paused" ? "paused" : res === "stopped" ? "stopped" : "done");
    } catch (e) {
      log.error("scrapeOne error", { err: e.message });
      return await finalizeScrape(postUrl, "error");
    }
  }
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
