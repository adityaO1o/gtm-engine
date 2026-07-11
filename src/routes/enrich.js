// POST /enrich — Trigify calls this once per engager.
// Always returns 200 (even on internal failure) so a single bad lead never kills a Trigify batch.

import { Router } from "express";
import { enrichLead } from "../pipeline/enrichLead.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

export const enrichRouter = Router();

enrichRouter.post("/enrich", async (req, res) => {
  if ((req.headers["x-ingest-token"] || "") !== config.ingestToken) {
    return res.status(401).json({ ok: false, error: "bad token" });
  }
  try {
    const result = await enrichLead(req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) {
    // never 500 back to Trigify — log it, ack it, move on
    log.error("enrich pipeline error", { err: e.message, stack: e.stack });
    res.json({ ok: false, outcome: "error", error: e.message });
  }
});
