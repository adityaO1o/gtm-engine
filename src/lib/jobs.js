// Durable work queue on Mongo. This is the ONLY contract between the Node platform and the Go
// crawler — no RPC, no protobuf, no codegen. Both sides lease jobs the same way, so adding a worker
// in any language means implementing two queries.
//
// Why a queue at all: an agency run is 250k+ page fetches over hours. Held in process memory it dies
// on every deploy — which on this repo means every push to main. A leased job whose worker vanishes
// simply becomes claimable again when its lease expires; nothing is lost and nothing is duplicated
// while the worker is alive.
//
// Priority is the shared-capacity mechanism. Trigify ingest and campaigns must never be starved by a
// 50k-domain crawl, so the crawl runs at the bottom and takes only what is left.
import { jobs } from "../db/mongo.js";
import { log } from "./logger.js";

export const PRIORITY = {
  INTERACTIVE: 100,   // something a human is watching
  CAMPAIGN: 50,       // the existing funnel
  CRAWL: 10,          // agency crawl — deliberately last
};

const LEASE_MS = 5 * 60_000;      // a worker must heartbeat within this or lose the job
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [0, 30_000, 2 * 60_000, 10 * 60_000];

// Enqueue is idempotent on `key`: re-submitting the same agency, or a retry that races, collapses
// into one job instead of crawling the same site twice.
export async function enqueue(type, payload, { key, priority = PRIORITY.CRAWL, runId = null, maxAttempts = MAX_ATTEMPTS, delayMs = 0 } = {}) {
  const _key = key || `${type}:${JSON.stringify(payload)}`;
  const now = new Date();
  const r = await jobs().updateOne(
    { key: _key },
    {
      $setOnInsert: {
        key: _key, type, payload, runId, priority, maxAttempts,
        state: "queued", attempts: 0, lastError: null, leaseUntil: null,
        nextRunAt: new Date(now.getTime() + delayMs), createdAt: now, updatedAt: now,
      },
    },
    { upsert: true },
  );
  return { inserted: !!r.upsertedCount };
}

export async function enqueueMany(items) {
  if (!items.length) return { inserted: 0 };
  const now = new Date();
  const ops = items.map(({ type, payload, key, priority = PRIORITY.CRAWL, runId = null, maxAttempts = MAX_ATTEMPTS, delayMs = 0 }) => ({
    updateOne: {
      filter: { key: key || `${type}:${JSON.stringify(payload)}` },
      update: {
        $setOnInsert: {
          key: key || `${type}:${JSON.stringify(payload)}`, type, payload, runId, priority, maxAttempts,
          state: "queued", attempts: 0, lastError: null, leaseUntil: null,
          nextRunAt: new Date(now.getTime() + delayMs), createdAt: now, updatedAt: now,
        },
      },
      upsert: true,
    },
  }));
  let inserted = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const r = await jobs().bulkWrite(ops.slice(i, i + 1000), { ordered: false }).catch((e) => {
      log.warn("enqueueMany partial failure", { err: e.message });
      return { upsertedCount: 0 };
    });
    inserted += r.upsertedCount || 0;
  }
  return { inserted };
}

// Re-arm a job that may already have run. enqueue() is $setOnInsert-only, so once a rollup has
// completed it can never be queued again — but a rollup MUST re-run after each client scan lands, or
// the agency's totals freeze at whatever was true the first time. The delay debounces it: twenty
// scans finishing in a minute schedule one rollup, not twenty.
export async function reschedule(type, payload, { key, priority = PRIORITY.CRAWL, runId = null, delayMs = 60_000 } = {}) {
  const _key = key || `${type}:${JSON.stringify(payload)}`;
  const now = new Date();
  await jobs().updateOne(
    { key: _key },
    {
      $set: { state: "queued", attempts: 0, leaseUntil: null, lastError: null, nextRunAt: new Date(now.getTime() + delayMs), updatedAt: now },
      $setOnInsert: { key: _key, type, payload, runId, priority, maxAttempts: MAX_ATTEMPTS, createdAt: now },
    },
    { upsert: true },
  );
}

// Claim one job atomically. findOneAndUpdate is the whole concurrency story: two workers racing for
// the same document, one wins, the other gets the next. No locks, no coordinator.
export async function lease(types, { workerId, leaseMs = LEASE_MS } = {}) {
  const now = new Date();
  const r = await jobs().findOneAndUpdate(
    {
      type: { $in: Array.isArray(types) ? types : [types] },
      $or: [
        { state: "queued", nextRunAt: { $lte: now } },
        // Reclaim: a worker that died mid-job left its lease behind. Nothing else can free it.
        { state: "leased", leaseUntil: { $lt: now } },
      ],
    },
    { $set: { state: "leased", leaseUntil: new Date(now.getTime() + leaseMs), workerId, updatedAt: now }, $inc: { attempts: 1 } },
    { sort: { priority: -1, nextRunAt: 1 }, returnDocument: "after" },
  );
  return r?.value || r || null;   // driver version tolerance
}

export async function heartbeat(id, { leaseMs = LEASE_MS } = {}) {
  await jobs().updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() + leaseMs), updatedAt: new Date() } });
}

export async function complete(id, result = null) {
  await jobs().updateOne({ _id: id }, { $set: { state: "done", result, leaseUntil: null, finishedAt: new Date(), updatedAt: new Date() } });
}

// A failure retries with backoff until maxAttempts, then parks as "failed" — visible, not silently
// dropped. The distinction matters: "failed" is a thing to look at, "done" is not.
export async function fail(id, error, { retry = true } = {}) {
  const job = await jobs().findOne({ _id: id }, { projection: { attempts: 1, maxAttempts: 1 } });
  const attempts = job?.attempts || 1;
  const max = job?.maxAttempts ?? MAX_ATTEMPTS;
  if (!retry || attempts >= max) {
    await jobs().updateOne({ _id: id }, { $set: { state: "failed", lastError: String(error).slice(0, 500), leaseUntil: null, finishedAt: new Date(), updatedAt: new Date() } });
    return { retried: false };
  }
  const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
  await jobs().updateOne({ _id: id }, {
    $set: { state: "queued", lastError: String(error).slice(0, 500), leaseUntil: null, nextRunAt: new Date(Date.now() + delay), updatedAt: new Date() },
  });
  return { retried: true, inMs: delay };
}

// Queue depth by type and state — the only honest way to answer "is it still working or is it
// stuck", which a progress bar derived from counts alone cannot.
export async function queueStats(runId = null) {
  const match = runId ? { runId } : {};
  const rows = await jobs().aggregate([
    { $match: match },
    { $group: { _id: { type: "$type", state: "$state" }, n: { $sum: 1 } } },
  ]).toArray();
  const out = {};
  for (const r of rows) {
    out[r._id.type] = out[r._id.type] || { queued: 0, leased: 0, done: 0, failed: 0 };
    out[r._id.type][r._id.state] = r.n;
  }
  return out;
}

export async function purgeFinished({ olderThanMs = 7 * 86400000 } = {}) {
  const { deletedCount } = await jobs().deleteMany({ state: "done", finishedAt: { $lt: new Date(Date.now() - olderThanMs) } });
  return deletedCount;
}

// Requeue everything that parked as failed for a run — the queue's equivalent of the campaign's
// "Retry N failed" button.
export async function retryFailed(runId = null) {
  const q = { state: "failed", ...(runId ? { runId } : {}) };
  const { modifiedCount } = await jobs().updateMany(q, {
    $set: { state: "queued", attempts: 0, nextRunAt: new Date(), lastError: null, updatedAt: new Date() },
  });
  return modifiedCount;
}
