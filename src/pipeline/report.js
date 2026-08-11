// Shareable blacklist reports — the artefact a prospect asks for after the cold email says "your
// domains are blacklisted". One report = one seed company, one unguessable URL, no login.
//
// SNAPSHOT, NOT LIVE. The page renders what was true when the report was generated, and says so on
// its face. A live page would quietly empty itself the moment the prospect cleaned their domains up,
// which would make the email that linked to it look like a lie. "Re-check" mints a NEW report and
// leaves the old link intact.
//
// COSTS NOTHING for a seed we have already scanned: campaign_targets already stores every blacklisted
// domain with its zones and risk score, plus the redirect total. Only a seed we have never seen needs
// a host.io call, and the blacklist check itself is our own API.
import { randomBytes } from "crypto";
import { ObjectId } from "mongodb";
import { splitDomain } from "../lib/permute.js";
import { runPool } from "../lib/pool.js";
import { apiRedirectPage } from "../services/hostio.js";
import { pushDomains, syncAllVerdicts, verdictsFor } from "../services/blacklistProject.js";
import { campaignTargets, hostioPages, hostioUsage, reports, leads as leadsCol } from "../db/mongo.js";
import { log } from "../lib/logger.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// URL token. 12 chars of base62 ≈ 71 bits — not enumerable, and short enough to sit in an email
// without wrapping. Ambiguous glyphs are kept: these are copied, never typed by hand.
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function newToken() {
  const b = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += ALPHABET[b[i] % ALPHABET.length];
  return out;
}

export function normalizeSeed(raw) {
  const { label, tld } = splitDomain(raw);
  return label && tld ? `${label}.${tld}` : "";
}

// A human company name for the report header. "acme.com's 507 domains" reads like a machine wrote
// it — the same problem the email copy has, solved the same way.
async function companyNameFor(seed) {
  const t = await campaignTargets().findOne(
    { seed, companyName: { $nin: [null, ""] } }, { projection: { companyName: 1 } },
  ).catch(() => null);
  if (t?.companyName) return t.companyName;
  const l = await leadsCol().findOne(
    { company_domain: seed, company: { $nin: [null, ""] } }, { projection: { company: 1 } },
  ).catch(() => null);
  if (l?.company) return l.company;
  const label = seed.split(".")[0].replace(/[-_]+/g, " ").trim();
  return label ? label.replace(/\b\w/g, (c) => c.toUpperCase()) : seed;
}

// Which zones list these domains, and how many domains each zone caught — the report's "who says so"
// section. A prospect who has never heard of SURBL needs the provider names, not just a count.
function summarizeZones(domains) {
  const counts = new Map();
  for (const d of domains) for (const z of d.zones || []) counts.set(z, (counts.get(z) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([zone, count]) => ({ zone, count }));
}

// Everything we already hold for this seed, from the funnel runs. Zero API calls, zero credits.
async function fromCache(seed) {
  const t = await campaignTargets().findOne(
    { seed, blacklistedDomains: { $exists: true, $ne: [] } },
    { projection: { blacklistedDomains: 1, redirectCount: 1, confirmedCount: 1, companyName: 1, updatedAt: 1 },
      sort: { blacklistedCount: -1 } },
  ).catch(() => null);
  if (!t) return null;
  return {
    domains: (t.blacklistedDomains || []).map((d) => ({ domain: d.domain, zones: d.zones || [], riskScore: d.riskScore ?? null })),
    totalDomains: t.redirectCount ?? null,
    checkedDomains: t.confirmedCount ?? (t.blacklistedDomains || []).length,
    companyName: t.companyName || null,
    scannedAt: t.updatedAt || null,
    source: "cache",
  };
}

// A seed we have never scanned: one host.io page (50 domains) + a blacklist check. This is the only
// path that spends anything, and it spends exactly one API call.
async function freshScan(seed) {
  const cachedPage = await hostioPages().findOne({ _id: `${seed}:1` }).catch(() => null);
  let total = cachedPage?.total ?? null;
  let candidates = cachedPage?.domains || [];

  if (!cachedPage) {
    const res = await apiRedirectPage(seed, 1, {
      onApiCall: async ({ count }) => {
        await hostioUsage().insertOne({ at: new Date(), campaignId: null, seed, page: 1, count, source: "report" }).catch(() => {});
      },
    });
    if (!res.ok) return { error: `could not read ${seed}'s redirect list (host.io ${res.status ?? "failed"})` };
    total = res.total ?? null;
    candidates = res.domains || [];
    await hostioPages().updateOne({ _id: `${seed}:1` },
      { $set: { seed, page: 1, source: "api", total, domains: candidates, at: new Date() } }, { upsert: true }).catch(() => {});
  }

  if (!candidates.length) return { domains: [], totalDomains: total ?? 0, checkedDomains: 0, source: "scan" };

  // Queue whatever the checker hasn't seen, then wait for it — bounded, so one stuck domain can't
  // hang a report the user is watching load.
  let map = await verdictsFor(candidates);
  const unknown = candidates.filter((d) => { const v = map.get(d); return !v || v.status === "pending" || v.status === "checking"; });
  if (unknown.length) {
    await pushDomains(unknown);
    const deadline = Date.now() + 30_000;
    for (;;) {
      await sleep(1500);
      await syncAllVerdicts().catch(() => {});
      map = await verdictsFor(candidates);
      const left = unknown.filter((d) => { const v = map.get(d); return !v || v.status === "pending" || v.status === "checking"; });
      if (!left.length || Date.now() >= deadline) break;
    }
  }

  const domains = [];
  for (const d of candidates) {
    const v = map.get(d);
    if (v && v.status === "listed") domains.push({ domain: d, zones: v.zones || [], riskScore: v.riskScore ?? null });
  }
  return { domains, totalDomains: total ?? candidates.length, checkedDomains: candidates.length, source: "scan" };
}

// Build (or return) a report for one seed.
//   reuse=true  (default) hands back the existing link if there is one — the same company chased
//               twice should not end up with two different URLs in two different emails.
//   force=true  always mints a fresh report; the old link keeps working and keeps its old date.
export async function createReport(rawSeed, { reuse = true, force = false } = {}) {
  const seed = normalizeSeed(rawSeed);
  if (!seed) return { ok: false, error: "that doesn't look like a domain" };

  if (reuse && !force) {
    const existing = await reports().findOne({ seed }, { sort: { generatedAt: -1 } }).catch(() => null);
    if (existing) return { ok: true, token: existing._id, seed, reused: true, blacklistedCount: existing.blacklistedCount };
  }

  const data = (await fromCache(seed)) || (await freshScan(seed));
  if (data.error) return { ok: false, error: data.error };
  if (!data.domains.length) {
    return { ok: false, error: `${seed}: nothing blacklisted found — no report worth sending` };
  }

  data.domains.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0) || (b.zones.length - a.zones.length));
  const token = newToken();
  const doc = {
    _id: token,
    seed,
    companyName: data.companyName || (await companyNameFor(seed)),
    generatedAt: new Date(),
    scannedAt: data.scannedAt || new Date(),
    source: data.source,
    totalDomains: data.totalDomains,
    checkedDomains: data.checkedDomains,
    blacklistedCount: data.domains.length,
    domains: data.domains,
    zoneSummary: summarizeZones(data.domains),
    views: 0,
    lastViewedAt: null,
  };
  await reports().insertOne(doc);
  log.info("blacklist report created", { seed, token, blacklisted: doc.blacklistedCount, source: doc.source });
  return { ok: true, token, seed, reused: false, blacklistedCount: doc.blacklistedCount, source: doc.source };
}

// Public read. Counting views is the only write a visitor causes, and it's fire-and-forget so a
// slow counter never delays the page.
export async function readReport(token) {
  const doc = await reports().findOne({ _id: String(token || "") }).catch(() => null);
  if (!doc) return null;
  reports().updateOne({ _id: doc._id }, { $inc: { views: 1 }, $set: { lastViewedAt: new Date() } }).catch(() => {});
  return doc;
}

export async function listReports({ limit = 200 } = {}) {
  const items = await reports().find({}, {
    projection: { seed: 1, companyName: 1, generatedAt: 1, blacklistedCount: 1, totalDomains: 1, views: 1, lastViewedAt: 1, source: 1 },
  }).sort({ generatedAt: -1 }).limit(limit).toArray();
  return { ok: true, items: items.map((i) => ({ token: i._id, ...i, _id: undefined })) };
}

export async function deleteReport(token) {
  const { deletedCount } = await reports().deleteOne({ _id: String(token || "") });
  return { ok: !!deletedCount, deleted: deletedCount };
}

// Generate reports in bulk for seeds a funnel already scanned — free, since every one of them comes
// from fromCache(). Skips seeds that already have a report so it's safe to re-run.
export async function bulkCreateReports({ campaignId, minBlacklisted = 3, limit = 500 } = {}) {
  const q = { blacklistedCount: { $gte: minBlacklisted }, stage: { $in: ["done", "qualified"] } };
  if (campaignId) {
    if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
    q.campaignId = new ObjectId(campaignId);
  }
  const targets = await campaignTargets().find(q, { projection: { seed: 1 } })
    .sort({ blacklistedCount: -1 }).limit(limit).toArray();
  if (!targets.length) return { ok: false, error: "no scanned companies match that filter" };

  const seeds = [...new Set(targets.map((t) => t.seed))];
  const already = new Set((await reports().find({ seed: { $in: seeds } }, { projection: { seed: 1 } }).toArray()).map((r) => r.seed));
  const todo = seeds.filter((s) => !already.has(s));

  let created = 0, failed = 0;
  await runPool(todo, async (seed) => {
    const r = await createReport(seed, { reuse: false });
    if (r.ok) created++; else failed++;
  }, { concurrency: 8 });

  log.info("bulk blacklist reports", { requested: seeds.length, skipped: already.size, created, failed });
  return { ok: true, matched: seeds.length, alreadyHadReport: already.size, created, failed };
}
