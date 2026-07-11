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
import { log } from "./lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Behind Traefik — trust the first proxy so rate-limit sees the real client IP.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false })); // dashboard is same-origin inline; keep other headers
app.use(express.json({ limit: "1mb" }));

// Rate limits. /enrich is called per-engager by Trigify (bursty) so it gets a higher ceiling.
const enrichLimiter = rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
// Brute-force guard on the login surface: only FAILED (non-2xx) requests count, so the
// dashboard's own auto-refresh isn't affected but password guessing is throttled hard.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 25,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/health", (_req, res) => res.json({ ok: true, proxies: poolSize() }));

// Trigify ingest — token-guarded (inside the router) + rate-limited.
app.use("/", enrichLimiter, enrichRouter);

// Dashboard API + static UI — brute-force guard + basic-auth + rate-limited.
app.use("/api", authLimiter, apiLimiter, basicAuth, apiRouter);
app.use("/", authLimiter, basicAuth, express.static(path.join(__dirname, "../public")));

async function main() {
  await connect();
  app.listen(config.port, () =>
    log.info("gtm-engine up", { port: config.port, proxies: poolSize(), dashLocked: !!(config.dashUser && config.dashPass) })
  );
}

main().catch((e) => {
  log.error("fatal boot error", { err: e.message });
  process.exit(1);
});
