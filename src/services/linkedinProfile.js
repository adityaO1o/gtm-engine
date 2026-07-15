// Paid LinkedIn profile lookup (RapidAPI). Used as a LAST-RESORT company getter: when we've
// resolved a person to a vanity URL but still have no employer (their headline had none and the
// SERP snippet didn't expose one), this returns their current company + often the company domain
// directly — which unlocks the name+domain email path.
//
// Cost control: only ever called when the free paths (headline, SERP snippet) failed AND we have
// a real vanity URL — so it fires on a minority of leads, not every one.

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

let outOfQuota = false; // 429/402/403 -> stop calling for the rest of the run
const stats = { calls: 0, hits: 0, quota: 0 };
export function linkedinProfileStats() { return { ...stats, outOfQuota }; }

// The exact JSON shape varies by provider, so pull company + domain from any of the common
// field names / nesting these APIs use.
function pickCompany(d) {
  const cands = [
    d?.company, d?.company_name, d?.current_company, d?.current_company_name,
    d?.experiences?.[0]?.company, d?.experience?.[0]?.company,
    d?.data?.company, d?.data?.company_name, d?.position, d?.occupation,
    d?.current_company?.name, d?.company?.name,
  ];
  const c = cands.find((x) => typeof x === "string" && x.trim().length > 1);
  return c ? c.trim() : null;
}
function pickDomain(d) {
  const cands = [
    d?.company_domain, d?.company_website, d?.website, d?.current_company?.website,
    d?.company?.domain, d?.company?.website, d?.data?.company_domain,
    d?.experiences?.[0]?.company_domain,
  ];
  for (const v of cands) {
    if (typeof v === "string" && v.includes(".")) {
      const m = v.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
      if (/\.[a-z]{2,}$/i.test(m)) return m.toLowerCase();
    }
  }
  return null;
}

// -> { company, domain } | null
export async function profileCompany(linkedinUrl) {
  if (!config.linkedinApiKey || outOfQuota || !linkedinUrl) return null;
  try {
    stats.calls++;
    const r = await axios.get(`https://${config.linkedinApiHost}/get-linkedin-profile`, {
      params: { linkedin_url: linkedinUrl },
      headers: { "x-rapidapi-host": config.linkedinApiHost, "x-rapidapi-key": config.linkedinApiKey },
      timeout: 25000, validateStatus: () => true,
    });
    if (r.status === 402 || r.status === 403 || r.status === 429) {
      outOfQuota = true; stats.quota++;
      log.warn("linkedin profile api quota/subscription — disabling for this run", { status: r.status });
      return null;
    }
    if (r.status !== 200) { log.warn("linkedin profile api non-200", { status: r.status }); return null; }
    const body = r.data?.data || r.data || {};
    const company = pickCompany(body);
    const domain = pickDomain(body);
    if (company || domain) { stats.hits++; return { company, domain }; }
    return null;
  } catch (e) {
    log.warn("linkedin profile api threw", { err: e.message });
    return null;
  }
}
