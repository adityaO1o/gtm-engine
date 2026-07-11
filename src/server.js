import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { connect } from "./db/mongo.js";
import { enrichRouter } from "./routes/enrich.js";
import { apiRouter } from "./routes/api.js";
import { poolSize } from "./lib/proxies.js";
import { log } from "./lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, proxies: poolSize() }));
app.use("/", enrichRouter);
app.use("/api", apiRouter);

// dashboard
app.use(express.static(path.join(__dirname, "../public")));

async function main() {
  await connect();
  app.listen(config.port, () => log.info("gtm-engine up", { port: config.port, proxies: poolSize() }));
}

main().catch((e) => {
  log.error("fatal boot error", { err: e.message });
  process.exit(1);
});
