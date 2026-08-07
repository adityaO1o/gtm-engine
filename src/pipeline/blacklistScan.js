// Blacklist-only scan. Same question as the campaign's first half — which of a company's secondary
// domains are blacklisted — but stripped to exactly that:
//
//   * ONE host.io API call per seed (page 1: total + up to 50 domains). No web scrape: the scrape
//     path is what kept failing, and the free page is not worth the failure rate here.
//   * No gates. Every seed is reported, including the ones with nothing blacklisted.
//   * No Prospeo. Contacts already exist in the caller's own file.
//
// A seed whose page 1 we already hold (from any earlier campaign, scraped or API) costs no call at
// all — that cache is the difference between 5,270 calls and rather fewer.
import { ObjectId } from "mongodb";
import { splitDomain } from "../lib/permute.js";
import { runPool } from "../lib/pool.js";
import { apiRedirectPage } from "../services/hostio.js";
import { pushDomains, refreshVerdicts, verdictsFor } from "../services/blacklistProject.js";
import { campaigns, campaignTargets, hostioPages, hostioUsage } from "../db/mongo.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_TTL_MS = 7 * 86400000;

export function parseDomains(raw) {
  const out = new Set();
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[\s,]+/);
  for (const tok of list) {
    const { label, tld } = splitDomain(tok);
    if (label && tld) out.add(`${label}.${tld}`);
  }
  return [...out];
}

// Page 1 for a seed, from cache if we have it, else exactly one API call.
async function pageOne(scanId, seed) {
  const hit = await hostioPages().findOne({ _id: `${seed}:1` }).catch(() => null);
  if (hit && Date.now() - new Date(hit.at).getTime() < PAGE_TTL_MS) {
    return { ok: true, total: hit.total, domains: hit.domains || [], cached: true };
  }
  const res = await apiRedirectPage(seed, 1, {
    onApiCall: async ({ count }) => {
      await campaigns().updateOne({ _id: scanId }, { $inc: { apiCallsUsed: 1 } }).catch(() => {});
      await hostioUsage().insertOne({ at: new Date(), campaignId: scanId, seed, page: 1, count, source: "api" }).catch(() => {});
    },
  });
  if (res.ok) {
    await hostioPages().updateOne({ _id: `${seed}:1` },
      { $set: { seed, page: 1, source: "api", total: res.total, domains: res.domains, at: new Date() } },
      { upsert: true }).catch(() => {});
  }
  return { ...res, cached: false };
}

// Verdicts for a batch, queueing only what we don't already know.
async function blacklistOf(domains) {
  if (!domains.length) return [];
  let map = await verdictsFor(domains);
  const unknown = domains.filter((d) => { const v = map.get(d); return !v || v.status === "pending" || v.status === "checking"; });
  if (unknown.length) {
    await pushDomains(unknown);
    const deadline = Date.now() + 25_000;
    for (;;) {
      await sleep(1200);
      await refreshVerdicts();
      map = await verdictsFor(domains);
      const left = unknown.filter((d) => { const v = map.get(d); return !v || v.status === "pending" || v.status === "checking"; });
      if (!left.length || Date.now() >= deadline) break;
    }
  }
  const out = [];
  for (const d of domains) {
    const v = map.get(d);
    if (v && v.status === "listed") out.push({ domain: d, riskScore: v.riskScore ?? null, zones: v.zones || [] });
  }
  return out;
}

async function scanSeed(scanId, t) {
  try {
    await campaignTargets().updateOne({ _id: t._id }, { $set: { stage: "blacklisting", updatedAt: new Date() } });
    const p1 = await pageOne(scanId, t.seed);
    if (!p1.ok) {
      await campaignTargets().updateOne({ _id: t._id },
        { $set: { stage: "error", error: "host.io api call failed", updatedAt: new Date() } });
      return;
    }
    const checked = p1.domains || [];
    const bl = await blacklistOf(checked);
    await campaignTargets().updateOne({ _id: t._id }, {
      $set: {
        stage: "done",
        redirectCount: p1.total ?? null,
        checkedCount: checked.length,
        blacklistedCount: bl.length,
        blacklistedDomains: bl,
        fromCache: !!p1.cached,
        updatedAt: new Date(),
      },
    });
  } catch (e) {
    await campaignTargets().updateOne({ _id: t._id },
      { $set: { stage: "error", error: e.message, updatedAt: new Date() } }).catch(() => {});
  }
}

// What would this cost? Page 1 already held for a seed means no call at all, so the answer is not
// simply the number of domains — and with a metered API that difference is worth knowing first.
export async function estimateBlacklistScan(rawDomains) {
  const seeds = parseDomains(rawDomains);
  if (!seeds.length) return { ok: false, error: "no usable domains" };
  const fresh = Date.now() - PAGE_TTL_MS;
  let cached = 0;
  for (let i = 0; i < seeds.length; i += 500) {
    const ids = seeds.slice(i, i + 500).map((s) => `${s}:1`);
    cached += await hostioPages().countDocuments({ _id: { $in: ids }, at: { $gte: new Date(fresh) } });
  }
  return { ok: true, domains: seeds.length, cached, apiCallsNeeded: seeds.length - cached };
}

export async function startBlacklistScan(rawDomains) {
  const seeds = parseDomains(rawDomains);
  if (!seeds.length) return { ok: false, error: "no usable domains" };

  const { insertedId } = await campaigns().insertOne({
    kind: "blacklist_scan", seedCount: seeds.length, status: "running", stage: "queued",
    apiCallsUsed: 0, createdAt: new Date(), updatedAt: new Date(),
  });
  await campaignTargets().insertMany(seeds.map((seed) => ({
    campaignId: insertedId, seed, stage: "queued", createdAt: new Date(),
  })));

  (async () => {
    await campaigns().updateOne({ _id: insertedId }, { $set: { stage: "running", startedAt: new Date() } });
    await refreshVerdicts().catch(() => {});
    const targets = await campaignTargets().find({ campaignId: insertedId }).toArray();
    await runPool(targets, (t) => scanSeed(insertedId, t), { concurrency: config.campaign.seedConcurrency });
    await campaigns().updateOne({ _id: insertedId },
      { $set: { status: "done", stage: "done", finishedAt: new Date(), updatedAt: new Date() } });
    log.info("blacklist scan finished", { id: String(insertedId), seeds: seeds.length });
  })().catch((e) => {
    log.error("blacklist scan crashed", { err: e.message });
    campaigns().updateOne({ _id: insertedId }, { $set: { status: "error", error: e.message } }).catch(() => {});
  });

  return { ok: true, id: String(insertedId), seedCount: seeds.length };
}

export async function getBlacklistScan(id) {
  if (!ObjectId.isValid(id)) return null;
  const _id = new ObjectId(id);
  const scan = await campaigns().findOne({ _id });
  if (!scan) return null;
  const agg = await campaignTargets().aggregate([
    { $match: { campaignId: _id } }, { $group: { _id: "$stage", n: { $sum: 1 } } },
  ]).toArray();
  const stages = Object.fromEntries(agg.map((r) => [r._id, r.n]));
  const cached = await campaignTargets().countDocuments({ campaignId: _id, fromCache: true });
  return {
    id: String(_id), status: scan.status, stage: scan.stage, seedCount: scan.seedCount,
    apiCallsUsed: scan.apiCallsUsed || 0, servedFromCache: cached, stages,
    startedAt: scan.startedAt, finishedAt: scan.finishedAt,
  };
}

export async function blacklistScanResults(id) {
  if (!ObjectId.isValid(id)) return null;
  const rows = await campaignTargets().find({ campaignId: new ObjectId(id) })
    .project({ seed: 1, stage: 1, redirectCount: 1, checkedCount: 1, blacklistedCount: 1, blacklistedDomains: 1, error: 1 })
    .toArray();
  return rows.map((r) => ({
    seed: r.seed, stage: r.stage, redirectCount: r.redirectCount ?? null,
    checkedCount: r.checkedCount ?? 0, blacklistedCount: r.blacklistedCount ?? 0,
    blacklistedDomains: (r.blacklistedDomains || []).map((d) => d.domain), error: r.error || null,
  }));
}
