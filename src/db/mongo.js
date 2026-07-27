// MongoDB — the system of record (replaces the Google Sheet).
//   leads:       one document per person, keyed by linkedin_url. Holds accumulated
//                score/status/categories + email + which posts they were seen on.
//   engagements: append-only log, one document per engagement (audit + rescoring).

import { MongoClient } from "mongodb";
import { config } from "./../config.js";
import { log } from "../lib/logger.js";

let db = null;

export async function connect() {
  if (db) return db;
  // On a fresh Mongo volume the server takes a few seconds to create the root user and
  // enable auth — retry with backoff so the app doesn't crashloop during that window.
  let client;
  for (let attempt = 1; ; attempt++) {
    try {
      client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      break;
    } catch (e) {
      if (attempt >= 10) throw e;
      log.warn("mongo connect retry", { attempt, err: e.message });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  db = client.db(config.mongoDb);
  await db.collection("leads").createIndex({ linkedin_url: 1 }, { unique: true });
  // Every enrichLead() call opens with `$or: [{linkedin_url}, {urns}]` to recognise a repeat
  // engager. Mongo only uses indexes for an $or when EVERY branch is indexed — linkedin_url was,
  // urns was not, so that $or fell back to a COLLSCAN of the whole leads collection, once per
  // engager, on every scrape. This is the other half of the pair.
  await db.collection("leads").createIndex({ urns: 1 });
  await db.collection("leads").createIndex({ email: 1 });
  await db.collection("leads").createIndex({ status: 1 });
  await db.collection("leads").createIndex({ score: -1 });
  await db.collection("engagements").createIndex({ linkedin_url: 1 });
  await db.collection("engagements").createIndex({ created_at: -1 });
  await db.collection("usage").createIndex({ campaign: 1 }, { unique: true });
  await db.collection("sources").createIndex({ url: 1 }, { unique: true });
  await db.collection("processed_posts").createIndex({ postUrl: 1 }, { unique: true });
  await db.collection("reprocess_runs").createIndex({ finishedAt: -1 });
  await db.collection("leads").createIndex({ recovered: 1 });
  await db.collection("leads").createIndex({ dnc: 1 });
  await db.collection("leads").createIndex({ posts_seen: 1 });         // per-scraped-post live counts
  // Dashboard count queries (/api/stats + /api/campaigns) filter on email_status and campaigns.
  // Without these they were COLLECTION SCANS — ~200 of them under concurrency made the dashboard
  // take 15-17s to load. These turn them into fast index counts.
  await db.collection("leads").createIndex({ email_status: 1 });
  // The retry pipeline (reprocess.js) scans email_status:"no-email" and then filters on last_retry_at
  // for the backoff. email_status alone narrows to a large slice; this compound lets Mongo skip
  // already-recently-tried leads on the index instead of in memory.
  await db.collection("leads").createIndex({ email_status: 1, last_retry_at: 1 });
  await db.collection("leads").createIndex({ campaigns: 1 });
  await db.collection("leads").createIndex({ campaigns: 1, status: 1 });
  await db.collection("leads").createIndex({ campaigns: 1, email_status: 1, email: 1 });
  await db.collection("leads").createIndex({ bb_verdict: 1 });          // BounceBan audit + scorecard
  await db.collection("bounceban_runs").createIndex({ finishedAt: -1 });
  // BounceBan verdict cache — keyed by email. The `at` TTL index is a hard cleanup bound (30d) so the
  // collection can't grow forever; the reuse window is the shorter, configurable bouncebanCacheMs
  // checked in code. (A wrong-person address is never cached — only real verdicts are stored.)
  await db.collection("bounceban_cache").createIndex({ email: 1 }, { unique: true });
  await db.collection("bounceban_cache").createIndex({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
  await db.collection("scraped_posts").createIndex({ postUrl: 1 }, { unique: true });
  // /internal internal-tool tool — one doc per job/hiring-post, deduped by a stable key.
  await db.collection("internal_jobs").createIndex({ dedup_key: 1 }, { unique: true });
  await db.collection("internal_jobs").createIndex({ created_at: -1 });
  await db.collection("internal_jobs").createIndex({ status: 1 });
  await db.collection("internal_searches").createIndex({ query: 1 }, { unique: true });
  // Per-campaign switches (currently just paused). Small and rarely written.
  await db.collection("campaign_state").createIndex({ key: 1 }, { unique: true });
  // Durable engager queue for the resumable "Scrape via post" job — scraped engagers are parked
  // here, then drained by the enrichment phase, so a restart/pause resumes instead of losing work.
  await db.collection("scrape_engagers").createIndex({ postUrl: 1, ekey: 1 }, { unique: true });
  await db.collection("scrape_engagers").createIndex({ postUrl: 1, enriched: 1 });

  // Reconcile the backfilled scraped-post history (idempotent, every boot). A manual scrape's post
  // appears on MANY of its leads' posts_seen; incidental posts (those people also engaged elsewhere)
  // appear on only a few. Keep the frequent ones, drop the noise. Real scrapes (no `backfilled`
  // flag) are NEVER touched — only backfilled rows are reconciled.
  try {
    const agg = await db.collection("leads").aggregate([
      { $match: { source_list: "manual-post", posts_seen: { $exists: true, $ne: [] } } },
      { $unwind: "$posts_seen" },
      { $group: { _id: "$posts_seen", n: { $sum: 1 } } },
      { $match: { n: { $gte: 50 } } }, // a real manual scrape lands on hundreds; noise on a handful
    ]).toArray();
    const legit = agg.map((a) => a._id).filter(Boolean);
    for (const u of legit) {
      await db.collection("scraped_posts").updateOne({ postUrl: u },
        { $setOnInsert: { postUrl: u, backfilled: true, startedAt: new Date() } }, { upsert: true });
    }
    const removed = await db.collection("scraped_posts").deleteMany({ backfilled: true, postUrl: { $nin: legit } });
    if (legit.length || removed.deletedCount) log.info("reconciled scraped-post history", { kept: legit.length, removed: removed.deletedCount });
  } catch (e) { log.warn("scraped-post backfill reconcile failed", { err: e.message }); }

  // A scrape marked running when the process died (deploy/crash) is not actually running — flag it
  // paused so the dashboard offers Resume (its queue + checkpoint are intact, so it continues cleanly).
  await db.collection("scraped_posts").updateMany({ running: true }, { $set: { running: false, paused: true, phase: "paused" } });

  // Every comments phase that has ever run did so against a parser that couldn't read the response
  // (it expected {comments:[…]}; the API returns a bare array), so `commentsDone: true` on an old
  // checkpoint means "we asked and threw the answer away", not "we have the commenters" — and a
  // resume would skip the phase forever. Reset it on any post that has no commenter in its queue,
  // so those posts actually fetch them. Self-limiting: once commenters land, the post stops
  // matching. scrape_done has to go too, or scrapeOne returns early before reaching the phase.
  try {
    const withComments = await db.collection("scrape_engagers").distinct("postUrl", { engagement_type: "comment" });
    const r = await db.collection("scraped_posts").updateMany(
      { "scrape_cp.commentsDone": true, postUrl: { $nin: withComments } },
      { $set: { "scrape_cp.commentsDone": false, "scrape_cp.page": 1 }, $unset: { scrape_done: "" } }
    );
    if (r.modifiedCount) log.info("reset the comments phase on posts whose commenters were never parsed", { posts: r.modifiedCount });
  } catch (e) { log.warn("comments-phase reconcile failed", { err: e.message }); }

  // Drop any SEEDED (hand-entered) RapidAPI balances. A RapidAPI plan's remaining is only knowable
  // from a real response header, and we no longer call the drained fresh/web-scrape hosts — so a
  // seeded number just sits there forever showing a stale, wrong figure. Only balances captured
  // from an actual API response are kept; the dashboard simply omits a provider we haven't called.
  try {
    await db.collection("api_usage").updateOne({ _id: "global", "balance_fresh.seeded": true }, { $unset: { balance_fresh: "" } });
    await db.collection("api_usage").updateOne({ _id: "global", "balance_webscrape.seeded": true }, { $unset: { balance_webscrape: "" } });
  } catch (e) { log.warn("clearing seeded api balances failed", { err: e.message }); }

  log.info("mongo connected", { db: config.mongoDb });
  return db;
}

export const leads = () => db.collection("leads");
export const engagements = () => db.collection("engagements");
export const usage = () => db.collection("usage");
// Global, cumulative API-consumption counters (Fresh scraper, web-scrape profile, resolver tiers,
// Prospeo, Clearbit). ONE doc {_id:"global"}; survives deploys so the dashboard shows true totals.
export const apiUsage = () => db.collection("api_usage");
export const sources = () => db.collection("sources");
export const processedPosts = () => db.collection("processed_posts");
export const reprocessRuns = () => db.collection("reprocess_runs");
// History of manually "Scrape via post" runs — postUrl + campaign; engager/verified counts are
// computed live from leads.posts_seen, so they stay current as retries recover emails.
export const scrapedPosts = () => db.collection("scraped_posts");
export const scrapeEngagers = () => db.collection("scrape_engagers");
export const internalJobs = () => db.collection("internal_jobs");
export const internalSearches = () => db.collection("internal_searches");
export const campaignState = () => db.collection("campaign_state");
// ── PND credit savers (permanent caches). A company's domain is looked up ONCE and then every
// future lead at that company is free, forever, across every post. Likewise a profile lookup is
// never paid for twice — retries reuse it.
export const companyDomains = () => db.collection("company_domains");   // _id: companyUsername
export const profileCache = () => db.collection("profile_cache");        // _id: profile url/urn
export const bouncebanRuns = () => db.collection("bounceban_runs");      // audit run history
export const verifyCache = () => db.collection("bounceban_cache");       // email -> {v: verdict, at}
