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
  await db.collection("scraped_posts").createIndex({ postUrl: 1 }, { unique: true });

  // One-time: seed the scraped-post history from existing manual-scrape leads, so posts scraped
  // BEFORE this feature (e.g. the Instantly post) still show up with their live engager/verified
  // counts instead of vanishing. Runs once (only when the collection is empty).
  if (await db.collection("scraped_posts").countDocuments() === 0) {
    const urls = (await db.collection("leads").distinct("posts_seen", { source_list: "manual-post" })).filter(Boolean);
    for (const u of urls) {
      await db.collection("scraped_posts").updateOne({ postUrl: u },
        { $setOnInsert: { postUrl: u, backfilled: true, startedAt: new Date() } }, { upsert: true });
    }
    if (urls.length) log.info("seeded scraped-post history", { posts: urls.length });
  }

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
