// Read-only API for the dashboard frontend.

import { Router } from "express";
import { leads, engagements } from "../db/mongo.js";
import { poolSize } from "../lib/proxies.js";

export const apiRouter = Router();

// GET /api/stats — headline counts
apiRouter.get("/stats", async (_req, res) => {
  const L = leads();
  const [total, hot, warm, cold, verified, noEmail, unverified] = await Promise.all([
    L.countDocuments({}),
    L.countDocuments({ status: "hot" }),
    L.countDocuments({ status: "warm" }),
    L.countDocuments({ status: "cold" }),
    L.countDocuments({ email_status: "verified" }),
    L.countDocuments({ email_status: "no-email" }),
    L.countDocuments({ email_status: "unverified" }),
  ]);
  const engCount = await engagements().countDocuments({});
  res.json({ total, hot, warm, cold, verified, noEmail, unverified, engagements: engCount, proxies: poolSize() });
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
