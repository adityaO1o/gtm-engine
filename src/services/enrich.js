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

// Role-based inboxes never reply — reject locally (Enrich.so doesn't flag these).
const ROLE = new Set([
  "info", "sales", "support", "admin", "hello", "contact", "team", "hi",
  "no-reply", "noreply", "billing", "help", "office", "mail", "marketing",
]);
export function isRoleBased(email = "") {
  const local = email.split("@")[0]?.toLowerCase() || "";
  return ROLE.has(local);
}
