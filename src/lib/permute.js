// Prefix/suffix/TLD permutation generator for the domain-prospecting scan. Companies that run cold
// email typically own a handful of ALT domains purely for sending (never browsed, just redirect back
// to the real site once opened) — this generates the plausible candidates for a seed domain so the
// pipeline can find out which ones are actually live + redirecting + blacklisted.

const TLDS = [
  "io", "co", "net", "org", "us", "email", "app", "dev", "xyz", "site", "online", "info", "biz",
  "me", "cc", "pro", "agency", "group", "team", "hq", "inc", "in", "ai", "cloud", "tech",
];
// Smaller set for the heavier prefix/suffix x TLD cross product — keeps total candidates in the
// ~500-1000 sweet spot instead of exploding into the tens of thousands.
const CORE_TLDS = ["com", "io", "co", "net", "app", "mail", "email", "org", "xyz", "online"];

const SEND_SUBDOMAINS = [
  "mail", "smtp", "send", "email", "outbound", "outreach", "campaign", "mg", "em", "go", "link",
  "click", "hello", "news", "updates", "info", "noreply", "no-reply", "notifications", "newsletter",
  "alerts", "account", "accounts", "contact", "support",
];
const BRAND_PREFIXES = [
  "get", "try", "use", "hi", "hey", "go", "the", "my", "join", "we", "team", "meet", "hello",
  "start", "choose", "with",
];
const BRAND_SUFFIXES = [
  "hq", "app", "mail", "inc", "co", "team", "now", "labs", "send", "pro", "group", "io", "online",
  "hub", "suite", "cloud",
];

const TWO_PART_TLDS = new Set(["co.in", "co.uk", "com.au", "co.nz", "com.br", "co.za"]);

// "https://www.acme.co.in/pricing" -> { label: "acme", tld: "co.in" }
export function splitDomain(input) {
  const clean = String(input || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].split(":")[0];
  const parts = clean.split(".").filter(Boolean);
  if (parts.length < 2) return { label: clean, tld: "" };
  const lastTwo = parts.slice(-2).join(".");
  if (parts.length >= 3 && TWO_PART_TLDS.has(lastTwo)) {
    return { label: parts.slice(0, -2).join("."), tld: lastTwo };
  }
  return { label: parts.slice(0, -1).join("."), tld: parts[parts.length - 1] };
}

// seedDomain -> ~500-1000 deduped candidate domains (never includes the seed itself)
export function generateCandidates(seedInput) {
  const { label, tld } = splitDomain(seedInput);
  if (!label) return [];
  const seedDomain = `${label}.${tld}`;
  const out = new Set();

  for (const t of TLDS) if (t !== tld) out.add(`${label}.${t}`);
  for (const sub of SEND_SUBDOMAINS) out.add(`${sub}.${seedDomain}`);
  for (const p of BRAND_PREFIXES) {
    for (const t of CORE_TLDS) {
      out.add(`${p}${label}.${t}`);
      out.add(`${p}-${label}.${t}`);
    }
  }
  for (const s of BRAND_SUFFIXES) {
    for (const t of CORE_TLDS) {
      out.add(`${label}${s}.${t}`);
      out.add(`${label}-${s}.${t}`);
    }
  }

  out.delete(seedDomain);
  return [...out];
}
