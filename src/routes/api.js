// Read-only API for the dashboard frontend.

import { Router, text as textBody } from "express";
import { ObjectId } from "mongodb";
import { leads, engagements, usage, sources, reprocessRuns, scrapedPosts, scrapeEngagers, bouncebanRuns, campaignState, pndDaily, engineState } from "../db/mongo.js";
import { sourcesStatus, scrapeOnePost, scrapePostStatus, pauseScrapePost } from "../pipeline/sources.js";
import { rapidScrapeStats, activityUrn } from "../services/rapidScrape.js";
import { pndStats, pndPostInfo, pndRaw, pndOutOfCredits } from "../services/pnd.js";
import { bouncebanStats, bouncebanBalance } from "../services/bounceban.js";
import { linkedinProfileStats } from "../services/linkedinProfile.js";
import { meterCumulative, readBalances } from "../services/apiMeter.js";
import { rerouteSourceLeads, rerouteStatus } from "../pipeline/reroute.js";
import { trigifyBalance } from "../services/trigify.js";
import { prospeoBalance, verifyEmail } from "../services/prospeo.js";
import { jinaBalance } from "../services/jina.js";
import { resolveStats } from "../services/resolve.js";
import { validateEmail } from "../services/enrich.js";
import { findEmailWaterfall } from "../pipeline/enrichLead.js";
import { reprocessNoEmail, reprocessStatus, noEmailQuery, MISS_REASONS } from "../pipeline/reprocess.js";
import { runBouncebanAudit, bouncebanAuditStatus, bouncebanScorecard, bouncebanProof, runBouncebanRepair, bouncebanRepairStatus, bouncebanCampaignReport, dncUnvouched, auditQuery } from "../pipeline/bouncebanAudit.js";
import { runKeywordSweep, keywordSweepStatus, pauseKeywordSweep, runManualKeyword, keywordManualStatus, pauseKeywordManual, keywordRunnerBusy } from "../pipeline/keywordSweep.js";
import { autoStatus, setAutoEnabled, rotateNow } from "../pipeline/autoScrape.js";
import { reconcileDnc } from "../pipeline/dncSync.js";
import { syncVerified, syncStatus } from "../pipeline/sync.js";
import { syncCampaignLocks, campaignLockStatus, planEnrolment } from "../pipeline/campaignLocks.js";
import { CAMPAIGNS, campaignByKey, campaignLabel, sendkitIdsFor, INTAKE_SENDKIT_ID } from "../services/campaigns.js";
import { upsertLeads, addLeadsToCampaign, addToDnc, listCampaigns, campaignSummary, updateCampaignSchedule } from "../services/sendkit.js";
import { createKey as createMcpKey, listKeys as listMcpKeys, revokeKey as revokeMcpKey, recentAudit as recentMcpAudit } from "../services/mcpKeys.js";
import { startDomainScan, getDomainScan, listDomainScans } from "../pipeline/domainScan.js";
import { createReport, listReports, deleteReport, bulkCreateReports, listRequests, setRequestStatus } from "../pipeline/report.js";
import { startAgencyRun, getAgencyRun, listAgencyRuns, agencyResults, agencyClients, enrichAgencies, agencyLeadsCsv, retryAgencyRun, stopAgencyRun } from "../pipeline/agency.js";
import { sourceAgencies, listAgencySources, markSourcesUsed } from "../pipeline/agencySource.js";
import {
  importCreatorCompanies, importCreatorUsers, importCreatorSpend, startCreatorEnrich, creatorEnrichStatus,
  stopCreatorEnrich, rescoreCreators, matchOwnAudience, creatorStats, creatorList, creatorCsv,
  SEGMENTS, DEFAULT_GATES,
} from "../pipeline/creator.js";
import { diagnose as diagnoseBlacklistProject, domainDetail } from "../services/blacklistProject.js";
import { dnsSelfTest } from "../services/domainDns.js";
import { diagnose as diagnoseHostio, scrapeDiagnose } from "../services/hostio.js";
import { startBlacklistScan, estimateBlacklistScan, getBlacklistScan, blacklistScanResults } from "../pipeline/blacklistScan.js";
import { startCampaign, getCampaign, getCampaignResults, listCampaigns as listOutreachCampaigns, revealCompanyEmails, hostioUsageReport, pushCampaignToSendkit, previewCampaignEmail, resumeCampaign, stopCampaign, deleteCampaign, backfillOwnLeadContacts, enrichQualifiedCompanies, recoverDroppedSeeds, droppedSeedsCsv, listRecoveredSeeds, campaignResultsCsv, campaignContactCount, recoveredLeadsCsv, enrichAllRecovered, listWorkspaces, pushTarget, campaignCsv, verifySeedAgainstHostio } from "../pipeline/campaign.js";
import { backfillCompanyDomains, backfillDomainsStatus } from "../pipeline/backfillDomains.js";
import { reclassifyIcp, reclassifyIcpStatus } from "../pipeline/reclassifyIcp.js";
import { safeEqual } from "../lib/auth.js";
import { config } from "../config.js";

export const apiRouter = Router();

// Coerce a query param to a plain string — blocks Mongo operator injection via qs
// bracket notation (?status[$ne]=x would otherwise arrive as an object).
const S = (v) => (typeof v === "string" ? v : "");
const escRegex = (v) => S(v).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Tiny in-memory TTL cache for the read-heavy, slow-changing dashboard aggregates (stats/campaigns/
// analytics). Keyed by full URL so ?campaign= variants cache separately. Repeated loads (tab
// switches, the 25s poll, multiple tabs) hit the cache instead of recomputing on Mongo.
const _cache = new Map();
const ttlCache = (seconds) => (req, res, next) => {
  const key = req.originalUrl;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < seconds * 1000) { res.set("X-Cache", "HIT"); return res.json(hit.body); }
  const orig = res.json.bind(res);
  res.json = (body) => { _cache.set(key, { at: Date.now(), body }); res.set("X-Cache", "MISS"); return orig(body); };
  next();
};

// counts for a lead filter (optionally scoped to one campaign)
// Go-forward bucketing: 2.0 = leads first seen on/after 27 Jul (the new-intake era), 1.0 = older
// (the multi-campaign base). Derived from created_at since the SendKit 1.0/2.0 membership isn't
// mirrored per-lead in Mongo. Campaigns + Hand-off drill 1.0/2.0 -> topic using this.
const BUCKET_CUTOFF = new Date("2026-07-27T00:00:00.000Z");
const bucketFilter = (b) => b === "1.0" ? { created_at: { $lt: BUCKET_CUTOFF } } : b === "2.0" ? { created_at: { $gte: BUCKET_CUTOFF } } : {};

async function countBlock(campaign, bucket) {
  campaign = S(campaign);
  const L = leads();
  const base = { ...(campaign ? { campaigns: campaign } : {}), ...bucketFilter(S(bucket)) };
  const [total, hot, warm, cold, verified, noEmail, unverified, review, competitor, recovered, dnc, discarded] = await Promise.all([
    L.countDocuments(base),
    L.countDocuments({ ...base, status: "hot" }),
    L.countDocuments({ ...base, status: "warm" }),
    L.countDocuments({ ...base, status: "cold" }),
    L.countDocuments({ ...base, email_status: "verified" }),
    L.countDocuments({ ...base, email_status: "no-email" }),
    L.countDocuments({ ...base, email_status: "unverified" }),
    L.countDocuments({ ...base, email_status: "review" }),
    L.countDocuments({ ...base, email_status: "competitor" }),
    L.countDocuments({ ...base, recovered: true }),   // emails rescued by a hand-off retry
    L.countDocuments({ ...base, dnc: true }),          // blocked AFTER reaching SendKit -> DNC'd
    L.countDocuments({ ...base, email_status: "discarded" }),
  ]);
  // SendKit stores ONE lead per EMAIL, but we store one doc per LinkedIn PROFILE — and two
  // profiles can resolve to the same address. So `verified` (docs) will always read higher
  // than SendKit. `verifiedEmails` is the distinct-email count: THAT is what SendKit can hold.
  const verifiedEmails = (await L.distinct("email", { ...base, email_status: "verified", email: { $ne: null } })).length;
  return { total, hot, warm, cold, verified, verifiedEmails, noEmail, unverified, review, competitor, recovered, dnc, discarded };
}

// shared lead filter builder (used by /leads and /export)
function buildLeadFilter(query) {
  const status = S(query.status), email_status = S(query.email_status), category = S(query.category), campaign = S(query.campaign), recovered = S(query.recovered), q = S(query.q);
  const filter = {};
  // status accepts one value or a comma-separated set ("hot,warm") so several buckets can be
  // viewed/exported together instead of one at a time.
  if (status) {
    const list = status.split(",").map((s) => s.trim()).filter(Boolean);
    filter.status = list.length > 1 ? { $in: list } : list[0];
  }
  // "has-email" = every lead we ever produced an address for (verified + unverified) — the Test tab.
  if (email_status === "has-email") { filter.email_status = { $in: ["verified", "unverified"] }; filter.email = { $nin: [null, ""] }; }
  else if (email_status) filter.email_status = email_status;
  if (category) filter.categories = category;
  if (campaign) filter.campaigns = campaign;
  if (recovered === "1") filter.recovered = true;
  if (S(query.dnc) === "1") filter.dnc = true;
  const src = S(query.source);
  if (src === "keyword") filter.source = { $in: [null, ""] };   // keyword engagers carry no source
  else if (src) filter.source = src;                            // influencer | hub
  if (S(query.list)) filter.source_list = { $regex: escRegex(query.list), $options: "i" };
  Object.assign(filter, bucketFilter(S(query.bucket))); // 1.0 / 2.0 drill-down
  if (q) {
    const rx = escRegex(q); // escaped -> literal substring match, no ReDoS / regex injection
    filter.$or = [{ name: { $regex: rx, $options: "i" } }, { email: { $regex: rx, $options: "i" } }, { company: { $regex: rx, $options: "i" } }];
  }
  return filter;
}

// GET /api/stats?campaign= — headline counts (all campaigns, or one), + live Trigify balance
apiRouter.get("/stats", ttlCache(8), async (req, res) => {
  const campaign = S(req.query.campaign);
  const counts = await countBlock(campaign, S(req.query.bucket));
  const engFilter = campaign ? { campaign } : {};
  const engCount = await engagements().countDocuments(engFilter);
  const [prospeo, jina, meter, apiBalance, bounceban] = await Promise.all([prospeoBalance(), jinaBalance(), meterCumulative(), readBalances(), bouncebanBalance()]);
  // `meter` = cumulative counters we tracked (started mid-life, so it UNDER-counts historical usage).
  // `apiBalance` = the RapidAPI plans' REAL remaining, snapshotted from their response headers — this
  // is the source of truth for "credits left", not a plan−meter estimate.
  res.json({ ...counts, engagements: engCount, prospeo, jina, bounceban, resolver: resolveStats(), meter, apiBalance,
    apiUsage: { rapid: rapidScrapeStats(), profile: linkedinProfileStats(), pnd: pndStats(), bounceban: bouncebanStats() } });
});

// GET /api/campaigns — one row per campaign: counts + per-campaign credits (trigify/prospeo/sendkit)
// ONE aggregation pass over `leads` (grouped per campaign) — replaces ~14 count-blocks × ~13 scans
// that made this take 17s under concurrency.
const cnt = (field, val) => ({ $sum: { $cond: [{ $eq: ["$" + field, val] }, 1, 0] } });
const cntTruthy = (field) => ({ $sum: { $cond: [{ $ifNull: ["$" + field, false] }, 1, 0] } });
apiRouter.get("/campaigns", ttlCache(10), async (req, res) => {
  const bucket = S(req.query.bucket);
  const [agg, uRows, prospeo, jina, pausedRows, credRows] = await Promise.all([
    leads().aggregate([
      { $match: { campaigns: { $exists: true, $ne: [] }, ...bucketFilter(bucket) } },
      { $unwind: "$campaigns" },
      { $group: {
        _id: "$campaigns", total: { $sum: 1 },
        hot: cnt("status", "hot"), warm: cnt("status", "warm"), cold: cnt("status", "cold"),
        verified: cnt("email_status", "verified"), noEmail: cnt("email_status", "no-email"),
        unverified: cnt("email_status", "unverified"), review: cnt("email_status", "review"),
        competitor: cnt("email_status", "competitor"), discarded: cnt("email_status", "discarded"),
        recovered: cntTruthy("recovered"), dnc: cntTruthy("dnc"),
      } },
      // NOTE: distinct-verified-email count ("In SendKit") was a $addToSet over the whole collection
      // that spilled to disk (~16s). Dropped — verifiedEmails now approximates to the verified count.
    ]).toArray(),
    usage().find({}).toArray(),
    prospeoBalance(), jinaBalance(),
    campaignState().find({ paused: true }, { projection: { key: 1 } }).toArray().catch(() => []),
    // PND credits spent scraping into each campaign, summed from the per-post ledger (keyed by campaign_key).
    scrapedPosts().aggregate([
      { $match: { campaign_key: { $ne: null }, "pnd_credits.total": { $gt: 0 } } },
      { $group: { _id: "$campaign_key", pnd: { $sum: "$pnd_credits.total" }, posts: { $sum: 1 } } },
    ]).toArray().catch(() => []),
  ]);
  const pausedSet = new Set(pausedRows.map((r) => r.key));
  const uMap = Object.fromEntries(uRows.map((u) => [u.campaign, u]));
  const credMap = Object.fromEntries(credRows.map((c) => [c._id, c]));
  const out = agg.map((g) => {
    const u = uMap[g._id] || {};
    const c = credMap[g._id] || {};
    return {
      campaign: g._id, label: campaignLabel(g._id),
      total: g.total, hot: g.hot, warm: g.warm, cold: g.cold,
      verified: g.verified, verifiedEmails: g.verified,
      noEmail: g.noEmail, unverified: g.unverified, review: g.review, competitor: g.competitor, discarded: g.discarded,
      recovered: g.recovered, dnc: g.dnc,
      paused: pausedSet.has(g._id),
      pndCredits: c.pnd || 0, pndPosts: c.posts || 0,
      credits: { trigify: u.trigify_scraped || 0, prospeo: u.prospeo_finds || 0, sendkit: g.verified },
    };
  }).sort((a, b) => b.total - a.total);
  res.json({ campaigns: out, prospeo, jina });
});

// GET /api/pnd/daily?days=7 — per-day PND spend, broken down by surface. The credit "days logs".
apiRouter.get("/pnd/daily", async (req, res) => {
  const days = Math.min(60, Math.max(1, parseInt(req.query.days || "7", 10)));
  const rows = await pndDaily().find({}).sort({ _id: -1 }).limit(days).toArray().catch(() => []);
  res.json({ days: rows.map((r) => ({ day: r._id, scrape: r.scrape || 0, profile: r.profile || 0, company: r.company || 0, total: r.total || 0, cacheSaved: r.cache_saved || 0, kinds: r.kinds || {} })) });
});

// GET /api/campaigns/list — every campaign that EXISTS, straight from campaigns.js.
// Deliberately not /api/campaigns: that one aggregates from the leads collection, so a campaign
// with no leads yet is missing from it entirely — which made it impossible to route a manual
// scrape INTO an empty campaign. This is the list the routing dropdowns use.
apiRouter.get("/campaigns/list", (_req, res) =>
  // Only the two go-forward send targets (1.0 / 2.0) — the topic campaigns no longer receive new leads.
  res.json({ campaigns: CAMPAIGNS.filter((c) => c.manualTarget).map((c) => ({ key: c.key, label: c.label, category: c.category })) }));

// GET /api/sendkit/campaigns — LIVE list of every campaign in the SendKit workspace, including any
// created directly in SendKit (not in our hardcoded config). Read-only; used by the MCP server.
// PATCH one SendKit campaign's sending schedule (timezone / hours / working days). SendKit defaults
// new campaigns to America/New_York 09:00-17:00 Mon-Fri, which leaves a campaign idle outside that
// window; this points it at the hours you actually want to send in.
apiRouter.post("/sendkit/campaigns/:id/schedule", async (req, res) => {
  const b = req.body || {};
  const schedule = {
    timezone: S(b.timezone) || "Asia/Kolkata",
    startTime: S(b.startTime) || "09:00",
    endTime: S(b.endTime) || "21:00",
    workingDays: Array.isArray(b.workingDays) ? b.workingDays.map(Number).filter((n) => n >= 0 && n <= 6) : [1, 2, 3, 4, 5, 6],
  };
  const r = await updateCampaignSchedule(req.params.id, schedule);
  res.status(r.ok ? 200 : 400).json({ ...r, schedule });
});

apiRouter.get("/sendkit/campaigns", async (_req, res) => {
  try { res.json({ campaigns: await listCampaigns() }); }
  catch (e) { res.status(502).json({ error: "sendkit unavailable", detail: e.message }); }
});

// GET /api/campaigns/summary — the CORRECT campaign view: the two real go-forward campaigns (1.0 / 2.0).
// `sendkit` = the source of truth (what's actually in the campaign + sent/replied/bounced). `have` =
// what the engine has collected for that bucket in Mongo (verified addresses, no-email, recovered).
// The old topic names (Smartlead, GTM, …) are KEYWORDS now, not campaigns — see /api/campaigns.
apiRouter.get("/campaigns/summary", ttlCache(20), async (_req, res) => {
  const targets = CAMPAIGNS.filter((c) => c.manualTarget && c.sendkitId);
  const out = await Promise.all(targets.map(async (c) => {
    const bucket = /2\.0/.test(c.key) ? "2.0" : /1\.0/.test(c.key) ? "1.0" : "";
    const [sk, have] = await Promise.all([campaignSummary(c.sendkitId), countBlock("", bucket)]);
    return {
      key: c.key, label: c.label, bucket, sendkitId: c.sendkitId,
      status: sk?.status || "unknown",
      sendkit: sk ? { inCampaign: sk.inCampaign, sent: sk.sent, replied: sk.replied, bounced: sk.bounced, active: sk.active, pending: sk.pending } : null,
      have: { total: have.total, verified: have.verifiedEmails, verifiedProfiles: have.verified, noEmail: have.noEmail, unverified: have.unverified, recovered: have.recovered },
    };
  }));
  res.json({ campaigns: out });
});

// ── Hosted-MCP key management (behind the dashboard basic-auth). Issue a key per teammate, list
// usage (incl. last IP), and revoke. The raw key is returned ONCE on creation and never again. ──
apiRouter.post("/mcp/keys", async (req, res) => res.json(await createMcpKey(S(req.body?.label))));
apiRouter.get("/mcp/keys", async (_req, res) => res.json({ keys: await listMcpKeys() }));
apiRouter.post("/mcp/keys/:id/revoke", async (req, res) => res.json(await revokeMcpKey(req.params.id)));
apiRouter.get("/mcp/audit", async (req, res) => res.json({ audit: await recentMcpAudit(parseInt(req.query.limit || "100", 10)) }));

// GET /api/leads/ids — every linkedin_url matching the CURRENT filter, so "select all" can mean
// all 800 results rather than the 100 on screen. Ids only (no documents), so even a large result
// set is a small response.
apiRouter.get("/leads/ids", async (req, res) => {
  const filter = buildLeadFilter(req.query);
  const rows = await leads().find(filter, { projection: { linkedin_url: 1, _id: 0 } }).limit(20000).toArray();
  res.json({ ids: rows.map((r) => r.linkedin_url), count: rows.length });
});

// POST /api/leads/backfill-domains — fill company_domain where missing (email @-domain, then Clearbit
// on company name). Runs in the background; GET .../status polls it.
apiRouter.post("/leads/backfill-domains", (req, res) => {
  if (backfillDomainsStatus().running) return res.json({ ok: false, error: "already running" });
  backfillCompanyDomains({ nameCap: parseInt(req.body?.nameCap || "500", 10) }).catch((e) => console.error("backfill domains error", e.message));
  res.json({ ok: true, started: true });
});
apiRouter.get("/leads/backfill-domains/status", (_req, res) => res.json(backfillDomainsStatus()));

// POST /api/leads/reclassify-icp — sweep existing leads and move any now-non-ICP ones (big tech,
// banks, …) out of hot/warm to "out-of-icp"/cold, DNC'ing those already in a campaign. Background.
apiRouter.post("/leads/reclassify-icp", (_req, res) => {
  if (reclassifyIcpStatus().running) return res.json({ ok: false, error: "already running" });
  reclassifyIcp().catch((e) => console.error("reclassify icp error", e.message));
  res.json({ ok: true, started: true });
});
apiRouter.get("/leads/reclassify-icp/status", (_req, res) => res.json(reclassifyIcpStatus()));

// GET /api/leads?status=&email_status=&category=&campaign=&q=&sort=&limit=&skip=
apiRouter.get("/leads", async (req, res) => {
  const filter = buildLeadFilter(req.query);
  const sortField = req.query.sort === "recent" ? "last_engagement_at" : "score";
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 10000);
  const skip = parseInt(req.query.skip || "0", 10);

  const [rows, count] = await Promise.all([
    leads().find(filter).sort({ [sortField]: -1 }).skip(skip).limit(limit).toArray(),
    leads().countDocuments(filter),
  ]);
  res.json({ count, rows });
});

// GET /api/leads/:id/timeline — every engagement for one person
apiRouter.get("/leads/:linkedin_url/timeline", async (req, res) => {
  const url = decodeURIComponent(req.params.linkedin_url);
  const rows = await engagements().find({ linkedin_url: url }).sort({ created_at: -1 }).toArray();
  res.json({ rows });
});

// GET /api/analytics?campaign= — status split, funnel, daily series (for the Overview charts)
apiRouter.get("/analytics", ttlCache(10), async (req, res) => {
  const campaign = S(req.query.campaign);
  const match = campaign ? { campaigns: campaign } : {};
  const counts = await countBlock(campaign);
  const emailFound = await leads().countDocuments({ ...match, email: { $ne: null } });
  const series = await leads().aggregate([
    { $match: { ...match, created_at: { $ne: null } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } }, total: { $sum: 1 }, verified: { $sum: { $cond: [{ $eq: ["$email_status", "verified"] }, 1, 0] } } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  res.json({
    status: { hot: counts.hot, warm: counts.warm, cold: counts.cold },
    funnel: { scraped: counts.total, emailFound, verified: counts.verified, noEmail: counts.noEmail, review: counts.review, competitor: counts.competitor, unverified: counts.unverified },
    series: series.map((s) => ({ day: s._id, total: s.total, verified: s.verified })),
  });
});

// GET /api/export — CSV of a filtered view or an explicit ?urls= list (selected rows)
const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                 // neutralize spreadsheet formula injection
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// Free-mail providers aren't a company domain, so we never derive one from them.
const EXPORT_FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "yahoo.co.in", "rocketmail.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com", "hey.com", "rediffmail.com"]);
const exportCompanyDomain = (r) => {
  if (r.company_domain) return r.company_domain;
  const d = (r.email || "").split("@")[1]?.toLowerCase();
  return d && !EXPORT_FREE_MAIL.has(d) ? d : "";
};
apiRouter.get("/export", async (req, res) => {
  let rows;
  if (req.query.urls) {
    const urls = String(req.query.urls).split(",").map((u) => decodeURIComponent(u));
    rows = await leads().find({ linkedin_url: { $in: urls } }).toArray();
  } else {
    rows = await leads().find(buildLeadFilter(req.query)).sort({ score: -1 }).limit(50000).toArray();
  }
  const cols = ["name", "email", "email_status", "email_method", "verified_by", "company", "company_domain", "status", "score", "categories", "times_seen", "personal_email", "created_at", "last_engagement_at", "linkedin_url"];
  const valOf = (r, c) => (c === "company_domain" ? exportCompanyDomain(r) : Array.isArray(r[c]) ? r[c].join("|") : r[c]);
  const body = rows.map((r) => cols.map((c) => csvCell(valOf(r, c))).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="gtm-leads.csv"`);
  res.send(cols.join(",") + "\n" + body);
});

// POST /api/leads/:url/reverify {provider: prospeo|enrich|refind} — manual per-lead action
apiRouter.post("/leads/:url/reverify", async (req, res) => {
  const url = decodeURIComponent(req.params.url);
  const d = await leads().findOne({ linkedin_url: url });
  if (!d) return res.status(404).json({ ok: false, error: "not found" });
  const provider = (req.body?.provider || "").toLowerCase();

  if (provider === "refind") {
    const w = await findEmailWaterfall({ name: d.name, headline: d.headline, linkedin_url: url });
    if (w.em.found && w.em.email) {
      await leads().updateOne({ linkedin_url: url }, { $set: { email: w.em.email, email_method: w.emailMethod, email_source: w.emailSource, updated_at: new Date() } });
      return res.json({ ok: true, action: "refind", email: w.em.email, method: w.emailMethod });
    }
    return res.json({ ok: false, action: "refind", message: "no email found" });
  }
  if (!d.email) return res.json({ ok: false, message: "no email to verify" });
  if (provider === "prospeo") {
    const v = await verifyEmail(d.email);
    if (v.ok) await leads().updateOne({ linkedin_url: url }, { $set: { verified_by: "prospeo", email_status: "verified", verify_detail: "manual:prospeo:" + v.status } });
    return res.json({ ok: v.ok, provider: "prospeo", result: v.status });
  }
  const v = await validateEmail(d.email);
  if (v.good) await leads().updateOne({ linkedin_url: url }, { $set: { verified_by: "enrich", email_status: "verified", verify_detail: "manual:enrich:" + v.result } });
  return res.json({ ok: v.good, provider: "enrich", result: v.result, confidence: v.confidence });
});

// POST /api/sync {campaign?} — reconcile verified leads -> correct SendKit campaign + re-find missing method
apiRouter.post("/sync", (req, res) => {
  const st = syncStatus();
  if (st.running) return res.json({ started: false, ...st });
  syncVerified({ campaign: req.body?.campaign || "" }).catch((e) => console.error("sync error", e.message));
  res.json({ started: true });
});
apiRouter.get("/sync/status", (_req, res) => res.json(syncStatus()));

// POST /api/campaigns/:key/pause {paused} — disable/enable the campaign's Trigify workflow
// POST /api/campaigns/:key/pause { paused } — stop (or resume) generating leads for a campaign.
//
// This used to toggle a Trigify WORKFLOW by name. Trigify no longer runs our keyword searches — the
// engine's own sweep does — so the lookup always failed and the button reported "workflow not
// found". Pausing now means the keyword sweep skips this campaign's keywords entirely.
//
// It does NOT stop SendKit from emailing people already in the campaign: that is controlled in
// SendKit itself. This only stops NEW leads being found for it.
apiRouter.post("/campaigns/:key/pause", async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (!campaignByKey(key)) return res.json({ ok: false, error: `unknown campaign: ${key}` });
  const paused = req.body?.paused !== false;
  await campaignState().updateOne({ key }, { $set: { key, paused, updated_at: new Date() } }, { upsert: true });
  res.json({ ok: true, key, paused, scope: "keyword sweep only — SendKit sending is controlled in SendKit" });
});

// POST /api/leads/decision { urls:[], action:"approve"|"discard" }
// Manual adjudication of the `review` bucket — the emails the name-match guard held back
// because the local-part didn't plausibly match the person's name. You are the tie-breaker:
//   approve -> treat as verified, push into EVERY campaign the lead belongs to
//   discard -> never send; and if it already reached SendKit, DNC it so it can't be emailed
const tagsForDoc = (d) => [
  "gtm-auto", ...(d.categories || []).map((c) => "cat:" + c),
  "score:" + d.score, "seen:" + d.times_seen, (d.status || "cold") + "-lead",
  ...(d.source ? ["source:" + d.source] : []),
];
apiRouter.post("/leads/decision", async (req, res) => {
  const action = S(req.body?.action);
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.map(S).filter(Boolean) : [];
  if (!["approve", "discard"].includes(action)) return res.status(400).json({ ok: false, error: "bad action" });
  if (!urls.length) return res.status(400).json({ ok: false, error: "no leads selected" });

  const docs = await leads().find({ linkedin_url: { $in: urls } }).toArray();
  const now = new Date();

  if (action === "discard") {
    let discarded = 0, dnc = 0;
    for (const d of docs) {
      await leads().updateOne({ linkedin_url: d.linkedin_url },
        { $set: { email_status: "discarded", discarded: true, needs_email: false, updated_at: now } });
      discarded++;
      // already pushed to SendKit? DNC is the only way to guarantee it is never emailed.
      if (d.email && d.sendkit_campaigns?.length) {
        await addToDnc([d.email]);
        await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { dnc: true, dnc_at: now } });
        dnc++;
      }
    }
    return res.json({ ok: true, discarded, dnc });
  }

  // approve
  const keep = docs.filter((d) => d.email);
  const byEmail = new Map();
  for (const d of keep) {
    const [first, ...rest] = (d.name || "").split(" ");
    const e = d.email.trim().toLowerCase();
    if (!byEmail.has(e)) byEmail.set(e, { email: e, firstName: first, lastName: rest.join(" "), companyName: d.company || "", jobTitle: d.headline || "", linkedinUrl: d.linkedin_url, tags: tagsForDoc(d) });
  }
  await upsertLeads([...byEmail.values()]);

  // Manual approval can hit leads that are already enrolled — push only the ones that aren't.
  // `placed` still covers everyone, so the membership recorded below stays correct either way.
  const { toPush, placed: emailToCid } = await planEnrolment(
    keep.map((d) => ({ email: d.email, sendkitCampaigns: d.sendkit_campaigns })),
    INTAKE_SENDKIT_ID,
  );
  let pushed = 0;
  for (const [cid, set] of toPush) {
    const r = await addLeadsToCampaign(cid, [...set]);
    pushed += r.added;
  }
  for (const d of keep) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, {
      $set: {
        email_status: "verified", email_low_confidence: false, needs_email: false, unverified: false,
        manually_approved: true, approved_at: now, verified_by: "manual",
        tags: tagsForDoc(d), sendkit_campaigns: emailToCid.get(d.email.trim().toLowerCase()) ? [emailToCid.get(d.email.trim().toLowerCase())] : [], updated_at: now,
      },
    });
  }
  res.json({ ok: true, approved: keep.length, pushed });
});

// POST /api/reprocess {campaigns:[]} — re-run no-email leads through the Enrich-first waterfall
const campList = (v) => (Array.isArray(v) ? v.map(S).filter(Boolean) : []);
apiRouter.post("/reprocess", (req, res) => {
  const st = reprocessStatus();
  if (st.running) return res.json({ started: false, ...st });
  // concurrency 14: each lead is mostly network-wait (Clearbit -> Enrich -> proxy resolve -> Prospeo),
  // so a wider pool is ~3x faster wall-clock without meaningfully more CPU.
  // deep: ignore backoff/terminal-skip/attempt-cap/paid-once — every stuck lead, always pay, once more.
  reprocessNoEmail({ concurrency: 14, campaigns: campList(req.body?.campaigns), deep: !!req.body?.deep, bucket: S(req.body?.bucket) })
    .catch((e) => console.error("reprocess error", e.message));
  res.json({ started: true });
});
apiRouter.get("/reprocess/status", (_req, res) => res.json(reprocessStatus()));

// ── BounceBan audit ("Test" tab) — re-verify every found email against BounceBan and make it the
// source of truth: only BounceBan-approved addresses stay in SendKit; rejects are DNC'd + badged.
apiRouter.post("/bounceban/audit", (req, res) => {
  const st = bouncebanAuditStatus();
  if (st.running) return res.json({ started: false, ...st });
  runBouncebanAudit({ concurrency: 8, campaigns: campList(req.body?.campaigns), limit: parseInt(req.body?.limit || "0", 10) })
    .catch((e) => console.error("bounceban audit error", e.message));
  res.json({ started: true });
});
apiRouter.get("/bounceban/audit/status", (_req, res) => res.json(bouncebanAuditStatus()));
// How good were Enrich / Prospeo really? Confirmed-vs-rejected of what each ORIGINALLY verified.
apiRouter.get("/bounceban/scorecard", async (_req, res) => {
  const [card, runs] = await Promise.all([
    bouncebanScorecard(),
    bouncebanRuns().find({}).sort({ finishedAt: -1 }).limit(10).toArray(),
  ]);
  res.json({ ...card, runs });
});
// Count of what the audit would cover (leads with an email: verified + unverified).
apiRouter.get("/bounceban/count", async (_req, res) => res.json({ count: await leads().countDocuments(auditQuery()) }));

// Re-push confirmed leads the original audit lost to the rate limit (bulk path, no BounceBan cost).
apiRouter.post("/bounceban/repair", (_req, res) => {
  const st = bouncebanRepairStatus();
  if (st.running) return res.json({ alreadyRunning: true, ...st });
  runBouncebanRepair().catch((e) => console.error("bounceban repair error", e.message));
  res.json({ started: true });
});
apiRouter.get("/bounceban/repair/status", (_req, res) => res.json(bouncebanRepairStatus()));

// Verify the audit's guarantee against SendKit itself, rather than against our own counters.
// Walks SendKit's whole DNC list, so it takes ~30-60s — no TTL cache, it must be a live read.
apiRouter.get("/bounceban/proof", async (_req, res) => {
  try { res.json(await bouncebanProof()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-campaign before/after, checked against SendKit's own membership counts.
apiRouter.get("/bounceban/campaign-report", async (_req, res) => {
  try { res.json(await bouncebanCampaignReport()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Block every emailable address BounceBan never approved (strays from outside our pipeline).
apiRouter.post("/bounceban/dnc-unvouched", async (_req, res) => {
  try { res.json(await dncUnvouched()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Pull SendKit's block list onto our leads on demand (it also runs before every audit and sync).
apiRouter.post("/dnc/reconcile", async (_req, res) => {
  try {
    const r = await reconcileDnc();
    res.json({ ok: true, dncEmails: r.emails.size, marked: r.marked, cleared: r.cleared, truncated: r.truncated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Teach the lock who SendKit is already emailing. Reads 1.0 + 2.0 membership and records, per
// email, the ONE campaign it may live in — so a person already in 1.0 is never re-enrolled into
// 2.0. Runs daily on its own; this is the on-demand trigger (and ?dry=1 to preview).
apiRouter.post("/campaign-locks/sync", async (req, res) => {
  try {
    const apply = req.query.dry !== "1";
    res.json({ ok: true, ...(await syncCampaignLocks({ apply })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/campaign-locks/status — last reconcile result + whether one is in flight.
apiRouter.get("/campaign-locks/status", (_req, res) => res.json(campaignLockStatus()));

// GET /api/reprocess/runs — history of retry runs (recovered per run + why the rest missed)
apiRouter.get("/reprocess/runs", async (_req, res) => {
  const runs = await reprocessRuns().find({}).sort({ finishedAt: -1 }).limit(20).toArray();
  res.json({ runs, reasonLabels: MISS_REASONS });
});

// GET /api/reprocess/count?campaigns=a,b — TRUE distinct no-email count for a selection.
// The UI must never add up per-campaign no-email totals: a lead in two campaigns would be
// counted twice (that's how "8,262 to retry" appeared next to a real hand-off of 7,048).
apiRouter.get("/reprocess/count", async (req, res) => {
  const camps = S(req.query.campaigns).split(",").map((x) => x.trim()).filter(Boolean);
  res.json({ count: await leads().countDocuments(noEmailQuery(camps, S(req.query.bucket))) });
});

// ── Sources (LinkedIn hubs + influencers) ──────────────────────────────
apiRouter.get("/sources", async (_req, res) => {
  // Only the hand-managed sources are returned in full (hubs + manual/harvested influencers).
  // Imported CSV lists can be thousands of rows, so they come back as a per-list SUMMARY and
  // the members are fetched on demand via /sources/list/:list.
  const rows = await sources().find({ lists: { $in: [null, []] } }).sort({ addedAt: -1 }).toArray();
  const agg = await sources().aggregate([
    { $match: { lists: { $nin: [null, []] } } },
    { $unwind: "$lists" },
    { $group: { _id: "$lists", count: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ["$active", true] }, 1, 0] } }, ran: { $sum: { $cond: [{ $ifNull: ["$last_picked_at", false] }, 1, 0] } }, done: { $sum: { $cond: [{ $eq: ["$scrape_done", true] }, 1, 0] } }, pndCredits: { $sum: { $ifNull: ["$pnd_credits", 0] } } } },
    { $sort: { count: -1 } },
  ]).toArray();
  const lists = agg.map((a) => ({ list: a._id, count: a.count, active: a.active, ran: a.ran, done: a.done, pndCredits: a.pndCredits || 0 }));
  res.json({ sources: rows, lists, status: sourcesStatus() });
});

// GET /api/sources/list/:list?skip=&limit=&q= — members of one imported list (paginated + searchable)
apiRouter.get("/sources/list/:list", async (req, res) => {
  const list = decodeURIComponent(req.params.list);
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 10000);
  const skip = parseInt(req.query.skip || "0", 10);
  const q = S(req.query.q).trim();
  const filter = { lists: list };
  if (q) { const rx = escRegex(q); filter.$or = [{ label: { $regex: rx, $options: "i" } }, { url: { $regex: rx, $options: "i" } }, { title: { $regex: rx, $options: "i" } }]; }
  const [rows, count] = await Promise.all([
    sources().find(filter).sort({ label: 1 }).skip(skip).limit(limit).toArray(),
    sources().countDocuments(filter),
  ]);
  res.json({ rows, count });
});
apiRouter.post("/sources", async (req, res) => {
  const type = req.body?.type === "hub" ? "hub" : "influencer";
  let url = S(req.body?.url).trim();
  if (!url) return res.status(400).json({ ok: false, error: "url required" });
  if (type === "influencer" && !/\/in\//.test(url) && !/linkedin\.com/.test(url)) {
    url = "https://www.linkedin.com/in/" + url.replace(/^@/, "");
  }
  const label = S(req.body?.label).trim() || (type === "influencer" ? (url.split("/in/")[1] || "").replace(/\/$/, "") : url.split("/").filter(Boolean).pop());
  await sources().updateOne({ url }, { $set: { url, type, label, active: true }, $setOnInsert: { addedAt: new Date() } }, { upsert: true });
  res.json({ ok: true });
});
apiRouter.delete("/sources/:id", async (req, res) => {
  try { await sources().deleteOne({ _id: new ObjectId(req.params.id) }); } catch { /* ignore bad id */ }
  res.json({ ok: true });
});

// POST /api/sources/:id/active { active } — pause/resume ONE influencer. The list-level switch
// flips every profile in a CSV at once; this is the per-person one, so a single noisy profile can
// be silenced without pausing the whole imported list it came from.
apiRouter.post("/sources/:id/active", async (req, res) => {
  const active = !!req.body?.active;
  try {
    const r = await sources().updateOne({ _id: new ObjectId(req.params.id) }, { $set: { active } });
    if (!r.matchedCount) return res.status(404).json({ error: "not found" });
  } catch { return res.status(400).json({ error: "bad id" }); }
  res.json({ ok: true, active });
});
// POST /api/sources/bulk-active { ids:[], active } — pause/resume MANY influencers at once (the
// multi-select in the list drill-in). Bad ids are ignored rather than failing the whole batch.
apiRouter.post("/sources/bulk-active", async (req, res) => {
  const active = !!req.body?.active;
  const oids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map((x) => { try { return new ObjectId(x); } catch { return null; } }).filter(Boolean);
  if (!oids.length) return res.json({ ok: false, error: "no valid ids" });
  const r = await sources().updateMany({ _id: { $in: oids } }, { $set: { active } });
  res.json({ ok: true, active, matched: r.matchedCount, modified: r.modifiedCount });
});

// POST /api/sources/import { list, items:[{url,label,title}] } — bulk import a CSV of influencers.
// Imported profiles start PAUSED (active:false): scraping ~4.7k profiles' posts would blow the
// Trigify budget many times over, so nothing is scraped until you enable a list. Grouped by
// `list` (the CSV name) so the dashboard can show each CSV separately.
const normProfile = (u) => {
  u = S(u).trim().replace(/\?.*$/, "").replace(/\/$/, "");
  if (!u) return "";
  if (!/linkedin\.com/i.test(u)) u = "https://www.linkedin.com/in/" + u.replace(/^@/, "");
  return u.replace(/^http:/, "https:");
};
apiRouter.post("/sources/import", async (req, res) => {
  const list = S(req.body?.list).trim().slice(0, 80);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!list || !items.length) return res.status(400).json({ ok: false, error: "list and items required" });

  const seen = new Set();
  const ops = [];
  for (const it of items) {
    const url = normProfile(it?.url);
    if (!url || !/\/in\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    ops.push({
      updateOne: {
        filter: { url },
        // `lists` is an ARRAY: the same influencer can appear in several CSVs (cold-email people
        // overlap a lot), and each list should show its full membership. $addToSet dedups.
        // never un-pause a source the user is already actively using ($setOnInsert on active).
        update: {
          $set: { url, type: "influencer", imported: true, label: S(it?.label).trim() || (url.split("/in/")[1] || ""), title: S(it?.title).trim() || null },
          $addToSet: { lists: list },
          $setOnInsert: { active: false, addedAt: new Date() },
          $unset: { list: "" }, // drop the old single-list field from the first import pass
        },
        upsert: true,
      },
    });
  }
  if (!ops.length) return res.json({ ok: true, imported: 0, list });
  const r = await sources().bulkWrite(ops, { ordered: false });
  res.json({ ok: true, list, imported: ops.length, added: r.upsertedCount, updated: r.modifiedCount });
});

// POST /api/sources/list/:list/active { active } — enable/disable a whole imported list at once.
// An explicit list pause/resume applies to EVERY member of the list — including members shared with
// another list — so pausing a list you no longer want really does turn ALL of it off (the row flips
// to "paused" and stays that way). Members are scraped once and marked done, so pausing one that also
// sits in another list barely affects that other list. We still record the paused-list set so the
// intent is visible, but the flag write is what the auto engine actually reads.
apiRouter.post("/sources/list/:list/active", async (req, res) => {
  const list = decodeURIComponent(req.params.list);
  const active = !!req.body?.active;
  await engineState().updateOne({ _id: "paused_lists" },
    active ? { $pull: { lists: list } } : { $addToSet: { lists: list } }, { upsert: true }).catch(() => {});
  const r = await sources().updateMany({ lists: list }, { $set: { active } });
  res.json({ ok: true, list, active, matched: r.matchedCount });
});

// DELETE /api/sources/list/:list — remove a list. A profile in several lists is kept (just
// dropped from this one); a profile that was ONLY in this list is removed entirely.
apiRouter.delete("/sources/list/:list", async (req, res) => {
  const list = decodeURIComponent(req.params.list);
  await sources().updateMany({ lists: list }, { $pull: { lists: list } });
  // only remove profiles that came from a CSV import and now belong to no list — never a
  // manually-added or hub-harvested influencer.
  const r = await sources().deleteMany({ lists: { $in: [null, []] }, imported: true });
  res.json({ ok: true, list, removed: r.deletedCount });
});
// "Run now" is now the auto engine's manual rotation kick (the old Trigify runSources is retired
// from the scheduler; this button used to fire it and did nothing while paused/out-of-credits).
apiRouter.post("/sources/run", async (_req, res) => res.json(await rotateNow()));
apiRouter.get("/sources/status", (_req, res) => res.json(sourcesStatus()));

// ── Auto engine (scheduled keyword sweep + hub pass + daily rotation) ────────────────────────
apiRouter.get("/auto/status", async (_req, res) => res.json(await autoStatus()));
apiRouter.post("/auto/toggle", async (req, res) => res.json(await setAutoEnabled(!!req.body?.enabled)));
apiRouter.post("/auto/rotate-now", async (_req, res) => res.json(await rotateNow()));

// POST /api/sources/reroute — fix source leads that landed in the empty Influencer/Hub campaigns
apiRouter.post("/sources/reroute", (_req, res) => {
  const st = rerouteStatus();
  if (st.running) return res.json({ started: false, ...st });
  rerouteSourceLeads().catch((e) => console.error("reroute error", e.message));
  res.json({ started: true });
});
apiRouter.get("/sources/reroute/status", (_req, res) => res.json(rerouteStatus()));

// POST /api/sources/scrape-post { postUrl, campaign } — harvest one specific post into a campaign
apiRouter.post("/sources/scrape-post", async (req, res) => {
  const postUrl = S(req.body?.postUrl).trim();
  const campaign = S(req.body?.campaign).trim();
  // scrapeOnePost's own `scrapeOneRunning` guard only covers a post that is being scraped RIGHT
  // NOW — and a keyword run resets that flag between its posts, leaving a window where this route
  // would start a second scrape that then fights the keyword run over the shared scrapeCtl.
  if (keywordRunnerBusy() === "keyword") {
    return res.json({ ok: false, error: "a keyword run is in progress — pause it first" });
  }
  const r = await scrapeOnePost({ postUrl, campaignKey: campaign });
  res.json(r);
});
// DB-backed status so it survives restarts (in-memory state resets, the scraped_posts doc doesn't).
apiRouter.get("/sources/scrape-post/status", async (_req, res) => {
  const mem = scrapePostStatus();
  let doc = mem.postUrl ? await scrapedPosts().findOne({ postUrl: mem.postUrl }) : null;
  if (!doc) doc = await scrapedPosts().findOne({ scrape_cp: { $exists: true } }, { sort: { startedAt: -1 } });
  if (!doc) return res.json({ ...mem, rapid: rapidScrapeStats() });
  const live = mem.running && mem.postUrl === doc.postUrl;
  res.json({
    running: live, phase: live ? mem.phase : doc.phase, postUrl: doc.postUrl, campaign: doc.campaign || "",
    total: live ? mem.total : (doc.engager_total || 0),
    enriched: live ? mem.enriched : (doc.enriched_count || 0),
    sent: live ? mem.sent : (doc.sent || 0),
    expected: (doc.expected_reactions || 0) + (doc.expected_comments || 0),
    paused: !live && (doc.paused || false), scrapeDone: !!doc.scrape_done, outOfCredits: doc.out_of_credits || false,
    rapid: rapidScrapeStats(),
  });
});

// POST /api/sources/scrape-post/pause — ask the running scrape to checkpoint and stop
apiRouter.post("/sources/scrape-post/pause", (_req, res) => res.json(pauseScrapePost()));

// GET /api/sources/scraped-posts — history of "Scrape via post" runs, with LIVE per-post counts
// (engagers / verified / no-email / unverified) computed from leads.posts_seen. Counts stay current
// as retries recover emails, so Verified climbs here on its own.
apiRouter.get("/sources/scraped-posts", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 10000);
  const skip = parseInt(req.query.skip || "0", 10);
  const [posts, total] = await Promise.all([
    scrapedPosts().find({}).sort({ startedAt: -1 }).skip(skip).limit(limit).toArray(),
    scrapedPosts().countDocuments({}),
  ]);
  // Lazily fetch a human title (poster + post text) for any post missing one — once, then cached
  // on the doc. Skipped when out of credits so we don't set titleTried prematurely.
  // titleTried used to be a permanent tombstone: one failed lookup and the post could never get a
  // title again, so every fix to the resolver needed a migration to undo it. Store WHEN we tried
  // instead and retry after a day — a post fixed by new code heals itself, and one that genuinely
  // has no title costs at most a credit a day. (Legacy `true` values aren't dates, so they retry.)
  // ?refreshTitles=1 ignores the retry gate — for when a fix has just landed and waiting a day to
  // find out whether it worked is not an option.
  const DAY = 24 * 60 * 60 * 1000;
  const force = S(req.query.refreshTitles) === "1";
  for (const p of posts) {
    const triedAt = p.titleTried instanceof Date ? p.titleTried.getTime() : null;
    if (!force && (p.title || (triedAt && Date.now() - triedAt < DAY))) continue;
    const det = await pndPostInfo(p.postUrl).catch(() => null);
    if (det) {
      const set = { title: det.title, poster_name: det.posterName, poster_url: det.posterUrl, text: det.text, expected_reactions: det.numReactions, expected_comments: det.numComments, posted: det.posted, titleTried: new Date(), activity_urn: det.urn || p.activity_urn || null };
      await scrapedPosts().updateOne({ postUrl: p.postUrl }, { $set: set }).catch(() => {});
      Object.assign(p, set);
    } else if (!pndOutOfCredits()) {
      await scrapedPosts().updateOne({ postUrl: p.postUrl }, { $set: { titleTried: new Date() } }).catch(() => {});
    }
  }
  const out = await Promise.all(posts.map(async (p) => {
    const base = { posts_seen: p.postUrl };
    // `scraped` (the queue) and `engagers` (leads) are NOT the same number and never were: a
    // company page that reacts to a post is queued, then deliberately dropped ("company pages are
    // not people"). Reporting only one of them made the live box and this row disagree with no
    // explanation. Both are returned so the gap can be shown for what it is.
    const [engagers, verified, noEmail, unverified, scraped, skippedCompany] = await Promise.all([
      leads().countDocuments(base),
      leads().countDocuments({ ...base, email_status: "verified" }),
      leads().countDocuments({ ...base, email_status: "no-email" }),
      leads().countDocuments({ ...base, email_status: "unverified" }),
      scrapeEngagers().countDocuments({ postUrl: p.postUrl }),
      scrapeEngagers().countDocuments({ postUrl: p.postUrl, outcome: "skipped_company" }),
    ]);
    return {
      postUrl: p.postUrl,
      activityId: p.activity_urn || p.activityId || activityUrn(p.postUrl),
      title: p.title || null, posterName: p.poster_name || null,
      campaign: p.campaign || null, sourceKind: p.source_kind || null, at: p.finishedAt || p.startedAt, running: !!p.running,
      engagers, verified, noEmail, unverified,
      scraped, skippedCompany,
      // Resume state, so the dashboard can offer Resume and say honestly what it will re-read.
      // An old fresh-era checkpoint has no reactionsDone and gets its paging restarted (the queue
      // dedups, so no lead is re-enriched — but the scrape pages ARE re-read and re-charged).
      cp: p.scrape_cp ? { page: p.scrape_cp.page ?? null, reactionsDone: !!p.scrape_cp.reactionsDone, commentsDone: !!p.scrape_cp.commentsDone, legacy: p.scrape_cp.reactionsDone === undefined } : null,
      scrapeDone: !!p.scrape_done, paused: !!p.paused, phase: p.phase || null,
      expectedReactions: p.expected_reactions ?? null,
      expectedComments: p.expected_comments ?? null,          // LinkedIn's count — INCLUDES replies
      commentsAvailable: p.comments_available ?? null,        // top-level commenters the API returns
      commentsSkipped: !!p.comments_skipped, commentsSkipReason: p.comments_skip_reason || null,
      partial: !!p.partial, partialReason: p.partial_reason || null,   // share link we couldn't resolve → incomplete
      // Per-post PND credit ledger (scrape pages + paid profile/company), accumulated across runs.
      pndCredits: p.pnd_credits ? {
        scrape: p.pnd_credits.scrape || 0, profile: p.pnd_credits.profile || 0, company: p.pnd_credits.company || 0,
        total: p.pnd_credits.total || 0, cacheSaved: p.pnd_credits.cache_saved || 0, paidLeads: p.pnd_credits.paid_leads || 0,
      } : null,
    };
  }));
  res.json({ posts: out, total });
});

// Keyword sweep — finds this week's posts for every campaign keyword and scrapes their engagers.
// This is what the Trigify workflows used to do; the engine does it itself now.
apiRouter.post("/keywords/sweep", (req, res) => {
  // keywordRunnerBusy() — NOT keywordSweepStatus().running. The sweep and the manual keyword run
  // share one lock but keep separate status objects, so checking only this route's own status let a
  // sweep start during a manual run, get rejected by the lock inside the runner, and have that
  // rejection thrown away by the fire-and-forget .catch() — the UI toasted success for a no-op.
  const busy = keywordRunnerBusy();
  if (busy) return res.json({ alreadyRunning: true, busyWith: busy, ...keywordSweepStatus() });
  const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : [];
  runKeywordSweep({ keywords }).catch((e) => console.error("keyword sweep error", e.message));
  res.json({ started: true });
});
apiRouter.get("/keywords/sweep/status", (_req, res) => res.json(keywordSweepStatus()));
apiRouter.post("/keywords/sweep/pause", (_req, res) => res.json(pauseKeywordSweep()));

// Manual keyword scrape — search ONE keyword you type and route its engagers into the campaign you
// pick (the keyword needn't belong to that campaign). The keyword equivalent of "Scrape via post".
// Shares the single-runner lock with the sweep, so one answers `alreadyRunning` while the other runs.
apiRouter.post("/keywords/manual", (req, res) => {
  const keyword = S(req.body?.keyword).trim();
  const campaign = S(req.body?.campaign).trim();
  if (!keyword) return res.status(400).json({ error: "keyword required" });
  // Resolve the campaign HERE, before responding. runManualKeyword validates it too, but its
  // {error} return is swallowed by the fire-and-forget .catch() below — so a key that no longer
  // exists (a tab left open across a redeploy that renamed a campaign) answered {started:true} and
  // then quietly did nothing at all.
  if (!campaignByKey(campaign)) return res.status(400).json({ error: `unknown campaign: ${campaign || "(none picked)"}` });
  const busy = keywordRunnerBusy();
  if (busy) return res.json({ alreadyRunning: true, busyWith: busy, ...keywordManualStatus() });
  runManualKeyword({ keyword, campaignKey: campaign }).catch((e) => console.error("manual keyword error", e.message));
  res.json({ started: true, keyword, campaign });
});
apiRouter.get("/keywords/manual/status", (_req, res) => res.json(keywordManualStatus()));
apiRouter.post("/keywords/manual/pause", (_req, res) => res.json(pauseKeywordManual()));

// POST /api/sources/pause { paused } — master switch for the AUTO ENGINE, now persisted in Mongo
// (the old in-memory autoPaused reset to paused on every deploy). paused:true => enabled:false.
apiRouter.post("/sources/pause", async (req, res) => {
  const r = await setAutoEnabled(!req.body?.paused);
  res.json({ paused: !r.enabled });
});
apiRouter.get("/sources/pause", async (_req, res) => {
  const s = await autoStatus();
  res.json({ paused: !s.enabled, rapid: rapidScrapeStats() });
});

// GET /api/debug/pnd?path=&urn=... — raw PND response, so a parser can be written against what the
// API actually returns rather than what we assume it returns. Ingest-token guarded; read-only.
apiRouter.get("/debug/pnd", async (req, res) => {
  if (!safeEqual(req.headers["x-ingest-token"] || "", config.ingestToken)) return res.status(401).json({ ok: false });
  const path = S(req.query.path);
  if (!path) return res.status(400).json({ error: "path required" });
  const params = { ...req.query };
  delete params.path;
  const method = (params.method || "GET").toUpperCase();
  delete params.method;
  // reactions is a POST that takes {url, page}; everything else is a GET with query params.
  const d = method === "POST"
    ? await pndRaw(path, { method: "POST", body: { ...params, page: Number(params.page) || 1 } })
    : await pndRaw(path, { params });
  const summary = Array.isArray(d?.data)
    ? { isArray: true, count: d.data.length, total: d.total ?? d.data?.total, totalPage: d.totalPage }
    : { isArray: false, items: d?.data?.items?.length ?? null, total: d?.data?.total ?? d?.total ?? null };
  res.json({ path, method, params, summary, response: d });
});

// POST /api/reset — wipe all leads + engagements (guarded by the ingest token). For clearing test data.
apiRouter.post("/reset", async (req, res) => {
  if (!safeEqual(req.headers["x-ingest-token"] || "", config.ingestToken)) {
    return res.status(401).json({ ok: false });
  }
  const a = await leads().deleteMany({});
  const b = await engagements().deleteMany({});
  res.json({ ok: true, leadsDeleted: a.deletedCount, engagementsDeleted: b.deletedCount });
});

// POST /api/leads/bulk-email-update — write externally-recovered emails onto existing no-email leads
// (Bitscale/BetterContact finds, BounceBan/BetterContact verified). Ingest-token guarded. Matches by
// linkedin_url AND only touches rows still marked no-email, so it can't clobber a lead the live scrape
// has since verified. Body: { rows: [{ linkedin_url, email, email_status: "verified"|"unverified" }] }.
apiRouter.post("/leads/bulk-email-update", async (req, res) => {
  if (!safeEqual(req.headers["x-ingest-token"] || "", config.ingestToken)) return res.status(401).json({ ok: false });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const ops = [];
  for (const r of rows) {
    const url = String(r?.linkedin_url || "").trim();
    const email = String(r?.email || "").trim().toLowerCase();
    if (!url || !email || !email.includes("@")) continue;
    const status = r?.email_status === "verified" ? "verified" : "unverified";
    ops.push({ updateOne: {
      filter: { linkedin_url: url, email_status: "no-email" },
      update: { $set: {
        email, email_status: status, unverified: status === "unverified",
        needs_email: false, verified_by: "external-recovery", verify_detail: "bitscale/bettercontact",
        recovered: true, recovered_at: new Date(), updated_at: new Date(),
      } },
    } });
  }
  let updated = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const r = await leads().bulkWrite(ops.slice(i, i + 1000), { ordered: false }).catch(() => ({ modifiedCount: 0 }));
    updated += r.modifiedCount || 0;
  }
  res.json({ ok: true, received: rows.length, matchedOps: ops.length, updated });
});

// ── Domain prospecting — seed domain -> prefix/suffix/TLD permutations -> per-candidate streaming
// pipeline (DNS -> redirect-to-seed check -> blacklist verdict). Returns a jobId immediately;
// GET /:id streams live progress + results as they land (no barrier waits on the client side).
apiRouter.post("/domainscan", async (req, res) => {
  const domain = String(req.body?.domain || "").trim();
  if (!domain) return res.status(400).json({ error: "domain required" });
  // mode: "hostio" (default, reverse-redirect index) | "permutation" (guesser+DNS+HTTP fallback)
  const mode = req.body?.mode === "permutation" ? "permutation" : "hostio";
  try {
    const job = await startDomainScan(domain, { mode });
    res.json({ started: true, ...job });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
apiRouter.get("/domainscan", async (_req, res) => res.json({ items: await listDomainScans() }));
apiRouter.post("/campaign/:id/stop", async (req, res) => res.json(await stopCampaign(req.params.id)));
apiRouter.delete("/campaign/:id", async (req, res) => res.json(await deleteCampaign(req.params.id)));
apiRouter.post("/blacklist-scan/estimate", async (req, res) => res.json(await estimateBlacklistScan(req.body?.domains)));
apiRouter.post("/blacklist-scan", async (req, res) => res.json(await startBlacklistScan(req.body?.domains, req.body || {})));
apiRouter.get("/blacklist-scan/:id", async (req, res) => { const r = await getBlacklistScan(req.params.id); r ? res.json(r) : res.status(404).json({ error: "not found" }); });
apiRouter.get("/blacklist-scan/:id/results", async (req, res) => { const r = await blacklistScanResults(req.params.id); r ? res.json({ items: r }) : res.status(404).json({ error: "not found" }); });
apiRouter.get("/hostio/scrape-health", async (_req, res) => res.json(await scrapeDiagnose()));
apiRouter.get("/domainscan/diag", async (_req, res) => res.json({ blacklist: await diagnoseBlacklistProject(), hostio: await diagnoseHostio() }));
apiRouter.get("/domainscan/dnstest", async (_req, res) => res.json(await dnsSelfTest()));
// Live per-domain blacklist detail for the results drawer — which zones list it, enrichment, history.
apiRouter.get("/domainscan/domain-detail", async (req, res) => {
  const detail = await domainDetail(S(req.query.domain));
  if (!detail) return res.status(404).json({ error: "not tracked" });
  res.json(detail);
});
apiRouter.get("/domainscan/:id", async (req, res) => {
  const job = await getDomainScan(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(job);
});

// ── Campaign funnel — seed domains -> count gate -> discovery+blacklist -> Prospeo people ──────
apiRouter.post("/campaign", async (req, res) => {
  try {
    const r = await startCampaign(req.body?.seeds || "", { countGate: req.body?.countGate, blacklistGate: req.body?.blacklistGate, enrich: req.body?.enrich, guess: req.body?.guess, forceRescan: req.body?.forceRescan });
    res.json({ started: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
apiRouter.get("/campaign", async (req, res) => res.json(await listOutreachCampaigns(
  Math.min(parseInt(req.query.size, 10) || 20, 200), { page: parseInt(req.query.page, 10) || 0 },
)));
apiRouter.get("/hostio/usage", async (_req, res) => res.json(await hostioUsageReport()));

// Live API credit balances, bypassing the 5-minute service caches — after a big campaign the cached
// figures can be thousands of credits out of date, which is exactly when you want to look.
apiRouter.get("/balances/refresh", async (_req, res) => {
  const [prospeo, bounceban, apiBalance] = await Promise.all([
    prospeoBalance({ force: true }),
    bouncebanBalance({ force: true }),
    readBalances(),
  ]);
  res.json({ prospeo, bounceban, ...apiBalance });
});
// Push this campaign's qualified decision-makers into a DRAFT SendKit campaign (never started here).
apiRouter.post("/campaign/:id/push-sendkit", async (req, res) => {
  const r = await pushCampaignToSendkit(req.params.id, {
    campaignName: S(req.body?.name) || undefined,
    workspaceId: S(req.body?.workspaceId) || undefined,
  });
  res.status(r.ok ? 200 : 400).json(r);
});

// SendKit workspaces the funnel can push into — one per teammate, configured via SENDKIT_WORKSPACES.
// Only ids/labels are returned; keys never leave the server.
apiRouter.get("/campaign/:id/csv", async (req, res) => {
  const csv = await campaignCsv(req.params.id);
  if (csv == null) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=blacklist-campaign-leads.csv");
  res.send(csv);
});
apiRouter.get("/campaign/:id/push-target", async (req, res) => {
  const r = await pushTarget(req.params.id, { workspaceId: S(req.query.workspaceId) || undefined });
  res.status(r.ok ? 200 : 400).json(r);
});
apiRouter.get("/sendkit/workspaces", async (_req, res) => res.json({ items: await listWorkspaces() }));
// Render one sequence email for one lead, personalized — preview only, sends nothing.
apiRouter.get("/campaign/:id/preview", async (req, res) => {
  const r = await previewCampaignEmail(req.params.id, { email: S(req.query.email), step: parseInt(S(req.query.step) || "1", 10) });
  res.status(r.ok ? 200 : 400).json(r);
});
apiRouter.get("/campaign/:id", async (req, res) => {
  const c = await getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: "not found" });
  res.json(c);
});
apiRouter.get("/campaign/:id/results", async (req, res) => res.json(await getCampaignResults(req.params.id, {
  q: S(req.query.q), stage: S(req.query.stage),
  page: parseInt(req.query.page, 10) || 0, size: Math.min(parseInt(req.query.size, 10) || 100, 1000),
})));
// Whole run as CSV — built server-side so "Full report" never silently means "the page I'm on".
apiRouter.get("/campaign/:id/results.csv", async (req, res) => {
  const csv = await campaignResultsCsv(req.params.id);
  if (csv == null) return res.status(404).json({ error: "not found" });
  res.type("text/csv").set("Content-Disposition", `attachment; filename="campaign-${req.params.id}.csv"`).send(csv);
});
apiRouter.get("/campaign/:id/contacts-count", async (req, res) => res.json({ contacts: await campaignContactCount(req.params.id) }));
// Resume an interrupted/stalled campaign — reprocesses only the seeds without a final verdict, so
// already-enriched companies keep their result (and don't spend their Prospeo credits again).
apiRouter.post("/campaign/:id/resume", async (req, res) => {
  const r = await resumeCampaign(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});
// Fill in contacts for companies Prospeo found nobody at, using our own hot/warm engagers on that
// domain (these seed lists came from those leads to begin with). Free — no Prospeo credits.
apiRouter.post("/campaign/:id/backfill-contacts", async (req, res) => {
  const r = await backfillOwnLeadContacts(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});
// Company enrichment for a blacklist-only run: run Prospeo on the "qualified" seeds (blacklisted infra,
// contacts not requested at run time) to pull decision-makers + emails. Spends Prospeo credits.
apiRouter.post("/campaign/:id/enrich-companies", async (req, res) => {
  const r = await enrichQualifiedCompanies(req.params.id, { includeDone: !!req.body?.includeDone });
  res.status(r.ok ? 200 : 400).json(r);
});
// Re-judge seeds sitting in dropped_blacklist against a freshly synced verdict mirror: before the
// checker's rate limit was handled, unchecked domains read as clean, so seeds with bad infra could
// be dropped for good (resume treats dropped_blacklist as final). GET = dry-run report, POST =
// apply. Free either way — cached redirect pages, no host.io and no Prospeo.
// The sweep lives under /blacklist, NOT /campaign/recover-dropped: the latter would be swallowed by
// the two-segment /campaign/:id route registered above it.
apiRouter.get("/campaign/:id/recover-dropped", async (req, res) => {
  const r = await recoverDroppedSeeds(req.params.id, { apply: false });
  res.status(r.ok ? 200 : 400).json(r);
});
apiRouter.post("/campaign/:id/recover-dropped", async (req, res) => {
  const r = await recoverDroppedSeeds(req.params.id, { apply: true });
  res.status(r.ok ? 200 : 400).json(r);
});
// Which Mongo is THIS process actually talking to? The alias `mongo` resolves per-container on a
// shared Docker network, so two services can use an identical URI and reach different servers —
// which presents as an empty database, not as an error. Reports the resolved address so the workers
// can be pinned to the same one the app uses.
apiRouter.get("/debug/mongo", async (_req, res) => {
  const dns = await import("node:dns");
  const { leads: leadsCol } = await import("../db/mongo.js");
  const resolved = await new Promise((r) => dns.lookup("mongo", (e, addr) => r(e ? `lookup failed: ${e.code}` : addr)));
  res.json({
    db: config.mongoDb,
    uri: config.mongoUri,
    resolvedMongoIp: resolved,
    leads: await leadsCol().estimatedDocumentCount().catch((e) => `error: ${e.message}`),
    hint: "point WORKER_MONGO_URI at mongodb://<resolvedMongoIp>:27017",
  });
});

// ── Agency crawl ───────────────────────────────────────────────────────────────────────────────
// Submit agency domains; the Go crawler finds their case studies and the Node worker scans the
// clients behind them. NOTHING here spends a Prospeo credit — agency contacts are pulled only by the
// enrich endpoint below, which is a button, never a schedule.
// Harvest agency domains from search instead of typing a list. One Serper credit per query, up to
// 100 results each; directories are excluded by name because they outrank real agencies for exactly
// these searches and their "case studies" are other companies'.
apiRouter.post("/agency/source", async (req, res) => {
  const r = await sourceAgencies({
    target: Math.min(parseInt(req.body?.target, 10) || 2000, 20000),
    maxQueries: Math.min(parseInt(req.body?.maxQueries, 10) || 300, 2000),
  });
  res.status(r.ok ? 200 : 400).json(r);
});
apiRouter.get("/agency/sources", async (req, res) => res.json(await listAgencySources({ unusedOnly: req.query.unused === "1" })));
apiRouter.get("/agency/sources.csv", async (_req, res) => {
  const r = await listAgencySources({});
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = ["domain,title,query,geo,used,sourced_at"];
  for (const i of r.items) out.push([i._id, i.title, i.query, i.geo, !!i.used, i.sourcedAt?.toISOString?.() || ""].map(esc).join(","));
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="agency-sources.csv"').send(out.join("\n"));
});
// Start a crawl straight from what was sourced, so the list never has to round-trip through a file.
apiRouter.post("/agency/from-sources", async (req, res) => {
  const limit = Math.min(parseInt(req.body?.limit, 10) || 2000, 50000);
  const { items } = await listAgencySources({ unusedOnly: true, limit });
  if (!items.length) return res.status(400).json({ ok: false, error: "no unused sourced domains — run sourcing first" });
  const domains = items.map((i) => i._id);
  const r = await startAgencyRun(domains, req.body || {});
  if (r.ok) await markSourcesUsed(domains);
  res.status(r.ok ? 200 : 400).json({ ...r, fromSources: domains.length });
});
apiRouter.post("/agency", async (req, res) => {
  const r = await startAgencyRun(req.body?.domains, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
apiRouter.get("/agency", async (req, res) => res.json(await listAgencyRuns(
  Math.min(parseInt(req.query.size, 10) || 20, 200), { page: parseInt(req.query.page, 10) || 0 },
)));
apiRouter.get("/agency/:id", async (req, res) => {
  const r = await getAgencyRun(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: "not found" });
});
apiRouter.get("/agency/:id/results", async (req, res) => res.json(await agencyResults(req.params.id, {
  q: S(req.query.q), onlyHits: req.query.onlyHits === "1",
  page: parseInt(req.query.page, 10) || 0, size: Math.min(parseInt(req.query.size, 10) || 100, 500),
})));
apiRouter.get("/agency/:id/clients", async (req, res) => res.json({ items: await agencyClients(req.params.id, S(req.query.domain)) }));
// THE BUTTON: Prospeo on the agency domain only, and only for agencies that actually have a story.
apiRouter.post("/agency/:id/enrich", async (req, res) => {
  const r = await enrichAgencies(req.params.id, {
    minHits: parseInt(req.body?.minHits, 10) || 1,
    includeDone: !!req.body?.includeDone,
    limit: parseInt(req.body?.limit, 10) || 5000,
  });
  res.status(r.ok ? 200 : 400).json(r);
});
apiRouter.post("/agency/:id/retry", async (req, res) => res.json(await retryAgencyRun(req.params.id)));
apiRouter.post("/agency/:id/stop", async (req, res) => res.json(await stopAgencyRun(req.params.id)));
apiRouter.get("/agency/:id/leads.csv", async (req, res) => {
  const r = await agencyLeadsCsv(req.params.id, { minHits: parseInt(req.query.minHits, 10) || 1 });
  if (!r) return res.status(404).json({ error: "not found" });
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="agency-leads.csv"').send(r.csv);
});

// ── Shareable blacklist reports ────────────────────────────────────────────────────────────────
// Creating one is free for a company a funnel already scanned (the blacklisted domains are stored on
// the target); an unscanned seed costs exactly one host.io call.
apiRouter.get("/reports", async (req, res) => res.json(await listReports({
  q: S(req.query.q), page: parseInt(req.query.page, 10) || 0, size: Math.min(parseInt(req.query.size, 10) || 50, 500),
})));
// Inbound requests from the public landing page.
apiRouter.get("/report-requests", async (req, res) => res.json(await listRequests({
  status: S(req.query.status), page: parseInt(req.query.page, 10) || 0, size: Math.min(parseInt(req.query.size, 10) || 50, 500),
})));
apiRouter.post("/report-requests/:id", async (req, res) => res.json(await setRequestStatus(req.params.id, S(req.body?.status))));
apiRouter.post("/reports", async (req, res) => {
  const r = await createReport(S(req.body?.seed), { force: !!req.body?.force });
  res.status(r.ok ? 200 : 400).json(r);
});
apiRouter.post("/reports/bulk", async (req, res) => {
  const r = await bulkCreateReports({
    campaignId: S(req.body?.campaignId) || null,
    minBlacklisted: parseInt(req.body?.minBlacklisted, 10) || 3,
    limit: parseInt(req.body?.limit, 10) || 500,
  });
  res.status(r.ok ? 200 : 400).json(r);
});
apiRouter.delete("/reports/:token", async (req, res) => res.json(await deleteReport(req.params.token)));

// Every seed that was EVER dropped, with the verdict explaining why: recovered / still-unknown /
// genuinely-clean / non-icp / no-cached-pages. Read-only.
apiRouter.get("/blacklist/dropped.csv", async (_req, res) => {
  const r = await droppedSeedsCsv(null);
  if (!r.ok) return res.status(400).json(r);
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="dropped-seeds.csv"').send(r.csv);
});
// Contact enrichment for every recovered seed, across all the campaigns they're spread over.
// Spends Prospeo credits: ~1 search per company plus up to CAMPAIGN_REVEAL_PER_COMPANY reveals.
apiRouter.post("/blacklist/enrich-recovered", async (_req, res) => res.json(await enrichAllRecovered()));
// The recovered seeds as a SendKit-ready lead CSV — same columns as the per-campaign export.
apiRouter.get("/blacklist/recovered-leads.csv", async (_req, res) => {
  const r = await recoveredLeadsCsv();
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="recovered-leads.csv"').send(r.csv);
});

// The full list of seeds the recovery brought back (the dry-run report only samples 200).
apiRouter.get("/blacklist/recovered", async (_req, res) => res.json(await listRecoveredSeeds()));
apiRouter.get("/blacklist/recovered.csv", async (_req, res) => {
  const r = await listRecoveredSeeds({ csv: true });
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="recovered-seeds.csv"').send(r.csv || "");
});
apiRouter.get("/blacklist/recover-dropped", async (_req, res) => {
  const r = await recoverDroppedSeeds(null, { apply: false });
  res.status(r.ok ? 200 : 400).json(r);
});
apiRouter.post("/blacklist/recover-dropped", async (_req, res) => {
  const r = await recoverDroppedSeeds(null, { apply: true });
  res.status(r.ok ? 200 : 400).json(r);
});
// On-demand email reveal for one company's contacts (spends Prospeo credits — ~1 per person).
apiRouter.post("/campaign/:id/reveal", async (req, res) => {
  const people = await revealCompanyEmails(req.params.id, S(req.body?.seed));
  if (!people) return res.status(404).json({ error: "not found" });
  res.json({ people });
});

// On-demand: re-check one seed's blacklisted domains against host.io RIGHT NOW (1 fresh API call,
// not cached) — tells the UI which are still live on host.io today vs no longer there.
apiRouter.post("/campaign/:id/verify-live", async (req, res) => {
  try {
    const r = await verifySeedAgainstHostio(req.params.id, S(req.body?.seed));
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Creator Programme ─────────────────────────────────────────────────────────────────────────
// The customer base as an outreach list. Commercial priority (P1_CHURN -> … -> P3c) is fixed and
// set by the extract; creator fit is a filter applied INSIDE each tier and never reorders it.
//
// The extract's CSVs carry customer PII, so they are uploaded here rather than committed anywhere —
// they land in Mongo and nowhere else. Each file goes up as a raw body because companies.csv alone
// (2.3MB) is past the app-wide 1mb JSON limit.
const csvBody = textBody({ limit: "64mb", type: () => true });

apiRouter.post("/creator/import/companies", csvBody, async (req, res) => {
  try { res.json(await importCreatorCompanies(String(req.body || ""))); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
apiRouter.post("/creator/import/users", csvBody, async (req, res) => {
  try { res.json(await importCreatorUsers(String(req.body || ""))); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// spend_monthly.csv — the month-by-month revenue every churn and growth figure is derived from.
// Upload it before the people file so the buckets land on each person's row.
apiRouter.post("/creator/import/spend", csvBody, async (req, res) => {
  try { res.json(await importCreatorSpend(String(req.body || ""))); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

apiRouter.get("/creator/stats", ttlCache(5), async (_req, res) => res.json({
  ...(await creatorStats()), tiers_order: SEGMENTS, gates: DEFAULT_GATES, run: creatorEnrichStatus(),
}));

apiRouter.get("/creator/people", async (req, res) => res.json(await creatorList({
  tier: S(req.query.tier), fit: S(req.query.fit), audience: S(req.query.audience), role: S(req.query.role),
  growth: S(req.query.growth), q: S(req.query.q), inAudience: req.query.inAudience === "1",
  sort: S(req.query.sort), page: req.query.page, size: req.query.size,
})));

apiRouter.get("/creator/people.csv", async (req, res) => {
  const csv = await creatorCsv({
    tier: S(req.query.tier), fit: S(req.query.fit), audience: S(req.query.audience),
    role: S(req.query.role), growth: S(req.query.growth), q: S(req.query.q),
    inAudience: req.query.inAudience === "1",
  });
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="creator-programme.csv"').send(csv);
});

// Resolve people -> LinkedIn. enrich.so reverse lookup first (10 credits, refunded on a miss), then
// the free self-hosted SERP resolver for everyone it missed. Walks the base in priority order, so
// budget and time always land on P1 before P3c.
apiRouter.post("/creator/enrich", async (req, res) => {
  const tiers = Array.isArray(req.body?.tiers) ? req.body.tiers.filter((t) => SEGMENTS.includes(t)) : [];
  res.json(await startCreatorEnrich({
    tiers,
    limit: Math.max(0, parseInt(req.body?.limit || "0", 10)),
    redo: !!req.body?.redo,
    useSerp: req.body?.useSerp !== false,
    verifyWithPnd: req.body?.verifyWithPnd !== false,
    gates: req.body?.gates || DEFAULT_GATES,
  }));
});
apiRouter.get("/creator/enrich/status", (_req, res) => res.json(creatorEnrichStatus()));
apiRouter.post("/creator/enrich/stop", (_req, res) => res.json(stopCreatorEnrich()));

// Re-apply the gates at new thresholds. Pure recompute over Mongo — tuning the filter is free.
apiRouter.post("/creator/rescore", async (req, res) => res.json(await rescoreCreators(req.body?.gates || DEFAULT_GATES)));

// Cross-match the base against our own engagement DB (83k leads built from LinkedIn activity in our
// categories). A match means this customer is already active on LinkedIn, on our topics, inside our
// network — and hands us their profile for free, with no lookup and no credit.
apiRouter.post("/creator/match-audience", async (_req, res) => res.json({ ok: true, matched: await matchOwnAudience() }));
