// Access keys for the HOSTED MCP endpoint (/mcp). Each teammate gets their own key (issued once,
// stored only as a SHA-256 hash), so access is per-person and individually revocable. Every MCP
// request is logged with the caller's IP + which tool it called, so usage is fully auditable.

import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { mcpKeys, mcpAudit } from "../db/mongo.js";

const sha = (k) => crypto.createHash("sha256").update(String(k)).digest("hex");

// Issue a new key. The raw key is returned ONCE (never stored) — only its hash + a display prefix live.
export async function createKey(label) {
  const key = "sk_gtm_" + crypto.randomBytes(24).toString("hex");
  const doc = {
    keyHash: sha(key), prefix: key.slice(0, 15), label: String(label || "").trim().slice(0, 60) || "unnamed",
    createdAt: new Date(), disabled: false, requests: 0, lastUsedAt: null, lastIp: null,
  };
  const r = await mcpKeys().insertOne(doc);
  return { id: String(r.insertedId), key, prefix: doc.prefix, label: doc.label };
}

export async function listKeys() {
  const rows = await mcpKeys().find({}).sort({ createdAt: -1 }).toArray();
  return rows.map((k) => ({
    id: String(k._id), label: k.label, prefix: k.prefix, disabled: !!k.disabled,
    requests: k.requests || 0, lastUsedAt: k.lastUsedAt, lastIp: k.lastIp, createdAt: k.createdAt,
  }));
}

export async function revokeKey(id) {
  try { const r = await mcpKeys().updateOne({ _id: new ObjectId(id) }, { $set: { disabled: true } }); return { ok: !!r.matchedCount }; }
  catch { return { ok: false, error: "bad id" }; }
}

// Return the key doc if the raw key is valid and enabled, else null.
export async function validateKey(rawKey) {
  if (!rawKey) return null;
  return await mcpKeys().findOne({ keyHash: sha(rawKey), disabled: { $ne: true } }).catch(() => null);
}

// Record one MCP request against a key: bump counters + append an audit row (IP + tool).
export async function recordUse(doc, { ip, method, tool } = {}) {
  await mcpKeys().updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date(), lastIp: ip || null }, $inc: { requests: 1 } }).catch(() => {});
  await mcpAudit().insertOne({ keyId: doc._id, label: doc.label, ip: ip || null, method: method || null, tool: tool || null, at: new Date() }).catch(() => {});
}

export async function recentAudit(limit = 100) {
  const rows = await mcpAudit().find({}).sort({ at: -1 }).limit(Math.min(Math.max(1, limit), 1000)).toArray();
  return rows.map((r) => ({ label: r.label, ip: r.ip, method: r.method, tool: r.tool, at: r.at }));
}
