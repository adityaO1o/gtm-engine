// Single source of truth for every campaign: canonical name (matches the SendKit campaign
// exactly), its category (drives scoring), the EXISTING SendKit campaign id, and search config.
// These SendKit ids are the pre-made "- InboxKit" campaigns (do NOT create new ones).

const NOT = ["hiring", "job", "intern", "vacancy", "resume"];

export const CAMPAIGNS = [
  { key: "Smartlead LinkedIn Engagers - InboxKit",        label: "Smartlead",       category: "sequencer",        sendkitId: "6a4fbe815fed5bfd2bf5cf15", keywords: ["Smartlead"] },
  { key: "Instantly LinkedIn Engagers - InboxKit",        label: "Instantly",       category: "sequencer",        sendkitId: "6a4fbe8f5fed5bfd2bf5d9b9", keywords: ["Instantly"] },
  { key: "EmailBison LinkedIn Engagers - InboxKit",       label: "EmailBison",      category: "sequencer",        sendkitId: "6a4fbe9c5fed5bfd2bf5e2a8", keywords: ["EmailBison"] },
  { key: "PlusVibe LinkedIn Engagers - InboxKit",         label: "PlusVibe",        category: "infra-competitor", sendkitId: "6a4fbea85fed5bfd2bf5e74c", keywords: ["PlusVibe"] },
  { key: "PremiumInboxes LinkedIn Engagers - InboxKit",   label: "PremiumInboxes",  category: "infra-competitor", sendkitId: "6a4fc3215fed5bfd2bf86de2", keywords: ["PremiumInboxes"] },
  { key: "ScaledMail LinkedIn Engagers - InboxKit",       label: "ScaledMail",      category: "infra-competitor", sendkitId: "6a4fc3315fed5bfd2bf87cdb", keywords: ["ScaledMail"] },
  { key: "Zapmail LinkedIn Engagers - InboxKit",          label: "Zapmail",         category: "infra-competitor", sendkitId: "6a4fc3115fed5bfd2bf8650d", keywords: ["Zapmail"] },
  { key: "Cold Email Keyword Engagers - InboxKit",        label: "Cold Email",      category: "cold-email",       sendkitId: "6a4fc54e5fed5bfd2bfb3a30", keywords: ["cold email", "email outreach", "email deliverability", "cold email infrastructure"] },
  { key: "GTM Engineering Keyword Engagers - InboxKit",   label: "GTM Engineering", category: "gtm-eng",          sendkitId: "6a4fc55b5fed5bfd2bfb45fc", keywords: ["Clay", "GTM engineer", "GTM engineering", "Claygency"] },
  { key: "Data Tool Engagers - InboxKit",                 label: "Data Tools",      category: "data-tools",       sendkitId: "6a4fc8f95fed5bfd2bfe5510", keywords: ["Prospeo", "FullEnrich", "Apollo", "ZoomInfo"] },
  // Infrastructure home for generic infra/deliverability posts (InboxKit's core pitch).
  { key: "Infrastructure Engagers - InboxKit",            label: "Infrastructure",  category: "infra-competitor", sendkitId: "6a573d5b98fc993dafabcee0", keywords: [] },
  // Legacy source-based campaigns (v5) — kept for the leads already in them; new source engagers
  // now route by topic instead (see routeSourceEngager), so these no longer receive new leads.
  { key: "Influencer Engagers - InboxKit",                label: "Influencers",     category: "cold-email",       sendkitId: "6a53bb3d757679d541224126", keywords: [], source: "influencer" },
  { key: "LinkedIn Hub Engagers - InboxKit",              label: "LinkedIn Hubs",   category: "cold-email",       sendkitId: "6a53bb3e757679d54122419e", keywords: [], source: "hub" },
];

// Route a SOURCE engager (influencer / hub / CSV) to the campaign whose EMAIL matches what the
// post was about — so an infra-post engager gets the infra email, a Smartlead-post engager gets
// the Smartlead email, etc. Keyword-search engagers are unaffected (their campaign is fixed).
//   1) a specific brand named in the post wins (that brand's campaign has tailored copy)
//   2) else the classified category maps to a theme campaign
//   3) else Cold Email
const BRAND_TO_CAMPAIGN = [
  [/smartlead/, "Smartlead LinkedIn Engagers - InboxKit"],
  [/\binstantly\b/, "Instantly LinkedIn Engagers - InboxKit"],
  [/email\s*bison/, "EmailBison LinkedIn Engagers - InboxKit"],
  [/plus\s*vibe/, "PlusVibe LinkedIn Engagers - InboxKit"],
  [/premium\s*inboxes/, "PremiumInboxes LinkedIn Engagers - InboxKit"],
  [/scaled\s*mail/, "ScaledMail LinkedIn Engagers - InboxKit"],
  [/zap\s*mail/, "Zapmail LinkedIn Engagers - InboxKit"],
  [/\bclay\b|apollo|zoominfo|prospeo|fullenrich/, "Data Tool Engagers - InboxKit"],
];
const CATEGORY_TO_CAMPAIGN = {
  "infra-competitor": "Infrastructure Engagers - InboxKit",
  "deliverability": "Infrastructure Engagers - InboxKit",
  "cold-email": "Cold Email Keyword Engagers - InboxKit",
  "sequencer": "Smartlead LinkedIn Engagers - InboxKit",
  "data-tools": "Data Tool Engagers - InboxKit",
  "gtm-eng": "GTM Engineering Keyword Engagers - InboxKit",
};
export function routeSourceEngager(postText = "", category = "cold-email") {
  const t = (postText || "").toLowerCase();
  for (const [rx, key] of BRAND_TO_CAMPAIGN) if (rx.test(t)) return byKey[key];
  return byKey[CATEGORY_TO_CAMPAIGN[category] || "Cold Email Keyword Engagers - InboxKit"];
}

// source key -> its SendKit campaign name/id (used by the sources orchestrator)
export const SOURCE_CAMPAIGN = {
  influencer: { key: "Influencer Engagers - InboxKit", sendkitId: "6a53bb3d757679d541224126" },
  hub: { key: "LinkedIn Hub Engagers - InboxKit", sendkitId: "6a53bb3e757679d54122419e" },
};

export const KEYWORDS_NOT = NOT;

const byKey = Object.fromEntries(CAMPAIGNS.map((c) => [c.key, c]));

// Legacy alias: the wrongly-created "Smartlead LinkedIn" maps to the real Smartlead campaign.
const ALIAS = { "Smartlead LinkedIn": "Smartlead LinkedIn Engagers - InboxKit" };
export const resolveKey = (name) => ALIAS[name] || name;

export const campaignByKey = (name) => byKey[resolveKey(name)] || null;
export const CAMPAIGN_CATEGORY = Object.fromEntries(
  [...CAMPAIGNS.map((c) => [c.key, c.category]), ...Object.entries(ALIAS).map(([a, k]) => [a, byKey[k].category])]
);
export const CAMPAIGN_ID = Object.fromEntries(
  [...CAMPAIGNS.map((c) => [c.key, c.sendkitId]), ...Object.entries(ALIAS).map(([a, k]) => [a, byKey[k].sendkitId])]
);

// A lead is enrolled in exactly ONE active SendKit campaign: the FIRST one they were seen in,
// and they are NEVER moved off it. `campaigns[]` is built with $addToSet, which preserves
// insertion order, so [0] is first-seen; we take the first entry that maps to a real campaign
// (skipping any legacy/unmapped name at the front).
//
// This used to return EVERY campaign the lead had ever engaged across, and every push site loops
// over the result — so one person who engaged with a Smartlead post, an Instantly post, a Cold
// Email post and an Infrastructure post was enrolled in all 4 SendKit sequences at once and got
// emailed 4 times in parallel. Returning a single id (still as a 1-element array so every
// `for (const cid of sendkitIdsFor(...))` caller keeps working) is the fix, funnelled here so no
// call site can reintroduce the duplication. NOTE: SendKit has no remove-from-campaign endpoint,
// so this stops NEW duplicates only — leads already in multiple campaigns must be cleaned via DNC.
export const sendkitIdsFor = (campaigns = []) => {
  const first = (campaigns || []).find((c) => CAMPAIGN_ID[resolveKey(c)]);
  const id = first ? CAMPAIGN_ID[resolveKey(first)] : null;
  return id ? [id] : [];
};

// GO-FORWARD INTAKE — every NEW lead is enrolled into ONE campaign: "Cold Email Keyword Engagers 2.0".
// The old topic campaigns (Data Tool / GTM / Cold Email …) and their multi-campaign leads now live in
// "Cold email engagers 1.0" (contacted separately, later). So all push sites route intake here instead
// of per-topic. The email→campaign uniqueness lock still applies: a NEW email locks to 2.0; an email
// already locked to an old topic campaign stays there (won't be re-enrolled). Env-overridable so the
// intake target can be repointed without a code change.
export const INTAKE_SENDKIT_ID = process.env.INTAKE_SENDKIT_ID || "6a68b7146d040c2dfc1cae31";

export const campaignLabel = (name) =>
  (campaignByKey(name)?.label) || (name || "").replace(/\s*(Keyword )?Engagers - InboxKit$/, "").replace(/ - InboxKit$/, "").trim();

// ── Competitor detection ─────────────────────────────────────────────
// Someone who WORKS AT a competitor is not a prospect. Match by company name or email domain.
const COMPETITOR_BRANDS = new Set([
  "smartlead", "instantly", "instantly.ai", "emailbison", "lemlist", "salesforge",
  "plusvibe", "scaledmail", "premiuminboxes", "zapmail", "maildoso", "mailforge",
  "infraforge", "primeforge", "mailreef", "inframail", "mailscale", "maildeck",
  "aerosend", "hypertide", "warpleads", "saleshandy", "woodpecker", "quickmail",
  "reply.io", "smartreach", "mailshake", "gmass", "apollo", "zoominfo", "snov",
]);
const COMPETITOR_DOMAINS = new Set([
  "smartlead.ai", "instantly.ai", "emailbison.com", "lemlist.com", "salesforge.ai",
  "plusvibe.ai", "scaledmail.com", "premiuminboxes.com", "zapmail.ai", "maildoso.com",
  "mailforge.ai", "infraforge.ai", "primeforge.ai", "mailreef.com", "apollo.io",
  "zoominfo.com", "snov.io", "saleshandy.com", "woodpecker.co", "quickmail.com",
]);

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9.]/g, "");

export function isCompetitor({ company = "", emailDomain = "" } = {}) {
  const c = norm(company);
  if (c && [...COMPETITOR_BRANDS].some((b) => c === b || c.startsWith(b) || c.includes(b))) return true;
  const d = (emailDomain || "").toLowerCase();
  if (d && COMPETITOR_DOMAINS.has(d)) return true;
  return false;
}
