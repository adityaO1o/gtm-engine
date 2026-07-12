// Read-only pull of the live Trigify credit balance for the dashboard top bar.
// Cached 5 min so the dashboard's auto-refresh doesn't hammer Trigify.

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

let cache = { at: 0, data: null };

export async function trigifyBalance() {
  if (!config.trigifyKey) return null;
  if (cache.data && Date.now() - cache.at < 5 * 60_000) return cache.data;
  try {
    const r = await axios.get("https://api.trigify.io/v1/credits/balance", {
      headers: { "x-api-key": config.trigifyKey },
      timeout: 15000,
      validateStatus: () => true,
    });
    const d = r.data?.data;
    if (d) {
      cache = { at: Date.now(), data: { used: +d.used, remaining: +d.remaining, limit: +d.limit } };
    }
  } catch (e) {
    log.warn("trigify balance threw", { err: e.message });
  }
  return cache.data;
}
