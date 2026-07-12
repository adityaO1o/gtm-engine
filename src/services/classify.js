// Keyword-based post classifier — decides which category a scraped post is about,
// so its engagers get the right category weight + tag. Free, deterministic. Highest hit-count
// wins; ties resolve toward the earlier (higher-value) category; default cold-email.

const SETS = [
  ["infra-competitor", ["inbox", "inboxes", "domain", "warmup", "warm-up", "warming", "spf", "dkim", "dmarc", "dedicated ip", "azure tenant", "google workspace", "outlook inbox", "microsoft inbox", "aged domain", "pre-warmed", "prewarmed", "maildoso", "mailforge", "infraforge", "primeforge", "mailreef", "sending infrastructure", "email infrastructure", "secondary domain", "mailbox"]],
  ["deliverability", ["landing in spam", "spam folder", "sender reputation", "domain reputation", "blacklist", "blacklisted", "google postmaster", "bounce rate", "inbox placement", "burned domain", "deliverability"]],
  ["sequencer", ["smartlead", "instantly", "lemlist", "salesforge", "email sequence", "sequences", "cadence", "follow-up sequence", "sending platform", "outreach platform", "email automation"]],
  ["data-tools", ["clay", "apollo", "zoominfo", "enrichment", "waterfall enrichment", "lead list", "data provider", "prospeo", "fullenrich", "b2b data"]],
  ["gtm-eng", ["gtm engineer", "gtm engineering", "claygency", "signal-based", "allbound", "revops", "programmatic outbound"]],
  ["cold-email", ["cold email", "cold outreach", "outbound", "email outreach"]],
];

export function classifyPost(text = "") {
  const t = (text || "").toLowerCase();
  let best = "cold-email", bestScore = 0;
  for (const [cat, kws] of SETS) {
    let s = 0;
    for (const kw of kws) if (t.includes(kw)) s++;
    if (s > bestScore) { bestScore = s; best = cat; }
  }
  return best;
}
