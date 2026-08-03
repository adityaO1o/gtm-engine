// Prefix/suffix/TLD permutation generator for the domain-prospecting scan. Companies that run cold
// email typically own a handful of ALT domains purely for sending (never browsed, just redirect back
// to the real site once opened) — this generates the plausible candidates for a seed domain so the
// pipeline can find out which ones are actually live + redirecting + blacklisted.
//
// Calibrated against TWO real reverse-redirect samples (host.io's "domains redirecting to X" for
// both inboxkit.com and numeral.com), not guessed. They disagree with each other in an important
// way, and the numeral.com sample is the one that generalizes:
//   - inboxkit.com's sample was ~100% .com, single prefix+suffix. The FIRST version of this file was
//     tuned on that alone and only matched 148/557 of numeral.com's real redirecting domains — TLD
//     variety (.co/.io/.app/.info all appear heavily for numeral.com) and CHAINED suffixes
//     ("searchnumeralhqservice.co" = search + numeral + hq + service, three words after the brand)
//     turned out to be real, common patterns this file was blind to. Single-company samples overfit;
//     don't tune further on just one without checking it against another.
//   - A meaningful slice of any real sample (~10% in both cases) doesn't contain the brand name as a
//     substring at all (e.g. "newsamrossgroupbrand.co", "numroll.com") — a shared third-party
//     redirect-vendor's own naming, or pure coincidence. No permutation approach can find these; only
//     a crawled reverse-index (what host.io actually sells) can. That's a hard ceiling here, not a bug.

const PREFIXES = [
  "ignite", "ultra", "go", "sky", "easy", "global", "glide", "promote", "click", "true", "hello",
  "fast", "direct", "outreach", "bright", "mailhub", "try", "all", "power", "hyper", "share",
  "boost", "hi", "email", "grow", "clear", "pure", "skyhigh", "funnel", "spark", "join", "vivid",
  "express", "lead", "peak",
  "swift", "prime", "elite", "apex", "nova", "zen", "core", "next", "flow", "reach", "scale",
  "wave", "sync", "pulse", "quick", "launch", "smart", "top", "max", "one", "rapid", "rocket",
  "dash", "flash", "instant", "ace", "star", "gold", "super", "turbo", "crisp", "keen", "agile",
  "fresh", "live", "active",
  // from the numeral.com sample: know/why/run/search/join/start/at/your/do/reaching/think/lets/
  // drive/use/with/the/sending/emailing/projects/get all appear as the FIRST word of a real domain.
  "know", "why", "run", "search", "start", "at", "your", "do", "reaching", "think", "lets", "drive",
  "use", "with", "the", "sending", "emailing", "projects", "own", "get",
];
// Curated subset for the lighter TLDs (io/app/info/net) — those are a secondary tier, so they use
// the highest-signal prefixes rather than the full list, to keep the candidate count proportionate.
const LIGHT_TLD_PREFIXES = [
  "try", "get", "go", "hello", "your", "search", "start", "join", "use", "do", "at", "true", "grow",
  "clear", "pure", "spark", "smart", "quick", "launch", "reach", "boost", "share", "direct", "fast", "sky",
];
// Natural two-word phrases seen verbatim in the numeral.com sample (whynumeral, letsgonumeral,
// jointhenumeral, trynumeralhq...) — cheaper to list literally than to cross every word pair.
const PHRASE_PREFIXES = ["whyuse", "letsgo", "jointhe", "trythe", "getthe", "gojoin", "dothe"];

// The original, smaller, real-observed core — used for the wider TLD sweep below to keep that
// tier's size sane (full SUFFIXES x every TLD would be excessive).
const CORE_SUFFIXES = [
  "ai", "hq", "setup", "inc", "web", "labs", "zone", "bridge", "mail", "app", "co", "team", "now",
  "send", "pro", "group", "online", "hub", "suite", "cloud",
];
const SUFFIXES = [
  ...CORE_SUFFIXES,
  "tech", "base", "works", "spot", "link", "edge", "core", "kit",
  // from the numeral.com sample: suite/hub/link/growth/ledger/solutions/solution/service/services/
  // filing/vision/ecom/desk/results/engage/site/path/dashboard/find/outreach.
  "growth", "ledger", "solutions", "solution", "service", "services", "filing", "vision", "ecom",
  "desk", "results", "engage", "site", "path", "dashboard", "find", "outreach",
];
// A smaller set used as the SECOND suffix in "prefix + brand + hq + X" chains (numeralhqgrowth,
// searchnumeralhqservice, thenumeralhqecom, numeralhqsolutionprojects...) — "hq" is overwhelmingly
// the most common bridge word in the real sample, so this tier keys off it specifically rather than
// crossing every suffix pair (which would blow the candidate count up 40x for little extra signal).
const CHAIN_PREFIXES = ["get", "try", "search", "sending", "reaching", "emailing", "go", "the", "your", "hello", "projects"];

const SEND_SUBDOMAINS = [
  "mail", "smtp", "send", "email", "outbound", "outreach", "campaign", "mg", "em", "hello", "news",
  "noreply", "notifications", "newsletter", "contact",
];
// TLD variety turned out to be real and common (not the minor tier the inboxkit.com-only sample
// suggested) — .co/.io/.app/.info all show up repeatedly for numeral.com. .com and .co get the full
// combined prefix+suffix treatment (both are heavily represented); the rest get the lighter
// prefix-alone/suffix-alone tiers to keep the candidate count sane.
const MAIN_TLDS = ["com", "co"];
const LIGHT_TLDS = ["io", "app", "info", "net"];
const RARE_TLDS = ["org", "ai", "us", "site"];

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

// seedDomain -> ~6000-7000 deduped candidate domains (never includes the seed itself)
export function generateCandidates(seedInput) {
  const { label, tld } = splitDomain(seedInput);
  if (!label) return [];
  const seedDomain = `${label}.${tld}`;
  const out = new Set();
  const allPrefixes = [...PREFIXES, ...PHRASE_PREFIXES];
  const altTlds = [...MAIN_TLDS, ...LIGHT_TLDS, ...RARE_TLDS].filter((t) => t !== tld);

  // Dominant tier: prefix + brand + suffix COMBINED, both hyphenated and not. The real samples show
  // no-hyphen isn't actually limited to short words (projectsnumeralservice.co, getnumeralfiling.co,
  // boostnumeralengage.co are all long combos with no hyphen) — an earlier "only if short" heuristic
  // here was wrong and silently dropped real patterns. .com/.co get the full wordlist; the lighter
  // TLDs get the smaller CORE_SUFFIXES set to keep their contribution proportionate.
  for (const t of MAIN_TLDS) {
    for (const p of allPrefixes) {
      for (const s of SUFFIXES) {
        out.add(`${p}${label}-${s}.${t}`);
        out.add(`${p}${label}${s}.${t}`);
      }
    }
  }
  for (const t of LIGHT_TLDS) {
    for (const p of LIGHT_TLD_PREFIXES) {
      for (const s of CORE_SUFFIXES) {
        out.add(`${p}${label}-${s}.${t}`);
        out.add(`${p}${label}${s}.${t}`);
      }
    }
  }

  // Chained suffix tier: prefix? + brand + hq + suffix2 (searchnumeralhqservice.co, numeralhqgrowth.com...).
  for (const t of MAIN_TLDS) {
    for (const s2 of SUFFIXES) {
      out.add(`${label}hq${s2}.${t}`);
      out.add(`${label}-hq-${s2}.${t}`);
      for (const p of CHAIN_PREFIXES) out.add(`${p}${label}hq${s2}.${t}`);
    }
  }

  // Prefix alone (no suffix), across every TLD tier — whynumeral.com, runnumeral.info, donumeral.co...
  for (const p of allPrefixes) for (const t of [...MAIN_TLDS, ...LIGHT_TLDS]) out.add(`${p}${label}.${t}`);

  // Suffix alone (no prefix), across every TLD tier — numeralsuite.com, numeral-hq.co, numeraldesk.info...
  for (const s of SUFFIXES) {
    for (const t of [...MAIN_TLDS, ...LIGHT_TLDS]) {
      out.add(`${label}-${s}.${t}`);
      out.add(`${label}${s}.${t}`);
    }
  }

  // Send-subdomains on the real seed domain.
  for (const sub of SEND_SUBDOMAINS) out.add(`${sub}.${seedDomain}`);

  // Bare brand on every other TLD.
  for (const t of altTlds) out.add(`${label}.${t}`);

  out.delete(seedDomain);
  return [...out];
}
