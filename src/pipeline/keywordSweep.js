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

import { scrapedPosts, scrapeEngagers } from "../db/mongo.js";
import { pndSearchPosts, pndOutOfCredits } from "../services/pnd.js";
import { CAMPAIGNS } from "../services/campaigns.js";
import { scrapeOneInner, pauseScrapePost } from "./sources.js";
import { meterFlush } from "../services/apiMeter.js";
import { log } from "../lib/logger.js";

// Below this, a post isn't worth opening: its engagers cost real enrichment money and a thin post
// rarely yields a usable lead. This only gates posts we've never touched — see the check below,
// which never abandons a post whose engagers are already queued.
const MIN_ENGAGERS = 15;

let running = false;
let ctl = { paused: false };
let status = {
  running: false, phase: "idle", keyword: "", campaign: "",
  keywordsDone: 0, totalKeywords: 0, postsFound: 0, postsScraped: 0,
  skippedSmall: 0, skippedUnchanged: 0, newEngagers: 0,
  creditsAtStart: null, creditsUsed: null, startedAt: null, finishedAt: null,
};
export function keywordSweepStatus() { return status; }
export function pauseKeywordSweep() {
  ctl.paused = true;
  pauseScrapePost(); // stop the post currently being scraped, at its checkpoint
  status.paused = true;
  return { paused: true };
}

// Every campaign's keywords, paired with the campaign its engagers belong to. Keyword-search
// engagers have a FIXED campaign (unlike source posts, which are routed by topic) — that's how the
// Trigify workflows were set up and what the campaign copy is written for.
function keywordPlan() {
  const plan = [];
  for (const c of CAMPAIGNS) {
    for (const kw of c.keywords || []) plan.push({ keyword: kw, campaignKey: c.key, label: c.label });
  }
  return plan;
}

export async function runKeywordSweep({ keywords = [] } = {}) {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  ctl = { paused: false };

  const { pndStats } = await import("../services/pnd.js");
  const plan = keywords.length
    ? keywordPlan().filter((p) => keywords.includes(p.keyword))
    : keywordPlan();

  status = {
    running: true, phase: "searching", keyword: "", campaign: "",
    keywordsDone: 0, totalKeywords: plan.length, postsFound: 0, postsScraped: 0,
    skippedSmall: 0, skippedUnchanged: 0, newEngagers: 0, paused: false,
    creditsAtStart: pndStats().balance?.creditsRemaining ?? null, creditsUsed: null,
    startedAt: new Date(), finishedAt: null,
  };

  try {
    for (const item of plan) {
      if (ctl.paused) break;
      status.keyword = item.keyword;
      status.campaign = item.label;
      status.phase = "searching";

      const r = await pndSearchPosts({ keyword: item.keyword, datePosted: "past-week", sortBy: "date_posted" }).catch(() => null);
      if (pndOutOfCredits()) { log.warn("keyword sweep stopping — out of credits"); break; }

      for (const p of r?.posts || []) {
        if (ctl.paused) break;
        if (!p.postUrl) continue;
        status.postsFound++;

        const counts = p.counts || {};
        const engagers = (counts.totalReactions || 0) + (counts.comments || 0);

        // Has this post already been scraped, and has it GROWN since? Both answered for free from
        // the search result — no call needed to find out there's nothing new.
        const rec = await scrapedPosts().findOne({ postUrl: p.postUrl });

        // Too thin to be worth opening — but only if we've never touched it. Raising this threshold
        // would otherwise strand posts queued under the old one: their engagers are already scraped
        // and paid for, and skipping here means scrapeOneInner (and with it enrichPending, which
        // drains enriched:false) never runs, so those people never become leads.
        if (engagers < MIN_ENGAGERS && !rec) { status.skippedSmall++; continue; }
        const seenBefore = rec?.last_total_engagers ?? null;
        if (rec?.scrape_done && seenBefore !== null && engagers <= seenBefore) {
          status.skippedUnchanged++;
          continue;
        }

        // Store what we learned for free BEFORE scraping: the per-type counts let the scraper skip
        // reaction types nobody used, and last_total_engagers is next run's growth baseline.
        await scrapedPosts().updateOne({ postUrl: p.postUrl }, {
          $set: {
            postUrl: p.postUrl, type_counts: counts, last_total_engagers: engagers,
            expected_reactions: counts.totalReactions ?? null, expected_comments: counts.comments ?? null,
            text: (p.text || "").slice(0, 300), posted: p.postedAt || null,
            source_kind: "keyword", keyword: item.keyword,
          },
          $setOnInsert: { startedAt: new Date() },
        }, { upsert: true }).catch(() => {});

        // A post that grew is re-opened — but its PER-TYPE progress (scrape_cp.types) is deliberately
        // kept. That memory is what makes the second pass cheap: emojis whose count didn't move are
        // skipped outright, and the ones that did grow resume from the page they reached instead of
        // re-reading from page 1. Only reactionsDone/commentsDone are cleared, so the phases run
        // again and consult that memory. typeIdx/page are reset because they're a mid-run pause
        // pointer, not cross-run state.
        if (rec?.scrape_done && seenBefore !== null && engagers > seenBefore) {
          await scrapedPosts().updateOne({ postUrl: p.postUrl }, {
            $unset: { scrape_done: "" },
            $set: { "scrape_cp.reactionsDone": false, "scrape_cp.commentsDone": false, "scrape_cp.typeIdx": 0, "scrape_cp.page": 1 },
          }).catch(() => {});
          log.info("keyword post grew — re-scraping only the delta", { postUrl: p.postUrl, was: seenBefore, now: engagers });
        }

        status.phase = "scraping";
        const before = await scrapeEngagers().countDocuments({ postUrl: p.postUrl });
        await scrapeOneInner({ postUrl: p.postUrl, campaignKey: item.campaignKey }).catch((e) =>
          log.warn("keyword post scrape failed", { postUrl: p.postUrl, err: e.message }));
        const after = await scrapeEngagers().countDocuments({ postUrl: p.postUrl });
        status.newEngagers += Math.max(0, after - before);
        status.postsScraped++;

        if (pndOutOfCredits()) { log.warn("keyword sweep stopping — out of credits"); break; }
      }
      status.keywordsDone++;
    }
  } catch (e) {
    log.error("keyword sweep failed", { err: e.message });
    status.error = e.message;
  }

  await meterFlush().catch(() => {});
  const end = (await import("../services/pnd.js")).pndStats().balance?.creditsRemaining ?? null;
  status = {
    ...status, running: false, phase: ctl.paused ? "paused" : "done",
    creditsUsed: (status.creditsAtStart != null && end != null) ? status.creditsAtStart - end : null,
    finishedAt: new Date(),
  };
  running = false;
  log.info("keyword sweep done", { postsScraped: status.postsScraped, newEngagers: status.newEngagers, creditsUsed: status.creditsUsed });
  return status;
}
