// Prospeo: find a work email, and verify an email.
//
// The critical quirk: Prospeo returns HTTP 400 with {error_code:"NO_MATCH"} when the
// person simply isn't in its database. That's a normal outcome, not a failure — so we
// swallow it and return a clean {found:false}. (Trigify's raw http node couldn't do this;
// it treated every 400 as fatal and killed the whole run. This module is why the engine exists.)

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const ENDPOINT = "https://api.prospeo.io/enrich-person";
const headers = () => ({ "X-KEY": config.prospeoKey, "Content-Type": "application/json" });

async function call(dataObj) {
  const r = await axios.post(
    ENDPOINT,
    { only_verified_email: false, data: dataObj },
    { headers: headers(), timeout: 20000, validateStatus: () => true }
  );
  return r;
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
  try {
    const r = await call(ids);
    if (r.status === 200 && r.data && r.data.error === false) {
      return extract(r.data);
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
