#!/usr/bin/env node
// GTM Engine MCP server — exposes the InboxKit GTM lead engine to any MCP client (Claude Desktop,
// Claude Code, etc.) as tools. It's a thin, typed wrapper over the platform's existing /api/* REST
// endpoints, so an AI can scrape posts, add influencers, search/export leads, route to campaigns,
// recover emails, and read insights — the same operations the dashboard performs.
//
// Auth: every /api/* route is behind HTTP Basic auth (DASH_USER / DASH_PASS) plus an IP allowlist.
// Run this on a machine whose IP is allowed (same as your dashboard browser). Config via env:
//   GTM_BASE           base URL of the deployed engine (required)
//   GTM_USER, GTM_PASS dashboard basic-auth credentials (required)
//   GTM_INGEST_TOKEN   only needed for the ingest-guarded tools (optional)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.GTM_BASE || "").replace(/\/$/, "");
const USER = process.env.GTM_USER || "";
const PASS = process.env.GTM_PASS || "";
const INGEST = process.env.GTM_INGEST_TOKEN || "";

if (!BASE || !USER || !PASS) {
  console.error("[gtm-mcp] Missing config. Set GTM_BASE, GTM_USER, GTM_PASS environment variables.");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

// One HTTP helper for every tool. Throws with a readable message on non-2xx so the client sees why.
async function api(method, path, { query, body, ingest } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== "") url.searchParams.set(k, String(v));
  const headers = { Authorization: AUTH, "User-Agent": "gtm-mcp/1.0" };
  if (body) headers["Content-Type"] = "application/json";
  if (ingest) headers["x-ingest-token"] = INGEST;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status}: ${typeof data === "string" ? data.slice(0, 400) : JSON.stringify(data)}`);
  return data;
}

const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const server = new McpServer({ name: "gtm-engine", version: "1.0.0" });

// Register a tool with uniform error handling. `run` returns raw data; we wrap/serialise it.
const tool = (name, description, shape, run) =>
  server.tool(name, description, shape, async (args) => {
    try { return ok(await run(args || {})); }
    catch (e) { return { content: [{ type: "text", text: "Error: " + e.message }], isError: true }; }
  });

// ─────────────────────────────── READ / INSIGHTS ───────────────────────────────
tool("gtm_get_stats", "Overall lead totals (total, verified, no-email, recovered, review, competitor). Optional bucket '1.0' (old) or '2.0' (new).",
  { bucket: z.enum(["1.0", "2.0"]).optional() },
  ({ bucket }) => api("GET", "/api/stats", { query: { bucket } }));

tool("gtm_get_campaigns", "Per-topic campaign breakdown (leads, verified, no-email, recovered per keyword topic). Optional bucket '1.0'/'2.0'.",
  { bucket: z.enum(["1.0", "2.0"]).optional() },
  ({ bucket }) => api("GET", "/api/campaigns", { query: { bucket } }));

tool("gtm_list_target_campaigns", "The two go-forward SEND targets leads can be routed into (Cold Email 1.0 / 2.0), with their routing keys.",
  {}, () => api("GET", "/api/campaigns/list"));

tool("gtm_list_sendkit_campaigns", "LIVE list of every campaign in the SendKit workspace — including ones created directly in SendKit that aren't in the engine's config. Use this to discover new campaigns.",
  {}, () => api("GET", "/api/sendkit/campaigns"));

tool("gtm_search_leads", "Search/list leads. Filters: query (name/email/company), email_status (verified|no-email|unverified|review|competitor), bucket (1.0|2.0). sort (score|recent). Paginated.",
  { query: z.string().optional(), email_status: z.string().optional(), bucket: z.enum(["1.0", "2.0"]).optional(),
    sort: z.string().optional(), limit: z.number().int().min(1).max(10000).optional(), skip: z.number().int().min(0).optional() },
  ({ query, email_status, bucket, sort, limit, skip }) =>
    api("GET", "/api/leads", { query: { q: query, email_status, bucket, sort: sort || "score", limit: limit || 50, skip: skip || 0 } }));

tool("gtm_export_leads", "Export leads as CSV text (filtered like gtm_search_leads). Returns raw CSV.",
  { email_status: z.string().optional(), bucket: z.enum(["1.0", "2.0"]).optional(), query: z.string().optional() },
  ({ email_status, bucket, query }) => api("GET", "/api/export", { query: { email_status, bucket, q: query } }));

tool("gtm_get_analytics", "Time-series and funnel analytics for the dashboard Overview.", {}, () => api("GET", "/api/analytics"));

tool("gtm_get_sources", "All scraping sources: standalone influencers, hubs, and imported CSV lists (with per-list progress).",
  {}, () => api("GET", "/api/sources"));

tool("gtm_list_source_members", "Members of one imported list (by list name). Optional q search + pagination.",
  { list: z.string(), q: z.string().optional(), limit: z.number().int().optional(), skip: z.number().int().optional() },
  ({ list, q, limit, skip }) => api("GET", `/api/sources/list/${encodeURIComponent(list)}`, { query: { q, limit: limit || 100, skip: skip || 0 } }));

tool("gtm_scraped_posts", "History of scraped posts with live counts (engagers, verified, no-email, hit-rate, PND credits per post). Paginated.",
  { limit: z.number().int().optional(), skip: z.number().int().optional() },
  ({ limit, skip }) => api("GET", "/api/sources/scraped-posts", { query: { limit: limit || 25, skip: skip || 0 } }));

tool("gtm_auto_engine_status", "Auto engine state: enabled, next 12h sweep ETA, daily rotation progress, credit floor, what it's busy with.",
  {}, () => api("GET", "/api/auto/status"));

tool("gtm_scrape_status", "Live status of the current 'scrape via post' run (phase, engagers scraped, enriched, verified & sent).",
  {}, () => api("GET", "/api/sources/scrape-post/status"));

tool("gtm_keyword_sweep_status", "Status of the automatic 12h keyword sweep.", {}, () => api("GET", "/api/keywords/sweep/status"));

tool("gtm_reprocess_runs", "History of email-recovery (retry) runs and why remaining leads are still stuck.",
  {}, () => api("GET", "/api/reprocess/runs"));

tool("gtm_bounceban_scorecard", "BounceBan verification scorecard (deliverable / risky / undeliverable breakdown).",
  {}, () => api("GET", "/api/bounceban/scorecard"));

// ─────────────────────────────── ACTIONS: SCRAPING ───────────────────────────────
tool("gtm_scrape_post", "Scrape ALL engagers (reactors + commenters) of a LinkedIn post, enrich + verify their emails, and route them. campaign='' (default) auto-routes by the post's topic into Cold Email 2.0. Pass a routing key from gtm_list_target_campaigns to override.",
  { url: z.string().describe("LinkedIn post URL (…/feed/update/urn:li:activity:… or /posts/…)"), campaign: z.string().optional() },
  ({ url, campaign }) => api("POST", "/api/sources/scrape-post", { body: { postUrl: url, campaign: campaign || "" } }));

tool("gtm_pause_scrape", "Pause the currently running post scrape (resumable later).", {}, () => api("POST", "/api/sources/scrape-post/pause", { body: {} }));

tool("gtm_scrape_keyword", "Scrape everyone who engaged with this week's posts for a keyword and route them into a campaign. campaign must be a routing key from gtm_list_target_campaigns.",
  { keyword: z.string(), campaign: z.string().describe("Routing key (from gtm_list_target_campaigns) — required, no auto-route for keywords") },
  ({ keyword, campaign }) => api("POST", "/api/keywords/manual", { body: { keyword, campaign } }));

tool("gtm_add_influencer", "Add a LinkedIn profile as an influencer source. The auto engine then scrapes their last-3-months ON-TOPIC (cold-email-related) posts and routes the engagers, then marks them done.",
  { url: z.string().describe("LinkedIn profile URL or handle") },
  ({ url }) => api("POST", "/api/sources", { body: { type: "influencer", url } }));

tool("gtm_add_hub", "Add a LinkedIn top-content hub URL as a source (its relevant posts' engagers get scraped).",
  { url: z.string().describe("linkedin.com/top-content/... URL") },
  ({ url }) => api("POST", "/api/sources", { body: { type: "hub", url } }));

tool("gtm_import_influencer_list", "Bulk-import a named list of LinkedIn profiles as influencers (imported PAUSED — enable with gtm_set_list_active).",
  { list: z.string().describe("A name for this CSV/list"), urls: z.array(z.string()).describe("LinkedIn profile URLs or handles") },
  ({ list, urls }) => api("POST", "/api/sources/import", { body: { list, items: urls.map((u) => ({ url: u })) } }));

tool("gtm_remove_source", "Delete a source (influencer/hub) by its id (leads already collected stay).",
  { id: z.string() }, ({ id }) => api("DELETE", `/api/sources/${encodeURIComponent(id)}`));

tool("gtm_set_source_active", "Pause/resume ONE influencer source by id (active=true resumes, false pauses).",
  { id: z.string(), active: z.boolean() }, ({ id, active }) => api("POST", `/api/sources/${encodeURIComponent(id)}/active`, { body: { active } }));

tool("gtm_set_list_active", "Enable/pause an entire imported list by name (enabling spends scraping credits).",
  { list: z.string(), active: z.boolean() }, ({ list, active }) => api("POST", `/api/sources/list/${encodeURIComponent(list)}/active`, { body: { active } }));

// ─────────────────────────────── ACTIONS: ENGINE / RECOVERY ───────────────────────────────
tool("gtm_rotate_now", "Kick the daily influencer/list rotation immediately (scrapes the next batch of members' on-topic posts).",
  {}, () => api("POST", "/api/auto/rotate-now", { body: {} }));

tool("gtm_toggle_engine", "Turn the whole auto engine on or off (persisted).",
  { enabled: z.boolean() }, ({ enabled }) => api("POST", "/api/auto/toggle", { body: { enabled } }));

tool("gtm_retry_no_email", "Re-run the email-recovery waterfall for no-email leads. Optionally scope to campaign topic keys and/or a bucket. deep=true retries EVERY stuck lead (spends more credits).",
  { campaigns: z.array(z.string()).optional(), deep: z.boolean().optional(), bucket: z.enum(["1.0", "2.0"]).optional() },
  ({ campaigns, deep, bucket }) => api("POST", "/api/reprocess", { body: { campaigns: campaigns || [], deep: !!deep, bucket } }));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[gtm-mcp] GTM Engine MCP server running on stdio →", BASE);
