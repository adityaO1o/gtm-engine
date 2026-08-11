// The Node worker — a SECOND process, not the web one.
//
// This exists because the web container serves Trigify's per-engager /enrich calls and the
// dashboard, and neither can afford to sit behind a client scan. Running both in one process is how
// a long job starves an interactive one; splitting them is the whole point of the queue.
//
// It handles the job types that need the platform's own code (the seed funnel, Prospeo, Mongo
// aggregation). The Go crawler handles the fetch-heavy types from the same queue — neither knows the
// other exists, which is exactly the property that lets either be restarted at any moment.
import { connect } from "./db/mongo.js";
import { lease, complete, fail, heartbeat, purgeFinished, reschedule, PRIORITY } from "./lib/jobs.js";
import { scanClient, rollupAgency, finalizeClientVerdicts } from "./pipeline/agency.js";
import { pushDomains, refreshVerdicts } from "./services/blacklistProject.js";
import { clients } from "./db/mongo.js";
import { log } from "./lib/logger.js";

const TYPES = ["client:scan", "client:verdict", "agency:rollup"];
const WORKER_ID = `node-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "4", 10);
const IDLE_MS = 2000;

let stopping = false;

async function handle(job) {
  switch (job.type) {
    case "client:scan": {
      const res = await scanClient(job.payload);
      // A scan that only QUEUED domains for checking has nothing to roll up yet — the verdict job
      // does that once an answer actually exists. Cached and skipped clients are final immediately.
      if (!res.queuedForVerdicts) {
        const { runId, agencyDomain } = job.payload;
        await reschedule("agency:rollup", { runId, domain: agencyDomain }, {
          key: `agency:rollup:${runId}:${agencyDomain}`,
          runId: job.runId, priority: PRIORITY.CRAWL + 10, delayMs: 60_000,
        }).catch(() => {});
      }
      return res;
    }
    case "client:verdict": {
      const res = await finalizeClientVerdicts(job.payload);
      // Only a FINISHED client changes an agency's totals; a round that is still waiting must not
      // trigger a recount that would read its zero as real.
      if (res.ok && !res.pending) {
        const { runId, agencyDomain } = job.payload;
        await reschedule("agency:rollup", { runId, domain: agencyDomain }, {
          key: `agency:rollup:${runId}:${agencyDomain}`,
          runId: job.runId, priority: PRIORITY.CRAWL + 10, delayMs: 60_000,
        }).catch(() => {});
      }
      return res;
    }
    case "agency:rollup":
      return rollupAgency(job.payload);
    default:
      throw new Error(`unknown job type ${job.type}`);
  }
}

// One lane. Several run concurrently; each leases independently, so a slow job blocks only itself.
async function lane(n) {
  while (!stopping) {
    let job;
    try {
      job = await lease(TYPES, { workerId: `${WORKER_ID}#${n}` });
    } catch (e) {
      log.warn("lease failed", { err: e.message });
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!job) { await new Promise((r) => setTimeout(r, IDLE_MS)); continue; }

    // Keep the lease alive while the job runs. Without this a scan that outlives the lease would be
    // handed to a second worker and done twice.
    const beat = setInterval(() => heartbeat(job._id).catch(() => {}), 60_000);
    try {
      const res = await handle(job);
      await complete(job._id, res && typeof res === "object" ? { ok: res.ok !== false } : null);
    } catch (e) {
      const r = await fail(job._id, e.message);
      log.warn("job failed", { type: job.type, err: e.message, retried: r.retried });
    } finally {
      clearInterval(beat);
    }
  }
}

// ── Batched pushing + mirror refresh ───────────────────────────────────────────────────────────
// The checker allows 120 requests/min and its docs are explicit that the limit counts REQUESTS, not
// domains: "a single request happily takes thousands". Pushing per client would spend that budget on
// a few dozen scans a minute; one batch every few seconds spends almost none of it and lifts the
// ceiling to whatever host.io itself allows.
const PUSH_BATCH_DOMAINS = 4000;

async function pushPending() {
  const docs = await clients().find({ pushed: false, candidates: { $exists: true, $ne: [] } },
    { projection: { candidates: 1 } }).limit(400).toArray().catch(() => []);
  if (!docs.length) return 0;

  const ids = [], domains = new Set();
  for (const d of docs) {
    if (domains.size >= PUSH_BATCH_DOMAINS) break;
    ids.push(d._id);
    for (const c of d.candidates || []) domains.add(c);
  }
  if (!domains.size) return 0;

  await pushDomains([...domains]);
  await clients().updateMany({ _id: { $in: ids } }, { $set: { pushed: true, pushedAt: new Date() } });
  log.info("pushed domains for checking", { clients: ids.length, domains: domains.size });
  return ids.length;
}

function background() {
  // One shared refresh keeps every waiting verdict job current. Previously each scan drove its own
  // polling loop, which is what made the mirror both the bottleneck and the budget.
  setInterval(() => { refreshVerdicts().catch(() => {}); }, 20_000);
  setInterval(() => { pushPending().catch((e) => log.warn("push batch failed", { err: e.message })); }, 8_000);
}

async function main() {
  await connect();
  background();
  log.info("worker up", { workerId: WORKER_ID, types: TYPES, concurrency: CONCURRENCY });

  // Finished jobs are kept a week for debugging, then dropped — the queue is a work log, not an
  // archive, and the agency collections already hold the results.
  setInterval(() => purgeFinished().then((n) => n && log.info("purged finished jobs", { n })).catch(() => {}), 6 * 3600_000);

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => lane(i)));
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    // Stop leasing NEW work and let in-flight jobs finish their current attempt. Anything still
    // running when the process dies keeps its lease, which expires and is picked up again.
    log.info("worker draining", { sig });
    stopping = true;
    setTimeout(() => process.exit(0), 15_000).unref();
  });
}

main().catch((e) => { log.error("worker crashed", { err: e.message }); process.exit(1); });
