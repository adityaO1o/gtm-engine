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
import { campaignTargets, hostioPages, hostioUsage, reports, reportRequests, leads as leadsCol } from "../db/mongo.js";
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

// The registrable domain — subdomains dropped. splitDomain keeps them (a funnel seed is a specific
// host), but "does this person work here" is a question about the company, not the host.
//   mail.acme.com -> acme.com      acme.co.uk -> acme.co.uk      mail.acme.co.uk -> acme.co.uk
export function registrable(raw) {
  const { label, tld } = splitDomain(raw);
  if (!label || !tld) return "";
  const bits = label.split(".").filter(Boolean);
  return `${bits[bits.length - 1]}.${tld}`;
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
export async function createReport(rawSeed, { reuse = true, force = false, agency = null } = {}) {
  const seed = normalizeSeed(rawSeed);
  if (!seed) return { ok: false, error: "that doesn't look like a domain" };

  // An AGENCY report is a different document: it is about somebody else's clients, so it carries a
  // list of companies rather than a list of domains. The agency's own footprint is not the story.
  if (agency) return createAgencyReport(seed, agency, { reuse, force });

  if (reuse && !force) {
    const existing = await reports().findOne({ seed, kind: { $ne: "agency" } }, { sort: { generatedAt: -1 } }).catch(() => null);
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

// One report covering several of an agency's clients. Rebuilt on every rollup (the client list
// changes as scans land), but the TOKEN is stable per agency — the link in a sent email must not
// stop working because the numbers moved.
export async function createAgencyReport(agencyDomain, agency, { reuse = true, force = false } = {}) {
  const existing = await reports().findOne({ seed: agencyDomain, kind: "agency" }).catch(() => null);
  if (existing && reuse && !force && !agency?.clients) {
    return { ok: true, token: existing._id, seed: agencyDomain, reused: true, blacklistedCount: existing.blacklistedCount };
  }

  const clientDocs = (agency.clients || []).map((c) => ({
    domain: c.clientDomain || c.domain,
    name: c.clientName || c.name || null,
    blacklistedCount: c.blacklistedCount || 0,
    checkedDomains: c.redirectCount ?? null,
    domains: (c.blacklistedDomains || []).slice(0, 8).map((d) => ({ domain: d.domain, zones: d.zones || [], riskScore: d.riskScore ?? null })),
  })).filter((c) => c.domain);
  if (!clientDocs.length) return { ok: false, error: "no blacklisted clients to report" };

  const allZones = clientDocs.flatMap((c) => c.domains.flatMap((d) => d.zones || []));
  const zoneCounts = new Map();
  for (const z of allZones) zoneCounts.set(z, (zoneCounts.get(z) || 0) + 1);

  const doc = {
    kind: "agency",
    seed: agencyDomain,
    companyName: agency.companyName || (await companyNameFor(agencyDomain)),
    generatedAt: new Date(),
    scannedAt: new Date(),
    source: "agency-crawl",
    clientCount: clientDocs.length,
    blacklistedCount: clientDocs.reduce((a, c) => a + c.blacklistedCount, 0),
    clients: clientDocs.sort((a, b) => b.blacklistedCount - a.blacklistedCount),
    zoneSummary: [...zoneCounts.entries()].sort((a, b) => b[1] - a[1]).map(([zone, count]) => ({ zone, count })),
    views: existing?.views || 0,
    lastViewedAt: existing?.lastViewedAt || null,
  };

  if (existing) {
    await reports().updateOne({ _id: existing._id }, { $set: doc });
    return { ok: true, token: existing._id, seed: agencyDomain, reused: true, blacklistedCount: doc.blacklistedCount };
  }
  const token = newToken();
  await reports().insertOne({ _id: token, ...doc });
  log.info("agency report created", { agency: agencyDomain, token, clients: clientDocs.length });
  return { ok: true, token, seed: agencyDomain, reused: false, blacklistedCount: doc.blacklistedCount };
}

// Public read. Counting views is the only write a visitor causes, and it's fire-and-forget so a
// slow counter never delays the page.
export async function readReport(token) {
  const doc = await reports().findOne({ _id: String(token || "") }).catch(() => null);
  if (!doc) return null;
  reports().updateOne({ _id: doc._id }, { $inc: { views: 1 }, $set: { lastViewedAt: new Date() } }).catch(() => {});
  return doc;
}

const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

export async function listReports({ q = "", page = 0, size = 50 } = {}) {
  const find = q ? { $or: [{ seed: rx(q) }, { companyName: rx(q) }] } : {};
  const [items, count] = await Promise.all([
    reports().find(find, {
      projection: { seed: 1, companyName: 1, generatedAt: 1, blacklistedCount: 1, totalDomains: 1, views: 1, lastViewedAt: 1, source: 1 },
    }).sort({ generatedAt: -1 }).skip(page * size).limit(size).toArray(),
    reports().countDocuments(find),
  ]);
  return { ok: true, count, items: items.map((i) => ({ token: i._id, ...i, _id: undefined })) };
}

export async function deleteReport(token) {
  const { deletedCount } = await reports().deleteOne({ _id: String(token || "") });
  return { ok: !!deletedCount, deleted: deletedCount };
}

// ── Inbound requests from the public landing page ──────────────────────────────────────────────
// A visitor asks for their own company's report. The gate is that the email's domain must BE the
// company domain they typed: it proves they work there, keeps a competitor from pulling a rival's
// footprint, and gives us an address the report can actually be sent to.

// Free-mail providers. Not an anti-abuse measure so much as the whole point: a gmail address tells
// us nothing about which company's infrastructure the visitor is entitled to see.
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
  "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "rediffmail.com", "tutanota.com",
  "hey.com", "fastmail.com", "hushmail.com", "qq.com", "163.com", "126.com", "naver.com",
]);

export function validateRequest(rawEmail, rawDomain) {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, field: "email", error: "That doesn't look like a valid email address." };

  const emailDomain = email.split("@")[1];
  if (FREE_MAIL.has(emailDomain)) {
    return { ok: false, field: "email", error: "Please use your work email — a personal address can't be matched to a company." };
  }

  const seed = registrable(rawDomain);
  if (!seed) return { ok: false, field: "domain", error: "That doesn't look like a valid company domain." };

  // Compare REGISTRABLE domains, so mail.acme.com and acme.com are the same company. Plenty of
  // companies mail from a subdomain, and a visitor typing "mail.acme.com" is not an impostor —
  // rejecting them would be a bug wearing the costume of a security check. A rival still can't pass,
  // because they'd need an address at acme.com to begin with.
  if (registrable(emailDomain) !== seed) {
    return { ok: false, field: "domain", error: `Your email is @${emailDomain}, which doesn't match ${seed}. Both must be the same company.` };
  }
  return { ok: true, email, seed };
}

export async function createRequest(rawEmail, rawDomain, meta = {}) {
  const v = validateRequest(rawEmail, rawDomain);
  if (!v.ok) return v;

  const now = new Date();
  // Upsert on email+seed: refreshing the form or double-clicking submit must not queue a second
  // request, and a returning visitor should update their existing one rather than duplicate it.
  await reportRequests().updateOne(
    { email: v.email, seed: v.seed },
    {
      $set: { updatedAt: now, ip: meta.ip || null, userAgent: (meta.userAgent || "").slice(0, 200) },
      $setOnInsert: { email: v.email, seed: v.seed, status: "new", createdAt: now, reportToken: null },
      $inc: { submissions: 1 },
    },
    { upsert: true },
  );
  log.info("report requested", { seed: v.seed, email: v.email });

  // If a funnel already scanned this company, the report costs nothing and can be ready before we
  // even reply — so build it in the background and attach it. Never blocks the visitor's response.
  createReport(v.seed, { reuse: true })
    .then((r) => { if (r.ok) return reportRequests().updateOne({ email: v.email, seed: v.seed }, { $set: { reportToken: r.token, blacklistedCount: r.blacklistedCount } }); })
    .catch(() => {});

  return { ok: true, email: v.email, seed: v.seed };
}

export async function listRequests({ status = "", page = 0, size = 50 } = {}) {
  const find = status ? { status } : {};
  const [items, count] = await Promise.all([
    reportRequests().find(find).sort({ createdAt: -1 }).skip(page * size).limit(size).toArray(),
    reportRequests().countDocuments(find),
  ]);
  return { ok: true, count, items };
}

export async function setRequestStatus(id, status) {
  if (!["new", "sent", "ignored"].includes(status)) return { ok: false, error: "bad status" };
  if (!ObjectId.isValid(id)) return { ok: false, error: "bad id" };
  await reportRequests().updateOne({ _id: new ObjectId(id) }, { $set: { status, updatedAt: new Date() } });
  return { ok: true };
}

// Generate reports in bulk for seeds a funnel already scanned — free, since every one of them comes
// from fromCache(). Skips seeds that already have a report so it's safe to re-run.
export async function bulkCreateReports({ campaignId, minBlacklisted = 3, limit = 50_000 } = {}) {
  const q = { blacklistedCount: { $gte: minBlacklisted }, stage: { $in: ["done", "qualified"] } };
  if (campaignId) {
    if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
    q.campaignId = new ObjectId(campaignId);
  }
  const [targets, total] = await Promise.all([
    campaignTargets().find(q, { projection: { seed: 1 } }).sort({ blacklistedCount: -1 }).limit(limit).toArray(),
    campaignTargets().countDocuments(q),
  ]);
  if (!targets.length) return { ok: false, error: "no scanned companies match that filter" };

  // Say so when the cap bit. Sorting by blacklistedCount desc means a silent truncation drops the
  // LOW end — so the run looks complete while exactly the weakest-but-still-qualifying companies
  // are missing, which is indistinguishable from "those had no reports to make".
  const truncated = total > targets.length;
  if (truncated) log.warn("bulk reports hit the limit", { matched: total, taken: targets.length, dropped: total - targets.length });

  const seeds = [...new Set(targets.map((t) => t.seed))];
  const already = new Set((await reports().find({ seed: { $in: seeds } }, { projection: { seed: 1 } }).toArray()).map((r) => r.seed));
  const todo = seeds.filter((s) => !already.has(s));

  let created = 0, failed = 0;
  await runPool(todo, async (seed) => {
    const r = await createReport(seed, { reuse: false });
    if (r.ok) created++; else failed++;
  }, { concurrency: 8 });

  log.info("bulk blacklist reports", { requested: seeds.length, skipped: already.size, created, failed, truncated });
  return { ok: true, matched: seeds.length, alreadyHadReport: already.size, created, failed, truncated, ...(truncated ? { notCovered: total - targets.length } : {}) };
}
