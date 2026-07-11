// POST /enrich — Trigify calls this once per engager.
// Always returns 200 on internal failure so one bad lead never kills a Trigify batch,
// but rejects unauthenticated or malformed requests up front.

import { Router } from "express";
import { enrichLead } from "../pipeline/enrichLead.js";
import { config } from "../config.js";
import { safeEqual } from "../lib/auth.js";
import { log } from "../lib/logger.js";

export const enrichRouter = Router();

// clamp a string field to a sane length (defence against oversized/abusive payloads)
const str = (v, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");

enrichRouter.post("/enrich", async (req, res) => {
  if (!safeEqual(req.headers["x-ingest-token"] || "", config.ingestToken)) {
    return res.status(401).json({ ok: false, error: "bad token" });
  }

  const b = req.body || {};
  // must have SOMETHING to identify the person, else it's junk
  if (!b.linkedin_url && !b.name) {
    return res.status(400).json({ ok: false, error: "missing linkedin_url/name" });
  }

  const clean = {
    name: str(b.name, 200),
    headline: str(b.headline, 600),
    linkedin_url: str(b.linkedin_url, 400),
    engagement_type: b.engagement_type === "comment" ? "comment" : "like",
    comment_text: str(b.comment_text, 2000),
    campaign: str(b.campaign, 120),
    campaign_id: str(b.campaign_id, 60),
    post_url: str(b.post_url, 400),
  };

  try {
    const result = await enrichLead(clean);
    res.json({ ok: true, ...result });
  } catch (e) {
    // never 500 back to Trigify — log it, ack it, move on
    log.error("enrich pipeline error", { err: e.message });
    res.json({ ok: false, outcome: "error" });
  }
});
