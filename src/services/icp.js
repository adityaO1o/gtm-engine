// ── Non-ICP exclusion ────────────────────────────────────────────────────────────────────────
// Big companies whose employees are NOT prospects for InboxKit — they don't buy cold-email sending
// infrastructure. Applied in TWO places:
//   1. engagement scraper — an engager at one of these is SAVED but never sent (like a competitor)
//      and pinned to status "cold" so they don't pollute the hot/warm working set.
//   2. blacklist campaign — a seed domain on this list is dropped before it costs any credits.
//
// EDIT THESE LISTS freely — one brand or domain per entry, lowercase. Brand matching is WHOLE-WORD
// (so "ola" matches a company literally named "Ola", not "Nikola"); multi-word brands are matched as
// a substring. Domain matching is exact on the email/seed domain.

export const NON_ICP_BRANDS = new Set([
  // global big tech
  "google", "alphabet", "youtube",
  "microsoft", "azure", "linkedin", "github",
  "amazon", "aws", "amazon web services",
  "meta", "facebook", "instagram", "whatsapp",
  "apple", "oracle", "salesforce", "sap", "ibm", "adobe", "intel", "nvidia",
  "cisco", "dell", "hp", "hewlett packard", "netflix", "uber", "paypal", "stripe",
  // retail / other giants
  "flipkart", "walmart",
  // Indian IT services & consulting
  "tcs", "tata consultancy", "infosys", "wipro", "hcl", "hcltech", "tech mahindra",
  "cognizant", "accenture", "capgemini", "deloitte", "kpmg", "pwc", "ernst young",
  // Indian conglomerates & unicorns
  "reliance", "jio", "tata", "adani", "paytm", "zomato", "swiggy", "ola", "byju", "byjus",
  // major banks / financial institutions — employees don't buy cold-email infra (foreign + domestic).
  // Generic "bank" / "banco" / "banque" are handled by NON_ICP_KEYWORDS below; these catch the
  // one-word names that don't contain "bank".
  "jpmorgan", "chase", "citi", "citibank", "citigroup", "hsbc", "barclays", "goldman sachs",
  "morgan stanley", "wells fargo", "bank of america", "deutsche bank", "ubs", "credit suisse",
  "standard chartered", "bnp paribas", "santander", "natwest", "lloyds", "scotiabank", "nomura",
  "mizuho", "macquarie", "capital one", "american express", "amex", "hdfc", "icici", "axis bank",
  "kotak", "yes bank", "state bank of india", "sbi", "punjab national", "revolut", "monzo",
]);

// Whole-word keywords: if any word of the company name matches, it's out of ICP. Kept separate so
// broad categories (any bank) don't need every institution enumerated. Whole-word only, so "bank"
// matches "HSBC Bank" but not "DataBank".
export const NON_ICP_KEYWORDS = new Set(["bank", "banco", "banque", "bancorp"]);

export const NON_ICP_DOMAINS = new Set([
  "google.com", "youtube.com", "alphabet.com",
  "microsoft.com", "azure.com", "linkedin.com", "github.com",
  "amazon.com", "aws.amazon.com", "amazon.in",
  "meta.com", "facebook.com", "instagram.com", "whatsapp.com",
  "apple.com", "oracle.com", "salesforce.com", "sap.com", "ibm.com", "adobe.com",
  "intel.com", "nvidia.com", "cisco.com", "dell.com", "hp.com", "netflix.com",
  "uber.com", "paypal.com", "stripe.com",
  "flipkart.com", "walmart.com",
  "tcs.com", "infosys.com", "wipro.com", "hcl.com", "hcltech.com", "techmahindra.com",
  "cognizant.com", "accenture.com", "capgemini.com", "deloitte.com", "kpmg.com", "pwc.com", "ey.com",
  "reliance.com", "ril.com", "jio.com", "tata.com", "adani.com",
  "paytm.com", "zomato.com", "swiggy.com", "olacabs.com", "byjus.com",
]);

// Is this person's employer out of our ICP? Match by email domain (exact) or company name (whole-word
// for single-word brands, substring for multi-word ones — avoids "ola" catching "Nikola").
export function isOutOfIcp({ company = "", emailDomain = "" } = {}) {
  const d = (emailDomain || "").toLowerCase().trim();
  if (d && NON_ICP_DOMAINS.has(d)) return true;

  const words = (company || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const full = words.join(" ");
  for (const b of NON_ICP_BRANDS) {
    const bn = b.toLowerCase();
    if (full === bn) return true;
    if (bn.includes(" ")) { if (full.includes(bn)) return true; } // multi-word brand -> substring
    else if (words.includes(bn)) return true;                     // single-word brand -> whole word
  }
  for (const k of NON_ICP_KEYWORDS) if (words.includes(k)) return true; // category keyword -> whole word
  return false;
}

// Is this blacklist-campaign SEED domain (e.g. "google.com") out of ICP? Exact domain match, plus the
// bare label against single-word brands so "flipkart.com" -> "flipkart" is caught even if the exact
// domain isn't listed.
export function isExcludedSeed(domain = "") {
  const d = (domain || "").toLowerCase().trim();
  if (!d) return false;
  if (NON_ICP_DOMAINS.has(d)) return true;
  const label = d.split(".")[0];
  if (!label) return false;
  for (const b of NON_ICP_BRANDS) {
    if (!b.includes(" ") && label === b) return true;
  }
  return false;
}
