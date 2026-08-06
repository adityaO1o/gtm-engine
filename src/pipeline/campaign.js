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
import { scrapeRedirectPage, apiRedirectPage } from "../services/hostio.js";
import { searchPeople, findEmail } from "../services/prospeo.js";
import { pushDomains, getWorkspaceVerdicts } from "../services/blacklistProject.js";
import { createCampaign as createSendkitCampaign, upsertLeads, addLeadsToCampaign, previewEmail, findLeadByEmail, listMailboxes } from "../services/sendkit.js";
import { BLACKLIST_SEQUENCE, leadPayload } from "./blacklistCopy.js";
import { campaigns, campaignTargets, hostioPages, hostioUsage } from "../db/mongo.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_TTL_MS = 7 * 86400000; // cached redirect pages are reused for 7 days

// Page 1 = FREE web scrape (gives total count + ~48 domains). Cached so a re-run never re-scrapes.
async function cachedPage1(seed) {
  const _id = `${seed}:1`;
  const hit = await hostioPages().findOne({ _id }).catch(() => null);
  if (hit && Date.now() - new Date(hit.at).getTime() < PAGE_TTL_MS) return { total: hit.total, domains: hit.domains || [] };
  const page = await scrapeRedirectPage(seed);
  if (page.domains.length || page.total != null) {
    await hostioPages().updateOne({ _id }, { $set: { seed, page: 1, source: "scrape", total: page.total, domains: page.domains, at: new Date() } }, { upsert: true }).catch(() => {});
  }
  return page;
}

// Page >=2 = PAID API (50/page). Cached; a real call is logged to hostio_usage + increments the
// campaign's apiCallsUsed counter (a cache hit does neither — that's the saving).
async function cachedApiPage(campaignId, seed, page) {
  const _id = `${seed}:${page}`;
  const hit = await hostioPages().findOne({ _id }).catch(() => null);
  if (hit && Date.now() - new Date(hit.at).getTime() < PAGE_TTL_MS) return hit.domains || [];
  const res = await apiRedirectPage(seed, page, {
    onApiCall: async ({ count }) => {
      await campaigns().updateOne({ _id: campaignId }, { $inc: { apiCallsUsed: 1 } }).catch(() => {});
      await hostioUsage().insertOne({ at: new Date(), campaignId, seed, page, count, source: "api" }).catch(() => {});
    },
  });
  if (res.ok) await hostioPages().updateOne({ _id }, { $set: { seed, page, source: "api", domains: res.domains, at: new Date() } }, { upsert: true }).catch(() => {});
  return res.domains;
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

// Push a fresh batch of domains to the blacklist checker and wait (via the shared workspace-verdict
// map) until they're checked — then return which are listed. The wait is bounded and the map is
// shared across all seeds, so concurrent seeds' domains get checked together.
async function blacklistOf(domains) {
  if (!domains.length) return [];
  await pushDomains(domains);
  const want = new Set(domains);
  const deadline = Date.now() + 20_000;
  let map = await getWorkspaceVerdicts();
  for (;;) {
    const pending = [...want].filter((d) => { const v = map.get(d); return !v || v.status === "pending" || v.status === "checking"; });
    if (!pending.length || Date.now() >= deadline) break;
    await sleep(2500);
    map = await getWorkspaceVerdicts();
  }
  const out = [];
  for (const d of domains) { const v = map.get(d); if (v && v.status === "listed") out.push({ domain: d, riskScore: v.riskScore ?? null, zones: v.zones || [] }); }
  return out;
}

// One seed's WHOLE independent pipeline: free page-1 (count gate) -> blacklist it -> if < gate,
// lazily pull API pages one at a time, checking each, stopping the instant blacklistGate is reached
// (so a company whose bad domains are on page 1 costs ZERO API calls). Then Prospeo if it qualifies.
async function processSeed(campaignId, t, gates) {
  try {
    await setTarget(t._id, { stage: "scraping", activity: "fetching redirects (free)" });
    const p1 = await cachedPage1(t.seed);
    const count = p1.total;
    await setTarget(t._id, { redirectCount: count });
    if (count == null || count < gates.countGate) {
      await setTarget(t._id, { stage: "dropped_count", activity: null });
      return;
    }

    const seen = new Set();
    const blacklisted = [];
    const feed = async (domains) => {
      const fresh = domains.filter((d) => d && !seen.has(d));
      fresh.forEach((d) => seen.add(d));
      if (fresh.length) blacklisted.push(...await blacklistOf(fresh));
    };

    await setTarget(t._id, { stage: "blacklisting", activity: "checking page 1 (free)" });
    await feed(p1.domains);

    // lazy paid pagination — only if page 1 didn't already clear the gate
    let page = 2, apiPages = 0;
    while (blacklisted.length < gates.blacklistGate && (page - 1) * 50 < count && page <= config.campaign.maxApiPages + 1) {
      await setTarget(t._id, { activity: `checking page ${page} (api)`, apiPagesUsed: apiPages + 1 });
      const domains = await cachedApiPage(campaignId, t.seed, page);
      if (!domains.length) break;
      await feed(domains);
      apiPages++; page++;
    }

    blacklisted.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
    const common = { confirmedCount: seen.size, blacklistedCount: blacklisted.length, blacklistedDomains: blacklisted, apiPagesUsed: apiPages };
    if (blacklisted.length < gates.blacklistGate) {
      await setTarget(t._id, { ...common, stage: "dropped_blacklist", activity: null });
      return;
    }

    await setTarget(t._id, { ...common, stage: "enriching", activity: "finding decision-makers (prospeo)" });
    const { people, total, free, error } = await searchPeople(t.seed);

    // Auto-reveal the decision-makers' emails (search-person masks them) — these are already
    // filtered to Founder/C-Suite/VP/Head/Director, so the per-person enrich credits only go to
    // people worth contacting. Without an email they can't be pushed to SendKit at all.
    if (people.length) {
      await setTarget(t._id, { ...common, people, peopleCount: people.length, activity: `revealing ${people.length} emails (prospeo)` });
      await runPool(people, async (p, i) => {
        const ids = p.linkedin_url ? { linkedin_url: p.linkedin_url }
          : { first_name: p.first_name, last_name: p.last_name, company_domain: t.seed };
        const r = await findEmail(ids);
        people[i].email = r.email || null;
        people[i].email_status = r.email_status || null;
      }, { concurrency: 4 });
    }
    const withEmail = people.filter((p) => p.email).length;
    await setTarget(t._id, {
      ...common, people, peopleCount: people.length, peopleTotal: total, emailsRevealed: true,
      contactsWithEmail: withEmail, prospeoFree: !!free, prospeoError: error || null,
      stage: "done", activity: null,
    });
  } catch (e) {
    await setTarget(t._id, { stage: "error", error: e.message, activity: null });
  }
}

// Fully independent, single-pool run — every seed flows through its whole pipeline on its own, at
// high concurrency, no stage barriers. Contacts stream in as companies qualify.
async function runCampaign(campaignId, targets, gates) {
  await campaigns().updateOne({ _id: campaignId }, { $set: { stage: "running", startedAt: new Date(), updatedAt: new Date() } });
  await runPool(targets, (t) => processSeed(campaignId, t, gates), { concurrency: config.campaign.seedConcurrency });
  await campaigns().updateOne({ _id: campaignId }, { $set: { stage: "done", status: "done", finishedAt: new Date(), updatedAt: new Date() } });
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
    seedCount: seeds.length, gates, status: "running", stage: "queued", apiCallsUsed: 0,
    createdAt: new Date(), startedAt: null, updatedAt: new Date(), finishedAt: null,
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

// Funnel tallies + live activity for the dashboard poll: stage counts, how many seeds are SETTLED vs
// still working (for a real progress bar + ETA), and a sample of what's being processed right now.
const SETTLED = new Set(["done", "dropped_count", "dropped_blacklist", "error", "interrupted"]);
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
  const processed = Object.entries(stages).reduce((a, [k, n]) => a + (SETTLED.has(k) ? n : 0), 0);
  // a few seeds actively being worked, with their current step — the "it's alive" ticker
  const active = await campaignTargets().find(
    { campaignId: _id, stage: { $nin: [...SETTLED, "queued"] } },
    { projection: { seed: 1, stage: 1, activity: 1, blacklistedCount: 1 }, limit: 12, sort: { updatedAt: -1 } },
  ).toArray();
  return { ...campaign, id, stages, processed, active };
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

// ── Push a campaign's qualified prospects into a SendKit campaign ──────────────────────────────
// Creates (once) a DRAFT SendKit campaign carrying the blacklist sequence, upserts every revealed
// decision-maker as a lead with their per-company variables (blacklistedDomainCount, domain1..4, …),
// and adds them to it. Nothing is ever sent: the campaign stays a draft until it's started by hand
// in SendKit — starting a real outbound sequence is deliberately left as a human decision.
export async function pushCampaignToSendkit(campaignId, { campaignName } = {}) {
  if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
  const _id = new ObjectId(campaignId);
  const camp = await campaigns().findOne({ _id });
  if (!camp) return { ok: false, error: "campaign not found" };

  const targets = await campaignTargets().find({ campaignId: _id, stage: "done", peopleCount: { $gt: 0 } }).toArray();
  const leads = [];
  for (const t of targets) {
    for (const p of t.people || []) {
      if (p.email) leads.push(leadPayload(p, t));
    }
  }
  if (!leads.length) return { ok: false, error: "no contacts with a revealed email yet" };

  // All blacklist prospecting funnels feed ONE standing SendKit campaign ("Blacklist Campaign"), so
  // every run's leads land in the same sequence instead of scattering across a campaign per run.
  // Falls back to creating a per-run campaign only if that standing id isn't configured.
  let sendkitCampaignId = config.sendkit.blacklistCampaignId || camp.sendkitCampaignId;
  if (!sendkitCampaignId) {
    const name = campaignName || `Blacklist campaign — ${new Date(camp.createdAt).toISOString().slice(0, 10)}`;
    const created = await createSendkitCampaign(name, BLACKLIST_SEQUENCE);
    if (!created.ok) return { ok: false, error: `could not create SendKit campaign: ${created.error}` };
    sendkitCampaignId = created.id;
  }
  if (sendkitCampaignId !== camp.sendkitCampaignId) {
    await campaigns().updateOne({ _id }, { $set: { sendkitCampaignId, updatedAt: new Date() } });
  }

  const up = await upsertLeads(leads);                                   // creates/updates + custom fields
  const add = await addLeadsToCampaign(sendkitCampaignId, leads.map((l) => l.email));
  await campaigns().updateOne({ _id }, { $set: { sendkitPushedAt: new Date(), sendkitLeadCount: leads.length, updatedAt: new Date() } });

  log.info("pushed campaign to sendkit", { campaignId, sendkitCampaignId, leads: leads.length, added: add.added, skipped: add.skipped });
  return { ok: true, sendkitCampaignId, leads: leads.length, upserted: up.ok, failed: up.failed, added: add.added, alreadyIn: add.skipped };
}

// Render one of the sequence's emails exactly as SendKit would send it for a given lead — no send.
export async function previewCampaignEmail(campaignId, { email, step = 1 }) {
  if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
  const camp = await campaigns().findOne({ _id: new ObjectId(campaignId) });
  if (!camp?.sendkitCampaignId) return { ok: false, error: "push to SendKit first" };
  const lead = await findLeadByEmail(email);
  if (!lead) return { ok: false, error: "lead not found in SendKit" };
  const boxes = await listMailboxes();
  if (!boxes.length) return { ok: false, error: "no mailbox in the SendKit workspace to preview as" };
  return previewEmail(camp.sendkitCampaignId, { sequenceStep: step, leadId: lead.id, mailboxId: boxes[0].id });
}

// host.io PAID API usage — totals + recent calls, for the tracking view.
export async function hostioUsageReport() {
  const [total, today, recent] = await Promise.all([
    hostioUsage().countDocuments({}),
    hostioUsage().countDocuments({ at: { $gte: new Date(Date.now() - 86400000) } }),
    hostioUsage().find({}, { projection: { _id: 0 } }).sort({ at: -1 }).limit(50).toArray(),
  ]);
  return { totalApiCalls: total, last24h: today, recent };
}
