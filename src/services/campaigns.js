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
  // Source-based campaigns (v5): category is classified per-post, so the entry's category is only a neutral default.
  { key: "Influencer Engagers - InboxKit",                label: "Influencers",     category: "cold-email",       sendkitId: "6a53bb3d757679d541224126", keywords: [], source: "influencer" },
  { key: "LinkedIn Hub Engagers - InboxKit",              label: "LinkedIn Hubs",   category: "cold-email",       sendkitId: "6a53bb3e757679d54122419e", keywords: [], source: "hub" },
];

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

// short display label from any campaign name
// Every SendKit campaign id a lead belongs to. A person who engages with a Smartlead post AND
// a Cold Email post sits in BOTH campaigns — our per-campaign "verified" counts reflect that,
// so the push must too. Only ever pushing campaigns[0] is what left SendKit short.
export const sendkitIdsFor = (campaigns = []) =>
  [...new Set((campaigns || []).map((c) => CAMPAIGN_ID[resolveKey(c)]).filter(Boolean))];

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
