// Free company-name -> domain resolver (Clearbit autocomplete — public, no key).
// Powers the Enrich/Prospeo "name + domain" email paths. Cached 24h in-process.
//
// GUARD: Clearbit is a best-effort GUESS — "Refine Labs" can come back as "Refine Restaurant"
// (refine.co), a different company. companyDomainGuarded() cross-checks Clearbit's returned
// company NAME against the name we searched for and REJECTS a mismatch, so we never build an
// email on a wrong company's domain. It also hands back alternate suggestions for the retry pass.

import axios from "axios";
import { log } from "../lib/logger.js";
import { meter } from "./apiMeter.js";

const cache = new Map(); // lowercased name -> { at, top: { name, domain, all:[{name,domain}] } | null }
const DAY = 24 * 3600 * 1000;

// Fetch (cached) Clearbit's top suggestion + up to 5 alternates for a company name.
async function suggestTop(name) {
  const key = name.toLowerCase().trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit.top;
  let top = null;
  try {
    meter.inc("clearbit_calls");
    const r = await axios.get("https://autocomplete.clearbit.com/v1/companies/suggest", {
      params: { query: name }, timeout: 12000, validateStatus: () => true,
    });
    if (Array.isArray(r.data) && r.data[0]?.domain) {
      top = {
        name: r.data[0].name || name,
        domain: r.data[0].domain,
        all: r.data.slice(0, 5).map((x) => ({ name: x.name, domain: x.domain })).filter((x) => x.domain),
      };
    }
  } catch (e) {
    log.warn("clearbit threw", { err: e.message });
  }
  cache.set(key, { at: Date.now(), top });
  return top;
}

// Back-compat: ungated top domain (still used where a guess is acceptable / already trusted).
export async function companyDomain(name) {
  if (!name) return null;
  const top = await suggestTop(name);
  return top?.domain || null;
}

// Token overlap between the name we searched for and the name Clearbit returned. Legal suffixes
// are dropped; "Refine Labs" vs "Refine Labs" -> 1.0 (accept), vs "Refine Restaurant" -> 0.5.
const STOP = new Set(["inc", "llc", "ltd", "co", "corp", "corporation", "company", "the", "group", "holdings", "gmbh", "plc", "limited", "and"]);
const toks = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
export function companyNameMatches(searched, returned) {
  const a = toks(searched), b = new Set(toks(returned));
  if (!a.length || !b.size) return true;   // can't judge -> don't block
  const hit = a.filter((t) => b.has(t)).length;
  return hit / a.length >= 0.6;
}

// Guarded name -> domain. -> { domain, rejected, name?, candidate?, alts:[domain] }
//   domain    : accepted work domain, or null
//   rejected  : true when Clearbit returned a DIFFERENT company (guard blocked it)
//   candidate : the rejected domain (for logging/visibility)
//   alts      : alternate domains Clearbit suggested (used by the unverified retry pass)
export async function companyDomainGuarded(name) {
  if (!name) return { domain: null, rejected: false, alts: [] };
  const top = await suggestTop(name);
  if (!top?.domain) return { domain: null, rejected: false, alts: [] };
  const alts = (top.all || []).map((x) => x.domain).filter(Boolean);
  if (!companyNameMatches(name, top.name)) {
    meter.inc("clearbit_rejects");
    log.info("clearbit guard rejected", { searched: name, got: top.name, domain: top.domain });
    return { domain: null, rejected: true, candidate: top.domain, alts };
  }
  return { domain: top.domain, rejected: false, name: top.name, alts };
}
