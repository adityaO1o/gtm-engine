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

// ── internal-tool (the /internal tool) ───────────────────────────────────────────────
// Same professional-network-data plan as everything above — verified the engine's key can hit
// these. These search LinkedIn's structured job board and post feed; nothing here scrapes engagers,
// so it's cheap (one search = one credit for ~25 results).

// Structured job listings. salary/datePosted/onsiteRemote are LinkedIn's own server-side filters,
// so "100k+, pastWeek, remote" is enforced before results ever reach us.
// Returns { jobs:[{id,title,url,company,location,postAt,postedTimestamp}], total }.
export async function pndSearchJobs({ keywords, datePosted = "pastWeek", salary = "", onsiteRemote = "", sort = "mostRecent", locationId = "", start = "" } = {}) {
  const params = { keywords, datePosted, sort };
  if (salary) params.salary = salary;
  if (onsiteRemote) params.onsiteRemote = onsiteRemote;
  if (locationId) params.locationId = locationId;
  if (start) params.start = String(start);
  const d = await call("search-jobs", { params });
  if (!d) return null;
  meter.inc("pnd_profile_calls");
  const items = Array.isArray(d.data?.items) ? d.data.items : Array.isArray(d.data) ? d.data : [];
  const jobs = items.map((j) => ({
    id: String(j.id || j.jobId || ""),
    title: j.title || "",
    url: j.url || j.jobUrl || (j.id ? `https://www.linkedin.com/jobs/view/${j.id}/` : ""),
    company: j.company?.name || j.companyName || "",
    companyLogo: j.company?.logo || null,
    companyUrl: j.company?.url || "",
    companyUsername: companyUsernameFromUrl(j.company?.url || ""),
    staffRange: j.company?.staffCountRange && Object.keys(j.company.staffCountRange).length ? j.company.staffCountRange : null,
    location: j.location || "",
    postAt: j.postAt || j.postedAt || null,
    postedTimestamp: j.postedTimestamp || j.postedDateTimestamp || null,
  })).filter((j) => j.id || j.url);
  return { jobs, total: d.data?.total ?? jobs.length };
}

// The recruiter(s)/hiring manager attached to a job — the actual person to reach.
// Returns [{name, linkedin, title, headline}].
export async function pndHiringTeam(jobId) {
  if (!jobId) return [];
  const d = await call("get-hiring-team", { params: { id: String(jobId) } });
  if (!d) return [];
  meter.inc("pnd_profile_calls");
  const members = Array.isArray(d.data?.items) ? d.data.items : Array.isArray(d.data) ? d.data : (d.data ? [d.data] : []);
  return members.map((m) => ({
    name: m.fullName || m.name || [m.firstName, m.lastName].filter(Boolean).join(" "),
    linkedin: m.profileUrl || m.url || m.linkedinUrl || (m.username ? `https://www.linkedin.com/in/${m.username}` : ""),
    title: m.title || "",
    headline: m.headline || m.title || "",
  })).filter((m) => m.name || m.linkedin);
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
      text: String(p.text || p.commentary || "").replace(/\s+/g, " ").trim(),
      author: {
        name: a.fullName || a.name || [a.firstName, a.lastName].filter(Boolean).join(" "),
        linkedin: a.profileUrl || a.url || a.linkedinUrl || (a.username ? `https://www.linkedin.com/in/${a.username}` : ""),
        headline: a.headline || a.title || "",
      },
      postedAt: p.postedAt || p.postedDate || null,
      postedTimestamp: p.postedDateTimestamp || p.postedTimestamp || null,
    };
  }).filter((p) => p.postUrl || p.text);
  return { posts, total: d.data?.total ?? posts.length };
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
  const a = p.author || {};
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ").trim();
  const text = String(p.text || "").replace(/\s+/g, " ").trim();
  return {
    urn,
    title: [name, text].filter(Boolean).join(" — ").slice(0, 120) || null,
    posterName: name || null,
    posterUrl: a.url || (a.username ? `https://www.linkedin.com/in/${a.username}` : null),
    text: text || null, // FULL body — the router classifies on this; callers slice for display
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

  const d = await call("get-profile-data-by-url", { params: { url: key } });
  if (!d || d.message === "The url is not valid." || !d.username) return null;
  stats.profileCalls++; meter.inc("pnd_profile_calls");
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
// company_domains. staffCountRange ("51 - 200") and followerCount are how /internal judges whether a
// startup is big/backed enough to actually pay well: a 1-10-person, 200-follower shop can't; a
// 51-200 scale-up with 30k followers and a Crunchbase page can.
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
  const p = await pndProfile(urlOrUrn);
  if (!p) return null;
  const domain = p.companyUsername ? await pndCompanyDomain(p.companyUsername) : null;
  return { company: p.company, domain, vanity: p.vanity, headline: p.headline, name: p.name };
}
