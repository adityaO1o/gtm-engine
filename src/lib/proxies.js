// Proxy pool with self-rotation and validate-before-use.
//
// Rules (from the proxy provider's behaviour, learned the hard way):
//   - Static residential: each proxy is a fixed exit IP, sometimes slow, sometimes briefly dead.
//   - Hitting many at once from one source IP gets rate-limited — so we rotate ONE AT A TIME.
//   - We validate the specific proxy we're about to use, right before using it — not the whole
//     pool every time. A short-lived cache avoids re-validating the same proxy on every call.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadProxies() {
  // Priority: PROXIES env (newline list) -> proxies.txt at repo root.
  let raw = config.proxiesRaw;
  if (!raw) {
    const p = path.join(__dirname, "../../proxies.txt");
    if (fs.existsSync(p)) raw = fs.readFileSync(p, "utf8");
  }
  // Split on newlines, commas or whitespace — so PROXIES can be a single-line env var
  // (Dokploy env vars don't handle multi-line values well) or a multi-line proxies.txt.
  const list = raw
    .split(/[\s,]+/)
    .map((l) => l.trim())
    .filter((l) => l && l.startsWith("http"));
  return [...new Set(list)];
}

const PROXIES = loadProxies();
let cursor = 0;

// validity cache: proxyUrl -> { ok, checkedAt }
const cache = new Map();
const CACHE_MS = 60_000; // trust a validation result for 60s

async function isAlive(proxyUrl) {
  const cached = cache.get(proxyUrl);
  if (cached && Date.now() - cached.checkedAt < CACHE_MS) return cached.ok;
  let ok = false;
  try {
    const agent = new HttpsProxyAgent(proxyUrl);
    const r = await axios.get("https://api.ipify.org", {
      httpsAgent: agent,
      timeout: config.proxyTimeoutMs,
      validateStatus: () => true,
    });
    ok = typeof r.data === "string" && /^\d+\.\d+\.\d+\.\d+/.test(r.data.trim());
  } catch {
    ok = false;
  }
  cache.set(proxyUrl, { ok, checkedAt: Date.now() });
  return ok;
}

// Return the next working proxy's agent, validating one at a time as we rotate.
// Scans at most the whole pool once; throws if none are alive.
export async function nextWorkingAgent() {
  if (PROXIES.length === 0) throw new Error("no proxies configured");
  for (let tries = 0; tries < PROXIES.length; tries++) {
    const proxyUrl = PROXIES[cursor % PROXIES.length];
    cursor++;
    if (await isAlive(proxyUrl)) {
      return { agent: new HttpsProxyAgent(proxyUrl), proxyUrl };
    }
  }
  throw new Error("no working proxy in pool");
}

export function poolSize() {
  return PROXIES.length;
}

// CLI: `npm run validate-proxies` — validate the whole pool once and report.
if (process.argv.includes("--validate")) {
  const results = [];
  for (const p of PROXIES) {
    cache.delete(p);
    const ok = await isAlive(p);
    results.push({ p: p.split("@")[1], ok });
    log.info("proxy", { proxy: p.split("@")[1], ok });
  }
  const alive = results.filter((r) => r.ok).length;
  log.info("validation done", { alive, total: PROXIES.length });
  process.exit(0);
}
