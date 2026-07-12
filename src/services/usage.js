// Per-campaign credit/usage counters (what the dashboard's credits bar reads).
//   trigify_scraped : engagers this campaign sent to /enrich (≈ 1 Trigify scrape credit each)
//   prospeo_calls   : Prospeo API calls made for this campaign
//   sendkit_pushed  : leads pushed into this campaign's SendKit campaign
// Enrich is deliberately NOT tracked here (per product decision).

import { usage } from "../db/mongo.js";

export async function bumpUsage(campaign, inc) {
  if (!campaign || !inc) return;
  await usage().updateOne(
    { campaign },
    { $inc: inc, $set: { updated_at: new Date() } },
    { upsert: true }
  );
}
