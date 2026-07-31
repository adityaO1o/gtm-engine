#!/usr/bin/env node
// GTM Engine MCP server — LOCAL (stdio) variant. Runs on your machine, wraps the deployed engine's
// /api/* endpoints as tools. For the hosted/remote variant (URL + secret key), see src/routes/mcp.js.
//
// Config via env: GTM_BASE (required), GTM_USER + GTM_PASS (dashboard basic auth), GTM_INGEST_TOKEN (optional).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const BASE = (process.env.GTM_BASE || "").replace(/\/$/, "");
const USER = process.env.GTM_USER || "";
const PASS = process.env.GTM_PASS || "";
const INGEST = process.env.GTM_INGEST_TOKEN || "";

if (!BASE || !USER || !PASS) {
  console.error("[gtm-mcp] Missing config. Set GTM_BASE, GTM_USER, GTM_PASS environment variables.");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

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

const server = new McpServer({ name: "gtm-engine", version: "1.0.0" });
registerTools(server, api);
await server.connect(new StdioServerTransport());
console.error("[gtm-mcp] GTM Engine MCP server running on stdio →", BASE);
