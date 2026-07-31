# GTM Engine MCP server

Exposes the InboxKit GTM lead engine to any MCP client (Claude Desktop, Claude Code, …) as tools.
It's a thin, typed wrapper over the platform's existing `/api/*` endpoints — an AI can scrape posts,
add influencers, search/export leads, route to campaigns, recover emails, and read insights: the
same operations the dashboard performs.

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
