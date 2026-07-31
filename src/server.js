import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { connect } from "./db/mongo.js";
import { enrichRouter } from "./routes/enrich.js";
import { apiRouter } from "./routes/api.js";
import { mcpRouter } from "./routes/mcp.js";
import { internalRouter } from "./routes/internal.js";
import { basicAuth, internalAuth } from "./lib/auth.js";
import { poolSize } from "./lib/proxies.js";
import { startAutoLoop } from "./pipeline/autoScrape.js";
import { meterFlush } from "./services/apiMeter.js";
import { log } from "./lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "../public");
// The Next.js dashboard (static export) is now the DEFAULT. Escape hatch: set USE_OLD_UI=1 in
// Dokploy to instantly fall back to the vanilla dashboard (no code change) if anything regresses.
const nextDir = path.join(__dirname, "../web/out");
const uiDir = process.env.USE_OLD_UI === "1" ? publicDir : nextDir;

const app = express();

// Behind Traefik — trust the first proxy so rate-limit + IP allowlist see the real client IP.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// gzip/brotli JSON + the Next JS/CSS bundles (client negotiates via Accept-Encoding; already-
// compressed assets like fonts/images are skipped). Big transfer-size win on lead lists + first load.
app.use(compression());

// Security headers incl. a CSP that permits only self + inline styles/data-URIs (dashboard is self-hosted).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Next.js static export ships inline bootstrap/hydration <script> blocks that a strict
      // 'self'-only policy blocks (the dashboard then never hydrates). Allow inline scripts —
      // the dashboard is behind basic-auth (single trusted user), so the XSS surface is minimal.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
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

// Health check — no secrets. `sha` is the deployed commit, baked at image-build time (Dockerfile
// ARG GIT_SHA -> ENV). Reads "unknown" until the build passes GIT_SHA; once wired, "is the latest
// deploy live?" is a single curl instead of digging through the Dokploy UI.
app.get("/health", (_req, res) => res.json({ ok: true, sha: process.env.GIT_SHA || "unknown" }));

// Trigify ingest — token-guarded (inside the router) + rate-limited.
app.use("/", enrichLimiter, enrichRouter);

// Hosted MCP — public URL, guarded by per-teammate secret keys (checked INSIDE the router, not by
// basic-auth), so it is mounted BEFORE /api. No IP allowlist: teammates connect from anywhere.
app.use("/mcp", mcpRouter);

// /internal — the personal internal-tool tool. Its OWN login (internalAuth), mounted BEFORE the main /api and
// the catch-all so the dashboard's basic-auth never applies to it and vice-versa.
//
// The API lives UNDER the page's own prefix (/internal/api, not /api/internal) on purpose: browsers only
// send cached basic-auth credentials proactively to paths at or below where auth succeeded. With
// the API on a different prefix, every poll fired a credential-less request first (401, then a
// 200 retry) — and the 401s tripped the 25-per-15-min auth limiter within a minute, which is the
// "too many requests" you saw. Same prefix = creds sent up front = no 401 storm. And this surface
// is gated by internalAuth + the 150/min apiLimiter, so the strict auth limiter isn't needed here.
app.use("/internal/api", ipAllow, apiLimiter, internalAuth, internalRouter);
app.use("/internal", ipAllow, internalAuth, express.static(path.join(publicDir, "internal"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
}));

// Dashboard API — IP allowlist + brute-force guard + basic-auth + rate-limit.
app.use("/api", ipAllow, authLimiter, apiLimiter, basicAuth, apiRouter);

// Fonts are shared by both dashboards — always served from the backend's public/fonts, long-cached.
app.use("/fonts", ipAllow, authLimiter, basicAuth, express.static(path.join(publicDir, "fonts"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable"),
}));
// Static UI — the vanilla dashboard, or the Next.js static export when USE_NEXT_UI=1.
app.use("/", ipAllow, authLimiter, basicAuth, express.static(uiDir, {
  setHeaders: (res, p) => {
    if (/[\\/]fonts[\\/]/.test(p)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (/[\\/]_next[\\/]/.test(p)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  },
}));

async function main() {
  await connect();
  app.listen(config.port, () =>
    log.info("gtm-engine up", { port: config.port, proxies: poolSize(), dashLocked: !!(config.dashUser && config.dashPass), ipAllowlist: config.allowIps.length })
  );
  // The AUTO ENGINE — the single scheduled loop (autoScrape.js): keyword sweep every N hours, hub
  // pass, and a daily influencer/imported-list rotation, all through the incremental PND scraper.
  // Replaces the old sourcesLoop, which drove the dead Trigify path (paused-by-default + no credits)
  // while the working sweep had no schedule. `runSources`/`processPost` remain in sources.js but are
  // no longer scheduled — kept for manual/legacy use until Trigify credits return.
  startAutoLoop();

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
