// Read-only API for the dashboard frontend.

import { Router } from "express";
import { leads, engagements, usage } from "../db/mongo.js";
import { trigifyBalance, setWorkflowEnabled } from "../services/trigify.js";
import { prospeoBalance, verifyEmail } from "../services/prospeo.js";
import { validateEmail } from "../services/enrich.js";
import { findEmailWaterfall } from "../pipeline/enrichLead.js";
import { reprocessNoEmail, reprocessStatus } from "../pipeline/reprocess.js";
import { syncVerified, syncStatus } from "../pipeline/sync.js";
import { campaignByKey, campaignLabel } from "../services/campaigns.js";
import { config } from "../config.js";

export const apiRouter = Router();

// counts for a lead filter (optionally scoped to one campaign)
async function countBlock(campaign) {
  const L = leads();
  const base = campaign ? { campaigns: campaign } : {};
  const [total, hot, warm, cold, verified, noEmail, unverified, review, competitor] = await Promise.all([
    L.countDocuments(base),
    L.countDocuments({ ...base, status: "hot" }),
    L.countDocuments({ ...base, status: "warm" }),
    L.countDocuments({ ...base, status: "cold" }),
    L.countDocuments({ ...base, email_status: "verified" }),
    L.countDocuments({ ...base, email_status: "no-email" }),
    L.countDocuments({ ...base, email_status: "unverified" }),
    L.countDocuments({ ...base, email_status: "review" }),
    L.countDocuments({ ...base, email_status: "competitor" }),
  ]);
  return { total, hot, warm, cold, verified, noEmail, unverified, review, competitor };
}

// shared lead filter builder (used by /leads and /export)
function buildLeadFilter(query) {
  const { status, email_status, category, campaign, q, recovered } = query;
  const filter = {};
  if (status) filter.status = status;
  if (email_status) filter.email_status = email_status;
  if (category) filter.categories = category;
  if (campaign) filter.campaigns = campaign;
  if (recovered === "1") filter.recovered = true;
  if (q) filter.$or = [
    { name: { $regex: q, $options: "i" } },
    { email: { $regex: q, $options: "i" } },
    { company: { $regex: q, $options: "i" } },
  ];
  return filter;
}

// GET /api/stats?campaign= — headline counts (all campaigns, or one), + live Trigify balance
apiRouter.get("/stats", async (req, res) => {
  const campaign = req.query.campaign || "";
  const counts = await countBlock(campaign);
  const engFilter = campaign ? { campaign } : {};
  const engCount = await engagements().countDocuments(engFilter);
  const [trigify, prospeo] = await Promise.all([trigifyBalance(), prospeoBalance()]);
  res.json({ ...counts, engagements: engCount, trigify, prospeo });
});

// GET /api/campaigns — one row per campaign: counts + per-campaign credits (trigify/prospeo/sendkit)
apiRouter.get("/campaigns", async (_req, res) => {
  const names = (await leads().distinct("campaigns")).filter(Boolean);
  const rows = await usage().find({}).toArray();
  const uMap = Object.fromEntries(rows.map((u) => [u.campaign, u]));
  const out = [];
  for (const c of names) {
    const counts = await countBlock(c);
    const u = uMap[c] || {};
    out.push({
      campaign: c,
      label: campaignLabel(c),
      ...counts,
      credits: {
        trigify: u.trigify_scraped || 0,          // engagers scraped ≈ Trigify credits
        prospeo: u.prospeo_finds || 0,            // successful Prospeo finds ≈ Prospeo credits (misses are free)
        sendkit: counts.verified,                 // pushed = verified (every verified lead is pushed); real, not a drifting counter
      },
    });
  }
  out.sort((a, b) => b.total - a.total);
  const [trigify, prospeo] = await Promise.all([trigifyBalance(), prospeoBalance()]);
  res.json({ campaigns: out, trigify, prospeo });
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
apiRouter.get("/analytics", async (req, res) => {
  const campaign = req.query.campaign || "";
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
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
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

// POST /api/reprocess {campaign?} — re-run no-email leads through the Enrich-first waterfall (background)
apiRouter.post("/reprocess", (req, res) => {
  const st = reprocessStatus();
  if (st.running) return res.json({ started: false, ...st });
  reprocessNoEmail({ concurrency: 5, campaign: req.body?.campaign || "" }).catch((e) => console.error("reprocess error", e.message));
  res.json({ started: true });
});
apiRouter.get("/reprocess/status", (_req, res) => res.json(reprocessStatus()));

// POST /api/reset — wipe all leads + engagements (guarded by the ingest token). For clearing test data.
apiRouter.post("/reset", async (req, res) => {
  if ((req.headers["x-ingest-token"] || "") !== config.ingestToken) {
    return res.status(401).json({ ok: false });
  }
  const a = await leads().deleteMany({});
  const b = await engagements().deleteMany({});
  res.json({ ok: true, leadsDeleted: a.deletedCount, engagementsDeleted: b.deletedCount });
});
