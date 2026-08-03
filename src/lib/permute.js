// Prefix/suffix/TLD permutation generator for the domain-prospecting scan. Companies that run cold
// email typically own a handful of ALT domains purely for sending (never browsed, just redirect back
// to the real site once opened) — this generates the plausible candidates for a seed domain so the
// pipeline can find out which ones are actually live + redirecting + blacklisted.
//
// Wordlists + weighting below are calibrated against a real reverse-redirect sample (host.io's list
// of 557 domains actually redirecting into inboxkit.com) rather than guessed:
//   - almost every real one is .com — orgs barely vary TLD, so that tier is now small/secondary
//     (was previously the single biggest tier — backwards)
//   - the dominant real pattern is PREFIX + brand + SUFFIX COMBINED on the same domain
//     ("ignite" + "inboxkit" + "-ai" -> ignitedinboxkit-ai.com), almost always hyphenated before the
//     suffix. The old generator only ever did prefix-OR-suffix, never both together — that was the
//     single biggest gap vs what real cold-email infra domains look like.

// Drawn directly from the real observed pattern (ignite/ultra/go/sky/easy/global/glide/promote/
// click/true/hello/fast/direct/outreach/bright/mailhub/try/all/power/hyper/share/boost/hi/email/
// grow/clear/pure/skyhigh/funnel/spark/join/vivid/express/lead/peak all appear in the sample).
const PREFIXES = [
  "ignite", "ultra", "go", "sky", "easy", "global", "glide", "promote", "click", "true", "hello",
  "fast", "direct", "outreach", "bright", "mailhub", "try", "all", "power", "hyper", "share",
  "boost", "hi", "email", "grow", "clear", "pure", "skyhigh", "funnel", "spark", "join", "vivid",
  "express", "lead", "peak",
];
// "-ai/-hq/-setup/-inc/-web/-labs/-zone/-bridge" are all in the real sample; the rest are the same
// family of words (kept from the original list since they fit the same pattern).
const SUFFIXES = [
  "ai", "hq", "setup", "inc", "web", "labs", "zone", "bridge", "mail", "app", "co", "team", "now",
  "send", "pro", "group", "online", "hub", "suite", "cloud",
];
const SEND_SUBDOMAINS = [
  "mail", "smtp", "send", "email", "outbound", "outreach", "campaign", "mg", "em", "hello", "news",
  "noreply", "notifications", "newsletter", "contact",
];
// Orgs rarely swap TLD on their brand name (the real sample is ~100% .com) — kept as a small tier,
// not the dominant one.
const RARE_TLDS = ["io", "co", "net", "org", "in", "ai"];

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

// seedDomain -> ~700-900 deduped candidate domains (never includes the seed itself)
export function generateCandidates(seedInput) {
  const { label, tld } = splitDomain(seedInput);
  if (!label) return [];
  const seedDomain = `${label}.${tld}`;
  const out = new Set();

  // Dominant tier: prefix + brand + suffix COMBINED, hyphenated, .com — the real-world pattern.
  // PREFIXES x SUFFIXES already lands ~700, i.e. most of the budget, on purpose.
  for (const p of PREFIXES) {
    for (const s of SUFFIXES) {
      out.add(`${p}${label}-${s}.com`);
      // Non-hyphenated only reads naturally when both words are short (matches the real sample:
      // peakinboxkithq.com, tryinboxkithq.com, pureinboxkithq.com — all short+short).
      if (p.length + s.length <= 7) out.add(`${p}${label}${s}.com`);
    }
  }

  // Prefix alone (no suffix) — also seen for real (hiinboxkit.com, growinboxkit.com).
  for (const p of PREFIXES) out.add(`${p}${label}.com`);

  // Suffix alone (no prefix) — also seen for real (inboxkitzone.com, inboxkitbridge.com).
  for (const s of SUFFIXES) {
    out.add(`${label}-${s}.com`);
    out.add(`${label}${s}.com`);
  }

  // Send-subdomains on the real seed domain.
  for (const sub of SEND_SUBDOMAINS) out.add(`${sub}.${seedDomain}`);

  // Small TLD-swap tier — kept minor since real orgs rarely do this.
  for (const t of RARE_TLDS) if (t !== tld) out.add(`${label}.${t}`);

  out.delete(seedDomain);
  return [...out];
}
