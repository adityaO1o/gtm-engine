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

  // SEO SERP/Scrape API (self-hosted; wraps Jina + its own proxy pool). PRIMARY URN resolver
  // tier — the engine calls its /api/serp instead of hitting Jina directly, so the engine's own
  // drained Jina wallet is out of the loop and one funded key lives on the SEO server.
  seoApiBase: process.env.SEO_API_BASE || "https://seo-jb2ewi-7e7297.sendkit-mail.com",

  // Jina SERP (s.jina.ai) — the OLD in-engine resolver tier, kept dormant as a deep fallback.
  // Its wallet is drained, so it's OFF unless JINA_DIRECT=1 is set explicitly.
  jinaKey: process.env.JINA_KEY || "",
  jinaDirect: process.env.JINA_DIRECT === "1",
  // Serper.dev SERP keys (comma-separated), used after the SEO API tier. 1 credit per query.
  serperKeys: (process.env.SERPER_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean),

  // RapidAPI LinkedIn profile lookup (last-resort company/domain getter). Empty = skip the tier.
  linkedinApiKey: process.env.LINKEDIN_API_KEY || "",
  linkedinApiHost: process.env.LINKEDIN_API_HOST || "web-scraping-api2.p.rapidapi.com",
  // Plan credit caps — RapidAPI doesn't expose a live balance, so "left" = plan − used(metered).
  // Set these to your actual plan sizes in Dokploy (Ultra = 32000). Default Ultra.
  rapidFreshPlan: parseInt(process.env.RAPID_FRESH_PLAN || "32000", 10),
  rapidWebscrapePlan: parseInt(process.env.RAPID_WEBSCRAPE_PLAN || "32000", 10),

  // ── PND (professional-network-data, RapidAPI) — SEPARATE account from LINKEDIN_API_KEY.
  // Does everything in one API: post reactions/comments (50/credit), profile→company, company→exact
  // domain. Used for scraping, and as the PAID LAST RESORT when the free tiers can't find a domain.
  pndKey: process.env.PND_API_KEY || "",
  pndHost: process.env.PND_API_HOST || "professional-network-data.p.rapidapi.com",
  // Below this many credits remaining, the PAID enrichment tier (profile/company) switches off —
  // the free tiers keep running, so leads still flow. Safety net so a run can't drain the plan.
  pndCreditFloor: parseInt(process.env.PND_CREDIT_FLOOR || "300", 10),
  pndMinGapMs: parseInt(process.env.PND_MIN_GAP_MS || "250", 10),

  // BounceBan — PRIMARY email verifier (before Enrich/Prospeo). Big pool, 100/s, flags catch-all.
  bouncebanKey: process.env.BOUNCEBAN_KEY || "",
  // How long a BounceBan verdict is reused from cache before we re-verify (paid). A mailbox's status
  // drifts over time, so this is finite on purpose — long enough to spare the repeated re-checks the
  // live path, reprocess and the audit all make on the same address, short enough not to freeze
  // a stale verdict. 0 disables the cache entirely.
  bouncebanCacheMs: Math.max(0, parseInt(process.env.BOUNCEBAN_CACHE_DAYS || "14", 10)) * 86400000,
  // Post/engager scraping host — default FRESH so its $10/500 credits are drained first.
  scrapeApiHost: process.env.SCRAPE_API_HOST || "fresh-linkedin-profile-data.p.rapidapi.com",
  // Spacing between scrape API calls (ms) — a shared limiter so we don't burst the plan's
  // per-minute cap and trip 429s. 700ms ≈ 85/min (safe on Ultra); raise on smaller plans.
  scrapeMinGapMs: parseInt(process.env.SCRAPE_MIN_GAP_MS || "700", 10),

  sendkit: {
    key: req("SENDKIT_KEY"),
    base: process.env.SENDKIT_BASE || "https://api.sendkit.ai",
  },

  // Proxies: newline list of http://user:pass@host:port  (loaded from PROXIES env or proxies.txt)
  proxiesRaw: process.env.PROXIES || "",

  // Tunables
  proxyTimeoutMs: parseInt(process.env.PROXY_TIMEOUT_MS || "20000", 10),
  scrapeRetries: parseInt(process.env.SCRAPE_RETRIES || "4", 10),

  // ── Auto engine (scheduled keyword sweep + hub pass + daily influencer/list rotation) ────────
  autoSweepHours: parseInt(process.env.AUTO_SWEEP_HOURS || "12", 10),          // sweep cadence
  autoRotateUtcHour: parseInt(process.env.AUTO_ROTATE_UTC_HOUR || "3", 10),    // 03:00 UTC ≈ 08:30 IST
  autoPerList: parseInt(process.env.AUTO_PER_LIST || "25", 10),                 // members per list per day
  autoMaxPostsPerDay: parseInt(process.env.AUTO_MAX_POSTS_PER_DAY || "300", 10),// runaway brake on scrapes/day
  // Below this many PND credits, the whole auto engine idles (manual scrapes unaffected).
  // Distinct from PND_CREDIT_FLOOR, which only switches off the paid ENRICHMENT tier.
  autoMinCredits: parseInt(process.env.AUTO_MIN_CREDITS || "100", 10),
  autoPostMaxAgeDays: parseInt(process.env.AUTO_POST_MAX_AGE_DAYS || "90", 10),// the "last 3 months" window
};
