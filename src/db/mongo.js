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
  await db.collection("leads").createIndex({ campaigns: 1 });
  await db.collection("leads").createIndex({ campaigns: 1, status: 1 });
  await db.collection("leads").createIndex({ campaigns: 1, email_status: 1, email: 1 });
  await db.collection("leads").createIndex({ bb_verdict: 1 });          // BounceBan audit + scorecard
  await db.collection("bounceban_runs").createIndex({ finishedAt: -1 });
  await db.collection("scraped_posts").createIndex({ postUrl: 1 }, { unique: true });
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

  // activityUrn used to miss LinkedIn's newer "share-" post URLs, so every such post failed its
  // title lookup and got marked titleTried — which permanently stops the retry. Clear that mark on
  // the posts the old matcher couldn't parse, so they get one honest attempt with the fixed regex.
  // Scoped to non-"activity-" URLs: posts that legitimately have no title stay marked and don't
  // burn a credit on every boot.
  try {
    const r = await db.collection("scraped_posts").updateMany(
      { title: { $exists: false }, titleTried: true, postUrl: { $not: /activity[-:]\d/ } },
      { $unset: { titleTried: "" } }
    );
    if (r.modifiedCount) log.info("cleared titleTried on share-URL posts the old regex couldn't parse", { posts: r.modifiedCount });
  } catch (e) { log.warn("titleTried reconcile failed", { err: e.message }); }

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
// ── PND credit savers (permanent caches). A company's domain is looked up ONCE and then every
// future lead at that company is free, forever, across every post. Likewise a profile lookup is
// never paid for twice — retries reuse it.
export const companyDomains = () => db.collection("company_domains");   // _id: companyUsername
export const profileCache = () => db.collection("profile_cache");        // _id: profile url/urn
export const bouncebanRuns = () => db.collection("bounceban_runs");      // audit run history
