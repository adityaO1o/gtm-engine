// Campaign funnel: take a list of seed company domains and walk them through a progressive,
// credit-conscious funnel — cheap checks gate expensive ones, so paid calls only ever touch qualified
// prospects.
//
//   Stage 1  host.io redirect COUNT      1 host.io call/seed        gate: count >= countGate (def 50)
//   Stage 2  free discovery              permutation -> DNS -> HTTP  (no credits)
//   Stage 3  blacklist check             our own API                gate: blacklisted >= blacklistGate (def 3)
//   Stage 4  Prospeo search-person       1 credit/qualified company  -> people + roles (emails masked)
//   Stage 5  email reveal + copy         DEFERRED (not built yet)
//
// Everything is written incrementally into campaign_targets so the dashboard can poll the live funnel.
import { ObjectId } from "mongodb";
import { generateCandidates, splitDomain } from "../lib/permute.js";
import { runPool, createLimiter } from "../lib/pool.js";
import { domainHasDns } from "../services/domainDns.js";
import { redirectsToSeed } from "../services/redirectCheck.js";
import { redirectCount } from "../services/hostio.js";
import { searchPeople } from "../services/prospeo.js";
import { pushDomains, pollUntilChecked } from "../services/blacklistProject.js";
import { campaigns, campaignTargets } from "../db/mongo.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

// Normalize + dedupe a pasted blob of seed domains (newline/comma/space separated).
export function parseSeeds(raw) {
  const out = new Set();
  for (const tok of String(raw || "").split(/[\s,]+/)) {
    const { label, tld } = splitDomain(tok);
    if (label && tld) out.add(`${label}.${tld}`);
  }
  return [...out];
}

async function setTarget(id, fields) {
  await campaignTargets().updateOne({ _id: id }, { $set: { ...fields, updatedAt: new Date() } }).catch((e) =>
    log.warn("campaign setTarget failed", { err: e.message }));
}

// Stage 2+3 for one seed: guess candidates -> DNS filter -> redirect-to-seed check -> blacklist the
// confirmed ones. Returns { confirmedCount, blacklisted: [{domain, riskScore, zones}] }.
async function discoverAndBlacklist(seed) {
  const candidates = generateCandidates(seed);
  const confirmed = [];
  const redirectLimit = createLimiter(config.scanRedirectConcurrency);

  await runPool(candidates, async (candidate, i) => {
    if (!(await domainHasDns(candidate, i))) return;
    if (await redirectLimit(() => redirectsToSeed(candidate, seed))) confirmed.push(candidate);
  }, { concurrency: config.scanDnsConcurrency });

  if (!confirmed.length) return { confirmedCount: 0, blacklisted: [] };

  await pushDomains(confirmed);
  const verdicts = await pollUntilChecked(confirmed, { intervalMs: 1000, maxWaitMs: 60_000 });
  const blacklisted = [];
  for (const [domain, v] of verdicts) {
    if (v.status === "listed") blacklisted.push({ domain, riskScore: v.riskScore ?? null, zones: v.summary?.listedZones || [] });
  }
  blacklisted.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  return { confirmedCount: confirmed.length, blacklisted };
}

async function runCampaign(campaignId, targets, gates) {
  const done = (extra) => campaigns().updateOne({ _id: campaignId }, { $set: { updatedAt: new Date(), ...extra } });

  // ── Stage 1: host.io count (cheap gate) — all seeds in parallel ───────────────────────────────
  await done({ stage: "counting" });
  await runPool(targets, async (t) => {
    await setTarget(t._id, { stage: "counting" });
    const count = await redirectCount(t.seed);
    const pass = count != null && count >= gates.countGate;
    await setTarget(t._id, { redirectCount: count, stage: pass ? "discovery_queued" : "dropped_count" });
  }, { concurrency: 8 });

  // ── Stage 2+3: discovery + blacklist on seeds that passed the count gate ──────────────────────
  const qualified = await campaignTargets().find({ campaignId, stage: "discovery_queued" }).toArray();
  await done({ stage: "discovering" });
  await runPool(qualified, async (t) => {
    await setTarget(t._id, { stage: "discovering" });
    try {
      const { confirmedCount, blacklisted } = await discoverAndBlacklist(t.seed);
      const pass = blacklisted.length >= gates.blacklistGate;
      await setTarget(t._id, {
        confirmedCount, blacklistedCount: blacklisted.length, blacklistedDomains: blacklisted,
        stage: pass ? "enrich_queued" : "dropped_blacklist",
      });
    } catch (e) {
      await setTarget(t._id, { stage: "error", error: e.message });
    }
  }, { concurrency: config.campaign.seedConcurrency });

  // ── Stage 4: Prospeo search-person on companies with enough blacklisted domains ───────────────
  const toEnrich = await campaignTargets().find({ campaignId, stage: "enrich_queued" }).toArray();
  await done({ stage: "enriching" });
  await runPool(toEnrich, async (t) => {
    await setTarget(t._id, { stage: "enriching" });
    const { people, total, free, error } = await searchPeople(t.seed);
    await setTarget(t._id, {
      people, peopleCount: people.length, peopleTotal: total, prospeoFree: !!free,
      prospeoError: error || null, stage: "done",
    });
  }, { concurrency: 4 });

  await done({ stage: "done", status: "done", finishedAt: new Date() });
  log.info("campaign finished", { campaignId: String(campaignId) });
}

export async function startCampaign(rawSeeds, opts = {}) {
  const seeds = parseSeeds(rawSeeds);
  if (!seeds.length) throw new Error("no valid domains in the list");
  const gates = {
    countGate: parseInt(opts.countGate, 10) || config.campaign.countGate,
    blacklistGate: parseInt(opts.blacklistGate, 10) || config.campaign.blacklistGate,
  };

  const { insertedId } = await campaigns().insertOne({
    seedCount: seeds.length, gates, status: "running", stage: "queued",
    createdAt: new Date(), updatedAt: new Date(), finishedAt: null,
  });

  const targetDocs = seeds.map((seed) => ({
    campaignId: insertedId, seed, stage: "queued",
    redirectCount: null, confirmedCount: 0, blacklistedCount: 0, blacklistedDomains: [],
    peopleCount: 0, people: [], createdAt: new Date(), updatedAt: new Date(),
  }));
  await campaignTargets().insertMany(targetDocs);
  const targets = await campaignTargets().find({ campaignId: insertedId }).toArray();

  runCampaign(insertedId, targets, gates).catch((e) => {
    log.error("campaign crashed", { err: e.message });
    campaigns().updateOne({ _id: insertedId }, { $set: { status: "error", error: e.message, finishedAt: new Date() } }).catch(() => {});
  });

  return { id: String(insertedId), seedCount: seeds.length, gates };
}

// Funnel tallies + the campaign doc, for the dashboard poll.
export async function getCampaign(id) {
  if (!ObjectId.isValid(id)) return null;
  const _id = new ObjectId(id);
  const campaign = await campaigns().findOne({ _id });
  if (!campaign) return null;
  const byStage = await campaignTargets().aggregate([
    { $match: { campaignId: _id } },
    { $group: { _id: "$stage", n: { $sum: 1 } } },
  ]).toArray();
  const stages = Object.fromEntries(byStage.map((s) => [s._id, s.n]));
  return { ...campaign, id, stages };
}

// The qualified prospects (companies that reached Prospeo) with their blacklisted domains + people.
export async function getCampaignResults(id) {
  if (!ObjectId.isValid(id)) return [];
  return campaignTargets().find(
    { campaignId: new ObjectId(id), blacklistedCount: { $gte: 1 } },
    { projection: { campaignId: 0 } },
  ).sort({ blacklistedCount: -1 }).toArray();
}

export async function listCampaigns(limit = 20) {
  return campaigns().find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}
