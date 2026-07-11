# GTM Engine

Enrichment engine for the InboxKit GTM system. Trigify scrapes LinkedIn post engagers and calls this service once per person; the service does everything else and syncs results to SendKit + its own Mongo dashboard.

## Why it exists

Trigify's raw HTTP node treats Prospeo's `400 NO_MATCH` (a normal "person not in DB" result) as fatal and kills the whole batch. It also can't rotate proxies, resolve obfuscated LinkedIn URNs, or run logic without burning credits. This service does all of that off-platform, so Trigify only pays for scraping.

## Pipeline (per engager)

```
log engagement
  → resolve vanity URL   (likers: URN → real /in/slug via multi-engine free scraping —
                          Brave + DDG Lite + Bing, rotating engine AND residential proxy per try, ~80% hit)
  → find email           (Prospeo, 400-safe)
  → verify email         (Enrich.so → Prospeo second opinion; role-based rejected)
  → score                (deterministic: category weight × engagement points → cold/warm/hot)
  → persist              (Mongo lead doc + engagement log)
  → sync                 (SendKit: upsert tags, add to campaign)
```

Nobody is dropped. No-email and unverified people are saved to Mongo for hand-off. A repeat engager accumulates categories and climbs cold → warm → hot.

## Endpoints

- `POST /enrich` — Trigify ingest (needs `x-ingest-token` header). Always 200.
- `GET /api/stats`, `GET /api/leads`, `GET /api/leads/:url/timeline` — dashboard.
- `GET /` — dashboard UI.
- `GET /health`

## Deploy (Dokploy)

1. New **Compose** service pointed at this repo.
2. Set env vars: `INGEST_TOKEN`, `PROSPEO_KEY`, `ENRICH_KEY`, `SENDKIT_KEY`, `PROXIES` (newline list).
3. Deploy. Map a domain to the `app` service (port 3001).
4. Point Trigify's HTTP node at `https://<domain>/enrich` with the `x-ingest-token` header.

## Local dev

```
cp .env.example .env      # fill in keys
# put proxies in proxies.txt (one http://user:pass@host:port per line)
npm install
npm run validate-proxies  # check the pool
npm start
```
