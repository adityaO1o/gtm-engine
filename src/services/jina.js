// Jina token balance. A search on s.jina.ai costs ~10k tokens, so the headline number people
// actually care about is "how many more people can this resolve" — we surface that directly.

import axios from "axios";
import { config } from "./../config.js";
import { log } from "../lib/logger.js";

const TOKENS_PER_SEARCH = 10_000;
let cache = { at: 0, val: null };

export async function jinaBalance() {
  if (!config.jinaKey) return null;
  if (cache.val && Date.now() - cache.at < 60_000) return cache.val; // 60s cache

  try {
    const r = await axios.get("https://embeddings-dashboard-api.jina.ai/api/v1/api_key/user", {
      params: { api_key: config.jinaKey },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (r.status !== 200) return null;
    const w = r.data?.wallet || {};
    const remaining = Number(w.total_balance ?? (w.trial_balance || 0) + (w.regular_balance || 0)) || 0;
    const val = { remaining, searches: Math.floor(remaining / TOKENS_PER_SEARCH) };
    cache = { at: Date.now(), val };
    return val;
  } catch (e) {
    log.warn("jina balance failed", { err: e.message });
    return null;
  }
}
