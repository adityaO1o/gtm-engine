import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { connect } from "./db/mongo.js";
import { enrichRouter } from "./routes/enrich.js";
import { apiRouter } from "./routes/api.js";
import { basicAuth } from "./lib/auth.js";
import { poolSize } from "./lib/proxies.js";
import { runSources } from "./pipeline/sources.js";
import { meterFlush } from "./services/apiMeter.js";
import { log } from "./lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "../public");

const app = express();

// Behind Traefik — trust the first proxy so rate-limit + IP allowlist see the real client IP.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Security headers incl. a CSP that permits only self + inline styles/data-URIs (dashboard is self-hosted).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
app.use(express.json({ limit: "1mb" }));

// Rate limits. /enrich is called per-engager by Trigify (bursty) so it gets a higher ceiling.
const enrichLimiter = rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 150, standardHeaders: true, legacyHeaders: false });
// Brute-force guard on the login surface: only FAILED (non-2xx) requests count.
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 25, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false });

// Optional IP allowlist for the dashboard surface (opt-in via ALLOW_IPS; never applied to /enrich).
function ipAllow(req, res, next) {
  if (!config.allowIps.length) return next();
  const ip = (req.ip || "").replace("::ffff:", "");
  if (config.allowIps.includes(ip)) return next();
  return res.status(403).send("Forbidden");
}

// Health check — no secrets, no proxy count.
app.get("/health", (_req, res) => res.json({ ok: true }));

// Trigify ingest — token-guarded (inside the router) + rate-limited.
app.use("/", enrichLimiter, enrichRouter);

// Dashboard API — IP allowlist + brute-force guard + basic-auth + rate-limit.
app.use("/api", ipAllow, authLimiter, apiLimiter, basicAuth, apiRouter);

// Static UI — long-cache fonts (fixes the font flash on reload) behind the same guards.
app.use("/", ipAllow, authLimiter, basicAuth, express.static(publicDir, {
  setHeaders: (res, p) => {
    if (/[\\/]fonts[\\/]/.test(p)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  },
}));

async function main() {
  await connect();
  app.listen(config.port, () =>
    log.info("gtm-engine up", { port: config.port, proxies: poolSize(), dashLocked: !!(config.dashUser && config.dashPass), ipAllowlist: config.allowIps.length })
  );
  // Self-chaining source scraper. Each run processes a bounded batch (durable — progress is
  // persisted via processed_posts + per-influencer lastRun). If a run filled its batch there's
  // more backlog, so we come back in a minute and keep grinding through the ~5k influencers;
  // when it drains (small run) we idle to a 3-hour check for fresh posts. This is how "unlimited"
  // scraping stays alive across container restarts without a single giant run that dies midway.
  async function sourcesLoop() {
    let processed = 0;
    try { const r = await runSources(); processed = r?.postsProcessed || 0; }
    catch (e) { log.warn("scheduled sources failed", { err: e.message }); }
    const busy = processed >= 1000;                       // near the per-run cap => backlog remains
    setTimeout(sourcesLoop, busy ? 60_000 : 3 * 60 * 60 * 1000);
  }
  setTimeout(sourcesLoop, 60_000); // first sweep shortly after boot

  // Persist API-consumption counters every 30s (so the dashboard totals survive deploys even
  // between run-end flushes), and once more on shutdown so nothing is lost.
  setInterval(() => { meterFlush().catch(() => {}); }, 30_000);
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => { try { await meterFlush(); } catch { /* best effort */ } process.exit(0); });
  }
}

main().catch((e) => {
  log.error("fatal boot error", { err: e.message });
  process.exit(1);
});
