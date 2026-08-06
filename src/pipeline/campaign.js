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
import { pushDomains, refreshVerdicts, verdictsFor } from "../services/blacklistProject.js";
import { createCampaign as createSendkitCampaign, upsertLeads, addLeadsToCampaign, previewEmail, findLeadByEmail, listMailboxes, listCampaigns as listSendkitCampaigns } from "../services/sendkit.js";
import { BLACKLIST_SEQUENCE, BLACKLIST_CAMPAIGN_NAME, leadPayload } from "./blacklistCopy.js";
import { campaigns, campaignTargets, hostioPages, hostioUsage, leads } from "../db/mongo.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_TTL_MS = 7 * 86400000; // cached redirect pages are reused for 7 days

// Page 1 = FREE web scrape (gives total count + ~48 domains). Cached so a re-run never re-scrapes.
async function cachedPage1(seed) {
  const _id = `${seed}:1`;
  const hit = await hostioPages().findOne({ _id }).catch(() => null);
  if (hit && Date.now() - new Date(hit.at).getTime() < PAGE_TTL_MS) return { ok: true, total: hit.total, domains: hit.domains || [] };
  const page = await scrapeRedirectPage(seed);
  // Only cache a page we actually read. Caching a failed fetch would freeze a false "no redirects"
  // for a week.
  if (page.ok) {
    await hostioPages().updateOne({ _id }, { $set: { seed, page: 1, source: "scrape", total: page.total, domains: page.domains, at: new Date() } }, { upsert: true }).catch(() => {});
  }
  return page;
}

// Page >=2 = PAID API (50/page). Cached; a real call is logged to hostio_usage + increments the
// campaign's apiCallsUsed counter (a cache hit does neither — that's the saving).
async function cachedApiPage(campaignId, seed, page) {
  const _id = `${seed}:${page}`;
  const hit = await hostioPages().findOne({ _id }).catch(() => null);
  if (hit && Date.now() - new Date(hit.at).getTime() < PAGE_TTL_MS) return { ok: true, domains: hit.domains || [] };
  const res = await apiRedirectPage(seed, page, {
    onApiCall: async ({ count }) => {
      await campaigns().updateOne({ _id: campaignId }, { $inc: { apiCallsUsed: 1 } }).catch(() => {});
      await hostioUsage().insertOne({ at: new Date(), campaignId, seed, page, count, source: "api" }).catch(() => {});
    },
  });
  if (res.ok) await hostioPages().updateOne({ _id }, { $set: { seed, page, source: "api", domains: res.domains, at: new Date() } }, { upsert: true }).catch(() => {});
  return res;   // { ok, domains } — ok:false means the fetch failed, not that the list ended
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

  // Anything we already have a verdict for locally needs no round-trip at all.
  let map = await verdictsFor(domains);
  const unknown = domains.filter((d) => { const v = map.get(d); return !v || v.status === "pending" || v.status === "checking"; });

  if (unknown.length) {
    await pushDomains(unknown);                       // queues only the ones we don't know yet
    const deadline = Date.now() + 20_000;
    for (;;) {
      await sleep(1200);
      await refreshVerdicts();                        // incremental: a page or two, not the workspace
      map = await verdictsFor(domains);
      const stillUnknown = unknown.filter((d) => { const v = map.get(d); return !v || v.status === "pending" || v.status === "checking"; });
      if (!stillUnknown.length || Date.now() >= deadline) break;
    }
  }

  const out = [];
  for (const d of domains) { const v = map.get(d); if (v && v.status === "listed") out.push({ domain: d, riskScore: v.riskScore ?? null, zones: v.zones || [] }); }
  return out;
}

// DISCOVERY for one seed: free page-1 (count gate) -> blacklist it -> if still under the gate,
// lazily pull API pages one at a time, stopping the instant blacklistGate is reached (so a company
// whose bad domains are on page 1 costs ZERO API calls). Qualified seeds are handed to onQualified()
// rather than enriched here — enrichment runs in its own lane so it can't stall discovery.
async function discoverSeed(campaignId, t, gates, onQualified) {
  try {
    await setTarget(t._id, { stage: "scraping", activity: "fetching redirects (free)" });
    const p1 = await cachedPage1(t.seed);
    // Couldn't READ the page (all proxies + direct failed). That's not a verdict — record it as an
    // error so a resume retries it, instead of burying the seed in dropped_count, which is final.
    if (!p1.ok) {
      await setTarget(t._id, { stage: "error", error: "host.io page unreadable", activity: null });
      return;
    }
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
    let page = 2, apiPages = 0, pageFailed = false;
    while (blacklisted.length < gates.blacklistGate && (page - 1) * 50 < count && page <= config.campaign.maxApiPages + 1) {
      await setTarget(t._id, { activity: `checking page ${page} (api)` });
      const res = await cachedApiPage(campaignId, t.seed, page);
      if (!res.ok) { pageFailed = true; break; }   // API error — we did NOT see the rest of this footprint
      if (!res.domains.length) break;              // genuinely the end of the list
      await feed(res.domains);
      apiPages++; page++;
    }

    blacklisted.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
    const common = { confirmedCount: seen.size, blacklistedCount: blacklisted.length, blacklistedDomains: blacklisted, apiPagesUsed: apiPages };
    if (blacklisted.length < gates.blacklistGate) {
      // If a page fetch failed we never saw part of this company's footprint, so "not enough
      // blacklisted" isn't a real verdict — leave it retryable rather than dropping it for good.
      if (pageFailed) {
        await setTarget(t._id, { ...common, stage: "error", error: "host.io api page failed mid-pagination", activity: null });
        return;
      }
      await setTarget(t._id, { ...common, stage: "dropped_blacklist", activity: null });
      return;
    }

    // Qualified — hand off to the enrichment lane and free this slot immediately. Prospeo is globally
    // rate-limited, so doing it inline would pin a discovery slot for the whole enrich (at 4.6k seeds
    // that pinned 19/20 slots and pushed the run's ETA to ~38h).
    await setTarget(t._id, { ...common, stage: "enrich_queued", activity: "waiting for contact lookup" });
    onQualified(t);
  } catch (e) {
    await setTarget(t._id, { stage: "error", error: e.message, activity: null });
  }
}

// Contacts we ALREADY own for this company — our hot/warm engagers whose work email is on this
// domain. These seed lists are built from those very leads, so when Prospeo returns nothing for a
// company we usually still have a real, already-verified person there. Costs zero credits.
async function ownLeadsFor(seed) {
  const base = { email_status: { $in: ["verified", "unverified"] }, dnc: { $ne: true } };
  // company_domain is indexed, so try it first. It isn't populated on every lead, so fall back to a
  // suffix match on email — that one can't use an index (a trailing-anchored regex forces a scan),
  // which is why it's the fallback and not the primary query.
  let rows = await leads().find({ ...base, company_domain: seed }).sort({ score: -1 }).limit(10).toArray().catch(() => []);
  if (!rows.length) {
    const rx = new RegExp("@" + seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
    rows = await leads().find({ ...base, email: rx }).sort({ score: -1 }).limit(10).toArray().catch(() => []);
  }

  return rows.map((l) => {
    const parts = String(l.name || "").trim().split(/\s+/);
    return {
      prospeo_id: null,
      name: l.name || null,
      first_name: parts[0] || null,
      last_name: parts.slice(1).join(" ") || null,
      job_title: l.headline || null,
      seniority: null,
      department: null,
      linkedin_url: l.linkedin_url || null,
      email: l.email,
      email_status: l.email_status === "verified" ? "VERIFIED" : null,
      company: l.company || null,
      source: "gtm-lead",          // came from our own engagement data, not Prospeo
    };
  });
}

// A human company name for the copy. Without this the email reads "Pulled a scan on acme.com's …"
// instead of "on Acme's …" — the seed is a domain, so somebody has to supply the real name.
async function companyNameFor(seed, people) {
  const fromPeople = people.find((p) => p.company)?.company;
  if (fromPeople) return fromPeople;
  const lead = await leads().findOne(
    { $or: [{ company_domain: seed }, { email: new RegExp("@" + seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }], company: { $nin: [null, ""] } },
    { projection: { company: 1 } },
  ).catch(() => null);
  return lead?.company || null;
}

// The Prospeo half, run in its own small lane so it never blocks discovery.
async function enrichSeed(t) {
  try {
    await setTarget(t._id, { stage: "enriching", activity: "finding decision-makers (prospeo)" });
    const { people, total, free, error } = await searchPeople(t.seed);

    // Auto-reveal the decision-makers' emails (search-person masks them) — these are already
    // filtered to Founder/C-Suite/VP/Head/Director, so the per-person enrich credits only go to
    // people worth contacting. Without an email they can't be pushed to SendKit at all.
    // Reveal only the top N decision-makers' emails. Each reveal is its own rate-limited Prospeo
    // call, so revealing all 25 a search can return is what actually made runs slow and expensive;
    // the rest keep their masked record and can be revealed on demand from the UI later.
    const toReveal = people.slice(0, config.campaign.revealPerCompany);
    if (toReveal.length) {
      await setTarget(t._id, { people, peopleCount: people.length, activity: `revealing ${toReveal.length} of ${people.length} emails (prospeo)` });
      await runPool(toReveal, async (p, i) => {
        const ids = p.linkedin_url ? { linkedin_url: p.linkedin_url }
          : { first_name: p.first_name, last_name: p.last_name, company_domain: t.seed };
        const r = await findEmail(ids);
        people[i].email = r.email || null;
        people[i].email_status = r.email_status || null;
      }, { concurrency: 4 });
    }
    let withEmail = people.filter((p) => p.email).length;
    let fromOwnLeads = 0;

    // Prospeo found nobody reachable — fall back to the engagers we already have at this company.
    if (!withEmail) {
      const own = await ownLeadsFor(t.seed);
      if (own.length) {
        const have = new Set(people.map((p) => (p.email || "").toLowerCase()).filter(Boolean));
        for (const o of own) if (!have.has(o.email.toLowerCase())) people.push(o);
        fromOwnLeads = own.length;
        withEmail = people.filter((p) => p.email).length;
      }
    }

    await setTarget(t._id, {
      people, peopleCount: people.length, peopleTotal: total, emailsRevealed: true,
      contactsWithEmail: withEmail, contactsFromOwnLeads: fromOwnLeads,
      companyName: await companyNameFor(t.seed, people),
      prospeoFree: !!free, prospeoError: error || null,
      stage: "done", activity: null,
    });
  } catch (e) {
    await setTarget(t._id, { stage: "error", error: e.message, activity: null });
  }
}

// TWO INDEPENDENT LANES, run concurrently:
//   discovery  — free scrape + blacklist (+ occasional API page), wide concurrency
//   enrichment — Prospeo search + email reveal, small concurrency
// They must not share a pool. Prospeo is globally rate-limited (~85/min), so when enrichment ran
// inline it pinned nearly every discovery slot waiting on it: a 4,598-seed run measured 0.03
// seeds/sec (~38h ETA) with 19 of 20 slots parked in "enriching". Split like this, discovery runs at
// its own speed and enrichment trickles along behind it.
async function runCampaign(campaignId, targets, gates) {
  await campaigns().updateOne({ _id: campaignId }, { $set: { stage: "running", startedAt: new Date(), updatedAt: new Date() } });
  // Warm the local verdict mirror once up front (first run pulls the existing workspace; after that
  // every refresh is incremental) so seeds don't each pay for it.
  await refreshVerdicts().catch(() => {});

  const queue = [];
  let discoveryDone = false;

  const enrichLane = (async () => {
    const inFlight = new Set();
    while (!discoveryDone || queue.length || inFlight.size) {
      while (queue.length && inFlight.size < config.campaign.enrichConcurrency) {
        const t = queue.shift();
        const p = enrichSeed(t).finally(() => inFlight.delete(p));
        inFlight.add(p);
      }
      await (inFlight.size ? Promise.race(inFlight) : sleep(500));
    }
  })();

  await runPool(targets, (t) => discoverSeed(campaignId, t, gates, (q) => queue.push(q)),
    { concurrency: config.campaign.seedConcurrency });
  discoveryDone = true;
  await campaigns().updateOne({ _id: campaignId }, { $set: { stage: "enriching", updatedAt: new Date() } });

  await enrichLane;
  await campaigns().updateOne({ _id: campaignId }, { $set: { stage: "done", status: "done", finishedAt: new Date(), updatedAt: new Date() } });
  log.info("campaign finished", { campaignId: String(campaignId) });
}

// Resume a campaign that was interrupted (deploy/crash) or stalled — WITHOUT redoing settled seeds.
// Anything already done/dropped keeps its result (crucially, a `done` seed keeps its Prospeo data so
// its credits aren't spent twice); only the unsettled remainder is put back through the lanes.
export async function resumeCampaign(id) {
  if (!ObjectId.isValid(id)) return { ok: false, error: "bad campaign id" };
  const _id = new ObjectId(id);
  const camp = await campaigns().findOne({ _id });
  if (!camp) return { ok: false, error: "campaign not found" };
  if (camp.status === "running") return { ok: false, error: "already running" };

  // Only a real verdict is final. "interrupted" (killed mid-flight by a deploy) and "error"
  // (possibly transient) are exactly what a resume is for, so they go back through the lanes —
  // unlike SETTLED, which counts interrupted as finished for a dead run's progress display.
  const FINAL = ["done", "dropped_count", "dropped_blacklist"];
  const pending = await campaignTargets().find({ campaignId: _id, stage: { $nin: FINAL } }).toArray();
  if (!pending.length) {
    await campaigns().updateOne({ _id }, { $set: { status: "done", stage: "done", finishedAt: new Date() } });
    return { ok: true, resumed: 0, alreadySettled: camp.seedCount, note: "nothing left to process" };
  }

  await campaigns().updateOne({ _id }, { $set: { status: "running", stage: "running", finishedAt: null, updatedAt: new Date() } });
  const gates = camp.gates || { countGate: config.campaign.countGate, blacklistGate: config.campaign.blacklistGate };

  runCampaign(_id, pending, gates).catch((e) => {
    log.error("campaign resume crashed", { err: e.message, id });
    campaigns().updateOne({ _id }, { $set: { status: "error", error: e.message, finishedAt: new Date() } }).catch(() => {});
  });

  return { ok: true, resumed: pending.length, alreadySettled: camp.seedCount - pending.length };
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
// A seed counts as processed only once it has a REAL verdict. "interrupted" is deliberately not in
// here: those are seeds a deploy killed mid-flight, which a resume puts back through the lanes —
// counting them as processed made a resumed 4.6k run read "4568/4598 done" while 4,309 were still
// queued, and produced a meaningless ETA.
const SETTLED = new Set(["done", "dropped_count", "dropped_blacklist", "error"]);
const NOT_ACTIVE = new Set([...SETTLED, "queued", "interrupted"]); // neither working nor finished
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
  // Discovery is the throughput signal: a seed handed to the (slower) enrichment lane is done being
  // discovered even though it hasn't settled yet, so progress/ETA should count it.
  const discovered = processed + (stages.enrich_queued || 0) + (stages.enriching || 0);
  // a few seeds actively being worked, with their current step — the "it's alive" ticker
  const active = await campaignTargets().find(
    { campaignId: _id, stage: { $nin: [...NOT_ACTIVE] } },
    { projection: { seed: 1, stage: 1, activity: 1, blacklistedCount: 1 }, limit: 12, sort: { updatedAt: -1 } },
  ).toArray();
  return { ...campaign, id, stages, processed, discovered, active };
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

  // All blacklist prospecting funnels feed ONE standing SendKit campaign, so every run's leads land
  // in the same sequence instead of scattering across a campaign per run. It's resolved BY NAME from
  // SendKit (no env var / redeploy needed to point at it): an explicit id override wins, otherwise we
  // find the existing "Blacklist Campaign", otherwise we create it once.
  const standingName = campaignName || BLACKLIST_CAMPAIGN_NAME;
  let sendkitCampaignId = config.sendkit.blacklistCampaignId;
  if (!sendkitCampaignId) {
    const existing = (await listSendkitCampaigns()).find(
      (c) => String(c.name || "").trim().toLowerCase() === standingName.toLowerCase() && c.status !== "archived",
    );
    sendkitCampaignId = existing?.id;
  }
  if (!sendkitCampaignId) {
    const created = await createSendkitCampaign(standingName, BLACKLIST_SEQUENCE);
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

// Retro-fill contacts for companies already finished with nobody reachable, using the engagers we
// already own at that domain. Free (no Prospeo), and safe to re-run — it only touches targets that
// still have no contactable email.
export async function backfillOwnLeadContacts(campaignId) {
  if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
  const _id = new ObjectId(campaignId);
  const targets = await campaignTargets().find({
    campaignId: _id, stage: "done",
    $or: [{ contactsWithEmail: { $in: [0, null] } }, { contactsWithEmail: { $exists: false } }],
  }).toArray();

  let filled = 0, contacts = 0;
  await runPool(targets, async (t) => {
    const people = (t.people || []).slice();
    if (people.some((p) => p.email)) return;             // already reachable — leave it alone
    const own = await ownLeadsFor(t.seed);
    if (!own.length) return;
    people.push(...own);
    filled++; contacts += own.length;
    await setTarget(t._id, {
      people, peopleCount: people.length,
      contactsWithEmail: people.filter((p) => p.email).length,
      contactsFromOwnLeads: own.length,
    });
  }, { concurrency: 10 });

  return { ok: true, scanned: targets.length, companiesFilled: filled, contactsAdded: contacts };
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
