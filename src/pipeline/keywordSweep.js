// Keyword sweep — the replacement for the Trigify workflows that used to push engagers into
// /enrich. Trigify found keyword-matching posts and scraped their engagers for us; it's out of
// credits, so the engine does it itself now, on the professional-network-data plan it already pays
// for, with the same campaign routing.
//
//   for each campaign keyword
//     search-posts (last 7 days, newest first)        1 credit -> ~10 posts WITH engagement counts
//       skip posts too small to be worth scraping     free
//       skip posts already scraped that haven't GROWN free   <- the 70 -> 200 question
//       otherwise scrape its engagers into that campaign
//
// The free part is what makes this cheap: search-posts returns socialActivityCountsInsight per
// post, so "is this worth scraping?" and "has it grown since last time?" are both answered without
// spending anything. Re-scraping a grown post never re-enriches the people already done — the
// queue dedups on ekey and enrichment only touches enriched:false — so only the new engagers cost.

import { scrapedPosts, scrapeEngagers, campaignState } from "../db/mongo.js";
import { pndSearchPosts, pndOutOfCredits } from "../services/pnd.js";
import { CAMPAIGNS, campaignByKey } from "../services/campaigns.js";
import { scrapeOneInner, pauseScrapePost, scrapePostStatus } from "./sources.js";
import { canonicalPostUrl } from "../services/rapidScrape.js";
import { meterFlush } from "../services/apiMeter.js";
import { log } from "../lib/logger.js";

// Below this, a post isn't worth opening: its engagers cost real enrichment money and a thin post
// rarely yields a usable lead. This only gates posts we've never touched — see the check below,
// which never abandons a post whose engagers are already queued.
export const MIN_ENGAGERS = 15;

// ONE runner at a time. The sweep and a manual keyword run both spend the same PND credits and
// both drive scrapeOneInner, which has its own single-post state — letting them overlap would make
// them fight over the same checkpoint. They therefore share `running`, but keep SEPARATE status
// objects so the two UIs (Campaigns tab = sweep, Sources tab = manual) never show each other's run.
let running = false;
const blankStatus = () => ({
  running: false, phase: "idle", keyword: "", campaign: "",
  keywordsDone: 0, totalKeywords: 0, postsFound: 0, postsTotal: 0, postsScraped: 0,
  skippedSmall: 0, skippedUnchanged: 0, newEngagers: 0, paused: false,
  creditsAtStart: null, creditsUsed: null, startedAt: null, finishedAt: null,
});

// The authoritative "can a keyword run start?" check, for callers OUTSIDE this module.
// Reading `keywordSweepStatus().running || keywordManualStatus().running` is NOT equivalent: the
// two runners share one `running` flag but write into separate status objects, so each status
// reports only its own run and a route that consults just one of them starts a run that the shared
// lock then silently rejects. It also covers the single-post scraper, because a keyword run drives
// the very same scrapeOneInner / scrapeCtl state — overlapping them makes Pause hit the wrong post.
export function keywordRunnerBusy() {
  if (running) return "keyword";
  if (scrapePostStatus()?.running) return "scrape-post";
  return null;
}

let ctl = { paused: false };
let status = blankStatus();
export function keywordSweepStatus() { return status; }
export function pauseKeywordSweep() {
  ctl.paused = true;
  pauseScrapePost(); // stop the post currently being scraped, at its checkpoint
  status.paused = true;
  return { paused: true };
}

let manualCtl = { paused: false };
let manualStatus = blankStatus();
export function keywordManualStatus() { return manualStatus; }
export function pauseKeywordManual() {
  manualCtl.paused = true;
  pauseScrapePost();
  manualStatus.paused = true;
  return { paused: true };
}

// Every campaign's keywords, paired with the campaign its engagers belong to. Keyword-search
// engagers have a FIXED campaign (unlike source posts, which are routed by topic) — that's how the
// Trigify workflows were set up and what the campaign copy is written for.
//
// A PAUSED campaign contributes no keywords, so the sweep neither searches nor scrapes for it. That
// is what the dashboard's Pause button now means: before, it tried to disable a Trigify workflow,
// which no longer exists — the button just failed with "workflow not found".
export async function keywordPlan() {
  const paused = new Set(
    (await campaignState().find({ paused: true }, { projection: { key: 1 } }).toArray().catch(() => []))
      .map((r) => r.key)
  );
  const plan = [];
  for (const c of CAMPAIGNS) {
    if (paused.has(c.key)) continue;
    for (const kw of c.keywords || []) plan.push({ keyword: kw, campaignKey: c.key, label: c.label });
  }
  return plan;
}

// ── Growth-delta gate, shared by the sweep and the auto engine's hub pass. ────────────────────
// Given a post's scraped_posts record and its CURRENT engager total (from a free source: the
// search result's counts, or a get-post), decide what to do:
//   "unchanged" — fully scraped and hasn't grown → skip, zero credits
//   "reopened"  — scraped but GREW → scrape_done cleared so the delta machinery re-runs. The
//                 PER-TYPE progress (scrape_cp.types) is deliberately KEPT: emojis whose count
//                 didn't move are skipped outright and grown ones resume from their page, which
//                 is what makes the second pass cheap. typeIdx/page are reset because they're a
//                 mid-run pause pointer, not cross-run state.
//   "new"       — never fully scraped (no record, or an interrupted scrape) → just scrape it
export async function reopenIfGrown(postUrl, rec, engagers) {
  const seenBefore = rec?.last_total_engagers ?? null;
  if (rec?.scrape_done && seenBefore !== null && engagers <= seenBefore) return "unchanged";
  if (rec?.scrape_done && seenBefore !== null && engagers > seenBefore) {
    await scrapedPosts().updateOne({ postUrl }, {
      $unset: { scrape_done: "" },
      $set: { "scrape_cp.reactionsDone": false, "scrape_cp.commentsDone": false, "scrape_cp.typeIdx": 0, "scrape_cp.page": 1 },
    }).catch(() => {});
    log.info("post grew — re-scraping only the delta", { postUrl, was: seenBefore, now: engagers });
    return "reopened";
  }
  return "new";
}

// Search one keyword and scrape every post worth scraping into `item.campaignKey`.
// Shared by the automatic sweep and a manual one-off keyword run — the ONLY difference between
// them is how the plan is built (campaign keywords vs. whatever you typed) and which status object
// it writes into. Returns "credits" when the PND plan ran dry, so the caller stops the whole run.
async function processKeyword(item, st, c) {
  st.keyword = item.keyword;
  st.campaign = item.label;
  st.phase = "searching";

  // Manual runs want POPULAR posts (relevance sort, wider window) — latest posts often have no
  // engagers yet. The auto sweep stays on fresh weekly posts (date_posted / past-week).
  const r = await pndSearchPosts({ keyword: item.keyword, datePosted: item.datePosted || "past-week", sortBy: item.sortBy || "date_posted" }).catch(() => null);
  if (pndOutOfCredits()) { log.warn("keyword run stopping — out of credits"); return "credits"; }

  // How many posts this search returned, known up front. `postsFound` counts posts as we WALK them,
  // so it grows during the run and is useless as a progress denominator (the bar goes backwards).
  // This is the fixed total to divide by.
  st.postsTotal += (r?.posts || []).length;

  for (const p of r?.posts || []) {
    if (c.paused) break;
    if (!p.postUrl) continue;
    st.postsFound++;

    // Canonical activity-form key so this post dedups against the SAME post reached from a profile
    // listing (rotation) or a hub — otherwise search's `/posts/slug-activity-ID?utm…` and the
    // rotation's `feed/update/urn:li:activity:ID` fork one post into two docs that both get scraped.
    const postUrl = canonicalPostUrl(p.postUrl);
    const counts = p.counts || {};
    const engagers = (counts.totalReactions || 0) + (counts.comments || 0);

    // Has this post already been scraped, and has it GROWN since? Both answered for free from
    // the search result — no call needed to find out there's nothing new.
    const rec = await scrapedPosts().findOne({ postUrl });

    // Too thin to be worth opening — but only if we've never touched it. Raising this threshold
    // would otherwise strand posts queued under the old one: their engagers are already scraped
    // and paid for, and skipping here means scrapeOneInner (and with it enrichPending, which
    // drains enriched:false) never runs, so those people never become leads.
    if (engagers < MIN_ENGAGERS && !rec) { st.skippedSmall++; continue; }
    // Growth-delta gate (shared with the auto engine): unchanged → free skip; grown → reopened
    // with per-type memory kept so only the delta is paid for. Checked BEFORE the record write
    // below, which refreshes last_total_engagers to the new baseline.
    const verdict = await reopenIfGrown(postUrl, rec, engagers);
    if (verdict === "unchanged") { st.skippedUnchanged++; continue; }

    // Store what we learned for free BEFORE scraping: the per-type counts let the scraper skip
    // reaction types nobody used, and last_total_engagers is next run's growth baseline.
    await scrapedPosts().updateOne({ postUrl }, {
      $set: {
        postUrl, type_counts: counts, last_total_engagers: engagers,
        expected_reactions: counts.totalReactions ?? null, expected_comments: counts.comments ?? null,
        text: (p.text || "").slice(0, 300), posted: p.postedAt || null,
        source_kind: item.manual ? "keyword-manual" : "keyword", keyword: item.keyword,
      },
      $setOnInsert: { startedAt: new Date() },
    }, { upsert: true }).catch(() => {});

    st.phase = "scraping";
    const before = await scrapeEngagers().countDocuments({ postUrl });
    await scrapeOneInner({ postUrl, campaignKey: item.campaignKey, kind: item.manual ? "manual" : "keyword" }).catch((e) =>
      log.warn("keyword post scrape failed", { postUrl, err: e.message }));
    const after = await scrapeEngagers().countDocuments({ postUrl });
    st.newEngagers += Math.max(0, after - before);
    st.postsScraped++;

    if (pndOutOfCredits()) { log.warn("keyword run stopping — out of credits"); return "credits"; }
  }
  return null;
}

export async function runKeywordSweep({ keywords = [] } = {}) {
  const busy = keywordRunnerBusy();
  if (busy) return { alreadyRunning: true, busyWith: busy, ...status };
  running = true;
  ctl = { paused: false };

  // EVERYTHING from here to the finally must be inside the try. `running` is a lock shared with the
  // manual runner, so anything that throws before the reset — pndStats() on a half-initialised
  // balance, the dynamic import, keywordPlan()'s Mongo read — used to wedge BOTH runners until the
  // container restarted, with the route's fire-and-forget .catch() swallowing the reason.
  try {
    const { pndStats } = await import("../services/pnd.js");
    const all = await keywordPlan();
    const plan = keywords.length ? all.filter((p) => keywords.includes(p.keyword)) : all;

    status = {
      ...blankStatus(),
      running: true, phase: "searching", totalKeywords: plan.length,
      creditsAtStart: pndStats().balance?.creditsRemaining ?? null,
      startedAt: new Date(),
    };

    try {
      for (const item of plan) {
        if (ctl.paused) break;
        const stop = await processKeyword(item, status, ctl);
        status.keywordsDone++;
        if (stop === "credits") break;
      }
    } catch (e) {
      log.error("keyword sweep failed", { err: e.message });
      status.error = e.message;
    }

    await meterFlush().catch(() => {});
    const end = pndStats().balance?.creditsRemaining ?? null;
    status = {
      ...status, running: false, phase: ctl.paused ? "paused" : "done",
      creditsUsed: (status.creditsAtStart != null && end != null) ? status.creditsAtStart - end : null,
      finishedAt: new Date(),
    };
    log.info("keyword sweep done", { postsScraped: status.postsScraped, newEngagers: status.newEngagers, creditsUsed: status.creditsUsed });
    return status;
  } catch (e) {
    log.error("keyword sweep aborted", { err: e.message });
    status = { ...status, running: false, phase: "error", error: e.message, finishedAt: new Date() };
    return status;
  } finally {
    running = false;
  }
}

// ── Manual keyword scrape ────────────────────────────────────────────────────────────────────
// Search ONE keyword you type and route every engager it finds into the campaign YOU pick — the
// keyword does not have to belong to that campaign, or to any campaign at all. This is the keyword
// equivalent of "Scrape via post": a deliberate, one-off run, not part of the automatic sweep.
//
// The keyword is NOT added to the campaign's keyword list — a future sweep won't pick it up unless
// you add it in campaigns.js. Same cost rules as the sweep: posts already done are skipped unless
// they've grown, and thin posts are skipped, so re-running a keyword is cheap.
export async function runManualKeyword({ keyword = "", campaignKey = "" } = {}) {
  const kw = String(keyword || "").trim();
  if (!kw) return { error: "keyword required" };

  const camp = campaignByKey(campaignKey);
  if (!camp) return { error: "pick a campaign to route these leads into" };

  const busy = keywordRunnerBusy();
  if (busy) return { alreadyRunning: true, busyWith: busy, ...manualStatus };
  running = true;
  manualCtl = { paused: false };

  // Same shape as runKeywordSweep: everything inside the try, `running` released in the finally.
  try {
    const { pndStats } = await import("../services/pnd.js");
    manualStatus = {
      ...blankStatus(),
      running: true, phase: "searching", keyword: kw, campaign: camp.label,
      totalKeywords: 1,
      creditsAtStart: pndStats().balance?.creditsRemaining ?? null,
      startedAt: new Date(),
    };

    try {
      await processKeyword({ keyword: kw, campaignKey: camp.key, label: camp.label, manual: true, sortBy: "relevance", datePosted: "past-month" }, manualStatus, manualCtl);
      manualStatus.keywordsDone = 1;
    } catch (e) {
      log.error("manual keyword run failed", { keyword: kw, err: e.message });
      manualStatus.error = e.message;
    }

    await meterFlush().catch(() => {});
    const end = pndStats().balance?.creditsRemaining ?? null;
    manualStatus = {
      ...manualStatus, running: false, phase: manualCtl.paused ? "paused" : "done",
      creditsUsed: (manualStatus.creditsAtStart != null && end != null) ? manualStatus.creditsAtStart - end : null,
      finishedAt: new Date(),
    };
    log.info("manual keyword run done", { keyword: kw, campaign: camp.label, postsScraped: manualStatus.postsScraped, newEngagers: manualStatus.newEngagers });
    return manualStatus;
  } catch (e) {
    log.error("manual keyword run aborted", { keyword: kw, err: e.message });
    manualStatus = { ...manualStatus, running: false, phase: "error", error: e.message, finishedAt: new Date() };
    return manualStatus;
  } finally {
    running = false;
  }
}
