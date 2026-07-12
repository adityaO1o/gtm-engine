// Read-only API for the dashboard frontend.

import { Router } from "express";
import { leads, engagements, usage } from "../db/mongo.js";
import { poolSize } from "../lib/proxies.js";
import { trigifyBalance } from "../services/trigify.js";
import { config } from "../config.js";

export const apiRouter = Router();

// counts for a lead filter (optionally scoped to one campaign)
async function countBlock(campaign) {
  const L = leads();
  const base = campaign ? { campaigns: campaign } : {};
  const [total, hot, warm, cold, verified, noEmail, unverified] = await Promise.all([
    L.countDocuments(base),
    L.countDocuments({ ...base, status: "hot" }),
    L.countDocuments({ ...base, status: "warm" }),
    L.countDocuments({ ...base, status: "cold" }),
    L.countDocuments({ ...base, email_status: "verified" }),
    L.countDocuments({ ...base, email_status: "no-email" }),
    L.countDocuments({ ...base, email_status: "unverified" }),
  ]);
  return { total, hot, warm, cold, verified, noEmail, unverified };
}

// GET /api/stats?campaign= — headline counts (all campaigns, or one), + live Trigify balance
apiRouter.get("/stats", async (req, res) => {
  const campaign = req.query.campaign || "";
  const counts = await countBlock(campaign);
  const engFilter = campaign ? { campaign } : {};
  const engCount = await engagements().countDocuments(engFilter);
  const bal = await trigifyBalance();
  res.json({ ...counts, engagements: engCount, proxies: poolSize(), trigify: bal });
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
      ...counts,
      credits: {
        trigify: u.trigify_scraped || 0,
        prospeo: u.prospeo_calls || 0,
        sendkit: u.sendkit_pushed || 0,
      },
    });
  }
  out.sort((a, b) => b.total - a.total);
  res.json({ campaigns: out, trigify: await trigifyBalance() });
});

// GET /api/leads?status=&email_status=&category=&campaign=&q=&sort=&limit=&skip=
apiRouter.get("/leads", async (req, res) => {
  const { status, email_status, category, campaign, q } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (email_status) filter.email_status = email_status;
  if (category) filter.categories = category;
  if (campaign) filter.campaigns = campaign;
  if (q) filter.$or = [
    { name: { $regex: q, $options: "i" } },
    { email: { $regex: q, $options: "i" } },
    { company: { $regex: q, $options: "i" } },
  ];

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

// POST /api/reset — wipe all leads + engagements (guarded by the ingest token). For clearing test data.
apiRouter.post("/reset", async (req, res) => {
  if ((req.headers["x-ingest-token"] || "") !== config.ingestToken) {
    return res.status(401).json({ ok: false });
  }
  const a = await leads().deleteMany({});
  const b = await engagements().deleteMany({});
  res.json({ ok: true, leadsDeleted: a.deletedCount, engagementsDeleted: b.deletedCount });
});
