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
import { splitDomain } from "../lib/permute.js";
import { runPool } from "../lib/pool.js";
import { redirectCount, scrapeRedirectDomains } from "../services/hostio.js";
import { searchPeople, findEmail } from "../services/prospeo.js";
import { pushDomains, getWorkspaceVerdicts } from "../services/blacklistProject.js";
import { campaigns, campaignTargets, hostioCounts } from "../db/mongo.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// host.io redirect count with a Mongo cache — reuse a recent count instead of re-spending a host.io
// API call on every re-run of the same domain (the one place a re-run burns host.io quota). Default
// reuse window 7 days; a domain's redirect footprint barely moves day to day.
async function cachedRedirectCount(seed, maxAgeDays = 7) {
  const hit = await hostioCounts().findOne({ _id: seed }).catch(() => null);
  if (hit && hit.count != null && Date.now() - new Date(hit.at).getTime() < maxAgeDays * 86400000) {
    return { count: hit.count, cached: true };
  }
  const count = await redirectCount(seed);
  if (count != null) await hostioCounts().updateOne({ _id: seed }, { $set: { count, at: new Date() } }, { upsert: true }).catch(() => {});
  return { count, cached: false };
}

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

// Stage 2+3 for one seed: scrape host.io for its REAL redirect domains (free, ~48, no API quota),
// then blacklist-check them. Returns { confirmedCount, blacklisted: [{domain, riskScore, zones}] }.
// (Replaced the old permutation-guesser: on coldoutbound.com it found 48 real domains vs guessing's 3,
// because most real redirect domains are generic names that contain no part of the brand.)
async function discoverAndBlacklist(seed) {
  const domains = await scrapeRedirectDomains(seed);
  if (!domains.length) return { confirmedCount: 0, blacklisted: [] };

  await pushDomains(domains); // queues any not-yet-seen domains for checking (idempotent otherwise)

  // Read verdicts from the cached workspace-wide map (order-independent — correct even for domains
  // checked in an earlier run). Wait, refreshing the map, until our domains are all checked or the
  // deadline hits; whatever's still pending/checking by then is simply treated as not-listed.
  const want = new Set(domains);
  let map = await getWorkspaceVerdicts();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const pending = [...want].filter((d) => { const v = map.get(d); return !v || v.status === "pending" || v.status === "checking"; });
    if (!pending.length || Date.now() >= deadline) break;
    await sleep(2500);
    map = await getWorkspaceVerdicts();
  }

  const blacklisted = [];
  for (const d of domains) {
    const v = map.get(d);
    if (v && v.status === "listed") blacklisted.push({ domain: d, riskScore: v.riskScore ?? null, zones: v.zones || [] });
  }
  blacklisted.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  return { confirmedCount: domains.length, blacklisted };
}

async function runCampaign(campaignId, targets, gates) {
  const done = (extra) => campaigns().updateOne({ _id: campaignId }, { $set: { updatedAt: new Date(), ...extra } });

  // ── Stage 1: host.io count (cheap gate) — all seeds in parallel ───────────────────────────────
  await done({ stage: "counting" });
  await runPool(targets, async (t) => {
    await setTarget(t._id, { stage: "counting" });
    const { count } = await cachedRedirectCount(t.seed);
    const pass = count != null && count >= gates.countGate;
    await setTarget(t._id, { redirectCount: count, stage: pass ? "discovery_queued" : "dropped_count" });
  }, { concurrency: 8 });

  // ── Stage 2+3+4 PIPELINED per seed: each company runs discovery -> blacklist -> (if it clears the
  // gate) Prospeo, all in one pass, so contacts stream in as companies qualify instead of the whole
  // campaign waiting for every seed's discovery to finish before any enrichment starts. The shared
  // Prospeo spacer keeps the concurrent enrich calls under the plan's rate limit.
  const qualified = await campaignTargets().find({ campaignId, stage: "discovery_queued" }).toArray();
  await done({ stage: "discovering" });
  await runPool(qualified, async (t) => {
    try {
      await setTarget(t._id, { stage: "discovering" });
      const { confirmedCount, blacklisted } = await discoverAndBlacklist(t.seed);
      if (blacklisted.length < gates.blacklistGate) {
        await setTarget(t._id, { confirmedCount, blacklistedCount: blacklisted.length, blacklistedDomains: blacklisted, stage: "dropped_blacklist" });
        return;
      }
      await setTarget(t._id, { confirmedCount, blacklistedCount: blacklisted.length, blacklistedDomains: blacklisted, stage: "enriching" });
      const { people, total, free, error } = await searchPeople(t.seed);
      await setTarget(t._id, {
        people, peopleCount: people.length, peopleTotal: total, prospeoFree: !!free,
        prospeoError: error || null, stage: "done",
      });
    } catch (e) {
      await setTarget(t._id, { stage: "error", error: e.message });
    }
  }, { concurrency: config.campaign.seedConcurrency });

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

// EVERY seed's full funnel result (not just qualified ones) — so you can see each domain's whole
// journey: host.io redirect count, how many our discovery confirmed, how many were blacklisted, and
// what Prospeo returned. Sorted so the most-qualified prospects surface first, dropped ones last.
export async function getCampaignResults(id) {
  if (!ObjectId.isValid(id)) return [];
  return campaignTargets().find(
    { campaignId: new ObjectId(id) },
    { projection: { campaignId: 0 } },
  ).sort({ blacklistedCount: -1, confirmedCount: -1, redirectCount: -1 }).toArray();
}

export async function listCampaigns(limit = 20) {
  return campaigns().find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

// On-demand Stage 5a: reveal the actual emails for ONE company's contacts. search-person returns
// people with MASKED emails (to save credits); this enriches each via Prospeo enrich-person (~1
// credit per person that resolves) — run only when you actually want to contact that company, so
// credits aren't burned revealing everyone up front. Returns the updated people list.
export async function revealCompanyEmails(campaignId, seed) {
  if (!ObjectId.isValid(campaignId)) return null;
  const target = await campaignTargets().findOne({ campaignId: new ObjectId(campaignId), seed });
  if (!target) return null;
  const people = (target.people || []).map((p) => ({ ...p }));

  await runPool(people, async (p, i) => {
    const ids = p.linkedin_url
      ? { linkedin_url: p.linkedin_url }
      : { first_name: p.first_name, last_name: p.last_name, company_domain: seed };
    const r = await findEmail(ids);
    people[i].email = r.email || null;
    people[i].email_status = r.email_status || null;
  }, { concurrency: 5 });

  await campaignTargets().updateOne({ _id: target._id },
    { $set: { people, emailsRevealed: true, updatedAt: new Date() } });
  return people;
}
