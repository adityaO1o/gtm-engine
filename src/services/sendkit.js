// SendKit: the sending platform. We look a lead up (scoped to our own gtm-auto tag so
// the 112k legacy leads stay invisible), upsert them with fresh tags, and add them to a campaign.

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

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

export async function upsertLead(lead) {
  // lead: {email, firstName, lastName, companyName, jobTitle, linkedinUrl, tags:[...] }
  try {
    // tags must be an ARRAY here — the bulk endpoint stores a comma-string as a single literal tag
    const r = await axios.post(
      `${base}/v1/leads/bulk`,
      { skipDuplicates: false, leads: [{ ...lead, tags: lead.tags }] },
      { headers: h(), timeout: 20000, validateStatus: () => true }
    );
    return r.status < 300;
  } catch (e) {
    log.warn("sendkit upsert threw", { err: e.message });
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
