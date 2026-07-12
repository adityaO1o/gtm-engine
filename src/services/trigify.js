// Read-only pull of the live Trigify credit balance for the dashboard top bar.
// Cached 5 min so the dashboard's auto-refresh doesn't hammer Trigify.

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const BASE = "https://api.trigify.io/v1";
const h = () => ({ "x-api-key": config.trigifyKey, "Content-Type": "application/json" });

// Enable/disable the Trigify workflow whose name matches a campaign label (for the Pause button).
export async function setWorkflowEnabled(campaignLabel, enabled) {
  if (!config.trigifyKey) return { ok: false, error: "no trigify key" };
  try {
    const r = await axios.get(`${BASE}/workflows`, { headers: h(), timeout: 15000, validateStatus: () => true });
    let list = r.data?.data;
    list = Array.isArray(list) ? list : list?.items || [];
    const label = (campaignLabel || "").toLowerCase();
    const wf = list.find((w) => (w.name || "").toLowerCase().includes(label));
    if (!wf) return { ok: false, error: "workflow not found" };
    const p = await axios.patch(`${BASE}/workflows/${wf.id}`, { enabled }, { headers: h(), timeout: 15000, validateStatus: () => true });
    return { ok: !!p.data?.success || p.status < 300, workflowId: wf.id, enabled };
  } catch (e) {
    log.warn("setWorkflowEnabled threw", { err: e.message });
    return { ok: false, error: e.message };
  }
}

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
