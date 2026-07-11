// All configuration comes from environment variables.
// Copy .env.example to .env for local dev; on Dokploy set these in the service's Environment tab.

const req = (name, fallback = undefined) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) console.warn(`[config] missing env ${name}`);
  return v;
};

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),

  // Shared secret Trigify must send as x-ingest-token so randoms can't hit /enrich
  ingestToken: req("INGEST_TOKEN", "change-me"),

  mongoUri: req("MONGO_URI", "mongodb://mongo:27017"),
  mongoDb: process.env.MONGO_DB || "gtm",

  prospeoKey: req("PROSPEO_KEY"),
  enrichKey: req("ENRICH_KEY"),

  sendkit: {
    key: req("SENDKIT_KEY"),
    base: process.env.SENDKIT_BASE || "https://api.sendkit.ai",
  },

  // Proxies: newline list of http://user:pass@host:port  (loaded from PROXIES env or proxies.txt)
  proxiesRaw: process.env.PROXIES || "",

  // Tunables
  proxyTimeoutMs: parseInt(process.env.PROXY_TIMEOUT_MS || "20000", 10),
  scrapeRetries: parseInt(process.env.SCRAPE_RETRIES || "4", 10),
};
