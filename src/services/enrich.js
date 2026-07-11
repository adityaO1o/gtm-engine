// Enrich.so: email validation (the deliverability gate).
// result is one of valid | invalid | risky; confidence definitive..none.
// Free on a miss. We treat only high-confidence "valid" as good.

import axios from "axios";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const ENDPOINT = "https://dev.enrich.so/api/v3/email-validation";

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
