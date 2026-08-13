// Campaign funnel: take a list of seed company domains and walk them through a progressive,
// credit-conscious funnel — cheap checks gate expensive ones, so paid calls only ever touch qualified
// prospects.
//
//   Stage 1  host.io redirect COUNT      1 host.io call/seed        gate: count >= countGate (def 50)
//   Stage 2  free discovery              host.io scrape (+ paid API pagination if needed) — REAL domains
//   Stage 2b guessed discovery (OPT-IN)  permutation -> DNS -> HTTP redirect-confirm  (no credits, gates.guess)
//   Stage 3  blacklist check             our own API                gate: blacklisted >= blacklistGate (def 3)
//   Stage 4  Prospeo search-person       1 credit/qualified company  -> people + roles (emails masked)
//   Stage 5  email reveal + copy         DEFERRED (not built yet)
//
// Stage 2b used to be the ONLY discovery path, then got dropped for host.io scraping — permutation
// guessing only finds brand-name-shaped domains, which turned out to be a tiny fraction of a company's
// real footprint (coldoutbound.com: 703 real redirects, 3 contained the brand name). It's back here as
// an OPT-IN supplementary source, off by default: every domain it finds is still DNS + HTTP-redirect
// CONFIRMED (not a blind guess sent to the blacklist checker), but coverage is low and mostly noise, so
// it only runs when a caller explicitly asks (gates.guess) and every domain it contributes is tagged
// `source: "guessed"` so nobody mistakes it for host.io's index. host.io-sourced domains are tagged
// `source: "hostio"` — the distinction the campaign UI shows per domain.
//
// Everything is written incrementally into campaign_targets so the dashboard can poll the live funnel.
import { ObjectId } from "mongodb";
import { generateCandidates, splitDomain } from "../lib/permute.js";
import { runPool, createLimiter } from "../lib/pool.js";
import { scrapeRedirectPage, apiRedirectPage, scrapeUsable, liveRedirectDomains } from "../services/hostio.js";
import { domainHasDns } from "../services/domainDns.js";
import { redirectsToSeed } from "../services/redirectCheck.js";
import { searchPeople, findEmail } from "../services/prospeo.js";
import { pushDomains, refreshVerdicts, syncAllVerdicts, verdictsFor } from "../services/blacklistProject.js";
import { createCampaign as createSendkitCampaign, upsertLeads, addLeadsToCampaign, previewEmail, findLeadByEmail, listMailboxes, listCampaigns as listSendkitCampaigns } from "../services/sendkit.js";
import { BLACKLIST_SEQUENCE, BLACKLIST_CAMPAIGN_NAME, workspaceCampaignId, DEFAULT_BLACKLIST_CAMPAIGN_ID, leadPayload } from "./blacklistCopy.js";
import { isExcludedSeed } from "../services/icp.js";
import { campaigns, campaignTargets, hostioPages, hostioUsage, reports as reportsCol, leads as leadsCol } from "../db/mongo.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_TTL_MS = 7 * 86400000; // cached redirect pages are reused for 7 days

// Page 1 = FREE web scrape (gives total count + ~48 domains). Cached so a re-run never re-scrapes.
async function cachedPage1(seed, campaignId) {
  const _id = `${seed}:1`;
  const hit = await hostioPages().findOne({ _id }).catch(() => null);
  if (hit && Date.now() - new Date(hit.at).getTime() < PAGE_TTL_MS) return { ok: true, total: hit.total, domains: hit.domains || [] };
  // Don't attempt a scrape the pool can't serve — every exit rate-limited means three doomed
  // attempts and their waits per seed, and more pressure on IPs that need quiet to recover.
  const canScrape = scrapeUsable() || !config.campaign.apiFallback || !campaignId;
  const page = canScrape ? await scrapeRedirectPage(seed) : { ok: false, total: null, domains: [] };
  // Only cache a page we actually read. Caching a failed fetch would freeze a false "no redirects"
  // for a week.
  if (page.ok) {
    await hostioPages().updateOne({ _id }, { $set: { seed, page: 1, source: "scrape", total: page.total, domains: page.domains, at: new Date() } }, { upsert: true }).catch(() => {});
    return page;
  }

  // The free scrape is the fragile half: one run lost 4,730 seeds to it while the paid API answered
  // 5,270 domains with zero failures. So rather than writing the seed off, spend ONE API call — the
  // same call the blacklist scan makes, carrying both the total and up to 50 domains. It only ever
  // fires on a seed the scrape already failed, so a healthy pool costs nothing extra.
  if (!config.campaign.apiFallback || !campaignId) return page;
  const res = await cachedApiPage(campaignId, seed, 1);
  if (!res.ok) return page;                       // API failed too — still a retryable error
  await campaigns().updateOne({ _id: campaignId }, { $inc: { apiFallbacks: 1 } }).catch(() => {});
  return { ok: true, total: res.total ?? null, domains: res.domains || [] };
}

// Page >=2 = PAID API (50/page). Cached; a real call is logged to hostio_usage + increments the
// campaign's apiCallsUsed counter (a cache hit does neither — that's the saving).
async function cachedApiPage(campaignId, seed, page) {
  const _id = `${seed}:${page}`;
  const hit = await hostioPages().findOne({ _id }).catch(() => null);
  // `total` matters when this is page 1 (the scrape fallback): without it the caller reads the count
  // as null and drops the seed below the count gate despite having just paid for the answer.
  if (hit && Date.now() - new Date(hit.at).getTime() < PAGE_TTL_MS) return { ok: true, domains: hit.domains || [], total: hit.total ?? null };
  const res = await apiRedirectPage(seed, page, {
    onApiCall: async ({ count }) => {
      await campaigns().updateOne({ _id: campaignId }, { $inc: { apiCallsUsed: 1 } }).catch(() => {});
      await hostioUsage().insertOne({ at: new Date(), campaignId, seed, page, count, source: "api" }).catch(() => {});
    },
  });
  if (res.ok) {
    const set = { seed, page, source: "api", domains: res.domains, at: new Date() };
    if (res.total != null) set.total = res.total;
    await hostioPages().updateOne({ _id }, { $set: set }, { upsert: true }).catch(() => {});
  }
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
// map) until they're checked — then return which are listed AND which we never got an answer for.
// The wait is bounded and the map is shared across all seeds, so concurrent seeds' domains get
// checked together.
//
// UNRESOLVED IS NOT CLEAN. A domain the checker rate-limited us out of, or that was still being
// checked when the bounded wait expired, has no verdict — and reporting it as "not listed" is how a
// company with genuinely bad infra ends up in dropped_blacklist, which resume treats as final.
//
// `source` ("hostio" | "guessed") is stamped onto every listed entry so the campaign UI can show,
// per domain, whether host.io's index actually knows about it or we found it via permutation + DNS +
// redirect-confirm. Purely a label — it plays no part in the verdict itself.
async function blacklistOf(domains, source) {
  if (!domains.length) return { listed: [], unresolved: [] };

  // Anything we already have a verdict for locally needs no round-trip at all.
  let map = await verdictsFor(domains);
  const isUnknown = (d) => { const v = map.get(d); return !v || v.status === "pending" || v.status === "checking"; };
  const unknown = domains.filter(isUnknown);

  if (unknown.length) {
    await pushDomains(unknown);                       // queues only the ones we don't know yet
    const deadline = Date.now() + 20_000;
    for (;;) {
      await sleep(1200);
      await refreshVerdicts();                        // incremental: a page or two, not the workspace
      map = await verdictsFor(domains);
      if (!unknown.some(isUnknown) || Date.now() >= deadline) break;
    }
  }

  const listed = [], unresolved = [];
  for (const d of domains) {
    const v = map.get(d);
    if (v && v.status === "listed") listed.push({ domain: d, riskScore: v.riskScore ?? null, zones: v.zones || [], source });
    else if (isUnknown(d)) unresolved.push(d);
  }
  return { listed, unresolved };
}

// DISCOVERY for one seed: free page-1 (count gate) -> blacklist it -> if still under the gate,
// lazily pull API pages one at a time, stopping the instant blacklistGate is reached (so a company
// whose bad domains are on page 1 costs ZERO API calls). Qualified seeds are handed to onQualified()
// rather than enriched here — enrichment runs in its own lane so it can't stall discovery.
async function discoverSeed(campaignId, t, gates, onQualified) {
  try {
    await setTarget(t._id, { stage: "scraping", activity: "fetching redirects (free)" });
    const p1 = await cachedPage1(t.seed, campaignId);
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
    const unresolved = [];
    const feed = async (domains, source) => {
      const fresh = domains.filter((d) => d && !seen.has(d));
      fresh.forEach((d) => seen.add(d));
      if (!fresh.length) return;
      const res = await blacklistOf(fresh, source);
      blacklisted.push(...res.listed);
      unresolved.push(...res.unresolved);
    };

    await setTarget(t._id, { stage: "blacklisting", activity: "checking page 1 (free)" });
    await feed(p1.domains, "hostio");

    // lazy paid pagination — only if page 1 didn't already clear the gate
    let page = 2, apiPages = 0, pageFailed = false;
    while (blacklisted.length < gates.blacklistGate && (page - 1) * 50 < count && page <= config.campaign.maxApiPages + 1) {
      await setTarget(t._id, { activity: `checking page ${page} (api)` });
      const res = await cachedApiPage(campaignId, t.seed, page);
      if (!res.ok) { pageFailed = true; break; }   // API error — we did NOT see the rest of this footprint
      if (!res.domains.length) break;              // genuinely the end of the list
      await feed(res.domains, "hostio");
      apiPages++; page++;
    }

    // OPT-IN Stage 2b: permutation-guess the rest of the label space, DNS-filter, then confirm each
    // survivor actually redirects to this seed via HTTP before it ever reaches the blacklist checker —
    // so nothing un-verified gets pushed. Skips anything host.io already gave us (`seen`). Off by
    // default: coverage is real but low (see the header note), so it only runs when asked.
    let guessedConfirmed = 0, guessedChecked = 0;
    if (gates.guess) {
      await setTarget(t._id, { activity: "guessing extra domains (dns + redirect check)" });
      const candidates = generateCandidates(t.seed).filter((d) => !seen.has(d));
      guessedChecked = candidates.length;
      const confirmed = [];
      const redirectLimit = createLimiter(config.scanRedirectConcurrency);
      await runPool(candidates, async (candidate) => {
        if (!(await domainHasDns(candidate))) return;
        if (!(await redirectLimit(() => redirectsToSeed(candidate, t.seed)))) return;
        confirmed.push(candidate);
      }, { concurrency: config.scanDnsConcurrency });
      guessedConfirmed = confirmed.length;
      if (confirmed.length) {
        await setTarget(t._id, { activity: `checking blacklist on ${confirmed.length} guessed domain(s)` });
        await feed(confirmed, "guessed");
      }
    }

    blacklisted.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
    const common = {
      confirmedCount: seen.size, blacklistedCount: blacklisted.length, blacklistedDomains: blacklisted,
      unresolvedCount: unresolved.length, apiPagesUsed: apiPages,
      ...(gates.guess ? { guessedChecked, guessedConfirmed } : {}),
    };
    if (blacklisted.length < gates.blacklistGate) {
      // If a page fetch failed we never saw part of this company's footprint, so "not enough
      // blacklisted" isn't a real verdict — leave it retryable rather than dropping it for good.
      if (pageFailed) {
        await setTarget(t._id, { ...common, stage: "error", error: "host.io api page failed mid-pagination", activity: null });
        return;
      }
      // Same reasoning for domains that never came back with a verdict: "under the gate" is only a
      // real answer once every domain has actually been checked. Dropping here is permanent —
      // dropped_blacklist is in resume's FINAL set — so an unchecked remainder stays retryable.
      if (unresolved.length) {
        log.warn("seed left unresolved by the blacklist checker", { seed: t.seed, unresolved: unresolved.length, checked: seen.size });
        await setTarget(t._id, { ...common, stage: "error", error: `${unresolved.length} of ${seen.size} domains had no blacklist verdict`, activity: null });
        return;
      }
      await setTarget(t._id, { ...common, stage: "dropped_blacklist", activity: null });
      return;
    }

    // Qualified. If contact enrichment is off, STOP here: the domain has blacklisted infra worth
    // pitching, but we spend no Prospeo credit finding people (the caller already has the emails, or
    // just wants the blacklist verdict). A distinct "qualified" stage keeps it out of the "Contacts
    // pulled" total, which counts only the "done" (actually-enriched) stage.
    if (gates.enrich === false) {
      await setTarget(t._id, { ...common, stage: "qualified", activity: "blacklisted infra — contacts not requested" });
      return;
    }

    // Hand off to the enrichment lane and free this slot immediately. Prospeo is globally
    // rate-limited, so doing it inline would pin a discovery slot for the whole enrich (at 4.6k seeds
    // that pinned 19/20 slots and pushed the run's ETA to ~38h).
    await setTarget(t._id, { ...common, stage: "enrich_queued", activity: "waiting for contact lookup" });
    onQualified(t);
  } catch (e) {
    await setTarget(t._id, { stage: "error", error: e.message, activity: null });
  }
}

// ── Two-phase seed scan, for volume ────────────────────────────────────────────────────────────
// runSingleSeed below reads the footprint and then WAITS up to 20 seconds for the checker to answer.
// That wait is most of the wall-clock in a scan, and at 24k clients it is the whole schedule: it put
// throughput at 4.7 scans/min, of which roughly 45 seconds per scan was a worker sleeping.
//
// Split in two, nothing waits. Phase 1 reads the footprint and returns. The domains are pushed to
// the checker in ONE batched request for thousands of them (the checker's own docs: "the rate limit
// counts requests, not domains" — pushing per client is what would blow the 120/min budget). Phase 2
// runs later and reads whatever the mirror knows by then.
export async function scanSeedStart(seed, { campaignId = null } = {}) {
  const p1 = await cachedPage1(seed, campaignId);
  if (!p1.ok) return { ok: false, error: "could not read the redirect list" };
  const domains = [...new Set((p1.domains || []).filter(Boolean))];
  return { ok: true, domains, redirectCount: p1.total ?? null, confirmedCount: domains.length };
}

// Which of these the checker has still not answered for. Phase 2 uses it to decide between
// finishing and waiting another round.
export async function readVerdicts(domains) {
  const map = await verdictsFor(domains);
  const listed = [], unresolved = [];
  for (const d of domains) {
    const v = map.get(d);
    if (v && v.status === "listed") listed.push({ domain: d, riskScore: v.riskScore ?? null, zones: v.zones || [] });
    else if (!v || v.status === "pending" || v.status === "checking") unresolved.push(d);
  }
  listed.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  return { listed, unresolved };
}

// Persist a finished two-phase scan into campaign_targets, so every later run — another agency
// listing the same client, or the seed funnel itself — reads it instead of re-scanning.
export async function saveSeedResult(seed, { redirectCount, confirmedCount, listed, unresolved, campaignId = null }) {
  await campaignTargets().updateOne(
    { seed, singleScan: true },
    {
      $setOnInsert: { seed, singleScan: true, campaignId, createdAt: new Date() },
      $set: {
        stage: "done", redirectCount: redirectCount ?? null, confirmedCount: confirmedCount ?? 0,
        blacklistedCount: listed.length, blacklistedDomains: listed,
        unresolvedCount: unresolved.length, activity: null, error: null, updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

// Scan ONE domain end to end, with no gates and no Prospeo — "what is this company's sending
// footprint and how much of it is listed". The agency crawl's clients come through here.
//
// Gates are deliberately absent: a client is EVIDENCE, not a prospect, so there is no threshold at
// which we stop caring — we want the number even when it's zero. The result is written to
// campaign_targets, which means the next agency listing the same client, and the seed funnel itself,
// both get it for free.
export async function runSingleSeed(seed, { campaignId = null } = {}) {
  const _id = `single:${seed}`;
  try {
    await campaignTargets().updateOne(
      { seed, singleScan: true },
      { $setOnInsert: { seed, singleScan: true, campaignId, stage: "scraping", createdAt: new Date() }, $set: { updatedAt: new Date() } },
      { upsert: true },
    );
    const target = await campaignTargets().findOne({ seed, singleScan: true }, { projection: { _id: 1 } });

    const p1 = await cachedPage1(seed, campaignId);
    if (!p1.ok) {
      await setTarget(target._id, { stage: "error", error: "host.io page unreadable" });
      return { ok: false, error: "could not read the redirect list" };
    }

    const domains = (p1.domains || []).filter(Boolean);
    const { listed, unresolved } = await blacklistOf([...new Set(domains)]);
    listed.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));

    await setTarget(target._id, {
      stage: "done", redirectCount: p1.total ?? null, confirmedCount: domains.length,
      blacklistedCount: listed.length, blacklistedDomains: listed,
      unresolvedCount: unresolved.length, activity: null, error: null,
    });
    return {
      ok: true, redirectCount: p1.total ?? null, confirmedCount: domains.length,
      blacklistedCount: listed.length, blacklistedDomains: listed, unresolved: unresolved.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
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
  let rows = await leadsCol().find({ ...base, company_domain: seed }).sort({ score: -1 }).limit(10).toArray().catch(() => []);
  if (!rows.length) {
    const rx = new RegExp("@" + seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
    rows = await leadsCol().find({ ...base, email: rx }).sort({ score: -1 }).limit(10).toArray().catch(() => []);
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
  const lead = await leadsCol().findOne(
    { $or: [{ company_domain: seed }, { email: new RegExp("@" + seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }], company: { $nin: [null, ""] } },
    { projection: { company: 1 } },
  ).catch(() => null);
  return lead?.company || null;
}

// The Prospeo half, run in its own small lane so it never blocks discovery.
export async function enrichSeed(t) {
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
// Campaigns that have been asked to stop. A run whose upstream has started refusing (host.io 429ing
// every exit) makes no progress but keeps the pressure on, so the block never lifts — there has to
// be a way to call it off without waiting hours or restarting the container.
const aborted = new Set();
export function isAborted(campaignId) { return aborted.has(String(campaignId)); }

export async function stopCampaign(id) {
  if (!ObjectId.isValid(id)) return { ok: false, error: "bad campaign id" };
  const _id = new ObjectId(id);
  const camp = await campaigns().findOne({ _id });
  if (!camp) return { ok: false, error: "campaign not found" };
  if (camp.status !== "running") return { ok: false, error: `campaign is ${camp.status}, not running` };

  aborted.add(String(_id));
  // Seeds still queued never started; the ones mid-flight finish their current attempt and stop.
  // Everything unsettled stays retryable, so a later resume picks up exactly where this left off.
  await campaignTargets().updateMany(
    { campaignId: _id, stage: { $in: ["queued", "scraping", "blacklisting"] } },
    { $set: { stage: "error", error: "stopped by user", activity: null, updatedAt: new Date() } },
  );
  await campaigns().updateOne({ _id }, { $set: { status: "interrupted", stage: "stopped", finishedAt: new Date(), updatedAt: new Date() } });
  log.warn("campaign stopped by user", { id });
  return { ok: true };
}

// Delete a campaign run and everything it owns — the campaign doc plus all its per-seed targets.
// If it's still running, abort the in-flight pool first so nothing keeps writing after the delete.
// This does NOT touch anything already pushed to SendKit (that lives in SendKit, on its own).
export async function deleteCampaign(id) {
  if (!ObjectId.isValid(id)) return { ok: false, error: "bad campaign id" };
  const _id = new ObjectId(id);
  const camp = await campaigns().findOne({ _id });
  if (!camp) return { ok: false, error: "campaign not found" };

  if (camp.status === "running") aborted.add(String(_id)); // stop the pool before we pull the rows out from under it
  const { deletedCount: targets } = await campaignTargets().deleteMany({ campaignId: _id });
  await campaigns().deleteOne({ _id });
  aborted.delete(String(_id));
  log.warn("campaign deleted by user", { id, targets });
  return { ok: true, targets };
}

async function runCampaign(campaignId, targets, gates) {
  await campaigns().updateOne({ _id: campaignId }, { $set: { stage: "running", startedAt: new Date(), updatedAt: new Date() } });
  // Warm the local verdict mirror once up front so seeds don't each pay for it. The CSV export does
  // the whole workspace in ONE request; the paged refresh is the fallback, and it caps at 40 pages,
  // so on a cold mirror it can only ever see the newest 20k domains.
  const sync = await syncAllVerdicts().catch(() => ({ ok: false }));
  if (!sync.ok) await refreshVerdicts().catch(() => {});

  const queue = [];
  let discoveryDone = false;

  const enrichLane = (async () => {
    const inFlight = new Set();
    while (!discoveryDone || queue.length || inFlight.size) {
      if (isAborted(campaignId)) queue.length = 0;
      while (queue.length && inFlight.size < config.campaign.enrichConcurrency) {
        const t = queue.shift();
        const p = enrichSeed(t).finally(() => inFlight.delete(p));
        inFlight.add(p);
      }
      await (inFlight.size ? Promise.race(inFlight) : sleep(500));
    }
  })();

  await runPool(targets, (t) => (isAborted(campaignId) ? Promise.resolve() : discoverSeed(campaignId, t, gates, (q) => queue.push(q))),
    { concurrency: config.campaign.seedConcurrency });
  discoveryDone = true;
  await campaigns().updateOne({ _id: campaignId }, { $set: { stage: "enriching", updatedAt: new Date() } });

  await enrichLane;
  if (isAborted(campaignId)) { aborted.delete(String(campaignId)); log.warn("campaign run ended after stop", { campaignId: String(campaignId) }); return; }
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

  // Put the seeds this run will redo back to "queued". They are mostly sitting in "error", which
  // counts as SETTLED — so the progress bar opened at 6,140 of 6,140 and the ETA, which only updates
  // when the settled count RISES, never had anything to measure. Re-queueing makes progress mean the
  // work this run is actually doing.
  await campaignTargets().updateMany(
    { campaignId: _id, stage: { $nin: FINAL } },
    { $set: { stage: "queued", activity: null, updatedAt: new Date() } },
  ).catch(() => {});

  await campaigns().updateOne({ _id }, { $set: { status: "running", stage: "running", finishedAt: null, updatedAt: new Date() } });
  const gates = camp.gates || { countGate: config.campaign.countGate, blacklistGate: config.campaign.blacklistGate };

  runCampaign(_id, pending, gates).catch((e) => {
    log.error("campaign resume crashed", { err: e.message, id });
    campaigns().updateOne({ _id }, { $set: { status: "error", error: e.message, finishedAt: new Date() } }).catch(() => {});
  });

  return { ok: true, resumed: pending.length, alreadySettled: camp.seedCount - pending.length };
}

// Company enrichment for a blacklist-only run. When "Find contacts" was off, qualified seeds stop at
// stage "qualified" (blacklisted infra, no contacts pulled). This runs Prospeo on exactly those —
// people search + email reveal — so their decision-makers' emails come through and they move to "done".
// Runs in the background (like resume) so a big batch doesn't block the request; the UI polls the funnel.
export async function enrichQualifiedCompanies(id, { includeDone = false } = {}) {
  if (!ObjectId.isValid(id)) return { ok: false, error: "bad campaign id" };
  const _id = new ObjectId(id);
  const camp = await campaigns().findOne({ _id });
  if (!camp) return { ok: false, error: "campaign not found" };
  if (camp.status === "running") return { ok: false, error: "already running" };

  // Normally we enrich the "qualified" seeds (blacklisted infra, contacts weren't requested at run
  // time). `includeDone` also re-runs Prospeo on already-"done" companies — for an old run that was
  // enriched before this feature existed, or to refresh stale contacts.
  const wantStages = includeDone ? ["qualified", "done"] : ["qualified"];
  const pending = await campaignTargets().find({ campaignId: _id, stage: { $in: wantStages } }).toArray();
  if (!pending.length) return { ok: false, error: includeDone ? "no companies to enrich" : "no qualified companies awaiting enrichment" };

  await campaigns().updateOne({ _id }, { $set: { status: "running", stage: "enriching", finishedAt: null, updatedAt: new Date() } });

  (async () => {
    await runPool(pending, (t) => (isAborted(_id) ? Promise.resolve() : enrichSeed(t)), { concurrency: config.campaign.enrichConcurrency });
    if (isAborted(_id)) { aborted.delete(String(_id)); log.warn("company enrichment ended after stop", { campaignId: String(_id) }); return; }
    await campaigns().updateOne({ _id }, { $set: { status: "done", stage: "done", finishedAt: new Date(), updatedAt: new Date() } });
    log.info("company enrichment finished", { campaignId: String(_id), enriched: pending.length });
  })().catch((e) => {
    log.error("company enrichment crashed", { err: e.message, id });
    campaigns().updateOne({ _id }, { $set: { status: "done", stage: "done", error: e.message, finishedAt: new Date() } }).catch(() => {});
  });

  return { ok: true, queued: pending.length };
}

export async function startCampaign(rawSeeds, opts = {}) {
  const parsed = parseSeeds(rawSeeds);
  // Drop non-ICP giants (google.com, linkedin.com, flipkart.com, …) BEFORE they cost any credits —
  // their employees don't buy cold-email sending infra. Edit the list in services/icp.js.
  const excludedSeeds = parsed.filter((s) => isExcludedSeed(s));
  const seeds = parsed.filter((s) => !isExcludedSeed(s));
  if (!seeds.length) throw new Error(`no valid ICP domains in the list${excludedSeeds.length ? ` (${excludedSeeds.length} excluded as non-ICP)` : ""}`);
  const gates = {
    countGate: parseInt(opts.countGate, 10) || config.campaign.countGate,
    blacklistGate: parseInt(opts.blacklistGate, 10) || config.campaign.blacklistGate,
    // Whether to run the PAID Prospeo contact lookup on domains that clear both gates. Default true
    // (unchanged behaviour). Set false to only find WHICH seed domains have blacklisted infra — no
    // contacts, no Prospeo credits — for when you already have emails for these companies.
    enrich: opts.enrich !== false,
    // Whether to ALSO run the permutation-guess + DNS + redirect-confirm pass per seed (see the file
    // header). Default false — it's a real but low-coverage extra source and slows discovery down, so
    // it only runs when explicitly asked. Every domain it finds is tagged source:"guessed" so it's
    // never confused with host.io's index (source:"hostio").
    guess: !!opts.guess,
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

  return { id: String(insertedId), seedCount: seeds.length, gates, excluded: excludedSeeds.length };
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
  // A blacklist scan gates nothing — every seed finishes "done" — so the stage-derived funnel the
  // cards use reports the entire list at every step (one run showed 5,270 seeds, 5,270 past the
  // count gate, 5,270 with bad infra). For those runs the funnel has to be counted from the values
  // actually measured against the gates.
  let funnel;
  if (campaign.kind === "blacklist_scan") {
    const gates = campaign.gates || { countGate: config.campaign.countGate, blacklistGate: config.campaign.blacklistGate };
    const [passedCount, hasBadInfra, contacts] = await Promise.all([
      campaignTargets().countDocuments({ campaignId: _id, redirectCount: { $gte: gates.countGate } }),
      campaignTargets().countDocuments({ campaignId: _id, redirectCount: { $gte: gates.countGate }, blacklistedCount: { $gte: gates.blacklistGate } }),
      campaignTargets().countDocuments({ campaignId: _id, peopleCount: { $gt: 0 } }),
    ]);
    funnel = { seeds: campaign.seedCount, passedCount, hasBadInfra, contacts };
  }

  return { ...campaign, id, stages, processed, discovered, active, ...(funnel ? { funnel } : {}) };
}

// EVERY seed's full funnel result (not just qualified ones) — so you can see each domain's whole
// journey: host.io redirect count, how many our discovery confirmed, how many were blacklisted, and
// what Prospeo returned. Sorted so the most-qualified prospects surface first, dropped ones last.
//
// PAGED. One run holds 22,333 seeds, and each row carries its people[] and blacklistedDomains[] —
// sending them all was megabytes per poll and a table the browser had to lay out in full.
export async function getCampaignResults(id, { q = "", stage = "", page = 0, size = 100 } = {}) {
  if (!ObjectId.isValid(id)) return { items: [], count: 0 };
  const find = { campaignId: new ObjectId(id) };
  if (stage) find.stage = stage;
  if (q) find.seed = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const [items, count] = await Promise.all([
    campaignTargets().find(find, { projection: { campaignId: 0 } })
      .sort({ blacklistedCount: -1, confirmedCount: -1, redirectCount: -1 })
      .skip(page * size).limit(size).toArray(),
    campaignTargets().countDocuments(find),
  ]);
  return { items, count };
}

// The whole run as CSV, built server-side. The dashboard used to assemble this from the rows it had
// already loaded — which silently became "the current page" once results were paged.
export async function campaignResultsCsv(id) {
  if (!ObjectId.isValid(id)) return null;
  const cols = ["seed", "stage", "redirect_count", "confirmed", "blacklisted", "blacklisted_domains", "contacts", "company"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = [cols.join(",")];
  const cursor = campaignTargets().find({ campaignId: new ObjectId(id) })
    .sort({ blacklistedCount: -1, confirmedCount: -1, redirectCount: -1 });
  for await (const r of cursor) {
    out.push([
      r.seed, r.stage, r.redirectCount ?? "", r.confirmedCount ?? 0, r.blacklistedCount ?? 0,
      // Each domain tagged with its source so the export carries the same host.io-vs-guessed
      // distinction the UI shows — old rows without a `source` predate this feature and are host.io.
      (r.blacklistedDomains || []).map((d) => `${d.domain}(${d.source || "hostio"})`).join("|"),
      (r.people || []).filter((p) => p.email).length, r.companyName || "",
    ].map(esc).join(","));
  }
  return out.join("\n");
}

// How many contacts this run actually produced — the number the header used to derive by reducing
// over every loaded row, which stops being the truth as soon as the rows are paged.
export async function campaignContactCount(id) {
  if (!ObjectId.isValid(id)) return 0;
  const [r] = await campaignTargets().aggregate([
    { $match: { campaignId: new ObjectId(id), peopleCount: { $gt: 0 } } },
    { $project: { n: { $size: { $filter: { input: { $ifNull: ["$people", []] }, as: "p", cond: { $ne: ["$$p.email", null] } } } } } },
    { $group: { _id: null, total: { $sum: "$n" } } },
  ]).toArray();
  return r?.total || 0;
}

export async function listCampaigns(limit = 20, { page = 0 } = {}) {
  const [items, count] = await Promise.all([
    campaigns().find({}).sort({ createdAt: -1 }).skip(page * limit).limit(limit).toArray(),
    campaigns().countDocuments({}),
  ]);
  return { items, count };
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

// On-demand: re-check ONE seed's already-found blacklisted domains against host.io RIGHT NOW (one
// fresh, uncached API call — bypasses hostio_pages entirely on purpose, this is the live answer, not
// the 7-day-cached one). Stamps each domain with whether host.io still lists it today, so the UI can
// show which of an older result is still verifiable vs which has since dropped out of host.io's index
// (renamed, retired, or otherwise no longer redirecting there) — without re-running discovery or
// touching the domain's original `source` (how it was FOUND), which this leaves untouched.
export async function verifySeedAgainstHostio(campaignId, seed) {
  if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
  const target = await campaignTargets().findOne({ campaignId: new ObjectId(campaignId), seed });
  if (!target) return { ok: false, error: "seed not found in this campaign" };
  if (!target.blacklistedDomains?.length) return { ok: false, error: "nothing to verify for this seed" };

  const live = await liveRedirectDomains(seed);
  if (!live.ok) return { ok: false, error: `host.io check failed: ${live.error || "unknown error"}` };

  const liveSet = new Set(live.domains);
  const domains = target.blacklistedDomains.map((d) => ({ ...d, stillOnHostio: liveSet.has(d.domain.toLowerCase()) }));
  const liveVerifiedAt = new Date();
  await campaignTargets().updateOne({ _id: target._id }, { $set: { blacklistedDomains: domains, liveVerifiedAt } });
  return { ok: true, domains, liveVerifiedAt, liveTotal: live.total };
}

// ── Push a campaign's qualified prospects into a SendKit campaign ──────────────────────────────
// Creates (once) a DRAFT SendKit campaign carrying the blacklist sequence, upserts every revealed
// decision-maker as a lead with their per-company variables (blacklistedDomainCount, domain1..4, …),
// and adds them to it. Nothing is ever sent: the campaign stays a draft until it's started by hand
// in SendKit — starting a real outbound sequence is deliberately left as a human decision.
// ── SendKit workspaces (one per teammate) ──────────────────────────────────────────────────────
// The funnel is shared, but each person sends from their OWN SendKit workspace, so the push target
// is selectable. No workspace = the default SENDKIT_KEY (the LinkedIn-engagement workspace).
// Workspaces come from SENDKIT_WORKSPACES (see config). Keys never leave the server.
export async function listWorkspaces() {
  const ws = config.sendkit.workspaces;
  if (ws.length) return ws.map((w) => ({ id: w.id, label: w.label }));
  return [{ id: "", label: "Default" }];        // nothing configured -> just the SENDKIT_KEY workspace
}

async function workspaceKey(workspaceId) {
  if (!workspaceId) return undefined;                       // undefined -> sendkit.js uses the default
  return config.sendkit.workspaces.find((w) => w.id === workspaceId)?.apiKey;
}

// The campaign a workspace is PINNED to, if any (see workspaceCampaignId). Matched on the slug and
// then on the label, so the pin survives someone configuring the workspace as "sendkit-dev|SendKit".
// No workspace selected = the SENDKIT_KEY workspace, which is InboxKit's — same pin, unless
// SENDKIT_BLACKLIST_CAMPAIGN_ID is set, which stays the explicit escape hatch.
function pinnedCampaignFor(workspaceId) {
  if (!workspaceId) return config.sendkit.blacklistCampaignId || DEFAULT_BLACKLIST_CAMPAIGN_ID;
  const label = config.sendkit.workspaces.find((w) => w.id === workspaceId)?.label;
  return workspaceCampaignId(workspaceId) || workspaceCampaignId(label);
}

// What a push WOULD do — which SendKit workspace and which campaign in it, whether that campaign
// already exists (and what sequence it carries), and how many contacts would go. Lets the confirm
// dialog state the real target instead of guessing.
export async function pushTarget(campaignId, { workspaceId } = {}) {
  if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
  const apiKey = await workspaceKey(workspaceId);
  if (workspaceId && !apiKey) return { ok: false, error: `unknown workspace "${workspaceId}"` };

  const targets = await campaignTargets().find(
    { campaignId: new ObjectId(campaignId), stage: "done", peopleCount: { $gt: 0 } },
    { projection: { people: 1, seed: 1 } },
  ).toArray();
  let contacts = 0, companies = 0;
  for (const t of targets) {
    const n = (t.people || []).filter((p) => p.email).length;
    if (n) { contacts += n; companies++; }
  }

  // A pinned workspace resolves by ID, not by name — see workspaceCampaignId. Report the pin's real
  // name/status so the confirm dialog names the campaign the leads actually land in.
  const pinned = pinnedCampaignFor(workspaceId);
  const all = await listSendkitCampaigns({ apiKey });
  const existing = pinned
    ? all.find((c) => String(c.id) === pinned)
    : all.find((c) => String(c.name || "").trim().toLowerCase() === BLACKLIST_CAMPAIGN_NAME.toLowerCase() && c.status !== "archived");
  const wsLabel = config.sendkit.workspaces.find((w) => w.id === workspaceId)?.label || "Default";

  // A pin that isn't visible in this workspace is a misconfiguration, not a "create it then" case:
  // say so instead of letting the dialog promise a new campaign we'd refuse to create anyway.
  if (pinned && !existing) {
    return { ok: false, error: `pinned campaign ${pinned} not found in the ${wsLabel} workspace` };
  }

  return {
    ok: true, workspaceId: workspaceId || null, workspaceLabel: wsLabel,
    campaignName: existing?.name || BLACKLIST_CAMPAIGN_NAME,
    campaignId: existing?.id || null, campaignStatus: existing?.status || null,
    exists: !!existing, contacts, companies,
  };
}

export async function pushCampaignToSendkit(campaignId, { campaignName, workspaceId } = {}) {
  if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
  const _id = new ObjectId(campaignId);
  const camp = await campaigns().findOne({ _id });
  if (!camp) return { ok: false, error: "campaign not found" };
  const apiKey = await workspaceKey(workspaceId);
  if (workspaceId && !apiKey) return { ok: false, error: `unknown workspace "${workspaceId}"` };

  const targets = await campaignTargets().find({ campaignId: _id, stage: "done", peopleCount: { $gt: 0 } }).toArray();

  // Fill in any company display names that are missing (targets from runs before we captured them),
  // so the copy says "RingCentral's" and not "ringcentral.com's". One query, not one per target.
  const needName = targets.filter((t) => !t.companyName).map((t) => t.seed);
  if (needName.length) {
    const rows = await leadsCol().find(
      { company_domain: { $in: needName }, company: { $nin: [null, ""] } },
      { projection: { company_domain: 1, company: 1 } },
    ).toArray().catch(() => []);
    const byDomain = new Map(rows.map((r) => [r.company_domain, r.company]));
    for (const t of targets) if (!t.companyName && byDomain.has(t.seed)) t.companyName = byDomain.get(t.seed);
  }

  const leads = [];
  for (const t of targets) {
    for (const p of t.people || []) {
      if (p.email) leads.push(leadPayload(p, t));
    }
  }
  if (!leads.length) return { ok: false, error: "no contacts with a revealed email yet" };

  // All blacklist prospecting funnels feed ONE standing SendKit campaign, so every run's leads land
  // in the same sequence instead of scattering across a campaign per run. Resolved INSIDE the chosen
  // workspace — each workspace has its own campaign.
  // Order: an explicit campaignName from the caller, else the workspace's PIN (an id — the live
  // campaigns are copies that share a name, so only the id picks the right one), else the old
  // by-name lookup for a workspace nobody has pinned, else create it once.
  const standingName = campaignName || BLACKLIST_CAMPAIGN_NAME;
  const pinned = campaignName ? "" : pinnedCampaignFor(workspaceId);
  let sendkitCampaignId = pinned;
  if (pinned) {
    // Verify the pin before pushing: a stale id would otherwise fail deep inside addLeadsToCampaign
    // (or, worse, silently push nowhere). Never fall back to name resolution here — the whole point
    // of the pin is that the name is ambiguous in this workspace.
    const found = (await listSendkitCampaigns({ apiKey })).some((c) => String(c.id) === pinned);
    if (!found) return { ok: false, error: `pinned campaign ${pinned} not found in this SendKit workspace` };
  }
  if (!sendkitCampaignId) {
    const existing = (await listSendkitCampaigns({ apiKey })).find(
      (c) => String(c.name || "").trim().toLowerCase() === standingName.toLowerCase() && c.status !== "archived",
    );
    sendkitCampaignId = existing?.id;
  }
  if (!sendkitCampaignId) {
    const created = await createSendkitCampaign(standingName, BLACKLIST_SEQUENCE, undefined, { apiKey });
    if (!created.ok) return { ok: false, error: `could not create SendKit campaign: ${created.error}` };
    sendkitCampaignId = created.id;
  }

  const up = await upsertLeads(leads, { apiKey });                        // creates/updates + custom fields
  const add = await addLeadsToCampaign(sendkitCampaignId, leads.map((l) => l.email), { apiKey });
  await campaigns().updateOne({ _id }, { $set: {
    sendkitCampaignId, sendkitWorkspaceId: workspaceId || null,
    sendkitPushedAt: new Date(), sendkitLeadCount: leads.length, updatedAt: new Date(),
  } });

  log.info("pushed campaign to sendkit", { campaignId, workspaceId: workspaceId || "default", sendkitCampaignId, leads: leads.length, added: add.added, skipped: add.skipped });
  return { ok: true, workspaceId: workspaceId || null, sendkitCampaignId, leads: leads.length, upserted: up.ok, failed: up.failed, added: add.added, alreadyIn: add.skipped };
}

// The exact rows that get pushed to SendKit, as CSV — same payload, same variables, so the file and
// the campaign can't drift apart. Importable straight into SendKit if you'd rather not use the push.
export async function campaignCsv(campaignId) {
  if (!ObjectId.isValid(campaignId)) return null;
  const _id = new ObjectId(campaignId);
  const targets = await campaignTargets().find({ campaignId: _id, stage: "done", peopleCount: { $gt: 0 } }).toArray();

  const needName = targets.filter((t) => !t.companyName).map((t) => t.seed);
  if (needName.length) {
    const rows = await leadsCol().find(
      { company_domain: { $in: needName }, company: { $nin: [null, ""] } },
      { projection: { company_domain: 1, company: 1 } },
    ).toArray().catch(() => []);
    const byDomain = new Map(rows.map((r) => [r.company_domain, r.company]));
    for (const t of targets) if (!t.companyName && byDomain.has(t.seed)) t.companyName = byDomain.get(t.seed);
  }

  const cols = ["email", "firstName", "lastName", "companyName", "jobTitle", "linkedinUrl",
    "secondaryDomainCount", "blacklistedDomainCount", "domain1", "domain2", "domain3", "domain4"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = [cols.join(",")];
  for (const t of targets) {
    for (const p of t.people || []) {
      if (!p.email) continue;
      const l = leadPayload(p, t);
      out.push(cols.map((c) => esc(l[c])).join(","));
    }
  }
  return out.join("\n");
}

// Render one of the sequence's emails exactly as SendKit would send it for a given lead — no send.
export async function previewCampaignEmail(campaignId, { email, step = 1 }) {
  if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
  const camp = await campaigns().findOne({ _id: new ObjectId(campaignId) });
  if (!camp?.sendkitCampaignId) return { ok: false, error: "push to SendKit first" };
  // preview must read from the SAME workspace the leads were pushed into
  const apiKey = await workspaceKey(camp.sendkitWorkspaceId);
  const lead = await findLeadByEmail(email, { apiKey });
  if (!lead) return { ok: false, error: "lead not found in SendKit" };
  const boxes = await listMailboxes({ apiKey });
  if (!boxes.length) return { ok: false, error: "no mailbox in the SendKit workspace to preview as" };
  return previewEmail(camp.sendkitCampaignId, { sequenceStep: step, leadId: lead.id, mailboxId: boxes[0].id, apiKey });
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

// ── Recovery: seeds dropped for "not enough blacklisted" that never actually had a verdict ───────
// Before the checker's 120/min rate limit was handled, a 429 during the verdict refresh made
// unchecked domains read as clean — so a seed with genuinely bad infra could land in
// dropped_blacklist, which resume treats as FINAL and never retries. This re-judges those seeds
// against a freshly synced mirror using the redirect pages already in hostio_pages, so it costs ZERO
// host.io credits and spends no Prospeo.
//
// DRY RUN BY DEFAULT — it reports what would be recovered so the damage can be seen before anything
// moves. `apply` promotes the wrongly-dropped seeds to "qualified" (blacklisted infra, contacts not
// pulled), which is exactly the state enrichQualifiedCompanies already knows how to finish, keeping
// the Prospeo spend a human decision.
//
// Pass no campaignId to sweep every campaign at once.
// `detail` widens the sweep to every seed that was EVER dropped (the ones still dropped plus the
// ones already recovered) and returns a verdict per seed instead of a tally, so the whole pile can be
// read as one list. It never applies — it is the reporting mode of the same judgement, so the file
// and the recovery can't disagree.
export async function recoverDroppedSeeds(campaignId, { apply = false, detail = false } = {}) {
  const q = detail
    ? { $or: [{ stage: "dropped_blacklist" }, { recoveredAt: { $exists: true } }] }
    : { stage: "dropped_blacklist" };
  if (campaignId) {
    if (!ObjectId.isValid(campaignId)) return { ok: false, error: "bad campaign id" };
    q.campaignId = new ObjectId(campaignId);
  }
  if (detail) apply = false;
  const dropped = await campaignTargets().find(q).toArray();
  if (!dropped.length) return { ok: true, applied: apply, scanned: 0, recoverable: 0, recovered: 0, noCachedPages: 0, stillUnknown: 0, nonIcp: 0, items: [], rows: [] };

  // Sync the mirror FIRST. Re-judging against the same stale mirror that caused the drop would just
  // confirm the original mistake.
  const sync = await syncAllVerdicts().catch(() => ({ ok: false }));
  if (!sync.ok) return { ok: false, error: "could not sync the blacklist mirror — refusing to re-judge on stale data" };

  // Per-campaign gate: an old run may have used a different blacklistGate than today's default.
  const camps = await campaigns().find(
    { _id: { $in: [...new Set(dropped.map((t) => String(t.campaignId)))].map((c) => new ObjectId(c)) } },
    { projection: { gates: 1 } },
  ).toArray();
  const gateOf = new Map(camps.map((c) => [String(c._id), c.gates?.blacklistGate ?? config.campaign.blacklistGate]));

  // The domains each seed was judged on, straight from the cached redirect pages — no host.io calls.
  const seeds = [...new Set(dropped.map((t) => t.seed))];
  const domainsOf = new Map();
  for (let i = 0; i < seeds.length; i += 1000) {
    const pages = await hostioPages().find(
      { seed: { $in: seeds.slice(i, i + 1000) } }, { projection: { seed: 1, domains: 1 } },
    ).toArray().catch(() => []);
    for (const p of pages) {
      const set = domainsOf.get(p.seed) || new Set();
      for (const d of p.domains || []) if (d) set.add(d);
      domainsOf.set(p.seed, set);
    }
  }

  // One mirror read for every domain in the sweep, chunked — not one query per seed.
  const allDomains = [...new Set([...domainsOf.values()].flatMap((s) => [...s]))];
  const verdicts = new Map();
  for (let i = 0; i < allDomains.length; i += 5000) {
    for (const [k, v] of await verdictsFor(allDomains.slice(i, i + 5000))) verdicts.set(k, v);
  }

  let recoverable = 0, recovered = 0, noCachedPages = 0, stillUnknown = 0, nonIcp = 0;
  const items = [], rows = [];
  const row = (t, verdict, extra = {}) => {
    if (detail) rows.push({ seed: t.seed, verdict, campaignId: String(t.campaignId), gate: gateOf.get(String(t.campaignId)) ?? config.campaign.blacklistGate, ...extra });
  };

  for (const t of dropped) {
    // Already brought back by an earlier run — kept in the detail sweep so the file covers the whole
    // pile, but there is nothing left to judge.
    if (t.recoveredAt) {
      row(t, "recovered", { blacklisted: t.blacklistedCount || 0, checked: t.confirmedCount || 0,
        topDomains: (t.blacklistedDomains || []).slice(0, 5).map((d) => d.domain),
        zones: [...new Set((t.blacklistedDomains || []).flatMap((d) => d.zones || []))].slice(0, 5) });
      continue;
    }

    // These runs pre-date the ICP exclusion list, so the dropped pile still holds universities,
    // banks and giants that were later purged on purpose. They are blacklisted often enough to clear
    // the gate easily — recovering them would quietly undo that purge, so they stay dropped.
    if (isExcludedSeed(t.seed)) { nonIcp++; row(t, "non-icp"); continue; }

    const domains = [...(domainsOf.get(t.seed) || [])];
    if (!domains.length) { noCachedPages++; row(t, "no-cached-pages"); continue; }  // only a real re-run can judge it

    const listed = [], unknown = [];
    for (const d of domains) {
      const v = verdicts.get(d);
      if (v && v.status === "listed") listed.push({ domain: d, riskScore: v.riskScore ?? null, zones: v.zones || [] });
      else if (!v || v.status === "pending" || v.status === "checking") unknown.push(d);
    }

    const gate = gateOf.get(String(t.campaignId)) ?? config.campaign.blacklistGate;
    listed.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
    const shared = {
      blacklisted: listed.length, checked: domains.length, unchecked: unknown.length,
      topDomains: listed.slice(0, 5).map((d) => d.domain),
      zones: [...new Set(listed.flatMap((d) => d.zones || []))].slice(0, 5),
    };

    if (listed.length < gate) {
      // Under the gate WITH unchecked domains left is still not a verdict — flag it rather than
      // silently confirming the drop a second time.
      if (unknown.length) { stillUnknown++; row(t, "still-unknown", shared); }
      else row(t, "genuinely-clean", shared);
      continue;
    }

    recoverable++;
    row(t, "recoverable", shared);
    if (items.length < 200) items.push({ seed: t.seed, campaignId: String(t.campaignId), was: t.blacklistedCount || 0, now: listed.length, gate });
    if (apply) {
      await setTarget(t._id, {
        stage: "qualified", activity: "recovered — blacklisted infra, contacts not pulled",
        blacklistedCount: listed.length, blacklistedDomains: listed,
        confirmedCount: domains.length, unresolvedCount: unknown.length,
        recoveredAt: new Date(), error: null,
      });
      recovered++;
    }
  }

  log.warn(apply ? "recovered wrongly-dropped seeds" : "audited wrongly-dropped seeds",
    { scanned: dropped.length, recoverable, recovered, noCachedPages, stillUnknown, nonIcp });

  if (detail) {
    // Most-blacklisted first, and within the same count the ones we're sure about ahead of the ones
    // we aren't — so the file opens on what's actually actionable.
    const rank = { recovered: 0, recoverable: 0, "still-unknown": 1, "genuinely-clean": 2, "no-cached-pages": 3, "non-icp": 4 };
    rows.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || ((b.blacklisted || 0) - (a.blacklisted || 0)));
  }
  return { ok: true, applied: apply, scanned: dropped.length, recoverable, recovered, noCachedPages, stillUnknown, nonIcp, items, ...(detail ? { rows } : {}) };
}

// The whole dropped pile as CSV — one row per seed, with the verdict that explains why it is where
// it is. Same judgement as the recovery, so the file can never disagree with what was applied.
export async function droppedSeedsCsv(campaignId) {
  const r = await recoverDroppedSeeds(campaignId, { detail: true });
  if (!r.ok) return r;
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = ["seed,verdict,blacklisted_domains,domains_checked,unchecked,gate,top_blacklisted,listed_zones,campaign_id"];
  for (const i of r.rows) {
    out.push([i.seed, i.verdict, i.blacklisted ?? "", i.checked ?? "", i.unchecked ?? "", i.gate,
      (i.topDomains || []).join("|"), (i.zones || []).join("|"), i.campaignId].map(esc).join(","));
  }
  return { ok: true, count: r.rows.length, csv: out.join("\n") };
}

// Every seed recoverDroppedSeeds brought back, newest first. `recoveredAt` is the marker, so this
// doubles as the undo list: these are exactly the targets the recovery touched.
export async function listRecoveredSeeds({ csv = false } = {}) {
  const rows = await campaignTargets().find(
    { recoveredAt: { $exists: true } },
    { projection: { seed: 1, campaignId: 1, stage: 1, blacklistedCount: 1, confirmedCount: 1, blacklistedDomains: 1, companyName: 1, people: 1, recoveredAt: 1 } },
  ).sort({ blacklistedCount: -1 }).toArray();

  // The shareable report for each seed, if one has been generated — the whole point of the file is
  // that it can be worked straight down, and a seed without its link means opening another tab.
  const bySeed = new Map(
    (await reportsCol().find({ seed: { $in: [...new Set(rows.map((r) => r.seed))] } },
      { projection: { seed: 1, blacklistedCount: 1 } }).toArray().catch(() => []))
      .map((r) => [r.seed, r._id]),
  );

  const items = rows.map((r) => ({
    seed: r.seed,
    companyName: r.companyName || "",
    campaignId: String(r.campaignId),
    stage: r.stage,
    blacklisted: r.blacklistedCount || 0,
    checked: r.confirmedCount || 0,
    contacts: (r.people || []).filter((p) => p.email).length,
    topDomains: (r.blacklistedDomains || []).slice(0, 5).map((d) => d.domain),
    zones: [...new Set((r.blacklistedDomains || []).flatMap((d) => d.zones || []))].slice(0, 5),
    reportToken: bySeed.get(r.seed) || "",
    recoveredAt: r.recoveredAt,
  }));
  if (!csv) return { ok: true, count: items.length, items };

  const host = process.env.REPORT_PUBLIC_URL || "https://blacklist-report.com";
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = ["seed,company,blacklisted_domains,domains_checked,contacts,report_url,top_blacklisted,listed_zones,stage,campaign_id,recovered_at"];
  for (const i of items) {
    out.push([i.seed, i.companyName || "", i.blacklisted, i.checked, i.contacts,
      i.reportToken ? `${host}/r/${i.reportToken}` : "",
      i.topDomains.join("|"), i.zones.join("|"), i.stage, i.campaignId,
      i.recoveredAt ? new Date(i.recoveredAt).toISOString() : ""].map(esc).join(","));
  }
  return { ok: true, count: items.length, withReport: items.filter((i) => i.reportToken).length, csv: out.join("\n") };
}

// The SendKit lead payload for the RECOVERED seeds only, across every campaign at once. Same columns
// as campaignCsv — same leadPayload builder, so the two files can't drift — but scoped by
// recoveredAt instead of by campaign, because the recovered seeds are spread over five runs and the
// point of the file is that they arrive as one list.
export async function recoveredLeadsCsv() {
  const targets = await campaignTargets().find({ recoveredAt: { $exists: true }, peopleCount: { $gt: 0 } })
    .sort({ blacklistedCount: -1 }).toArray();

  // Fill in company names we don't hold on the target, so the copy says "RingCentral's" and not
  // "ringcentral.com's". One query for all of them, not one per row.
  const needName = targets.filter((t) => !t.companyName).map((t) => t.seed);
  if (needName.length) {
    const rows = await leadsCol().find(
      { company_domain: { $in: needName }, company: { $nin: [null, ""] } },
      { projection: { company_domain: 1, company: 1 } },
    ).toArray().catch(() => []);
    const byDomain = new Map(rows.map((r) => [r.company_domain, r.company]));
    for (const t of targets) if (!t.companyName && byDomain.has(t.seed)) t.companyName = byDomain.get(t.seed);
  }

  const cols = ["email", "firstName", "lastName", "companyName", "jobTitle", "linkedinUrl",
    "secondaryDomainCount", "blacklistedDomainCount", "domain1", "domain2", "domain3", "domain4"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = [cols.join(",")];
  let companies = 0, duplicates = 0;
  // A company recovered by more than one run appears once per run, so the same person can be emitted
  // twice. Targets are sorted by blacklistedCount desc, so the FIRST copy of an address is the one
  // carrying the strongest numbers — keep that and drop the rest.
  const seen = new Set();
  for (const t of targets) {
    let any = false;
    for (const p of t.people || []) {
      if (!p.email) continue;
      const key = p.email.trim().toLowerCase();
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      any = true;
      const l = leadPayload(p, t);
      out.push(cols.map((c) => esc(l[c])).join(","));
    }
    if (any) companies++;
  }
  return { csv: out.join("\n"), rows: out.length - 1, companies, duplicates };
}

// Kick off contact enrichment for every campaign that still holds recovered (stage "qualified")
// seeds — they are spread across five runs, and doing them one endpoint call at a time is just a
// worse way to spend the same credits.
export async function enrichAllRecovered() {
  const ids = await campaignTargets().distinct("campaignId", { stage: "qualified", recoveredAt: { $exists: true } });
  const started = [];
  for (const id of ids) {
    const r = await enrichQualifiedCompanies(String(id)).catch((e) => ({ ok: false, error: e.message }));
    started.push({ campaignId: String(id), ...r });
  }
  return { ok: started.some((s) => s.ok), campaigns: started.length, started };
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
