// Enrich.so: email validation (the deliverability gate).
// result is one of valid | invalid | risky; confidence definitive..none.
// Free on a miss. We treat only high-confidence "valid" as good.

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const ENDPOINT = "https://dev.enrich.so/api/v3/email-validation";
const LTE_ENDPOINT = "https://staging-v3-api.enrich.so/api/v3/linkedin-to-email";
const FINDER_ENDPOINT = "https://dev.enrich.so/api/v3/email-finder";

// Primary finder: name + company domain -> work email. Returns an already-verified
// mailbox when confidence is high (so we can skip a separate validation call).
export async function findEmailByNameDomain(firstName, lastName, domain) {
  if (!firstName || !lastName || !domain) return { found: false, email: null };
  try {
    const r = await axios.post(
      FINDER_ENDPOINT,
      { firstName, lastName, domain },
      { headers: { "x-api-key": config.enrichKey, "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true }
    );
    const d = r.data?.data;
    if (r.status === 200 && d?.found && d?.email) {
      const verified = d.confidence === "high" || /verified/i.test(d.message || "");
      return { found: true, email: d.email, confidence: d.confidence || null, verified };
    }
    return { found: false, email: null };
  } catch (e) {
    log.warn("enrich email-finder threw", { err: e.message });
    return { found: false, email: null };
  }
}

// Prospeo fallback: find an email straight from the LinkedIn URL.
// Single URL -> 200 (found) / 404 (not found). Staging branch, so best-effort — never throws.
export async function findEmailByLinkedin(linkedinUrl) {
  try {
    const r = await axios.post(
      LTE_ENDPOINT,
      { linkedinUrls: [linkedinUrl], skipEnrichment: false },
      {
        headers: { "x-api-key": config.enrichLteKey, "Content-Type": "application/json" },
        timeout: 20000,
        validateStatus: () => true,
      }
    );
    if (r.status === 200 && r.data?.success) {
      const email = r.data?.data?.email || null;
      return { found: !!email, email, source: r.data?.data?.source || "enrich" };
    }
    return { found: false, email: null }; // 404 not-found, 401/503, etc.
  } catch (e) {
    log.warn("enrich linkedin-to-email threw", { err: e.message });
    return { found: false, email: null };
  }
}

export async function validateEmail(email) {
  try {
    const r = await axios.post(
      ENDPOINT,
      { email },
      {
        headers: { "x-api-key": config.enrichKey, "Content-Type": "application/json" },
        timeout: 20000,
        validateStatus: () => true,
      }
    );
    const d = r.data?.data || {};
    const result = d.result || null; // valid | invalid | risky
    const confidence = d.confidence || null;
    const good =
      result === "valid" && ["definitive", "high", "medium"].includes(confidence);
    return { good, result, confidence, isCatchAll: !!d.isCatchAll };
  } catch (e) {
    log.warn("enrich validate threw", { err: e.message });
    return { good: false, result: "error", confidence: null, isCatchAll: false };
  }
}

// ── Reverse email lookup: email -> the person's LinkedIn profile ────────────────────────────────
// The opposite direction to everything above, and the only route from the Creator Programme extract
// (which ships emails and nothing social) into a LinkedIn identity we can score a creator on.
//
// 10 credits per hit; a miss is refunded, so a sweep only ever costs what it actually found.
//
// ⚠️ The API answers a MISS with HTTP 500 "Internal Server Error", not the 404 its own spec
// documents. Measured on a random stratified sample of 125 customers: 9 × 200, 116 × 500, and the
// same address that 500s here resolves fine through the SERP fallback — so a 500 is a not-found,
// not an outage. We therefore report it as `miss` rather than `error`, because retrying it would
// burn the whole base against a wall. If enrich.so ever fixes the status code this still works:
// a real 404 lands in the same branch.
const REVERSE_ENDPOINT = "https://dev.enrich.so/api/v3/reverse-lookup/lookup";

export async function reverseEmailLookup(email) {
  if (!email) return { ok: false, status: "miss" };
  try {
    const r = await axios.post(
      REVERSE_ENDPOINT,
      { email },
      { headers: { "x-api-key": config.enrichKey, "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true }
    );
    if (r.status === 404 || r.status === 500) return { ok: false, status: "miss" };
    if (r.status === 429) return { ok: false, status: "throttled" };
    if (r.status !== 200) return { ok: false, status: "error", detail: r.data?.title || String(r.status) };
    const d = r.data?.data;
    if (!d || !d.profileUrl) return { ok: false, status: "miss" };
    return {
      ok: true,
      status: "hit",
      profile: {
        li_url: normaliseLinkedin(d.profileUrl),
        li_name: d.displayName || [d.firstName, d.lastName].filter(Boolean).join(" ") || null,
        li_headline: d.headline || null,
        li_summary: d.summary || null,
        li_company: d.companyName || null,
        li_location: d.location || null,
        li_photo: d.photoUrl || null,
        // LinkedIn caps this at 500 and flags the cap in isConnectionCountObfuscated — so 500 means
        // "500 or more", NOT "exactly 500". Kept as a weak network-size hint only; real audience
        // size comes from the follower/post pass, which is a different (paid) call.
        li_connections: typeof d.connectionCount === "number" ? d.connectionCount : null,
        li_connections_capped: !!d.isConnectionCountObfuscated,
        li_public: d.isPublic !== false,
        li_skills: Array.isArray(d.skills) ? d.skills.slice(0, 25) : [],
      },
    };
  } catch (e) {
    log.warn("enrich reverse-lookup threw", { err: e.message });
    return { ok: false, status: "error", detail: e.message };
  }
}

// linkedin.com/in/<vanity> in one shape, so a profile resolved by enrich.so and the same profile
// resolved by the SERP fallback dedupe against each other instead of landing as two people.
export function normaliseLinkedin(url = "") {
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${m[1].toLowerCase()}` : null;
}

// Role-based inboxes never reply — reject locally (Enrich.so doesn't flag these).
const ROLE = new Set([
  "info", "sales", "support", "admin", "hello", "contact", "team", "hi",
  "no-reply", "noreply", "billing", "help", "office", "mail", "marketing",
]);
export function isRoleBased(email = "") {
  const local = email.split("@")[0]?.toLowerCase() || "";
  return ROLE.has(local);
}
