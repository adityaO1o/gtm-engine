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

  // Dashboard + /api/* basic-auth. If unset, the dashboard stays OPEN (with a loud warning).
  dashUser: process.env.DASH_USER || "",
  dashPass: process.env.DASH_PASS || "",
  // Optional extra layer: comma-separated IP allowlist for the dashboard (empty = allow all).
  allowIps: (process.env.ALLOW_IPS || "").split(",").map((s) => s.trim()).filter(Boolean),

  mongoUri: req("MONGO_URI", "mongodb://mongo:27017"),
  mongoDb: process.env.MONGO_DB || "gtm",

  prospeoKey: req("PROSPEO_KEY"),
  enrichKey: req("ENRICH_KEY"),
  // Enrich.so "linkedin-to-email" finder (staging) — the Prospeo fallback.
  enrichLteKey: process.env.ENRICH_LTE_KEY || "lte_enrich_2026_internal",
  // Trigify API key — read-only, for pulling the live credit balance onto the dashboard.
  trigifyKey: process.env.TRIGIFY_KEY || "",

  // Jina SERP (s.jina.ai) — primary resolver for obfuscated liker URNs. Empty = skip straight
  // to the proxy engines, so a missing key degrades gracefully instead of breaking.
  jinaKey: process.env.JINA_KEY || "",
  // Serper.dev SERP keys (comma-separated), used after Jina runs out. 1 credit per query.
  serperKeys: (process.env.SERPER_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean),

  // RapidAPI LinkedIn profile lookup (last-resort company/domain getter). Empty = skip the tier.
  linkedinApiKey: process.env.LINKEDIN_API_KEY || "",
  linkedinApiHost: process.env.LINKEDIN_API_HOST || "web-scraping-api2.p.rapidapi.com",
  // Post/engager scraping host — default FRESH so its $10/500 credits are drained first.
  scrapeApiHost: process.env.SCRAPE_API_HOST || "fresh-linkedin-profile-data.p.rapidapi.com",

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
