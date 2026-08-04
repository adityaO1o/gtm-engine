// Domain-prospecting scan: seed domain -> prefix/suffix/TLD permutations -> per-candidate streaming
// pipeline (DNS pre-filter -> HTTP redirect-to-seed check -> blacklist verdict). No stage runs as a
// full barrier: each candidate flows through independently and results land in Mongo (and therefore
// the dashboard poll) the instant they're known, not when the whole batch finishes.
import { ObjectId } from "mongodb";
import { generateCandidates, splitDomain } from "../lib/permute.js";
import { runPool, createLimiter } from "../lib/pool.js";
import { domainHasDns } from "../services/domainDns.js";
import { redirectsToSeed } from "../services/redirectCheck.js";
import { fetchRedirectDomains } from "../services/hostio.js";
import { pushDomains, pollUntilChecked } from "../services/blacklistProject.js";
import { domainScans } from "../db/mongo.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bump(jobId, fields) {
  try { await domainScans().updateOne({ _id: jobId }, { $inc: fields, $set: { updatedAt: new Date() } }); }
  catch (e) { log.warn("domainScan bump failed", { err: e.message }); }
}

async function appendResult(jobId, domain, verdict) {
  const listed = verdict.status === "listed";
  try {
    await domainScans().updateOne({ _id: jobId }, {
      $push: {
        results: {
          domain, status: verdict.status, riskScore: verdict.riskScore ?? null,
          listedZones: verdict.summary?.listedZones || [], registrar: verdict.registrar || null,
          checkedAt: new Date(),
        },
      },
      $inc: { blacklistChecked: 1, ...(listed ? { listedCount: 1 } : {}) },
      $set: { updatedAt: new Date() },
    });
  } catch (e) { log.warn("domainScan appendResult failed", { err: e.message }); }
}

// Batches confirmed (redirect-verified) domains into the blacklist API instead of pushing one at a
// time — keeps well under its 120 req/min limit even if dozens confirm in the same second — while
// still polling+streaming results every ~1s so the UI doesn't wait for the whole batch to finish.
//
// A domain only ever enters `awaiting` once we KNOW the push actually landed — a push that throws or
// gets rejected (e.g. bad BLACKLIST_API_KEY/BLACKLIST_WORKSPACE_ID) used to add it to `awaiting`
// anyway, which meant polling for a domain that was never really pushed: it would never appear in the
// API's list, verdicts.size would stay 0 forever, and the whole scan hung in "running" indefinitely.
// Now a failed push is recorded immediately as a result with status "error" instead, and a hard
// deadline guarantees the loop (and therefore the scan) always terminates even if the blacklist API
// itself is unreachable or stuck.
async function pushPollLoop(jobId, queue, isDone) {
  const awaiting = new Map();
  const deadline = Date.now() + 5 * 60_000;

  while (!isDone() || queue.length || awaiting.size) {
    if (Date.now() > deadline) {
      log.warn("domainScan push/poll loop hit its hard deadline", { jobId: String(jobId), stillAwaiting: awaiting.size, stillQueued: queue.length });
      for (const d of [...awaiting.keys(), ...queue.splice(0)]) await appendResult(jobId, d, { status: "error" });
      break;
    }
    try {
      if (queue.length) {
        const batch = queue.splice(0, queue.length);
        let result = null;
        try { result = await pushDomains(batch); }
        catch (e) { log.error("domainScan blacklist push threw", { err: e.message, batchSize: batch.length }); }

        const rejected = !result || ((result.added || 0) === 0 && (result.skipped || 0) === 0 && (result.invalid || []).length === batch.length);
        if (rejected) {
          log.error("domainScan: blacklist push failed for the whole batch — check BLACKLIST_API_KEY/BLACKLIST_WORKSPACE_ID", { jobId: String(jobId), batchSize: batch.length });
          await domainScans().updateOne({ _id: jobId },
            { $set: { blacklistPushError: "push failed — check BLACKLIST_API_KEY / BLACKLIST_WORKSPACE_ID env vars", updatedAt: new Date() } });
          for (const d of batch) await appendResult(jobId, d, { status: "error" });
        } else {
          batch.forEach((d) => awaiting.set(d, true));
        }
      }
      if (awaiting.size) {
        const verdicts = await pollUntilChecked([...awaiting.keys()], { intervalMs: 1000, maxWaitMs: 10_000 });
        for (const [domain, v] of verdicts) {
          awaiting.delete(domain);
          await appendResult(jobId, domain, v);
        }
      }
    } catch (e) {
      log.warn("domainScan push/poll loop error", { err: e.message });
    }
    await sleep(500);
  }
}

async function runScan(jobId, seedDomain, candidates) {
  const confirmedQueue = [];
  let candidatesDone = false;
  const poller = pushPollLoop(jobId, confirmedQueue, () => candidatesDone);

  const redirectLimit = createLimiter(config.scanRedirectConcurrency);

  await runPool(candidates, async (candidate, i) => {
    const hasDns = await domainHasDns(candidate, i);
    await bump(jobId, { dnsChecked: 1 });
    if (!hasDns) return;
    await bump(jobId, { dnsPassed: 1 });

    const isLive = await redirectLimit(() => redirectsToSeed(candidate, seedDomain));
    await bump(jobId, { redirectChecked: 1 });
    if (!isLive) return;
    await bump(jobId, { redirectConfirmed: 1 });
    confirmedQueue.push(candidate);
  }, { concurrency: config.scanDnsConcurrency });

  candidatesDone = true;
  await poller;

  await domainScans().updateOne({ _id: jobId }, { $set: { status: "done", finishedAt: new Date(), updatedAt: new Date() } });
  log.info("domain scan finished", { jobId: String(jobId), seedDomain });
}

// host.io mode: pull the real redirecting domains from host.io's index and blacklist-check them —
// no permutation, no DNS, no HTTP redirect check. Domains stream into the blacklist stage per page.
async function runScanHostio(jobId, seedDomain) {
  const queue = [];
  let fetchDone = false;
  const poller = pushPollLoop(jobId, queue, () => fetchDone);

  try {
    const { total } = await fetchRedirectDomains(seedDomain, {
      onBatch: async (domains) => {
        queue.push(...domains);
        await domainScans().updateOne({ _id: jobId },
          { $inc: { redirectConfirmed: domains.length }, $set: { updatedAt: new Date() } });
      },
    });
    await domainScans().updateOne({ _id: jobId },
      { $set: { hostioTotal: total, totalCandidates: total, updatedAt: new Date() } });
  } finally {
    fetchDone = true;
  }

  await poller;
  await domainScans().updateOne({ _id: jobId }, { $set: { status: "done", finishedAt: new Date(), updatedAt: new Date() } });
  log.info("domain scan finished (hostio)", { jobId: String(jobId), seedDomain });
}

// Kicks off a scan in the background and returns immediately with the job id — the dashboard polls
// GET /api/domainscan/:id (which just reads this same Mongo doc) for live progress + streamed results.
// mode "hostio" (default) uses host.io's reverse-redirect index; "permutation" uses the guesser+DNS+
// HTTP pipeline (kept for when host.io quota is exhausted or a seed isn't in its index).
export async function startDomainScan(seedInput, { mode = "hostio" } = {}) {
  const { label, tld } = splitDomain(seedInput);
  if (!label || !tld) throw new Error("enter a valid domain, e.g. acme.com");
  const seedDomain = `${label}.${tld}`;
  const useHostio = mode === "hostio";
  const candidates = useHostio ? [] : generateCandidates(seedDomain);

  const doc = {
    seedDomain, mode, status: "running",
    totalCandidates: candidates.length, hostioTotal: 0,
    dnsChecked: 0, dnsPassed: 0, redirectChecked: 0, redirectConfirmed: 0,
    blacklistChecked: 0, listedCount: 0, results: [],
    createdAt: new Date(), updatedAt: new Date(), finishedAt: null,
  };
  const { insertedId } = await domainScans().insertOne(doc);

  const run = useHostio ? runScanHostio(insertedId, seedDomain) : runScan(insertedId, seedDomain, candidates);
  run.catch((e) => {
    log.error("domain scan crashed", { err: e.message, seedDomain, mode });
    domainScans().updateOne({ _id: insertedId },
      { $set: { status: "error", error: e.message, finishedAt: new Date() } }).catch(() => {});
  });

  return { id: String(insertedId), seedDomain, mode, totalCandidates: candidates.length };
}

export async function getDomainScan(id) {
  if (!ObjectId.isValid(id)) return null;
  return domainScans().findOne({ _id: new ObjectId(id) });
}

export async function listDomainScans(limit = 20) {
  return domainScans().find({}, { projection: { results: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
}
