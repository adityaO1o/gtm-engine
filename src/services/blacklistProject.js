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

// A cached snapshot of EVERY domain's verdict in the workspace: domain -> {status, riskScore, zones}.
// The campaign reads this instead of the lastCheckedAt-sorted per-seed poll, which silently missed
// domains that were checked in an earlier run (old lastCheckedAt -> buried deep in a now-4000+ domain
// workspace -> the poll's early-termination gave up before reaching them -> 0 blacklisted for domains
// that were actually listed). Membership here is order-independent and correct. Cached briefly and
// de-duped across concurrent seeds so it's ~10 list calls per refresh, not per seed.
let verdictCache = { at: 0, map: new Map() };
let verdictRefreshing = null;

// One page of the workspace, with 429/5xx backoff — a transient rate limit must NOT look like an
// empty page (that would cache an incomplete verdict map and wrongly report domains as not-listed).
async function verdictPage(page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await axios.get(`${base()}/projects/${ws()}/domains`, {
      // sort by DOMAIN NAME (stable) — the default riskScore sort shifts between page fetches as
      // enrichment/rechecks change scores, so domains fall through the cracks of pagination and go
      // missing from the map. Alphabetical is immutable, so every domain is read exactly once.
      headers: h(), timeout: 25000, validateStatus: () => true, params: { page, limit: 500, sort: "domain", dir: "asc" },
    });
    if (r.status === 200) return { ok: true, items: r.data?.items || [] };
    if (r.status !== 429 && r.status < 500) return { ok: false, items: [] }; // hard error — don't retry
    await new Promise((s) => setTimeout(s, 800 * 2 ** attempt)); // 0.8s,1.6s,3.2s,6.4s,12.8s
  }
  return { ok: false, items: [] };
}

export async function getWorkspaceVerdicts({ maxAgeMs = 10000 } = {}) {
  if (verdictCache.map.size && Date.now() - verdictCache.at < maxAgeMs) return verdictCache.map;
  if (verdictRefreshing) return verdictRefreshing;
  verdictRefreshing = (async () => {
    const map = new Map();
    let complete = true;
    for (let page = 1; page <= 400; page++) {
      const { ok, items } = await verdictPage(page);
      if (!ok) { complete = false; break; } // a page failed — the map is partial, don't trust it
      if (!items.length) break;
      for (const it of items) {
        const d = String(it.domain || "").toLowerCase();
        if (d) map.set(d, { status: it.status, riskScore: it.riskScore ?? null, zones: it.summary?.listedZones || [] });
      }
      if (items.length < 500) break;
    }
    // Only replace the cache with a COMPLETE read; on a partial failure keep the last good map so a
    // transient rate limit can't erase everyone's verdicts.
    if (complete && map.size) verdictCache = { at: Date.now(), map };
    verdictRefreshing = null;
    return complete && map.size ? map : verdictCache.map;
  })();
  return verdictRefreshing;
}

// Full per-domain detail for the "where is it blacklisted" drawer: current verdict + which exact
// DNSBL zones list it + DNS/WHOIS enrichment (registrar, MX, SPF/DMARC...) + the listing-event
// history. The scan doesn't store the blacklist-API's own domain id, so we look it up by search
// first (exact-match preferred), then fetch its detail. Returns null if the domain isn't tracked.
export async function domainDetail(domain) {
  const key = String(domain || "").trim().toLowerCase();
  if (!key) return null;
  const { items = [] } = await listDomains({ search: key, limit: 10 });
  const match = items.find((d) => String(d.domain || "").toLowerCase() === key) || items[0];
  if (!match?.id) return null;
  const r = await axios.get(`${base()}/domains/${match.id}`, { headers: h(), timeout: 20000, validateStatus: () => true });
  if (r.status >= 300) { log.warn("blacklist project domain detail failed", { domain: key, status: r.status }); return null; }
  return r.data; // { domain: {...summary.listedZones, riskScore, status}, enrichment, events }
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
