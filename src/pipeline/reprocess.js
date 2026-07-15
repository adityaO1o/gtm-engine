// Reprocess stuck leads through the current (Enrich-first) waterfall — a SAFETY NET now, not the
// only way to get emails (the live scrape already runs the full waterfall incl. the paid profile
// lookup). Two pools, both handled here:
//
//   • no-email     -> re-run the full find waterfall.
//   • unverified   -> ALTERNATE-DOMAIN recovery: an unverified email is usually a WRONG Clearbit
//                     domain, so we try Clearbit's other suggestions + re-verify.
//
// Smart, so we don't waste time/credits:
//   • BACKOFF     — a lead retried in the last 6h is skipped (unless "deep").
//   • TERMINAL    — "no_company_urn" (nothing to search on) is skipped (unless "deep").
//   • ATTEMPT CAP — 5 tries max per lead (unless "deep").
//   • PAID ONCE   — a lead that already had a paid get-personal-profile isn't re-charged (unless "deep").
// "Deep retry" ignores all four: every stuck lead, always pay, one more time.

import { leads, reprocessRuns } from "../db/mongo.js";
import { findEmailWaterfall, verifyEmailWaterfall, companyFromHeadline } from "./enrichLead.js";
import { isRoleBased, findEmailByNameDomain } from "../services/enrich.js";
import { companyDomainGuarded } from "../services/clearbit.js";
import { upsertLead, addToCampaign } from "../services/sendkit.js";
import { bumpUsage } from "../services/usage.js";
import { meterFlush } from "../services/apiMeter.js";
import { CAMPAIGN_ID, isCompetitor, sendkitIdsFor } from "../services/campaigns.js";
import { isPersonalDomain, nameMatchesEmail, emailDomain } from "../services/quality.js";
import { isUrn } from "../services/resolve.js";
import { log } from "../lib/logger.js";

const BACKOFF_MS = 6 * 3600 * 1000; // don't retry the same lead more than once per 6h
const MAX_ATTEMPTS = 5;             // give up on a lead after this many tries (unless deep)
const TERMINAL = ["no_company_urn"]; // nothing to search on — never recoverable, skip unless deep

let running = false;
let status = { running: false, processed: 0, total: 0, newlyFound: 0, reasons: {}, startedAt: null, finishedAt: null };
export function reprocessStatus() { return status; }

// Human-readable reasons a lead can't be recovered — shown in the hand-off run log so you can
// see WHY leads are still stuck, not just that they are.
export const MISS_REASONS = {
  recovered: "Recovered — email found, verified & sent",
  no_company_urn: "No company in the headline AND an obfuscated URL — nothing to search on",
  unresolved: "Couldn't resolve the LinkedIn profile (SEO API/Serper/proxies all missed)",
  no_email_found: "Profile resolved, but no email provider has this person",
  unverified: "Email found but it failed verification (likely a wrong company domain)",
  review: "Email found but the name didn't match — held for your review",
  competitor: "Works at a competitor — saved, never sent",
  role_based: "Role inbox (info@, sales@…) — saved, never sent",
};

const tagsFor = (d) => [
  "gtm-auto", ...(d.categories || []).map((c) => "cat:" + c),
  "score:" + d.score, "seen:" + d.times_seen, d.status + "-lead",
];

// ── Query builders ───────────────────────────────────────────────────────────
// no-email leads still worth a try. "deep" drops backoff / terminal-skip / attempt-cap.
function noEmailRetryQuery(campaigns, deep) {
  const q = { email_status: "no-email" };
  if (campaigns.length) q.campaigns = { $in: campaigns };
  if (!deep) {
    q.$and = [
      { $or: [{ last_retry_at: { $exists: false } }, { last_retry_at: { $lt: new Date(Date.now() - BACKOFF_MS) } }] },
      { $or: [{ last_miss_reason: { $exists: false } }, { last_miss_reason: { $nin: TERMINAL } }] },
      { $or: [{ retry_count: { $exists: false } }, { retry_count: { $lt: MAX_ATTEMPTS } }] },
    ];
  }
  return q;
}
// unverified leads — likely a wrong Clearbit domain, worth an alternate-domain pass.
function unverifiedRetryQuery(campaigns, deep) {
  const q = { email_status: "unverified" };
  if (campaigns.length) q.campaigns = { $in: campaigns };
  if (!deep) {
    q.$and = [
      { $or: [{ last_retry_at: { $exists: false } }, { last_retry_at: { $lt: new Date(Date.now() - BACKOFF_MS) } }] },
      { $or: [{ retry_count: { $exists: false } }, { retry_count: { $lt: MAX_ATTEMPTS } }] },
    ];
  }
  return q;
}

// Stamp retry metadata (attempt count, when, why, whether a paid lookup was spent) so the next
// run can back off, cap, and skip re-paying. Written as a separate update from the email fields.
async function stampRetry(url, reason, { paidTried } = {}) {
  const set = { last_retry_at: new Date(), last_miss_reason: reason };
  if (paidTried) set.paid_profile_tried = true;
  await leads().updateOne({ linkedin_url: url }, { $set: set, $inc: { retry_count: 1 } });
  return reason;
}

// ── Pool 1: no-email -> full waterfall ───────────────────────────────────────
async function recoverNoEmail(d, deep) {
  const hadUrn = isUrn(d.linkedin_url || "");
  const company = companyFromHeadline(d.headline || "");
  const skipPaid = !deep && !!d.paid_profile_tried; // don't re-charge a lead we already paid for
  const w = await findEmailWaterfall({ name: d.name, headline: d.headline, linkedin_url: d.linkedin_url, skipPaid });
  const { em, emailSource, emailMethod, preVerified } = w;
  const campaign = (d.campaigns || [])[0] || "";
  await bumpUsage(campaign, { prospeo_calls: w.prospeoCalls, prospeo_finds: emailSource === "prospeo" ? 1 : 0 });
  const finish = (reason) => stampRetry(d.linkedin_url, reason, { paidTried: w.paidTried });

  if (!em.found || !em.email) {
    if (!company && hadUrn && isUrn(w.vanity || d.linkedin_url)) return finish("no_company_urn");
    if (hadUrn && isUrn(w.vanity || d.linkedin_url)) return finish("unresolved");
    return finish("no_email_found");
  }

  const email = em.email;
  const base = {
    email, email_source: emailSource, email_method: emailMethod, domain_source: w.domainSource || null,
    clearbit_guard_rejected: !!w.guardRejected,
    personal_email: isPersonalDomain(email), needs_email: false, updated_at: new Date(),
  };

  if (isCompetitor({ company, emailDomain: emailDomain(email) })) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "competitor", is_competitor: true } });
    return finish("competitor");
  }
  if (isRoleBased(email)) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "role-based", role_based: true } });
    return finish("role_based");
  }
  if (!nameMatchesEmail(d.name || "", email)) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "review", email_low_confidence: true } });
    return finish("review");
  }

  const vr = await verifyEmailWaterfall(email, preVerified);
  if (vr.prospeoCalls) await bumpUsage(campaign, { prospeo_calls: vr.prospeoCalls });
  base.verified_by = vr.verifiedBy; base.verify_detail = vr.verifyLabel;

  if (!vr.verified) {
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { ...base, email_status: "unverified", unverified: true } });
    return finish("unverified");
  }

  await pushRecovered(d, email, base.company_domain, vr);
  return finish("recovered");
}

// ── Pool 2: unverified -> alternate-domain recovery ──────────────────────────
// An unverified email usually means Clearbit handed us the WRONG company's domain. Try Clearbit's
// OTHER suggestions (+ the guarded top pick) on the name+domain finder and re-verify.
async function recoverUnverified(d, deep) {
  const campaign = (d.campaigns || [])[0] || "";
  const company = d.company || companyFromHeadline(d.headline || "");
  const [firstName, ...rest] = (d.name || "").split(" ");
  const lastName = rest.join(" ");
  if (!company || !firstName || !lastName) return stampRetry(d.linkedin_url, "unverified");

  const g = await companyDomainGuarded(company);
  const currentDomain = (d.email || "").split("@")[1] || "";
  const candidates = [];
  if (g.domain && g.domain !== currentDomain) candidates.push(g.domain);
  for (const dm of g.alts || []) if (dm && dm !== currentDomain) candidates.push(dm);

  for (const dm of [...new Set(candidates)].slice(0, 3)) {
    const f = await findEmailByNameDomain(firstName, lastName, dm);
    if (!f.found || !f.email) continue;
    const vr = await verifyEmailWaterfall(f.email, f.verified);
    if (vr.prospeoCalls) await bumpUsage(campaign, { prospeo_calls: vr.prospeoCalls });
    if (!vr.verified) continue;

    if (isCompetitor({ company, emailDomain: emailDomain(f.email) })) {
      await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { email: f.email, company_domain: dm, email_status: "competitor", is_competitor: true, unverified: false, needs_email: false, updated_at: new Date() } });
      return stampRetry(d.linkedin_url, "competitor");
    }
    if (!nameMatchesEmail(d.name || "", f.email)) continue;

    await pushRecovered(d, f.email, dm, vr);
    return stampRetry(d.linkedin_url, "recovered");
  }
  return stampRetry(d.linkedin_url, "unverified");
}

// Write a verified email to Mongo + push it into every SendKit campaign the lead belongs to.
async function pushRecovered(d, email, domain, vr) {
  const tags = tagsFor(d);
  const [first, ...rest] = (d.name || "").split(" ");
  await upsertLead({ email, firstName: first, lastName: rest.join(" "), companyName: d.company || "", jobTitle: d.headline || "", linkedinUrl: d.linkedin_url, tags });
  const landed = [];
  for (const cid of sendkitIdsFor(d.campaigns)) { if (await addToCampaign(cid, email)) landed.push(cid); }
  await leads().updateOne({ linkedin_url: d.linkedin_url }, {
    $set: {
      email, company_domain: domain || null, email_status: "verified", unverified: false, needs_email: false,
      verified_by: vr.verifiedBy, verify_detail: vr.verifyLabel, tags,
      recovered: true, recovered_at: new Date(), sendkit_campaigns: landed, updated_at: new Date(),
    },
  });
  const campaign = (d.campaigns || [])[0] || "";
  await bumpUsage(campaign, { sendkit_pushed: 1 });
}

// returns a MISS_REASONS key describing the outcome
async function reprocessOne(d, deep) {
  return d.email_status === "unverified" ? recoverUnverified(d, deep) : recoverNoEmail(d, deep);
}

// `campaigns` is the exact set the user ticked. Leads are matched with $in, so a person who
// sits in two selected campaigns is retried ONCE — the per-campaign totals overlap and must
// never be summed. (Count endpoint only — counts the no-email pool the UI shows.)
export function noEmailQuery(campaigns = []) {
  const q = { email_status: "no-email" };
  if (campaigns.length) q.campaigns = { $in: campaigns };
  return q;
}

export async function reprocessNoEmail({ limit = 0, concurrency = 4, campaigns = [], deep = false } = {}) {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  // Invariant: a lead with no email cannot also be flagged "recovered". Older builds could
  // demote a recovered lead back to no-email without clearing the flag; heal that here.
  await leads().updateMany({ email_status: "no-email", recovered: true }, { $set: { recovered: false } });

  // Both pools: no-email (full waterfall) + unverified (alternate-domain recovery).
  const [noEmailDocs, unverDocs] = await Promise.all([
    leads().find(noEmailRetryQuery(campaigns, deep)).toArray(),
    leads().find(unverifiedRetryQuery(campaigns, deep)).toArray(),
  ]);
  let docs = [...noEmailDocs, ...unverDocs];
  const list = limit ? docs.slice(0, limit) : docs;
  const reasons = {};
  status = { running: true, deep, processed: 0, total: list.length, newlyFound: 0, reasons, campaigns, startedAt: new Date(), finishedAt: null };

  let idx = 0;
  const worker = async () => {
    while (idx < list.length) {
      const d = list[idx++];
      let reason = "no_email_found";
      try { reason = await reprocessOne(d, deep); }
      catch (e) { reason = "error"; log.warn("reprocess one failed", { err: e.message }); }
      reasons[reason] = (reasons[reason] || 0) + 1;
      if (reason === "recovered") status.newlyFound++;
      status.processed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));

  const finishedAt = new Date();
  status = { ...status, running: false, finishedAt };
  running = false;
  await meterFlush(); // persist the API consumption this run spent

  // Persist the run so the hand-off tab can show a history: how many recovered per run, and why
  // the rest missed. `at` is stamped by the route (workflow scripts can't call Date.now()).
  try {
    await reprocessRuns().insertOne({
      startedAt: status.startedAt, finishedAt, deep,
      processed: status.processed, recovered: status.newlyFound,
      campaigns, reasons,
    });
  } catch (e) { log.warn("reprocess run log failed", { err: e.message }); }

  log.info("reprocess done", { processed: status.processed, recovered: status.newlyFound, deep, reasons });
  return { processed: status.processed, newlyFound: status.newlyFound, total: status.total, reasons };
}
