// Intent scoring — pure deterministic logic, no LLM.
//
// A person earns a signal every time they engage with a post in a tracked category.
// Engaging with SEVERAL DIFFERENT categories is the strongest buying signal: they're
// assembling or replacing their cold-email stack right now.

export const CATEGORY_WEIGHT = {
  "infra-competitor": 5, // already pays a competitor for inboxes
  deliverability: 5,     // in pain right now
  infra: 3,              // researching infrastructure
  sequencer: 2,          // confirmed cold-email operator
  "gtm-eng": 2,          // agency, buys at scale
  "data-tools": 2,       // has data half, needs sending half
  "cold-email": 1,       // broad
};

export const ENGAGEMENT_POINTS = { comment: 3, like: 1 };

// Campaign name -> SendKit campaign id (used when reprocessing leads that predate campaign_id storage).
export const CAMPAIGN_ID = {
  "Smartlead LinkedIn": "6a523205757679d5417ea44a",
};

// Map a search/campaign to its category. Extend as campaigns are added.
export const CAMPAIGN_CATEGORY = {
  "Smartlead LinkedIn": "sequencer",
  "Instantly LinkedIn": "sequencer",
  "EmailBison LinkedIn": "sequencer",
  "PlusVibe LinkedIn": "infra-competitor",
  "PremiumInboxes LinkedIn": "infra-competitor",
  "ScaledMail LinkedIn": "infra-competitor",
  "Infra Switchers LinkedIn": "infra-competitor",
  "Deliverability Pain": "deliverability",
  "Cold Email Infra": "infra",
  "GTM Engineering": "gtm-eng",
  "Data Tool Engagers": "data-tools",
  "Cold Email": "cold-email",
};

// Given the categories a lead has ALREADY engaged with (Set of names) plus the
// new signal, compute their updated intent state.
export function computeStatus(distinctCategories) {
  const cats = [...distinctCategories];
  const n = cats.length;
  const hasHighValue = cats.includes("infra-competitor") || cats.includes("deliverability");

  if (n >= 3 || (n >= 2 && hasHighValue)) return "hot";
  if (n === 2) return "warm";
  return "cold";
}

// Full recompute from an engagement history array [{category, engagement}].
export function scoreFromHistory(history) {
  let score = 0;
  const cats = new Set();
  const perCategoryCount = {};
  for (const h of history) {
    const w = CATEGORY_WEIGHT[h.category] ?? 1;
    const p = ENGAGEMENT_POINTS[h.engagement] ?? 1;
    score += w * p;
    cats.add(h.category);
    perCategoryCount[h.category] = (perCategoryCount[h.category] || 0) + 1;
  }
  // WARM also if 3+ engagements inside a single category
  let status = computeStatus(cats);
  if (status === "cold" && Object.values(perCategoryCount).some((c) => c >= 3)) {
    status = "warm";
  }
  return { score, status, categories: [...cats], timesSeen: history.length };
}
