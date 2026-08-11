// AGENCY CRAWL — the second funnel.
//
// An agency's case-study pages are a list of its clients. If those clients are running blacklisted
// sending infrastructure, the agency is the one who has to answer for it — which makes the agency,
// not the client, the prospect. One agency is worth many clients, so this funnel deliberately spends
// more per target than the seed funnel does.
//
//   1  agency:discover   agency.com -> its case-studies / work / clients page   (Go crawler)
//   2  case:extract      that page -> the client behind each case study         (Go crawler)
//   3  client:scan       client domain -> blacklisted infra                     (Node, reuses the
//                                                                                existing funnel)
//   4  agency:rollup     per-agency totals + the report the email links to
//   5  agency:enrich     Prospeo on the AGENCY only — never on a click of ours  (button, on demand)
//
// Prospeo NEVER runs during a crawl. Clients are evidence, not prospects, so they cost zero credits;
// the agency's own decision-makers are pulled later, by hand, and only for agencies that actually
// have something to be told about. That is the same discipline as the seed funnel's `enrich: false`.
import { ObjectId } from "mongodb";
import { splitDomain } from "../lib/permute.js";
import { runPool } from "../lib/pool.js";
import { enqueueMany, queueStats, retryFailed, PRIORITY } from "../lib/jobs.js";
import { isExcludedSeed } from "../services/icp.js";
import { enrichSeed } from "./campaign.js";
import { createReport } from "./report.js";
import { agencyRuns, agencies, clients, campaignTargets, jobs } from "../db/mongo.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

export function parseDomains(raw) {
  const out = new Set();
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[\s,]+/);
  for (const tok of list) {
    const { label, tld } = splitDomain(tok);
    if (label && tld) out.add(`${label}.${tld}`);
  }
  return [...out];
}

// ── Start a run ────────────────────────────────────────────────────────────────────────────────
export async function startAgencyRun(rawDomains, opts = {}) {
  const domains = parseDomains(rawDomains);
  if (!domains.length) return { ok: false, error: "no usable agency domains" };

  const gates = {
    // Scan this many of an agency's clients first. If none are listed, the rest wait behind every
    // other agency's sample — so a dud agency costs 5 scans, not 40. Same shape as the seed funnel's
    // cheap-gates-expensive rule.
    sampleFirst: Number.isFinite(+opts.sampleFirst) ? +opts.sampleFirst : 5,
    // A client needs at least this many blacklisted domains to count as a hit worth pitching.
    blacklistGate: Number.isFinite(+opts.blacklistGate) ? +opts.blacklistGate : config.campaign.blacklistGate,
    maxClientsPerAgency: Number.isFinite(+opts.maxClientsPerAgency) ? +opts.maxClientsPerAgency : 40,
  };

  const { insertedId: runId } = await agencyRuns().insertOne({
    seedCount: domains.length, gates, status: "running", stage: "crawling",
    createdAt: new Date(), startedAt: new Date(), updatedAt: new Date(), finishedAt: null,
  });

  const now = new Date();
  for (let i = 0; i < domains.length; i += 1000) {
    const chunk = domains.slice(i, i + 1000);
    await agencies().bulkWrite(chunk.map((domain) => ({
      updateOne: {
        filter: { runId, domain },
        update: {
          $setOnInsert: {
            runId, domain, stage: "queued", caseStudyUrls: [], pagesFetched: 0,
            clientsFound: 0, clientsScanned: 0, clientsBlacklisted: 0,
            companyName: null, people: [], enrichedAt: null, error: null,
            createdAt: now, updatedAt: now,
          },
        },
        upsert: true,
      },
    })), { ordered: false }).catch((e) => log.warn("agency insert partial", { err: e.message }));

    await enqueueMany(chunk.map((domain) => ({
      type: "agency:discover",
      payload: { runId: String(runId), domain },
      key: `agency:discover:${runId}:${domain}`,
      runId, priority: PRIORITY.CRAWL,
    })));
  }

  log.info("agency run started", { runId: String(runId), agencies: domains.length, gates });
  return { ok: true, id: String(runId), agencies: domains.length, gates };
}

// ── client:scan — the Node half, run by the worker ─────────────────────────────────────────────
// Reuses the seed funnel wholesale rather than reimplementing it: the client is just a seed domain,
// and everything about reading its footprint and checking it is already solved and already cached.
export async function scanClient({ runId, agencyDomain, clientDomain }) {
  const _id = `${agencyDomain}:${clientDomain}`;
  const doc = await clients().findOne({ _id });
  if (!doc) return { ok: false, error: "unknown client" };
  if (doc.scanned) return { ok: true, cached: true, blacklistedCount: doc.blacklistedCount || 0 };

  // Non-ICP clients are evidence we'd never use — a university's mail estate is not a story an
  // agency's sending infra is responsible for.
  if (isExcludedSeed(clientDomain)) {
    await clients().updateOne({ _id }, { $set: { scanned: true, skipped: "non-icp", blacklistedCount: 0, scannedAt: new Date() } });
    return { ok: true, skipped: "non-icp" };
  }

  // Already scanned by ANY earlier run — the seed funnel, another agency's case study, anything.
  // Clients repeat across agencies, so this is the difference between scanning a domain once and
  // scanning it five times.
  const prior = await campaignTargets().findOne(
    { seed: clientDomain, blacklistedDomains: { $exists: true } },
    { projection: { blacklistedCount: 1, blacklistedDomains: 1, redirectCount: 1, confirmedCount: 1, companyName: 1 }, sort: { blacklistedCount: -1 } },
  ).catch(() => null);

  if (prior) {
    await clients().updateOne({ _id }, { $set: {
      scanned: true, source: "cache",
      blacklistedCount: prior.blacklistedCount || 0,
      blacklistedDomains: (prior.blacklistedDomains || []).slice(0, 20),
      redirectCount: prior.redirectCount ?? null,
      clientName: doc.clientName || prior.companyName || null,
      scannedAt: new Date(),
    } });
    return { ok: true, cached: true, blacklistedCount: prior.blacklistedCount || 0 };
  }

  // Never seen: run the real thing. discoverSeed writes into campaign_targets, so the result is
  // reusable by every other agency that lists this client — and by the seed funnel.
  const { runSingleSeed } = await import("./campaign.js");
  const res = await runSingleSeed(clientDomain, { enrich: false }).catch((e) => ({ ok: false, error: e.message }));
  if (!res.ok) {
    await clients().updateOne({ _id }, { $set: { scanned: true, error: res.error || "scan failed", scannedAt: new Date() } });
    return { ok: false, error: res.error };
  }

  await clients().updateOne({ _id }, { $set: {
    scanned: true, source: "scan",
    blacklistedCount: res.blacklistedCount || 0,
    blacklistedDomains: (res.blacklistedDomains || []).slice(0, 20),
    redirectCount: res.redirectCount ?? null,
    scannedAt: new Date(),
  } });
  return { ok: true, blacklistedCount: res.blacklistedCount || 0 };
}

// ── agency:rollup ──────────────────────────────────────────────────────────────────────────────
// Everything the outreach needs, computed once per agency: how many of its clients are listed, which
// ones, and the shareable report the email points at.
export async function rollupAgency({ runId, domain }) {
  const rid = typeof runId === "string" ? new ObjectId(runId) : runId;
  const run = await agencyRuns().findOne({ _id: rid }, { projection: { gates: 1 } });
  const gate = run?.gates?.blacklistGate ?? config.campaign.blacklistGate;

  const rows = await clients().find({ runId: rid, agencyDomain: domain }).toArray();
  const scanned = rows.filter((r) => r.scanned);
  const hits = scanned.filter((r) => (r.blacklistedCount || 0) >= gate)
    .sort((a, b) => (b.blacklistedCount || 0) - (a.blacklistedCount || 0));

  let reportToken = null;
  if (hits.length) {
    const r = await createReport(domain, { reuse: true, agency: { domain, clients: hits } }).catch(() => null);
    if (r?.ok) reportToken = r.token;
  }

  await agencies().updateOne({ runId: rid, domain }, { $set: {
    stage: hits.length ? "hit" : "no-hit",
    clientsFound: rows.length,
    clientsScanned: scanned.length,
    clientsBlacklisted: hits.length,
    topClients: hits.slice(0, 5).map((h) => ({ domain: h.clientDomain, name: h.clientName || null, blacklisted: h.blacklistedCount })),
    blacklistedTotal: hits.reduce((a, h) => a + (h.blacklistedCount || 0), 0),
    reportToken,
    rolledUpAt: new Date(), updatedAt: new Date(),
  } });

  return { ok: true, clients: rows.length, hits: hits.length, reportToken };
}

// ── agency:enrich — the BUTTON ─────────────────────────────────────────────────────────────────
// Prospeo, on the agency domain only, and only when a human asks. Defaults to agencies that actually
// have something to be told — pitching an agency whose clients are all clean has no story, and every
// credit spent there is a credit not spent on one that does.
export async function enrichAgencies(runId, { minHits = 1, limit = 5000, includeDone = false } = {}) {
  if (!ObjectId.isValid(runId)) return { ok: false, error: "bad run id" };
  const rid = new ObjectId(runId);

  const q = { runId: rid, clientsBlacklisted: { $gte: minHits } };
  if (!includeDone) q.enrichedAt = null;
  const targets = await agencies().find(q, { projection: { domain: 1 } })
    .sort({ clientsBlacklisted: -1 }).limit(limit).toArray();
  const total = await agencies().countDocuments(q);
  if (!targets.length) return { ok: false, error: `no agencies with ${minHits}+ blacklisted client(s) awaiting enrichment` };

  await agencyRuns().updateOne({ _id: rid }, { $set: { stage: "enriching", updatedAt: new Date() } });

  (async () => {
    await runPool(targets, async (a) => {
      // enrichSeed writes into campaign_targets, so agency contacts land in the same shape the rest
      // of the platform (SendKit push, CSV export, preview) already understands.
      const t = await campaignTargets().findOneAndUpdate(
        { seed: a.domain, agencyRunId: rid },
        { $setOnInsert: { seed: a.domain, agencyRunId: rid, campaignId: rid, stage: "enriching", createdAt: new Date() } },
        { upsert: true, returnDocument: "after" },
      );
      const target = t?.value || t;
      await enrichSeed({ _id: target._id, seed: a.domain });
      const done = await campaignTargets().findOne({ _id: target._id }, { projection: { people: 1, companyName: 1, peopleCount: 1 } });
      await agencies().updateOne({ runId: rid, domain: a.domain }, { $set: {
        people: done?.people || [], companyName: done?.companyName || null,
        contacts: (done?.people || []).filter((p) => p.email).length,
        enrichedAt: new Date(), updatedAt: new Date(),
      } });
    }, { concurrency: config.campaign.enrichConcurrency });

    await agencyRuns().updateOne({ _id: rid }, { $set: { stage: "done", updatedAt: new Date() } });
    log.info("agency enrichment finished", { runId, enriched: targets.length });
  })().catch((e) => log.error("agency enrichment crashed", { err: e.message, runId }));

  return { ok: true, queued: targets.length, matched: total, truncated: total > targets.length };
}

// ── Reads for the dashboard ────────────────────────────────────────────────────────────────────
export async function getAgencyRun(id) {
  if (!ObjectId.isValid(id)) return null;
  const rid = new ObjectId(id);
  const run = await agencyRuns().findOne({ _id: rid });
  if (!run) return null;

  const byStage = await agencies().aggregate([
    { $match: { runId: rid } }, { $group: { _id: "$stage", n: { $sum: 1 } } },
  ]).toArray();
  const stages = Object.fromEntries(byStage.map((s) => [s._id, s.n]));

  const [clientsFound, clientsScanned, hits, enriched] = await Promise.all([
    clients().countDocuments({ runId: rid }),
    clients().countDocuments({ runId: rid, scanned: true }),
    agencies().countDocuments({ runId: rid, clientsBlacklisted: { $gte: 1 } }),
    agencies().countDocuments({ runId: rid, enrichedAt: { $ne: null } }),
  ]);

  return {
    ...run, id, stages, queue: await queueStats(rid),
    funnel: { agencies: run.seedCount, clientsFound, clientsScanned, agenciesWithHits: hits, enriched },
  };
}

export async function listAgencyRuns(limit = 20, { page = 0 } = {}) {
  const [items, count] = await Promise.all([
    agencyRuns().find({}).sort({ createdAt: -1 }).skip(page * limit).limit(limit).toArray(),
    agencyRuns().countDocuments({}),
  ]);
  return { items, count };
}

export async function agencyResults(id, { q = "", onlyHits = false, page = 0, size = 100 } = {}) {
  if (!ObjectId.isValid(id)) return { items: [], count: 0 };
  const find = { runId: new ObjectId(id) };
  if (onlyHits) find.clientsBlacklisted = { $gte: 1 };
  if (q) find.domain = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const [items, count] = await Promise.all([
    agencies().find(find).sort({ clientsBlacklisted: -1, clientsFound: -1 }).skip(page * size).limit(size).toArray(),
    agencies().countDocuments(find),
  ]);
  return { items, count };
}

export async function agencyClients(id, domain) {
  if (!ObjectId.isValid(id)) return [];
  return clients().find({ runId: new ObjectId(id), agencyDomain: domain })
    .sort({ blacklistedCount: -1 }).toArray();
}

export async function retryAgencyRun(id) {
  if (!ObjectId.isValid(id)) return { ok: false, error: "bad run id" };
  const requeued = await retryFailed(new ObjectId(id));
  return { ok: true, requeued };
}

export async function stopAgencyRun(id) {
  if (!ObjectId.isValid(id)) return { ok: false, error: "bad run id" };
  const rid = new ObjectId(id);
  const { modifiedCount } = await jobs().updateMany(
    { runId: rid, state: { $in: ["queued", "leased"] } },
    { $set: { state: "failed", lastError: "stopped by user", leaseUntil: null, updatedAt: new Date() } },
  );
  await agencyRuns().updateOne({ _id: rid }, { $set: { status: "stopped", stage: "stopped", finishedAt: new Date() } });
  return { ok: true, cancelled: modifiedCount };
}

// The outreach list: one row per agency worth mailing, with its report link and its contacts.
export async function agencyLeadsCsv(id, { minHits = 1 } = {}) {
  if (!ObjectId.isValid(id)) return null;
  const rows = await agencies().find({ runId: new ObjectId(id), clientsBlacklisted: { $gte: minHits } })
    .sort({ clientsBlacklisted: -1 }).toArray();

  const host = process.env.REPORT_PUBLIC_URL || "https://blacklist-report.com";
  const cols = ["email", "firstName", "lastName", "companyName", "jobTitle", "linkedinUrl",
    "agencyDomain", "clientsBlacklisted", "clientsFound", "client1", "client2", "client3", "reportUrl"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = [cols.join(",")];
  const seen = new Set();

  for (const a of rows) {
    const top = (a.topClients || []).map((c) => `${c.domain} (${c.blacklisted})`);
    for (const p of a.people || []) {
      if (!p.email) continue;
      const key = p.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const parts = String(p.name || "").trim().split(/\s+/);
      out.push([
        p.email, p.first_name || parts[0] || "", p.last_name || parts.slice(1).join(" ") || "",
        a.companyName || a.domain, p.job_title || "", p.linkedin_url || "",
        a.domain, a.clientsBlacklisted || 0, a.clientsFound || 0,
        top[0] || "", top[1] || "", top[2] || "",
        a.reportToken ? `${host}/r/${a.reportToken}` : "",
      ].map(esc).join(","));
    }
  }
  return { csv: out.join("\n"), rows: out.length - 1, agencies: rows.length };
}
