// Keyword-based post classifier — decides which category a scraped post is about,
// so its engagers get the right category weight + tag. Free, deterministic. Highest hit-count
// wins; ties resolve toward the earlier (higher-value) category; default cold-email.

import { CAMPAIGNS, KEYWORDS_NOT } from "./campaigns.js";

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

// ── Relevance: is this post ABOUT our space at all? ──────────────────────────────────────────
// classifyPost answers "which category fits best" and defaults to cold-email even on ZERO hits —
// a post about kittens and a post about cold email look identical to it. The auto engine needs
// the opposite question: "is this worth spending scrape credits on?", i.e. does the text hit at
// least one keyword from the classifier sets OR any campaign's keyword list. Job/hiring posts are
// disqualified outright (KEYWORDS_NOT) — their engagers are job seekers, not buyers.
const ALL_KEYWORDS = [
  ...SETS.flatMap(([, kws]) => kws),
  ...CAMPAIGNS.flatMap((c) => (c.keywords || []).map((k) => k.toLowerCase())),
];

export function relevanceScore(text = "") {
  const t = (text || "").toLowerCase();
  if (!t) return 0;
  for (const bad of KEYWORDS_NOT) if (t.includes(bad)) return 0;
  let hits = 0;
  for (const kw of ALL_KEYWORDS) if (t.includes(kw)) hits++;
  return hits;
}

export const isRelevantPost = (text = "") => relevanceScore(text) >= 1;
