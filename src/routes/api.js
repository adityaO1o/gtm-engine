// Read-only API for the dashboard frontend.

import { Router } from "express";
import { ObjectId } from "mongodb";
import { leads, engagements, usage, sources, reprocessRuns, scrapedPosts, bouncebanRuns } from "../db/mongo.js";
import { runSources, sourcesStatus, scrapeOnePost, scrapePostStatus, pauseScrapePost, setAutoScrape, isAutoScrapePaused } from "../pipeline/sources.js";
import { rapidScrapeStats, activityUrn } from "../services/rapidScrape.js";
import { pndStats, pndPostInfo, pndRaw, pndOutOfCredits } from "../services/pnd.js";
import { bouncebanStats, bouncebanBalance } from "../services/bounceban.js";
import { linkedinProfileStats } from "../services/linkedinProfile.js";
import { meterCumulative, readBalances } from "../services/apiMeter.js";
import { rerouteSourceLeads, rerouteStatus } from "../pipeline/reroute.js";
import { trigifyBalance, setWorkflowEnabled } from "../services/trigify.js";
import { prospeoBalance, verifyEmail } from "../services/prospeo.js";
import { jinaBalance } from "../services/jina.js";
import { resolveStats } from "../services/resolve.js";
import { validateEmail } from "../services/enrich.js";
import { findEmailWaterfall } from "../pipeline/enrichLead.js";
import { reprocessNoEmail, reprocessStatus, noEmailQuery, MISS_REASONS } from "../pipeline/reprocess.js";
import { runBouncebanAudit, bouncebanAuditStatus, bouncebanScorecard, bouncebanProof, runBouncebanRepair, bouncebanRepairStatus, bouncebanCampaignReport, dncUnvouched, auditQuery } from "../pipeline/bouncebanAudit.js";
import { reconcileDnc } from "../pipeline/dncSync.js";
import { syncVerified, syncStatus } from "../pipeline/sync.js";
import { campaignByKey, campaignLabel, sendkitIdsFor } from "../services/campaigns.js";
import { upsertLeads, addLeadsToCampaign, addToDnc } from "../services/sendkit.js";
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
async function countBlock(campaign) {
  campaign = S(campaign);
  const L = leads();
  const base = campaign ? { campaigns: campaign } : {};
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
  if (status) filter.status = status;
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
  if (q) {
    const rx = escRegex(q); // escaped -> literal substring match, no ReDoS / regex injection
    filter.$or = [{ name: { $regex: rx, $options: "i" } }, { email: { $regex: rx, $options: "i" } }, { company: { $regex: rx, $options: "i" } }];
  }
  return filter;
}

// GET /api/stats?campaign= — headline counts (all campaigns, or one), + live Trigify balance
apiRouter.get("/stats", ttlCache(8), async (req, res) => {
  const campaign = S(req.query.campaign);
  const counts = await countBlock(campaign);
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
apiRouter.get("/campaigns", ttlCache(10), async (_req, res) => {
  const [agg, uRows, prospeo, jina] = await Promise.all([
    leads().aggregate([
      { $match: { campaigns: { $exists: true, $ne: [] } } },
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
  ]);
  const uMap = Object.fromEntries(uRows.map((u) => [u.campaign, u]));
  const out = agg.map((g) => {
    const u = uMap[g._id] || {};
    return {
      campaign: g._id, label: campaignLabel(g._id),
      total: g.total, hot: g.hot, warm: g.warm, cold: g.cold,
      verified: g.verified, verifiedEmails: g.verified,
      noEmail: g.noEmail, unverified: g.unverified, review: g.review, competitor: g.competitor, discarded: g.discarded,
      recovered: g.recovered, dnc: g.dnc,
      credits: { trigify: u.trigify_scraped || 0, prospeo: u.prospeo_finds || 0, sendkit: g.verified },
    };
  }).sort((a, b) => b.total - a.total);
  res.json({ campaigns: out, prospeo, jina });
});

// GET /api/leads?status=&email_status=&category=&campaign=&q=&sort=&limit=&skip=
apiRouter.get("/leads", async (req, res) => {
  const filter = buildLeadFilter(req.query);
  const sortField = req.query.sort === "recent" ? "last_engagement_at" : "score";
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
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
apiRouter.get("/export", async (req, res) => {
  let rows;
  if (req.query.urls) {
    const urls = String(req.query.urls).split(",").map((u) => decodeURIComponent(u));
    rows = await leads().find({ linkedin_url: { $in: urls } }).toArray();
  } else {
    rows = await leads().find(buildLeadFilter(req.query)).sort({ score: -1 }).limit(50000).toArray();
  }
  const cols = ["name", "email", "email_status", "email_method", "verified_by", "company", "status", "score", "categories", "times_seen", "personal_email", "created_at", "last_engagement_at", "linkedin_url"];
  const body = rows.map((r) => cols.map((c) => csvCell(Array.isArray(r[c]) ? r[c].join("|") : r[c])).join(",")).join("\n");
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
apiRouter.post("/campaigns/:key/pause", async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const label = campaignByKey(key)?.label || campaignLabel(key);
  const r = await setWorkflowEnabled(label, !req.body?.paused);
  res.json(r);
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

  const perCampaign = new Map();
  for (const d of keep) {
    for (const cid of sendkitIdsFor(d.campaigns)) {
      if (!perCampaign.has(cid)) perCampaign.set(cid, new Set());
      perCampaign.get(cid).add(d.email.trim().toLowerCase());
    }
  }
  let pushed = 0;
  for (const [cid, set] of perCampaign) {
    const r = await addLeadsToCampaign(cid, [...set]);
    pushed += r.added;
  }
  for (const d of keep) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, {
      $set: {
        email_status: "verified", email_low_confidence: false, needs_email: false, unverified: false,
        manually_approved: true, approved_at: now, verified_by: "manual",
        tags: tagsForDoc(d), sendkit_campaigns: sendkitIdsFor(d.campaigns), updated_at: now,
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
  reprocessNoEmail({ concurrency: 14, campaigns: campList(req.body?.campaigns), deep: !!req.body?.deep })
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
  res.json({ count: await leads().countDocuments(noEmailQuery(camps)) });
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
    { $group: { _id: "$lists", count: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ["$active", true] }, 1, 0] } }, ran: { $sum: { $cond: [{ $ifNull: ["$lastRun", false] }, 1, 0] } } } },
    { $sort: { count: -1 } },
  ]).toArray();
  const lists = agg.map((a) => ({ list: a._id, count: a.count, active: a.active, ran: a.ran }));
  res.json({ sources: rows, lists, status: sourcesStatus() });
});

// GET /api/sources/list/:list?skip=&limit= — members of one imported list (paginated)
apiRouter.get("/sources/list/:list", async (req, res) => {
  const list = decodeURIComponent(req.params.list);
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
  const skip = parseInt(req.query.skip || "0", 10);
  const [rows, count] = await Promise.all([
    sources().find({ lists: list }).sort({ label: 1 }).skip(skip).limit(limit).toArray(),
    sources().countDocuments({ lists: list }),
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
apiRouter.post("/sources/list/:list/active", async (req, res) => {
  const list = decodeURIComponent(req.params.list);
  const active = !!req.body?.active;
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
apiRouter.post("/sources/run", (_req, res) => {
  const st = sourcesStatus();
  if (st.running) return res.json({ started: false, ...st });
  runSources().catch((e) => console.error("sources run error", e.message));
  res.json({ started: true });
});
apiRouter.get("/sources/status", (_req, res) => res.json(sourcesStatus()));

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
apiRouter.get("/sources/scraped-posts", async (_req, res) => {
  const posts = await scrapedPosts().find({}).sort({ startedAt: -1 }).limit(50).toArray();
  // Lazily fetch a human title (poster + post text) for any post missing one — once, then cached
  // on the doc. Skipped when out of credits so we don't set titleTried prematurely.
  // titleTried used to be a permanent tombstone: one failed lookup and the post could never get a
  // title again, so every fix to the resolver needed a migration to undo it. Store WHEN we tried
  // instead and retry after a day — a post fixed by new code heals itself, and one that genuinely
  // has no title costs at most a credit a day. (Legacy `true` values aren't dates, so they retry.)
  // ?refreshTitles=1 ignores the retry gate — for when a fix has just landed and waiting a day to
  // find out whether it worked is not an option.
  const DAY = 24 * 60 * 60 * 1000;
  const force = S(_req.query.refreshTitles) === "1";
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
    const [engagers, verified, noEmail, unverified] = await Promise.all([
      leads().countDocuments(base),
      leads().countDocuments({ ...base, email_status: "verified" }),
      leads().countDocuments({ ...base, email_status: "no-email" }),
      leads().countDocuments({ ...base, email_status: "unverified" }),
    ]);
    return {
      postUrl: p.postUrl,
      activityId: p.activity_urn || p.activityId || activityUrn(p.postUrl),
      title: p.title || null, posterName: p.poster_name || null,
      campaign: p.campaign || null, at: p.finishedAt || p.startedAt, running: !!p.running,
      engagers, verified, noEmail, unverified,
      expectedReactions: p.expected_reactions ?? null, expectedComments: p.expected_comments ?? null,
      commentsSkipped: !!p.comments_skipped, commentsSkipReason: p.comments_skip_reason || null,
    };
  }));
  res.json({ posts: out });
});

// POST /api/sources/pause { paused } — master switch for the auto influencer/hub sweep
apiRouter.post("/sources/pause", (req, res) => res.json({ paused: setAutoScrape(!!req.body?.paused) }));
apiRouter.get("/sources/pause", (_req, res) => res.json({ paused: isAutoScrapePaused(), rapid: rapidScrapeStats() }));

// GET /api/debug/pnd?path=&urn=... — raw PND response, so a parser can be written against what the
// API actually returns rather than what we assume it returns. Ingest-token guarded; read-only.
apiRouter.get("/debug/pnd", async (req, res) => {
  if (!safeEqual(req.headers["x-ingest-token"] || "", config.ingestToken)) return res.status(401).json({ ok: false });
  const path = S(req.query.path);
  if (!path) return res.status(400).json({ error: "path required" });
  const params = { ...req.query };
  delete params.path;
  const d = await pndRaw(path, { params });
  res.json({ path, params, response: d });
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
