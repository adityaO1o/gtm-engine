// The AUTO ENGINE — the one scheduled loop that keeps leads flowing without anyone clicking.
//
// It replaces the old `sourcesLoop`, which drove the dead Trigify path (`runSources`) — paused by
// default and out of credits — while the working PND keyword sweep had no schedule at all. Every
// unit of work here funnels through `scrapeOneInner`, so it inherits the whole incremental machine:
// per-type checkpoints, growth-delta re-scrape (only NEW pages are paid for), the scrape_engagers
// dedup queue (nobody re-enriched), share-link resolve, and the per-post credit ledger.
//
// Three jobs, in priority order, each tick:
//   1. Keyword sweep      — every AUTO_SWEEP_HOURS (finds this week's posts for every campaign kw)
//   2. Hub pass           — piggybacks the sweep tick (harvest authors + scrape relevant hub posts)
//   3. Daily rotation     — once per calendar day: 5 members per resumed list + 5 standalone
//                           influencers, their last-3-months RELEVANT posts, then mark them done
//
// Credit discipline is the whole point:
//   • idle entirely below AUTO_MIN_CREDITS (a reserve; separate from the paid-tier PND_CREDIT_FLOOR)
//   • never run while any other scrape holds the lane (keywordRunnerBusy)
//   • relevance-gate every influencer/hub/list post so off-topic posts cost nothing
//   • a 90-day age guard stops ancient posts after a single peek credit
//   • AUTO_MAX_POSTS_PER_DAY caps how many scrapes the rotation can launch in a day

import { engineState, sources, scrapedPosts } from "../db/mongo.js";
import { config } from "../config.js";
import { pndStats, pndOutOfCredits, pndProfilePosts, pndPostInfo } from "../services/pnd.js";
import { hubScrape } from "../services/hubScrape.js";
import { isRelevantPost } from "../services/classify.js";
import { runKeywordSweep, keywordRunnerBusy, reopenIfGrown, MIN_ENGAGERS } from "./keywordSweep.js";
import { scrapeOneInner, routeText } from "./sources.js";
import { meterSinceBoot } from "../services/apiMeter.js";
import { log } from "../lib/logger.js";

const DAY = 86400000;
const HUB_REVISIT_MS = 7 * DAY; // a done hub post is only re-checked for growth for its first week

// ── Persisted state ───────────────────────────────────────────────────────────────────────────
const AUTO_ID = "auto";
async function state() {
  const d = await engineState().findOne({ _id: AUTO_ID }).catch(() => null);
  // Default ENABLED — the user wants automation on, and (unlike the old in-memory flag) this
  // survives deploys because it's read from Mongo, not reset to a hardcoded default on boot.
  if (!d) return { _id: AUTO_ID, enabled: true, sweepLastAt: null, rotationLastDay: null };
  return d;
}
async function patch(set) { await engineState().updateOne({ _id: AUTO_ID }, { $set: set }, { upsert: true }).catch(() => {}); }

export async function autoStatus() {
  const s = await state();
  const bal = pndStats().balance?.creditsRemaining ?? null;
  const nextSweepAt = s.sweepLastAt ? new Date(new Date(s.sweepLastAt).getTime() + config.autoSweepHours * 3600000) : new Date();
  const [listsDoneAgg] = await sources().aggregate([
    { $match: { type: "influencer", lists: { $exists: true, $ne: [] } } },
    { $group: { _id: null, total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ["$scrape_done", true] }, 1, 0] } } } },
  ]).toArray().catch(() => [null]);
  return {
    enabled: s.enabled !== false,
    creditsRemaining: bal, minCredits: config.autoMinCredits, idleLowCredits: bal != null && bal < config.autoMinCredits,
    sweepEveryHours: config.autoSweepHours, sweepLastAt: s.sweepLastAt, nextSweepAt,
    rotationLastDay: s.rotationLastDay, perList: config.autoPerList, maxPostsPerDay: config.autoMaxPostsPerDay,
    listMembers: listsDoneAgg ? { total: listsDoneAgg.total, done: listsDoneAgg.done } : { total: 0, done: 0 },
    busyWith: keywordRunnerBusy(),
  };
}

export async function setAutoEnabled(on) { await patch({ enabled: !!on }); return { enabled: !!on }; }

// ── Guards ──────────────────────────────────────────────────────────────────────────────────
function creditsOk() {
  const bal = pndStats().balance?.creditsRemaining;
  // Unknown balance (null, e.g. right after a restart before the first PND call) is allowed —
  // the very next call captures it, and pndOutOfCredits() still hard-stops a truly drained plan.
  return !pndOutOfCredits() && (bal == null || bal >= config.autoMinCredits);
}
const utcDayKey = (d = new Date()) => d.toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC

// ── Job 2: hub pass ───────────────────────────────────────────────────────────────────────────
async function hubPass(budget) {
  const hubs = await sources().find({ type: "hub", active: { $ne: false } }).toArray();
  for (const h of hubs) {
    if (budget.left <= 0 || !creditsOk() || keywordRunnerBusy()) break;
    let posts = [], authors = [];
    try { ({ posts = [], authors = [] } = await hubScrape(h.url)); }
    catch (e) { log.warn("hub scrape failed", { url: h.url, err: e.message }); continue; }
    // Harvest new influencer profiles (free; existing rows untouched via $setOnInsert).
    for (const a of authors.slice(0, 20)) {
      await sources().updateOne({ url: a },
        { $setOnInsert: { url: a, type: "influencer", label: (a.split("/in/")[1] || "").replace(/\/$/, ""), active: true, harvestedFrom: h.url, addedAt: new Date() } },
        { upsert: true }).catch(() => {});
    }
    for (const postUrl of posts) {
      if (budget.left <= 0 || !creditsOk() || keywordRunnerBusy()) break;
      // Relevance from the URL slug — free. Hub HTML carries no text, so this is the only free signal.
      if (!isRelevantPost(routeText("", postUrl))) continue;
      const rec = await scrapedPosts().findOne({ postUrl });
      // A post fully done more than a week ago is settled — don't even peek. Within the first week
      // it may still be growing, so peek (1 credit via get-post) and re-open only if it grew.
      if (rec?.scrape_done) {
        const doneAge = rec.finishedAt ? Date.now() - new Date(rec.finishedAt).getTime() : Infinity;
        if (doneAge > HUB_REVISIT_MS) continue;
        const det = await pndPostInfo(postUrl).catch(() => null);
        const engagers = (det?.counts?.totalReactions || 0) + (det?.counts?.comments || 0);
        if ((await reopenIfGrown(postUrl, rec, engagers)) !== "reopened") continue;
      }
      const res = await scrapeOneInner({ postUrl, campaignKey: "", maxAgeDays: config.autoPostMaxAgeDays, kind: "hub" })
        .catch((e) => { log.warn("hub post scrape failed", { postUrl, err: e.message }); return null; });
      if (res?.error === "already running") return; // a manual scrape took the lane — stop the hub pass
      if (res?.skipped !== "too-old") budget.left--;
    }
    await sources().updateOne({ _id: h._id }, { $set: { lastRun: new Date() } }).catch(() => {});
  }
}

// ── Job 3: one rotation member (a list member or a standalone influencer) ────────────────────
async function scrapeMember(m, budget) {
  // Snapshot PND counters so we can attribute what THIS member cost (listing pages + each post's
  // scrape/enrich) and show it per-influencer and rolled up per-list.
  const cbase = meterSinceBoot();
  // List this person's posts, newest first, stopping at the age window. paginationToken walks deeper.
  let token = "", total = 0, relevant = 0, scraped = 0, done = true;
  outer:
  for (let pageNo = 0; pageNo < 10; pageNo++) { // hard cap: 10 pages (~500 posts) of history
    if (!creditsOk() || keywordRunnerBusy()) { done = false; break; }
    const r = await pndProfilePosts(m.url, { paginationToken: token }).catch(() => null);
    if (!r || !r.posts.length) break;
    for (const p of r.posts) {
      total++;
      // Newest-first: the first post past the window means everything after is older too.
      if (p.postedTimestamp && Date.now() - p.postedTimestamp > config.autoPostMaxAgeDays * DAY) break outer;
      if (!isRelevantPost(p.text)) continue;
      const engagers = (p.counts?.totalReactions || 0) + (p.counts?.comments || 0);
      if (engagers < MIN_ENGAGERS) continue; // thin post — its engagers rarely convert, skip free
      relevant++;
      if (budget.left <= 0) { done = false; break outer; } // day's scrape budget spent — finish this member tomorrow
      // Seed the growth baseline + type counts (free), then scrape. reopenIfGrown handles a post
      // another source already did: unchanged → skips inside scrapeOneInner's own dedup.
      const rec = await scrapedPosts().findOne({ postUrl: p.postUrl });
      await scrapedPosts().updateOne({ postUrl: p.postUrl }, {
        $set: { postUrl: p.postUrl, type_counts: p.counts, last_total_engagers: engagers,
                text: (p.text || "").slice(0, 300), posted: p.posted, source_kind: "influencer" },
        $setOnInsert: { startedAt: new Date() },
      }, { upsert: true }).catch(() => {});
      if ((await reopenIfGrown(p.postUrl, rec, engagers)) === "unchanged") { scraped++; continue; }
      const res = await scrapeOneInner({ postUrl: p.postUrl, campaignKey: "", maxAgeDays: config.autoPostMaxAgeDays, kind: "influencer" })
        .catch((e) => { log.warn("member post scrape failed", { postUrl: p.postUrl, err: e.message }); return null; });
      if (res?.error === "already running") { done = false; break outer; } // a manual scrape took the lane — resume this member tomorrow
      scraped++;
      if (res?.skipped !== "too-old") budget.left--; // an old-post peek (1 credit) doesn't consume a scrape slot
    }
    token = r.paginationToken;
    if (!token) break;
  }
  // Per-member PND cost = the counter delta over this member's whole loop (listing + scrapes).
  const now = meterSinceBoot();
  const dd = (k) => Math.max(0, (now[k] || 0) - (cbase[k] || 0));
  const memberCredits = dd("pnd_scrape_pages") + dd("pnd_profile_calls") + dd("pnd_company_calls");
  const upd = { $set: { last_picked_at: new Date(), posts_total: total, posts_relevant: relevant, posts_scraped: scraped },
                $inc: { pnd_credits: memberCredits } };
  // "Done forever" only when the member's whole in-window backlog was walked. An interrupted member
  // (budget/credits/lock) is left not-done so tomorrow's rotation re-picks it; re-listing costs a
  // page or two, re-scraping ~0 (dedup), so resuming is cheap.
  if (done) { upd.$set.scrape_done = true; upd.$set.done_at = new Date(); }
  await sources().updateOne({ _id: m._id }, upd).catch(() => {});
  log.info("auto rotation member", { url: m.url, total, relevant, scraped, done });
}

// ── Job 3: daily rotation ─────────────────────────────────────────────────────────────────────
async function rotation(budget) {
  // 5 per resumed imported list (active members not yet done, oldest-picked first)...
  const lists = await sources().distinct("lists", { type: "influencer", active: { $ne: false }, lists: { $exists: true, $ne: [] } }).catch(() => []);
  for (const list of (lists || []).filter(Boolean)) {
    if (budget.left <= 0 || !creditsOk() || keywordRunnerBusy()) return;
    const members = await sources().find({ lists: list, active: { $ne: false }, scrape_done: { $ne: true } })
      .sort({ last_picked_at: 1 }).limit(config.autoPerList).toArray().catch(() => []);
    for (const m of members) {
      if (budget.left <= 0 || !creditsOk() || keywordRunnerBusy()) return;
      await scrapeMember(m, budget);
    }
  }
  // ...plus 5 standalone influencers (hand-added or hub-harvested, i.e. no list membership).
  if (budget.left > 0 && creditsOk() && !keywordRunnerBusy()) {
    const solo = await sources().find({ type: "influencer", active: { $ne: false }, scrape_done: { $ne: true }, $or: [{ lists: { $exists: false } }, { lists: { $size: 0 } }] })
      .sort({ last_picked_at: 1 }).limit(config.autoPerList).toArray().catch(() => []);
    for (const m of solo) {
      if (budget.left <= 0 || !creditsOk() || keywordRunnerBusy()) return;
      await scrapeMember(m, budget);
    }
  }
}

// One rotation at a time across BOTH entry points (the daily tick and the manual "Run now"). Their
// keywordRunnerBusy() checks aren't enough on their own: a rotation releases the scrape lane between
// members, so a manual rotate-now firing in that gap would run a SECOND rotation concurrently and
// re-list members that are already being processed — wasted listing credits. This flag serialises them.
let rotationRunning = false;
async function runRotationGuarded() {
  if (rotationRunning) return { ok: false, error: "a rotation is already running" };
  rotationRunning = true;
  const budget = { left: config.autoMaxPostsPerDay };
  try { await rotation(budget); return { ok: true, remaining: budget.left }; }
  finally { rotationRunning = false; }
}

// ── The tick ──────────────────────────────────────────────────────────────────────────────────
let running = false;
export async function autoTick() {
  if (running) return;
  running = true;
  try {
    const s = await state();
    if (s.enabled === false) return;
    if (!creditsOk()) { log.info("auto engine idle — low PND credits", { remaining: pndStats().balance?.creditsRemaining, floor: config.autoMinCredits }); return; }
    if (keywordRunnerBusy()) return; // a manual scrape / sweep holds the single lane — yield

    const now = new Date();

    // 1) Keyword sweep every N hours (+ the hub pass rides the same window). Stamp at START so a
    // crash mid-sweep can't tight-loop it.
    const sweepDue = !s.sweepLastAt || (now.getTime() - new Date(s.sweepLastAt).getTime()) >= config.autoSweepHours * 3600000;
    if (sweepDue) {
      await patch({ sweepLastAt: now });
      log.info("auto: keyword sweep starting");
      await runKeywordSweep().catch((e) => log.warn("auto sweep failed", { err: e.message }));
      if (creditsOk() && !keywordRunnerBusy()) {
        const budget = { left: config.autoMaxPostsPerDay };
        await hubPass(budget).catch((e) => log.warn("auto hub pass failed", { err: e.message }));
      }
    }

    // 2) Daily rotation — once per UTC day, on the first tick at/after the rotate hour.
    const today = utcDayKey(now);
    const rotationDue = s.rotationLastDay !== today && now.getUTCHours() >= config.autoRotateUtcHour;
    if (rotationDue && creditsOk() && !keywordRunnerBusy()) {
      await patch({ rotationLastDay: today });
      log.info("auto: daily rotation starting", { day: today });
      const r = await runRotationGuarded().catch((e) => { log.warn("auto rotation failed", { err: e.message }); return null; });
      log.info("auto: daily rotation done", { day: today, remaining: r?.remaining });
    }
  } catch (e) {
    log.error("auto tick error", { err: e.message });
  } finally {
    running = false;
  }
}

// Self-chaining loop, 5-min cadence. Kicked from server.js after boot.
export function startAutoLoop() {
  const TICK = 5 * 60 * 1000;
  const loop = async () => { await autoTick(); setTimeout(loop, TICK); };
  setTimeout(loop, 60_000); // first tick shortly after boot
}

// Manual kick (the repurposed "Run now" button) — runs a rotation immediately, honouring both the
// scrape lane and the rotation guard so it can't overlap the daily tick's rotation.
export async function rotateNow() {
  if (rotationRunning) return { ok: false, error: "a rotation is already running" };
  if (keywordRunnerBusy()) return { ok: false, error: "a scrape is already running — try again shortly" };
  if (!creditsOk()) return { ok: false, error: "auto engine is below its credit floor" };
  runRotationGuarded().catch((e) => log.warn("manual rotate failed", { err: e.message }));
  return { ok: true, started: true };
}
