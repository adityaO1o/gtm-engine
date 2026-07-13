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

export async function addToCampaign(campaignId, email) {
  if (!campaignId || !email) return false;
  try {
    const r = await axios.post(
      `${base}/v1/campaigns/${campaignId}/leads`,
      { leads: [{ email }] },
      { headers: h(), timeout: 20000, validateStatus: () => true }
    );
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
