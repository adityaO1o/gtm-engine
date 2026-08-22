// PND — professional-network-data (RapidAPI). ONE API that covers the whole pipeline:
//   • post reactions + comments  (50 engagers per credit — the scrape)
//   • profile by url OR obfuscated URN -> real vanity + current company + companyUsername
//   • company -> EXACT website domain (no Clearbit guessing)
//
// Credit discipline (every call = 1 credit):
//   • Scraping is cheap (~0.02 cr/engager) and always allowed.
//   • The PAID enrichment tier (profile/company) is a LAST RESORT — enrichLead only calls it when
//     the free tiers (headline, SERP snippet, comment vanity URL) couldn't produce a working domain.
//   • Two permanent Mongo caches make repeats free: a company's domain is bought ONCE and every
//     future lead there is free forever; a profile is never paid for twice (retries reuse it).
//   • A credit FLOOR switches the paid tier off before the plan can be drained — free tiers keep
//     running so leads never stop flowing.

import axios from "axios";
import { config } from "../config.js";
import { companyDomains, profileCache } from "../db/mongo.js";
import { meter, recordBalance } from "./apiMeter.js";
import { resolveActivityUrn } from "./postUrn.js";
import { log } from "../lib/logger.js";

const stats = { scrapePages: 0, engagers: 0, profileCalls: 0, companyCalls: 0, cacheHits: 0, throttled: 0 };
let bal = null;          // latest {creditsRemaining, creditsLimit, requestsRemaining, requestsLimit}
let outOfCredits = false;

export function pndStats() { return { ...stats, outOfCredits, balance: bal, paidBlocked: paidBlocked(), host: config.pndHost }; }
export function pndOutOfCredits() { return outOfCredits; }
// Paid enrichment stops at the floor; scraping + free tiers continue.
export function paidBlocked() {
  if (!config.pndKey || outOfCredits) return true;
  return bal?.creditsRemaining != null && bal.creditsRemaining <= config.pndCreditFloor;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hnum = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
function captureBalance(r) {
  const h = r?.headers || {};
  const b = { creditsRemaining: hnum(h["x-ratelimit-credits-remaining"]), creditsLimit: hnum(h["x-ratelimit-credits-limit"]),
              requestsRemaining: hnum(h["x-ratelimit-requests-remaining"]), requestsLimit: hnum(h["x-ratelimit-requests-limit"]) };
  if (b.creditsRemaining !== null || b.requestsRemaining !== null) { bal = b; recordBalance("pnd", b).catch(() => {}); }
}

// Shared limiter so we never burst the plan's per-minute cap.
let nextSlot = 0;
async function slot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + config.pndMinGapMs;
  if (wait > 0) await sleep(wait);
}

// -> body | null. 402/403 or a quota-429 = out of credits (terminal); a rate-429/5xx retries.
async function call(path, { method = "GET", params, body, retries = 2 } = {}) {
  if (!config.pndKey || outOfCredits) return null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await slot();
    let r;
    try {
      r = await axios({
        method, url: `https://${config.pndHost}/${path}`, params, data: body,
        headers: { "x-rapidapi-host": config.pndHost, "x-rapidapi-key": config.pndKey, "Content-Type": "application/json" },
        timeout: 45000, validateStatus: () => true,
      });
    } catch (e) {
      if (attempt < retries) { await sleep(1200 * 2 ** attempt); continue; }
      log.warn("pnd network error", { path, err: e.message });
      return null;
    }
    captureBalance(r);
    if (r.status === 402 || r.status === 403) { outOfCredits = true; log.warn("pnd out of credits/not subscribed", { status: r.status }); return null; }
    if (r.status === 429) {
      const txt = typeof r.data === "string" ? r.data : JSON.stringify(r.data || "");
      if (/exceeded .*quota|quota.*exceeded|monthly quota/i.test(txt) || bal?.creditsRemaining === 0) {
        outOfCredits = true; log.warn("pnd MONTHLY quota exhausted"); return null;
      }
      stats.throttled++;
      if (attempt < retries) { await sleep(2500 * 2 ** attempt); continue; }
      return null;
    }
    if (r.status !== 200) {
      if (attempt < retries) { await sleep(1200 * 2 ** attempt); continue; }
      log.warn("pnd non-200", { path, status: r.status });
      return null;
    }
    return r.data;
  }
  return null;
}

// Raw passthrough for diagnosing a PND endpoint's actual response shape. Every parser in this file
// is a guess about that shape until something like this proves it — pndCommentPage silently
// returned [] for months because its shape guess was never checked against a real response.
export async function pndRaw(path, { params, method = "GET", body } = {}) {
  return call(path, { params, method, body });
}

// ── SCRAPE ───────────────────────────────────────────────────────────────────
// PND's reactions endpoint hard-caps at page 38 (= 1,900 reactions) no matter the true count — its
// own error is "page can not be more than 38". BUT it also filters by reactionType, and each type
// gets its OWN 38-page budget. So paging every type separately reaches min(1900, count) PER TYPE
// instead of 1,900 across the whole post: on a 4,300-like post, ALL yields 1,900 while per-type
// yields 1,900 likes + every praise/empathy/interest/appreciation/entertainment in full. Verified
// against the live API: reactionType=PRAISE returns total:257 of only PRAISE, etc.
export const REACTION_TYPES = ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION", "ENTERTAINMENT"];

export async function pndReactionPage(postUrl, page, reactionType) {
  const body = { url: postUrl, page };
  if (reactionType) body.reactionType = reactionType;
  const d = await call("get-post-reactions", { method: "POST", body });
  if (!d) return null;
  stats.scrapePages++; meter.inc("pnd_scrape_pages");
  const items = d?.data?.items || [];
  const engagers = items.map((x) => ({
    name: x.fullName || "", headline: x.headline || "",
    linkedin_url: x.profileUrl || x.url || "", engagement_type: "like",
  })).filter((e) => e.name || e.linkedin_url);
  return { engagers, count: items.length, total: typeof d?.data?.total === "number" ? d.data.total : null };
}

// Keyword post search — surfaces "we're hiring" posts whose author is a REAL person (founder / HM),
// often with an email right in the text. Returns [{postUrl, urn, text, author:{name,linkedin,headline}, postedAt}].
export async function pndSearchPosts({ keyword, datePosted = "past-week", sortBy = "date_posted", page = 1 } = {}) {
  const d = await call("search-posts", { method: "POST", body: { keyword, datePosted, sortBy, page } });
  if (!d) return null;
  meter.inc("pnd_scrape_pages");
  const items = Array.isArray(d.data?.items) ? d.data.items : Array.isArray(d.data) ? d.data : [];
  const posts = items.map((p) => {
    const a = p.author || p.poster || {};
    return {
      postUrl: p.url || p.postUrl || "",
      urn: String(p.urn || p.activityUrn || "").match(/(\d{15,25})/)?.[1] || null,
      // Keep the post's LINE STRUCTURE. Collapsing all whitespace turned a formatted job post
      // ("Role:… Requirements:… Send your CV to x@y.com") into one unreadable blob and destroyed
      // the first line, which is the natural title. Verified this endpoint already returns the
      // COMPLETE body — get-post for the same urn returns byte-identical text — so there is
      // nothing further to fetch and no reason to throw any of it away.
      text: String(p.text || p.commentary || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
      author: {
        name: a.fullName || a.name || [a.firstName, a.lastName].filter(Boolean).join(" "),
        linkedin: a.profileUrl || a.url || a.linkedinUrl || (a.username ? `https://www.linkedin.com/in/${a.username}` : ""),
        headline: a.headline || a.title || "",
      },
      postedAt: p.postedAt || p.postedDate || null,
      postedTimestamp: p.postedDateTimestamp || p.postedTimestamp || null,
      // Engagement counts come back WITH the search — free, no extra call. They drive three things:
      // whether a post is worth scraping at all, whether an already-scraped post has GROWN, and
      // which reaction types actually have anyone in them (so we don't burn a credit paging PRAISE
      // on a post with zero praises).
      counts: socialCounts(p.socialActivityCountsInsight),
    };
  }).filter((p) => p.postUrl || p.text);
  return { posts, total: d.data?.total ?? posts.length };
}

// LinkedIn's per-emoji counter -> our REACTION_TYPES vocabulary. "maybeCount" has no matching
// reactionType (the API rejects "MAYBE"), so it's deliberately not mapped.
export function socialCounts(s = {}) {
  const n = (v) => (typeof v === "number" ? v : 0);
  return {
    LIKE: n(s.likeCount), PRAISE: n(s.praiseCount), EMPATHY: n(s.empathyCount),
    INTEREST: n(s.InterestCount ?? s.interestCount), APPRECIATION: n(s.appreciationCount),
    ENTERTAINMENT: n(s.funnyCount),
    totalReactions: n(s.totalReactionCount), comments: n(s.numComments),
  };
}

// A profile's own POSTS, newest first — what the auto engine's daily rotation walks to find an
// influencer's last-3-months posts. 1 credit per page of 50.
//
// Parser written against a REAL probed response (via /api/debug/pnd — the file's history shows
// what guessing shapes costs). Verified 2026-07-27 on username=prakhar-keshari:
//   • top level: { success, message, data:[50], paginationToken }
//   • item: { text, totalReactionCount, likeCount, praiseCount, empathyCount, appreciationCount,
//             commentsCount, postUrl, shareUrl, postedAt("2d"), postedDate, postedDateTimestamp
//             (epoch ms), urn (ACTIVITY id!), shareUrn, author{username,...}, contentType, ... }
//   • postUrl is ALREADY the canonical /feed/update/urn:li:activity:<id>/ form — exactly what
//     scrapeOneInner wants, so no share-link resolution is ever needed on this path.
//   • data is newest-first — callers can stop paging at the first post older than their window.
// Pagination is CURSOR-based: pass the previous response's paginationToken to get the next page
// (this RapidAPI family uses a token, not an offset — sending `start` too risks double-advancing).
export async function pndProfilePosts(usernameOrUrl, { paginationToken = "" } = {}) {
  const username = String(usernameOrUrl || "")
    .replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "").replace(/[/?#].*$/, "").trim();
  if (!username) return null;
  const params = { username };
  if (paginationToken) params.paginationToken = paginationToken;
  const d = await call("get-profile-posts", { params });
  if (!d || d.success === false || !Array.isArray(d.data)) return null;
  stats.scrapePages++; meter.inc("pnd_scrape_pages");
  const n = (v) => (typeof v === "number" ? v : 0);
  const posts = d.data.map((p) => ({
    postUrl: p.postUrl || "",
    urn: p.urn || null,                                  // the activity id
    text: String(p.text || ""),
    postedTimestamp: n(p.postedDateTimestamp) || null,   // epoch ms
    posted: p.postedDate || p.postedAt || null,
    // Same key vocabulary the keyword sweep stores as type_counts, so the per-emoji
    // skip-empty-types machinery works unchanged on rotation-scraped posts.
    counts: {
      LIKE: n(p.likeCount), PRAISE: n(p.praiseCount), EMPATHY: n(p.empathyCount),
      INTEREST: n(p.InterestCount ?? p.interestCount), APPRECIATION: n(p.appreciationCount),
      ENTERTAINMENT: n(p.funnyCount ?? p.entertainmentCount),
      totalReactions: n(p.totalReactionCount), comments: n(p.commentsCount),
    },
  })).filter((p) => p.postUrl);
  return { posts, paginationToken: d.paginationToken || "" };
}

// Find a PERSON from a name + the company we already know they work at.
//
// This is the opposite shape to a web search, and that is the point. A SERP asks "who on LinkedIn
// is called this", so the most famous holder of the name wins and a customer resolves to a
// stranger. This asks LinkedIn's own people search for that name INSIDE that company, so the answer
// is either our customer or nothing.
//
// The endpoint is FLAKY, not sparse: the identical query returns 1, then 0, then 1 within seconds.
// A single empty response therefore means nothing, so an empty result is retried before it is
// believed — without that, real people are recorded as "no profile". Two query shapes are tried,
// since the structured one and the free-text one do not always agree.
//
// ~1 credit per attempt. Worth it on a short, high-value list; too expensive to point at 6,000 rows.
const alphaKey = (v) => String(v || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

// A hard per-run ceiling on paid calls. The first version of this had none: pndFindPerson retried
// 3 times across 2 query shapes, so a person who simply is not on LinkedIn cost SIX credits before
// being given up on. ~360 such people burned roughly 2,160 credits — about 70% of a 3,360 wallet —
// for answers that were always going to be "not found". Never again: a run declares its budget up
// front and paid calls stop dead when it is spent.
let budget = { cap: 0, used: 0 };
export function setPndBudget(cap) { budget = { cap: Math.max(0, cap | 0), used: 0 }; }
export function pndBudget() { return { ...budget, left: budget.cap ? Math.max(0, budget.cap - budget.used) : Infinity }; }
const budgetSpent = () => budget.cap > 0 && budget.used >= budget.cap;
const spend = (n = 1) => { budget.used += n; };

// Is this company even ON LinkedIn? One cached lookup per DOMAIN, shared by everyone who works
// there — so a company with no page costs one call and then rules out all of its people for free,
// instead of each of them paying for a search that cannot succeed.
export async function pndCompanyOnLinkedin(domain) {
  if (!domain) return null;
  const key = `dom:${String(domain).toLowerCase()}`;
  const hit = await companyDomains().findOne({ _id: key }).catch(() => null);
  if (hit) { stats.cacheHits++; meter.inc("pnd_cache_hits"); return hit.company || null; }
  if (paidBlocked() || budgetSpent()) return null;
  const d = await call("get-company-by-domain", { params: { domain } });
  spend(); stats.companyCalls++; meter.inc("pnd_company_calls");
  const rec = { _id: key, company: d?.data?.name || null, universalName: d?.data?.universalName || null, at: new Date() };
  await companyDomains().updateOne({ _id: key }, { $set: rec }, { upsert: true }).catch(() => {});
  return rec.company;
}

// Find a PERSON from a name + the company we already know they work at.
//
// This is the opposite shape to a web search, and that is the point. A SERP asks "who on LinkedIn
// is called this", so the most famous holder of the name wins and a customer resolves to a
// stranger. This asks LinkedIn's own people search for that name INSIDE that company, so the answer
// is either our customer or nothing.
//
// The endpoint IS flaky — the identical query returns 1, then 0, then 1 within seconds — but
// retrying every miss inline is what emptied the wallet. So one pass costs at most TWO calls (the
// structured shape, then the free-text one) and a miss is left as a miss. Flakiness is recovered by
// re-running the missed people later as a deliberate second pass, where the cost is a decision
// rather than a surprise.

export async function pndFindPerson({ name = "", company = "" } = {}) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !company) return null;
  const first = parts[0], last = parts.length > 1 ? parts[parts.length - 1] : "";
  const shapes = [
    { firstName: first, ...(last ? { lastName: last } : {}), company },
    { keywords: `${name} ${company}` },
  ];
  const toks = parts.map(alphaKey).filter((t) => t.length >= 3);
  const looksRight = (p) => {
    const hay = alphaKey(`${p.fullName} ${p.username}`);
    return !toks.length || toks.every((t) => hay.includes(t));
  };

  for (const params of shapes) {
    if (paidBlocked() || budgetSpent()) return null;
    const d = await call("search-people", { params });
    spend(); stats.profileCalls++; meter.inc("pnd_profile_calls");
    const items = d?.data?.items || [];
    const hit = items.find(looksRight);
    if (hit && (hit.profileURL || hit.username)) {
      return {
        url: hit.profileURL || `https://www.linkedin.com/in/${hit.username}`,
        name: hit.fullName || null,
        headline: hit.headline || null,
        location: hit.location || null,
        photo: hit.profilePicture || null,
        candidates: items.length,
      };
    }
  }
  return null;
}

// Commenters, with their REAL vanity URL (no resolve needed).
//
// This parser was three guesses deep and every one was wrong, which is why not a single commenter
// has EVER been scraped — including from posts whose activity urn was valid all along. Checked
// against a real response:
//   • data is an ARRAY of comments — not {comments:[…]} or {items:[…]}, so the old lookup
//     silently produced [] on every page and the scrape reported success.
//   • the author is {name, username, linkedinUrl, title} — there is no firstName/lastName, so
//     even a correct array would have yielded nameless, unusable engagers.
//   • pagination is page-based via total/totalPage — there is no paginationToken. The old loop
//     stopped the moment the (never-present) token came back empty, i.e. after page one.
export async function pndCommentPage(urn, { page = 1 } = {}) {
  const d = await call("get-profile-posts-comments", { params: { urn, sort: "mostRecent", page: String(page) } });
  if (!d) return null;
  stats.scrapePages++; meter.inc("pnd_scrape_pages");
  const items = Array.isArray(d.data) ? d.data : [];
  const engagers = items.map((c) => {
    const a = c.author || {};
    return {
      name: a.name || [a.firstName, a.lastName].filter(Boolean).join(" ").trim(),
      headline: a.title || a.headline || "",
      linkedin_url: a.linkedinUrl || a.url || (a.username ? `https://www.linkedin.com/in/${a.username}` : ""),
      engagement_type: "comment",
      comment_text: c.text || "",
    };
  }).filter((e) => e.name || e.linkedin_url);
  return { engagers, count: items.length, total: d.total ?? null, totalPage: d.totalPage ?? null };
}

// Takes a post URL or a bare activity urn.
//
// Also written against guesses, also all wrong — which is why no post ever got a title:
//   • get-post wants a `url` ("Url is required" if you send a urn) — but not ANY url: a share-link
//     gets "Wrong post url provided". Only the canonical feed/update form works, so resolve to the
//     activity urn (free, via proxy) and build it.
//   • the shape is {author:{firstName,lastName,headline}, totalReactionCount, commentsCount},
//     not {poster:{first,last}, num_reactions, num_comments}.
export async function pndPostInfo(urlOrUrn) {
  const s = String(urlOrUrn || "");
  if (!s) return null;
  const urn = /^\d{15,25}$/.test(s) ? s : await resolveActivityUrn(s);
  if (!urn) return null; // unresolvable — say nothing rather than guess an id
  const d = await call("get-post", { params: { url: `https://www.linkedin.com/feed/update/urn:li:activity:${urn}/` } });
  const p = d?.data;
  if (!p) return null;
  // get-post costs 1 credit like any scrape call. It was the only PND call that never metered, so the
  // routing peek + hub growth-peek + age-guard peek were invisible to the ledger / pnd_daily / balance,
  // making "credits used" read systematically low. Count it in the same bucket as the other page calls.
  stats.scrapePages++; meter.inc("pnd_scrape_pages");
  const a = p.author || {};
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ").trim();
  const text = String(p.text || "").replace(/\s+/g, " ").trim();
  return {
    urn,
    title: [name, text].filter(Boolean).join(" — ").slice(0, 120) || null,
    posterName: name || null,
    posterUrl: a.url || (a.username ? `https://www.linkedin.com/in/${a.username}` : null),
    text: text || null, // FULL body — the router classifies on this; callers slice for display
    // get-post carries the same per-emoji breakdown search-posts does, so a MANUALLY pasted post
    // gets the empty-reaction-type skip too — not just posts found by the keyword sweep.
    counts: socialCounts(p),
    numReactions: p.totalReactionCount ?? null,
    numComments: p.commentsCount ?? null,
    posted: p.postedDate || p.postedAt || null,
  };
}

// ── PAID ENRICHMENT (last resort, both cached) ───────────────────────────────
// Profile by vanity URL OR raw obfuscated URN — the URN works directly, so no SERP resolve needed.
export async function pndProfile(urlOrUrn) {
  if (!urlOrUrn) return null;
  const key = String(urlOrUrn);
  const hit = await profileCache().findOne({ _id: key }).catch(() => null);
  if (hit) { stats.cacheHits++; meter.inc("pnd_cache_hits"); return hit; }
  if (paidBlocked()) return null;

  if (budgetSpent()) return null;
  const d = await call("get-profile-data-by-url", { params: { url: key } });
  spend(); stats.profileCalls++; meter.inc("pnd_profile_calls");
  if (!d || d.message === "The url is not valid." || !d.username) return null;
  const pos = (d.position || [])[0] || {};
  const rec = {
    _id: key,
    vanity: d.username ? `https://www.linkedin.com/in/${d.username}` : null,
    name: [d.firstName, d.lastName].filter(Boolean).join(" ") || null,
    headline: d.headline || null,
    company: pos.companyName || null,
    companyUsername: pos.companyUsername || null,
    at: new Date(),
  };
  await profileCache().updateOne({ _id: key }, { $set: rec }, { upsert: true }).catch(() => {});
  return rec;
}

// companyUsername -> exact website domain. Bought ONCE per company, then free forever.
export async function pndCompanyDomain(companyUsername) {
  const c = await pndCompanyDetails(companyUsername);
  return c?.domain || null;
}

// Full company card — domain AND size — from ONE get-company-details call, cached forever in
// company_domains. The domain is what the email waterfall (pndExactDomain) needs; staffCountRange
// and followerCount are also stored for any size-based signals.
export async function pndCompanyDetails(companyUsername) {
  if (!companyUsername) return null;
  const hit = await companyDomains().findOne({ _id: companyUsername }).catch(() => null);
  if (hit && hit.staffRange !== undefined) { stats.cacheHits++; meter.inc("pnd_cache_hits"); return hit; }
  if (paidBlocked()) return hit || null;

  const d = await call("get-company-details", { params: { username: companyUsername } });
  if (!d?.data) return hit || null;
  stats.companyCalls++; meter.inc("pnd_company_calls");
  const c = d.data;
  const rec = {
    _id: companyUsername,
    domain: String(c.website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase() || null,
    name: c.name || null,
    staff: c.staffCount ?? null,
    staffRange: c.staffCountRange || null,
    followers: c.followerCount ?? null,
    industry: Array.isArray(c.industries) ? c.industries[0] : (c.industry || null),
    funded: !!c.crunchbaseUrl,
    at: new Date(),
  };
  await companyDomains().updateOne({ _id: companyUsername }, { $set: rec }, { upsert: true }).catch(() => {});
  return rec;
}

// Turn a LinkedIn company URL (…/company/finn-app-co/…) into its username.
export function companyUsernameFromUrl(url = "") {
  return String(url).match(/\/company\/([^/?#]+)/)?.[1] || null;
}

// The paid last-resort: person -> { company, domain, vanity }. Both hops cached, so calling this
// twice for the same person (e.g. waterfall + a verify-fail retry) costs nothing extra.
export async function pndExactDomain(urlOrUrn) {
  if (budgetSpent()) return null;
  const p = await pndProfile(urlOrUrn);
  if (!p) return null;
  const domain = p.companyUsername ? await pndCompanyDomain(p.companyUsername) : null;
  return { company: p.company, domain, vanity: p.vanity, headline: p.headline, name: p.name };
}
