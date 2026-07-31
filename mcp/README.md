# GTM Engine MCP server

Exposes the InboxKit GTM lead engine to any MCP client (Claude Desktop, Claude Code, …) as 27 tools.
It's a thin, typed wrapper over the platform's existing `/api/*` endpoints — an AI can scrape posts,
add influencers, search/export leads, route to campaigns, recover emails, and read insights: the
same operations the dashboard performs.

There are two ways to run it: **hosted** (recommended for teammates — a URL + a personal key, nothing
to install) and **local** (stdio, runs on your own machine).

---

## Hosted (recommended) — a URL + a personal key

The engine already serves the MCP at **`https://<host>/mcp`**. Each person connects with their own
secret key; every request is logged with its source IP + the tool it called, and keys are revocable.

### 1. Issue a key (admin — behind the dashboard login)

```bash
curl -u "$DASH_USER:$DASH_PASS" -X POST https://<host>/api/mcp/keys \
  -H "Content-Type: application/json" -d '{"label":"alice"}'
# → { "id": "...", "key": "sk_gtm_xxxxxxxx...", "label": "alice" }   ← the key is shown ONCE
```

Manage keys: `GET /api/mcp/keys` (list + last IP + request count), `POST /api/mcp/keys/:id/revoke`,
`GET /api/mcp/audit` (recent requests with IP + tool).

### 2. Teammate connects (no install)

**Claude Code:**
```bash
claude mcp add gtm-engine --transport http "https://<host>/mcp/sk_gtm_xxxxxxxx..."
# (or keep the key in a header instead of the URL:)
claude mcp add gtm-engine --transport http "https://<host>/mcp" --header "Authorization: Bearer sk_gtm_xxxx..."
```

**Any MCP client that takes a URL:** use `https://<host>/mcp/<key>`.

The key can travel in the **URL path** (`/mcp/<key>`), an **`Authorization: Bearer <key>`** header, or
a **`?key=`** query param — whichever your client supports.

---

## Local (stdio) — runs on your machine

## Setup

```bash
cd gtm-engine/mcp
npm install
```

Configure via environment variables:

| Var | Required | What |
|-----|----------|------|
| `GTM_BASE` | ✅ | Base URL of the deployed engine (e.g. `https://…sslip.io`) |
| `GTM_USER` / `GTM_PASS` | ✅ | Dashboard basic-auth credentials (`DASH_USER` / `DASH_PASS`) |
| `GTM_INGEST_TOKEN` | — | Only for ingest-guarded tools (not used by the default toolset) |

> **Auth note:** every `/api/*` route sits behind HTTP Basic auth **and an IP allowlist**. Run this
> server on a machine whose IP is allowed — the same network you open the dashboard from.

## Add to Claude Desktop

`claude_desktop_config.json` → `mcpServers`:

```json
{
  "mcpServers": {
    "gtm-engine": {
      "command": "node",
      "args": ["C:/Users/acer/Desktop/GTM Auto/gtm-engine/mcp/index.js"],
      "env": {
        "GTM_BASE": "https://tigify-automation-gtmengine-4qawfh-d997ba-178-156-227-244.sslip.io",
        "GTM_USER": "inboxkit",
        "GTM_PASS": "<dashboard password>"
      }
    }
  }
}
```

## Add to Claude Code

```bash
claude mcp add gtm-engine -- node "C:/Users/acer/Desktop/GTM Auto/gtm-engine/mcp/index.js"
# then set GTM_BASE / GTM_USER / GTM_PASS in the environment
```

## Tools

**Read / insights**
`gtm_get_stats` · `gtm_get_campaigns` · `gtm_list_target_campaigns` · `gtm_list_sendkit_campaigns`
(live, incl. campaigns created directly in SendKit) · `gtm_search_leads` · `gtm_export_leads` ·
`gtm_get_analytics` · `gtm_get_sources` · `gtm_list_source_members` · `gtm_scraped_posts` ·
`gtm_auto_engine_status` · `gtm_scrape_status` · `gtm_keyword_sweep_status` · `gtm_reprocess_runs` ·
`gtm_bounceban_scorecard`

**Actions — scraping**
`gtm_scrape_post` (auto-routes to Cold Email 2.0, or override) · `gtm_pause_scrape` ·
`gtm_scrape_keyword` · `gtm_add_influencer` (auto-scrapes their last-3-months on-topic posts) ·
`gtm_add_hub` · `gtm_import_influencer_list` · `gtm_remove_source` · `gtm_set_source_active` ·
`gtm_set_list_active`

**Actions — engine / recovery**
`gtm_rotate_now` · `gtm_toggle_engine` · `gtm_retry_no_email`

## Example prompts

- "Scrape this LinkedIn post and tell me how many verified emails it produced."
- "Add these 5 influencers and enable the list."
- "Show me this week's verified leads in Cold Email 2.0, then export them."
- "Recover emails for all no-email hot leads."
- "What's the engine status and when's the next sweep?"

## Notes / limits

- **Single-tenant:** all tools act on the one shared workspace (one Mongo + one SendKit + one key
  set). This is for you/your team operating your instance — not a multi-user product. A public
  offering would need per-user auth + data isolation (see the platform roadmap).
- **Local (stdio):** runs on your machine. A remote/hosted version would need OAuth or token auth.
