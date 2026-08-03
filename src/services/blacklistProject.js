// The Blacklist Project — InboxKit's own DNSBL checker (~90 zones: Spamhaus, SURBL, URIBL,
// Barracuda...). Docs: http://163.123.236.189:4400/docs
import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const h = () => ({ "x-api-key": config.blacklistProject.key, "Content-Type": "application/json" });
const base = () => `${config.blacklistProject.base}/api/v1`;
const ws = () => config.blacklistProject.workspaceId;

// Push domains into the workspace — one batched request per scan (idempotent: re-pushing an
// already-tracked domain just counts as "skipped"), never one call per domain.
export async function pushDomains(domains = []) {
  if (!domains.length) return { added: 0, skipped: 0, invalid: [] };
  const r = await axios.post(`${base()}/projects/${ws()}/domains`, { domains },
    { headers: h(), timeout: 30000, validateStatus: () => true });
  if (r.status >= 300) {
    log.warn("blacklist project push failed", { status: r.status, body: JSON.stringify(r.data || {}).slice(0, 200) });
    return { added: 0, skipped: 0, invalid: domains };
  }
  return r.data;
}

// One page of domains in the workspace, optionally narrowed by search/status — used to poll a
// scan's candidates for their verdict without one GET per domain.
export async function listDomains({ search, status, page = 1, limit = 100, sort, dir } = {}) {
  const r = await axios.get(`${base()}/projects/${ws()}/domains`, {
    headers: h(), timeout: 20000, validateStatus: () => true,
    params: { page, limit, ...(search ? { search } : {}), ...(status ? { status } : {}), ...(sort ? { sort, dir } : {}) },
  });
  if (r.status >= 300) {
    log.warn("blacklist project list failed", { status: r.status });
    return { items: [], total: 0 };
  }
  return r.data;
}

// Poll until every one of `domains` has left pending/checking (benchmarked: typically 1-2s for a
// batch of a few dozen). Bounded by maxWaitMs so a stuck domain can't hang the whole scan forever —
// whatever hasn't resolved by then is reported back as still-pending and the scan moves on.
export async function pollUntilChecked(domains, { intervalMs = 1500, maxWaitMs = 60_000 } = {}) {
  const want = new Set(domains.map((d) => d.toLowerCase()));
  const verdicts = new Map();
  const deadline = Date.now() + maxWaitMs;

  while (want.size && Date.now() < deadline) {
    // sort by lastCheckedAt desc so the domains THIS scan just pushed/checked surface on the first
    // page or two regardless of how large the workspace has grown from earlier scans — avoids
    // paginating the entire workspace on every poll tick.
    let page = 1;
    for (let guard = 0; guard < 50; guard++) {
      const { items = [] } = await listDomains({ page, limit: 100, sort: "lastCheckedAt", dir: "desc" });
      if (!items.length) break;
      let sawWanted = false;
      for (const it of items) {
        const d = String(it.domain || "").toLowerCase();
        if (!want.has(d)) continue;
        sawWanted = true;
        if (it.status === "pending" || it.status === "checking") continue;
        verdicts.set(d, it);
        want.delete(d);
      }
      // once a whole page goes by with none of our wanted domains AND none pending/checking either,
      // the rest of the list is strictly older — stop paginating.
      if (!sawWanted && page > 1) break;
      if (!want.size) break;
      page++;
    }
    if (!want.size) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return verdicts; // Map<domain, DomainRecord> — domains left in `want` timed out and are just absent
}

// Self-test the deployed config: is the key set, is the workspace id set, and does a live call
// actually succeed — without ever exposing the key itself. Exists because a bad env var on the
// deploy host and a network/firewall block that prevents reaching 163.123.236.189 both look
// identical from the scan's side (push just fails) but need completely different fixes.
export async function diagnose() {
  const keySet = !!config.blacklistProject.key;
  const workspaceIdSet = !!config.blacklistProject.workspaceId;
  const out = {
    keySet, keyPrefix: keySet ? config.blacklistProject.key.slice(0, 7) + "…" : null,
    workspaceIdSet, workspaceId: config.blacklistProject.workspaceId || null,
    base: config.blacklistProject.base,
  };
  if (!keySet || !workspaceIdSet) return { ...out, reachable: false, error: "missing env var(s) — see keySet/workspaceIdSet above" };

  try {
    const r = await axios.get(`${base()}/projects/${ws()}`, { headers: h(), timeout: 15000, validateStatus: () => true });
    if (r.status >= 300) {
      return { ...out, reachable: true, ok: false, status: r.status, error: r.data?.error?.message || r.data?.error?.code || JSON.stringify(r.data).slice(0, 200) };
    }
    return { ...out, reachable: true, ok: true, status: r.status, workspaceName: r.data?.name, domainCount: r.data?.domainCount };
  } catch (e) {
    // Network-level failure (ECONNREFUSED/ETIMEDOUT/ENOTFOUND) — the deploy host can't reach the
    // blacklist API's host:port at all, which is a firewall/routing problem, not a bad key.
    return { ...out, reachable: false, error: e.code || e.message };
  }
}
