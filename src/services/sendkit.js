// SendKit: the sending platform. We look a lead up (scoped to our own gtm-auto tag so
// the 112k legacy leads stay invisible), upsert them with fresh tags, and add them to a campaign.

import axios from "axios";
import { config } from "../config.js";
import { emailCampaign } from "../db/mongo.js";
import { isActiveCampaignId, INTAKE_SENDKIT_ID } from "./campaigns.js";
import { log } from "../lib/logger.js";

// GLOBAL email → campaign uniqueness. Returns the ONE campaign id this email is allowed to live in.
// First-writer-wins and atomic ($setOnInsert + returnDocument:after): the first push to ever touch
// an email locks its campaign; every later push for that email — INCLUDING from a different LinkedIn
// profile that happens to share it — gets the same campaign back, so the email can never land in a
// second one. Every push site routes its desired campaign through this before calling addToCampaign.
// Falls back to the desired id if the DB is momentarily unavailable (fail-open, never blocks a push).
export async function assignEmailCampaign(email, desiredCampaignId) {
  const key = String(email || "").trim().toLowerCase();
  if (!key || !desiredCampaignId) return desiredCampaignId || null;
  try {
    const r = await emailCampaign().findOneAndUpdate(
      { _id: key },
      { $setOnInsert: { campaignId: desiredCampaignId, at: new Date() } },
      { upsert: true, returnDocument: "after" },
    );
    // driver v6 returns the doc directly; older returns { value }
    return (r && (r.campaignId ?? r.value?.campaignId)) || desiredCampaignId;
  } catch (e) {
    // A concurrent insert for the SAME email makes the loser's upsert throw a duplicate-key error
    // (E11000 on _id). Falling open to `desired` here would let the loser push the email into its OWN
    // campaign — the exact double-membership this lock exists to stop. Re-read the doc the winner just
    // wrote and return THAT campaign instead; only fall to desired if it's a genuine DB error.
    if (e?.code === 11000 || /E11000|duplicate key/i.test(e?.message || "")) {
      const won = await emailCampaign().findOne({ _id: key }).catch(() => null);
      if (won?.campaignId) return won.campaignId;
    }
    log.warn("assignEmailCampaign failed — using desired campaign", { err: e.message });
    return desiredCampaignId;
  }
}

// Deliberate MOVE — overwrite the assignment. Used only by the reroute repair tool, which
// intentionally relocates a lead to a better campaign; first-writer-wins would wrongly pin it to
// where it already (wrongly) sits. Ordinary pushes must use assignEmailCampaign, never this.
export async function reassignEmailCampaign(email, campaignId) {
  const key = String(email || "").trim().toLowerCase();
  if (!key || !campaignId) return;
  await emailCampaign().updateOne({ _id: key }, { $set: { campaignId, at: new Date() } }, { upsert: true }).catch(() => {});
}

// INTAKE routing with a retirement guard. All ongoing scrapes must land only in the active campaigns
// (1.0 / 2.0). But the uniqueness lock still holds legacy assignments pointing at the now-retired topic
// campaigns — so a re-seen email whose lock says "Smartlead" would otherwise be re-enrolled there. This
// wrapper resolves the lock; if it lands on a RETIRED topic, it repoints the lock to the intended intake
// campaign (default 2.0) and returns that instead, guaranteeing no new lead ever enters an old topic.
// Genuinely new emails behave exactly as before (lock inserts the desired campaign, which is active).
export async function intakeCampaign(email, desiredCampaignId) {
  const desired = desiredCampaignId || INTAKE_SENDKIT_ID;
  const cid = await assignEmailCampaign(email, desired);
  if (isActiveCampaignId(cid)) return cid;         // already in 1.0 / 2.0 — keep it there
  await reassignEmailCampaign(email, desired);      // lock was on a retired topic — move it to intake
  return desired;
}

const h = () => ({ "X-Api-Key": config.sendkit.key, "Content-Type": "application/json" });
const base = config.sendkit.base;

// Has this email already been claimed by our system? (tag-scoped, ignores legacy leads)
export async function findOurLead(email) {
  try {
    const r = await axios.get(`${base}/v1/leads`, {
      headers: h(),
      params: { search: email, tags: "gtm-auto" },
      timeout: 15000,
      validateStatus: () => true,
    });
    const arr = r.data?.data || [];
    return arr[0] || null;
  } catch (e) {
    log.warn("sendkit lookup threw", { err: e.message });
    return null;
  }
}

// Push one lead. MUST go through withRetry: SendKit rate-limits bursts of single calls, and this
// was the one write in this file without it — the BounceBan audit fired ~8k of these concurrently,
// ate 429s, and returned false silently (no retry, no log) while the caller counted them "pushed".
export async function upsertLead(lead) {
  // lead: {email, firstName, lastName, companyName, jobTitle, linkedinUrl, tags:[...] }
  try {
    // tags must be an ARRAY here — the bulk endpoint stores a comma-string as a single literal tag
    const r = await withRetry(() => axios.post(
      `${base}/v1/leads/bulk`,
      { skipDuplicates: false, leads: [{ ...lead, tags: lead.tags }] },
      { headers: h(), timeout: 20000, validateStatus: () => true }
    ));
    if (r.status >= 300) {
      log.warn("sendkit upsert failed", {
        email: lead.email, status: r.status,
        body: typeof r.data === "string" ? r.data.slice(0, 200) : JSON.stringify(r.data || {}).slice(0, 200),
      });
      return false;
    }
    return true;
  } catch (e) {
    log.warn("sendkit upsert threw", { email: lead.email, err: e.message });
    return false;
  }
}

// SendKit rate-limits us (a big sync fired thousands of single calls and most came back
// non-2xx). Retry 429/5xx with exponential backoff.
async function withRetry(fn, tries = 5) {
  let wait = 600, r;
  for (let i = 0; i < tries; i++) {
    r = await fn();
    if (r.status !== 429 && r.status < 500) return r;
    await new Promise((s) => setTimeout(s, wait));
    wait *= 2;
  }
  return r;
}

// Do-Not-Contact — the workspace-wide send-time suppression list. Campaigns run skipDNC:true, so
// a DNC'd address is skipped at send time regardless of which campaigns it sits in. Use this to
// block an address everywhere; use removeFromCampaign to pull it out of a SPECIFIC campaign (that
// endpoint exists — the older "SendKit has no remove endpoint" assumption was wrong). `reason` is
// an enum: manual|bounce|complaint|unsubscribe_link.
export async function addToDnc(emails = []) {
  const list = [...new Set(emails.filter(Boolean).map((e) => e.trim().toLowerCase()))];
  if (!list.length) return { added: 0, failed: 0 };
  let added = 0, failed = 0;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    try {
      const r = await withRetry(() => axios.post(
        `${base}/v1/dnc`,
        { entries: chunk.map((email) => ({ email, entryType: "email", reason: "manual" })) },
        { headers: h(), timeout: 30000, validateStatus: () => true }
      ));
      if (r.status >= 300) { failed += chunk.length; log.warn("sendkit dnc failed", { status: r.status, body: JSON.stringify(r.data || {}).slice(0, 200) }); continue; }
      added += r.data?.data?.added || 0;
    } catch (e) { failed += chunk.length; log.warn("sendkit dnc threw", { err: e.message }); }
  }
  return { added, failed };
}

// The workspace DNC list: BOTH the blocked addresses and the blocked DOMAINS. A third of this list
// is domain entries (1,515 of 4,672) — ignoring them made every lead at a blocked domain look
// contactable, which is how the proof reported an address as "leaked" that was blocked all along.
//
// Returns { emails, domains, truncated }. `truncated` is the important half: a short read looks
// identical to "this address is not blocked", and the reconcile would then clear dnc on leads
// SendKit is still blocking. Callers must never CLEAR a block on a truncated read.
export async function fetchDncEmails() {
  const emails = new Set(), domains = new Set();
  let cursor = "", truncated = true; // assume incomplete until we actually see the end of the list
  for (let i = 0; i < 1000; i++) {
    const r = await withRetry(() => axios.get(`${base}/v1/dnc`, {
      headers: h(), params: { limit: 100, ...(cursor ? { cursor } : {}) },
      timeout: 30000, validateStatus: () => true,
    }));
    if (r.status >= 300) { log.warn("sendkit dnc list failed", { status: r.status, page: i, got: emails.size }); break; }
    for (const e of (r.data?.data || [])) {
      const v = String(e?.email || e?.domain || "").trim().toLowerCase();
      if (!v) continue;
      if (e.entryType === "domain") domains.add(v.replace(/^@/, ""));
      else emails.add(v);
    }
    cursor = r.data?.pagination?.nextCursor || "";
    if (!cursor) { truncated = false; break; } // walked the whole list
  }
  if (truncated) log.warn("sendkit dnc list truncated — not clearing any blocks", { got: emails.size });
  return { emails, domains, truncated };
}

// How many leads SendKit itself says are in a campaign. NOTE this number does not fall when we
// DNC someone: DNC blocks at send time but leaves the membership in place — a DNC'd lead stays a
// member and is skipped when sending. To actually drop the membership, use removeFromCampaign.
// Membership and deliverability are different questions.
export async function campaignLeadCount(campaignId) {
  if (!campaignId) return null;
  try {
    const r = await withRetry(() => axios.get(`${base}/v1/campaigns/${campaignId}/leads`, {
      headers: h(), params: { limit: 1 }, timeout: 20000, validateStatus: () => true,
    }));
    if (r.status >= 300) { log.warn("sendkit campaign count failed", { campaignId, status: r.status }); return null; }
    return r.data?.pagination?.total ?? null;
  } catch (e) { log.warn("sendkit campaign count threw", { campaignId, err: e.message }); return null; }
}

// Live list of EVERY campaign in the SendKit workspace — so a campaign created directly in SendKit
// (not in our hardcoded CAMPAIGNS config) is still visible to the MCP / dashboard. Read-only.
export async function listCampaigns() {
  const out = [];
  let cursor = "";
  for (let i = 0; i < 30; i++) {
    const r = await withRetry(() => axios.get(`${base}/v1/campaigns`, {
      headers: h(), params: { limit: 100, ...(cursor ? { cursor } : {}) },
      timeout: 25000, validateStatus: () => true,
    }));
    if (r.status >= 300) { log.warn("sendkit list campaigns failed", { status: r.status, got: out.length }); break; }
    for (const c of (r.data?.data || [])) {
      out.push({ id: c._id, name: c.name, status: c.status, leads: c.leadsCount ?? c.totalLeads ?? null });
    }
    cursor = r.data?.pagination?.nextCursor || "";
    if (!cursor) break;
  }
  return out;
}

// Every member of a campaign, as SendKit records them: address, send status, and WHEN they were
// added. addedAt is the only honest source for "was this lead in the campaign before the audit" —
// our own dnc/verified flags were inflated by pushes that silently failed, so they can't answer it.
export async function campaignMembers(campaignId) {
  if (!campaignId) return [];
  const out = [];
  let cursor = "";
  for (let i = 0; i < 400; i++) {
    const r = await withRetry(() => axios.get(`${base}/v1/campaigns/${campaignId}/leads`, {
      headers: h(), params: { limit: 100, ...(cursor ? { cursor } : {}) },
      timeout: 30000, validateStatus: () => true,
    }));
    if (r.status >= 300) { log.warn("sendkit campaign members failed", { campaignId, status: r.status, got: out.length }); break; }
    for (const m of (r.data?.data || [])) {
      const email = String(m.leadId?.email || "").trim().toLowerCase();
      // m._id is the CAMPAIGN-LEAD record id (not the lead id) — the identifier removeFromCampaign needs.
      if (email) out.push({ email, campaignLeadId: m._id, status: m.status, addedAt: m.addedAt });
    }
    cursor = r.data?.pagination?.nextCursor || "";
    if (!cursor) break;
  }
  return out;
}

// Is this address blocked — either directly, or because its whole domain is?
export function isBlockedBy(dnc, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  if (dnc.emails?.has(e)) return true;
  const d = e.split("@")[1];
  return !!d && !!dnc.domains?.has(d);
}

// Bulk-upsert leads, 100 at a time (the /leads/bulk endpoint takes an array).
export async function upsertLeads(list = []) {
  let ok = 0, failed = 0;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    try {
      const r = await withRetry(() => axios.post(
        `${base}/v1/leads/bulk`,
        { skipDuplicates: false, leads: chunk.map((l) => ({ ...l, tags: l.tags })) },
        { headers: h(), timeout: 40000, validateStatus: () => true }
      ));
      if (r.status < 300) ok += chunk.length;
      else { failed += chunk.length; log.warn("sendkit bulk upsert failed", { status: r.status, body: JSON.stringify(r.data || {}).slice(0, 200) }); }
    } catch (e) { failed += chunk.length; log.warn("sendkit bulk upsert threw", { err: e.message }); }
  }
  return { ok, failed };
}

// Add many emails to one campaign, 100 at a time. SendKit answers {added, skipped}: "skipped"
// means the lead is ALREADY a member of that campaign — that's success, not a failure.
export async function addLeadsToCampaign(campaignId, emails = []) {
  if (!campaignId || !emails.length) return { added: 0, skipped: 0, failed: 0 };
  let added = 0, skipped = 0, failed = 0;
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    try {
      const r = await withRetry(() => axios.post(
        `${base}/v1/campaigns/${campaignId}/leads`,
        { leads: chunk.map((email) => ({ email })) },
        { headers: h(), timeout: 40000, validateStatus: () => true }
      ));
      if (r.status >= 300) {
        failed += chunk.length;
        log.warn("sendkit addLeadsToCampaign failed", { campaignId, n: chunk.length, status: r.status, body: JSON.stringify(r.data || {}).slice(0, 200) });
        continue;
      }
      added += r.data?.data?.added || 0;
      skipped += r.data?.data?.skipped || 0;
    } catch (e) {
      failed += chunk.length;
      log.warn("sendkit addLeadsToCampaign threw", { campaignId, err: e.message });
    }
  }
  return { added, skipped, failed };
}

// Remove leads from a campaign. `leadIds` are CAMPAIGN-LEAD record ids (the top-level `_id` from
// GET /campaigns/:id/leads — i.e. campaignMembers().campaignLeadId), NOT emails or lead ids.
// SendKit hard-deletes a lead that has had no email sent, and soft-deletes (status -> "removed",
// sending stops) one with send history. Batched by 100. Used by the campaign-dedup cleanup to
// pull a lead out of every campaign except the first one they were seen in.
export async function removeFromCampaign(campaignId, leadIds = []) {
  const ids = [...new Set((leadIds || []).filter(Boolean).map(String))];
  if (!campaignId || !ids.length) return { removed: 0, failed: 0 };
  let removed = 0, failed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const r = await withRetry(() => axios.post(
        `${base}/v1/campaigns/${campaignId}/leads/action`,
        { action: "remove", leadIds: chunk },
        { headers: h(), timeout: 40000, validateStatus: () => true }
      ));
      if (r.status >= 300) {
        failed += chunk.length;
        log.warn("sendkit removeFromCampaign failed", { campaignId, n: chunk.length, status: r.status, body: JSON.stringify(r.data || {}).slice(0, 200) });
        continue;
      }
      removed += r.data?.data?.modifiedCount ?? chunk.length;
    } catch (e) {
      failed += chunk.length;
      log.warn("sendkit removeFromCampaign threw", { campaignId, err: e.message });
    }
  }
  return { removed, failed };
}

// Single-lead add (used by the live /enrich path). A 2xx means the lead is in the campaign —
// either newly added, or "skipped" because they were already a member. Both are success.
export async function addToCampaign(campaignId, email) {
  if (!campaignId || !email) return false;
  try {
    const r = await withRetry(() => axios.post(
      `${base}/v1/campaigns/${campaignId}/leads`,
      { leads: [{ email }] },
      { headers: h(), timeout: 20000, validateStatus: () => true }
    ));
    if (r.status >= 300) {
      // Never swallow this — a silent failure here is a lead that shows as "verified" on the
      // dashboard but never actually reaches the SendKit campaign.
      log.warn("sendkit addToCampaign failed", {
        campaignId, email, status: r.status,
        body: typeof r.data === "string" ? r.data.slice(0, 200) : JSON.stringify(r.data || {}).slice(0, 200),
      });
      return false;
    }
    return true;
  } catch (e) {
    log.warn("sendkit addToCampaign threw", { campaignId, email, err: e.message });
    return false;
  }
}
