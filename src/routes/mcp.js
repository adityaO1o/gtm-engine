// HOSTED MCP endpoint. Teammates connect their MCP client to  https://<host>/mcp/<their-key>
// (or /mcp with an "Authorization: Bearer <key>" header). No install, no dashboard password — each
// person uses their own revocable key, and every request is logged with its source IP + tool name.
//
// Transport: MCP Streamable HTTP in STATELESS mode — one fresh server+transport per request, so no
// session bookkeeping. Tools call back into this same process over the loopback /api using the
// server-side dashboard credentials (teammates never see them).

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "../../mcp/tools.js";
import { validateKey, recordUse } from "../services/mcpKeys.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const LOOPBACK = `http://127.0.0.1:${config.port}`;
const DASH_AUTH = "Basic " + Buffer.from(`${config.dashUser}:${config.dashPass}`).toString("base64");

// Tools call the engine's own /api over loopback, authenticated as the dashboard user.
async function loopbackApi(method, path, { query, body, ingest } = {}) {
  const url = new URL(LOOPBACK + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== "") url.searchParams.set(k, String(v));
  const headers = { Authorization: DASH_AUTH, "User-Agent": "gtm-mcp-hosted/1.0" };
  if (body) headers["Content-Type"] = "application/json";
  if (ingest) headers["x-ingest-token"] = config.ingestToken;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status}: ${typeof data === "string" ? data.slice(0, 400) : JSON.stringify(data)}`);
  return data;
}

function buildServer() {
  const server = new McpServer({ name: "gtm-engine", version: "1.0.0" });
  registerTools(server, loopbackApi);
  return server;
}

const clientIp = (req) => {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || String(req.socket?.remoteAddress || "").replace("::ffff:", "") || null;
};
const bearer = (req) => {
  const h = String(req.headers.authorization || "");
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : null;
};

const rpcError = (res, status, message, id = null) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id });

async function handle(req, res) {
  const key = req.params.key || bearer(req) || req.query.key;
  const doc = await validateKey(key);
  if (!doc) return rpcError(res, 401, "Invalid or missing MCP key", req.body?.id ?? null);

  // Audit: who (key label), from where (IP), which tool. Fire-and-forget so it never blocks the call.
  const tool = req.body?.method === "tools/call" ? req.body?.params?.name : req.body?.method;
  recordUse(doc, { ip: clientIp(req), method: req.body?.method, tool }).catch(() => {});

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { try { transport.close(); } catch { /* noop */ } try { server.close(); } catch { /* noop */ } });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log.warn("mcp request failed", { err: e.message });
    if (!res.headersSent) rpcError(res, 500, "Internal MCP error", req.body?.id ?? null);
  }
}

export const mcpRouter = Router();
const mcpLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
mcpRouter.use(mcpLimiter);
mcpRouter.post("/", handle);
mcpRouter.post("/:key", handle);
// Stateless mode has no server-initiated SSE stream — clients fall back to POST-only.
const methodNotAllowed = (_req, res) => rpcError(res, 405, "Method not allowed — use POST");
mcpRouter.get(["/", "/:key"], methodNotAllowed);
mcpRouter.delete(["/", "/:key"], methodNotAllowed);
