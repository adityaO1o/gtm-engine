// Prospeo: find a work email, and verify an email.
//
// The critical quirk: Prospeo returns HTTP 400 with {error_code:"NO_MATCH"} when the
// person simply isn't in its database. That's a normal outcome, not a failure — so we
// swallow it and return a clean {found:false}. (Trigify's raw http node couldn't do this;
// it treated every 400 as fatal and killed the whole run. This module is why the engine exists.)

import axios from "axios";
import { config } from "../config.js";
import { meter } from "./apiMeter.js";
import { log } from "../lib/logger.js";

const ENDPOINT = "https://api.prospeo.io/enrich-person";
const headers = () => ({ "X-KEY": config.prospeoKey, "Content-Type": "application/json" });

async function call(dataObj) {
  // routed through the shared spacer + 429-retry so enrich (email reveal) also can't burst the API
  return prospeoPost(ENDPOINT, { only_verified_email: false, data: dataObj });
}

function extract(body) {
  const person = body?.person;
  const email = person?.email?.email || null;
  return {
    found: !!email,
    email,
    email_status: person?.email?.status || null, // VERIFIED | UNAVAILABLE
    company_name: body?.company?.name || null,
    company_domain: body?.company?.domain || null,
    prospeo_id: person?.person_id || null,
  };
}

// Find an email. Pass whatever identifiers you have; more = higher match rate.
// { linkedin_url } for commenters/resolved likers; { first_name,last_name,company_domain } as fallback.
export async function findEmail(ids) {
  meter.inc("prospeo_calls");
  try {
    const r = await call(ids);
    if (r.status === 200 && r.data && r.data.error === false) {
      const out = extract(r.data);
      if (out.found) meter.inc("prospeo_finds");
      return out;
    }
    // 400 NO_MATCH / INVALID_DATAPOINTS, or any non-200 => treat as "not found", never throw
    const code = r.data?.error_code || `http_${r.status}`;
    return { found: false, email: null, email_status: null, company_name: null, company_domain: null, error_code: code };
  } catch (e) {
    log.warn("prospeo find threw", { err: e.message });
    return { found: false, email: null, error_code: "exception" };
  }
}

// Live Prospeo credit balance for the dashboard (cached 5 min). remaining/used.
let balCache = { at: 0, data: null };
export async function prospeoBalance() {
  if (balCache.data && Date.now() - balCache.at < 5 * 60_000) return balCache.data;
  try {
    const r = await axios.post(
      "https://api.prospeo.io/account-information",
      {},
      { headers: headers(), timeout: 15000, validateStatus: () => true }
    );
    const d = r.data?.response;
    if (d) balCache = { at: Date.now(), data: { used: +d.used_credits, remaining: +d.remaining_credits } };
  } catch (e) {
    log.warn("prospeo balance threw", { err: e.message });
  }
  return balCache.data;
}

// ── Stage 4: find PEOPLE at a company (domain -> list of persons + roles) ──────────────────────
// Prospeo /search-person: filter by company website, get up to 25 people/page with name, title,
// seniority, department. Emails are MASKED here (revealing them needs a separate enrich-person call
// per person — deferred to the send step to save credits). Costs 1 credit per search that returns
// at least one person; a repeat of the same query within 30 days is free (marked `free:true`).
const SEARCH_ENDPOINT = "https://api.prospeo.io/search-person";

const pick = (...vals) => vals.find((v) => v != null && v !== "") ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared spacer across ALL Prospeo calls (search + enrich) so a big campaign doesn't burst the API
// and trip its plan rate limit — the reason a 30-seed run came back with 0 contacts and
// "Rate limit exceeded" while the 20-seed run was fine. ~700ms ≈ 85/min, under typical plan caps.
const PROSPEO_MIN_GAP_MS = parseInt(process.env.PROSPEO_MIN_GAP_MS || "700", 10);
let prospeoNextSlot = 0;
async function prospeoSlot() {
  const now = Date.now();
  const wait = Math.max(0, prospeoNextSlot - now);
  prospeoNextSlot = Math.max(now, prospeoNextSlot) + PROSPEO_MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
}

// POST to Prospeo with the shared spacer + retry on 429 (rate limit) with exponential backoff.
async function prospeoPost(url, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await prospeoSlot();
    const r = await axios.post(url, body, { headers: headers(), timeout: 25000, validateStatus: () => true });
    if (r.status !== 429) return r;
    const backoff = 1500 * 2 ** attempt; // 1.5s, 3s, 6s, 12s
    log.warn("prospeo 429 — backing off", { url: url.split("/").pop(), attempt, backoff });
    await sleep(backoff);
  }
  // one final attempt result (still 429) is returned so the caller surfaces the error
  await prospeoSlot();
  return axios.post(url, body, { headers: headers(), timeout: 25000, validateStatus: () => true });
}

function extractPerson(row) {
  const p = row?.person || row || {};
  const first = pick(p.first_name, p.firstName);
  const last = pick(p.last_name, p.lastName);
  const name = pick(p.full_name, p.name, [first, last].filter(Boolean).join(" ") || null);
  return {
    prospeo_id: pick(p.person_id, p.id, p.oid),
    name,
    first_name: first,
    last_name: last,
    job_title: pick(p.job_title, p.title, p.headline),
    seniority: pick(p.seniority, p.person_seniority),
    department: pick(p.department, p.person_department),
    linkedin_url: pick(p.linkedin_url, p.linkedin, p.linkedinUrl),
  };
}

// searchPeople(domain, { page }) -> { people, total, free, error } (emails NOT included — masked).
export async function searchPeople(domain, { page = 1 } = {}) {
  const site = String(domain || "").trim().toLowerCase();
  if (!site) return { people: [], total: 0, error: "no domain" };
  meter.inc("prospeo_search_calls");
  try {
    const r = await prospeoPost(SEARCH_ENDPOINT, { page, filters: { company: { websites: { include: [site] } } } });
    if (r.status !== 200 || r.data?.error) {
      const code = r.data?.error_code || `http_${r.status}`;
      // NO_MATCH / no results is normal — return empty, never throw.
      return { people: [], total: 0, free: !!r.data?.free, error: code };
    }
    const rows = r.data?.results || [];
    return {
      people: rows.map(extractPerson).filter((x) => x.name || x.prospeo_id),
      total: r.data?.pagination?.total_count ?? rows.length,
      totalPages: r.data?.pagination?.total_page ?? 1,
      free: !!r.data?.free,
      error: null,
    };
  } catch (e) {
    log.warn("prospeo search threw", { domain: site, err: e.message });
    return { people: [], total: 0, error: "exception" };
  }
}

// Verify an existing email. Prospeo echoes person.email.status = VERIFIED when deliverable.
export async function verifyEmail(email) {
  try {
    const r = await call({ email });
    const status = r.data?.person?.email?.status || null;
    return { ok: status === "VERIFIED", status: status || `http_${r.status}` };
  } catch (e) {
    return { ok: false, status: "exception" };
  }
}
