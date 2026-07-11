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
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  db = client.db(config.mongoDb);
  await db.collection("leads").createIndex({ linkedin_url: 1 }, { unique: true });
  await db.collection("leads").createIndex({ email: 1 });
  await db.collection("leads").createIndex({ status: 1 });
  await db.collection("leads").createIndex({ score: -1 });
  await db.collection("engagements").createIndex({ linkedin_url: 1 });
  await db.collection("engagements").createIndex({ created_at: -1 });
  log.info("mongo connected", { db: config.mongoDb });
  return db;
}

export const leads = () => db.collection("leads");
export const engagements = () => db.collection("engagements");
