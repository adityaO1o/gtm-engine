// Creator Programme — the customer base as an outreach list, filtered for who can actually create.
//
// Two things are deliberately kept apart in here, because collapsing them was the first thing that
// went wrong when this was designed:
//
//   1. COMMERCIAL PRIORITY — which customers we talk to, and in what order. That comes from the
//      extract (P1_CHURN -> P1b_AT_RISK -> P2_PAYING -> P3a -> P3b -> P3c) and is FIXED. Nothing in
//      this file reorders it.
//   2. CREATOR FIT — of the people inside a tier, who has an audience worth a creator ask. This is a
//      filter applied WITHIN a tier.
//
// Failing the creator filter does NOT drop anyone from outreach. It only means they get the normal
// win-back / upsell message instead of a creator ask. `creator_fit` is a label on the row, never a
// reason to delete it.
//
// The extract ships emails and no social data whatsoever — no person-level LinkedIn anywhere, and
// company LinkedIn on only 16% of companies. So every creator signal has to be resolved from the
// email, which is what the enrichment pass below does.
import { creatorPeople, creatorCompanies, creatorRuns, leads } from "../db/mongo.js";
import { reverseEmailLookup, normaliseLinkedin } from "../services/enrich.js";
import { resolveVanity } from "../services/resolve.js";
import { pndExactDomain, pndFindPerson, pndCompanyOnLinkedin, setPndBudget, pndBudget, paidBlocked } from "../services/pnd.js";
import { fetchPublicProfile, linkedinPublicStats } from "../services/linkedinPublic.js";
import { runPool } from "../lib/pool.js";
import { log } from "../lib/logger.js";

// The agreed outreach order. Index = rank, so a sort on priority_rank is the running order.
export const PRIORITY_ORDER = [
  "P1_CHURN", "P1b_AT_RISK", "P2_PAYING", "P3a_FREE_ACTIVATED", "P3b_FREE_TRIED", "P3c_FREE_DORMANT",
];
const RANK = Object.fromEntries(PRIORITY_ORDER.map((p, i) => [p, i + 1]));

// The running order as it is actually worked. P2_PAYING is split in two: the customers whose spend
// is going UP are their own step, taken before the rest of the paying base, because they are the
// Creator Programme's core and finding 350 of them inside a 3,255-person tier by eye is not a job.
// This splits a tier, it does not reorder the tiers — P2 growing and P2 rest both still sit after
// P1b and before P3.
export const SEGMENTS = [
  "P1_CHURN", "P1b_AT_RISK", "P2_GROWING", "P2_PAYING", "P3a_FREE_ACTIVATED", "P3b_FREE_TRIED", "P3c_FREE_DORMANT",
];
const SEG_RANK = Object.fromEntries(SEGMENTS.map((s, i) => [s, i + 1]));
// Mongo expression: which segment a document belongs to.
const SEG_EXPR = { $cond: [{ $and: [{ $eq: ["$contact_priority", "P2_PAYING"] }, { $eq: ["$is_growing", true] }] }, "P2_GROWING", "$contact_priority"] };
// Query form of the same split, for filtering.
export function segmentQuery(seg) {
  if (seg === "P2_GROWING") return { contact_priority: "P2_PAYING", is_growing: true };
  if (seg === "P2_PAYING") return { contact_priority: "P2_PAYING", is_growing: { $ne: true } };
  return { contact_priority: seg };
}

// Defaults for the creator gates. Every one is overridable per-run from the UI — the whole point of
// this tab is that the thresholds are tunable, not baked in.
export const DEFAULT_GATES = {
  minAudience: 500,      // network floor. 500 is LinkedIn's connection cap, i.e. "a full network"
  minFollowers: 1000,    // once real follower data exists it wins over the capped connection count
  requirePublic: true,   // a private profile can't carry a public post, so it can't create
};

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────
// RFC4180: quoted fields may contain commas, newlines and doubled quotes. The extract's job_title
// column carries commas, so a naive split() silently shifts every later column on those rows —
// which is exactly how a sample of "customers" came back full of test accounts the first time.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const hdr = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(hdr.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const numOf = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; };
const intOf = (v) => { const n = parseInt(String(v ?? "").replace(/[^0-9\-]/g, ""), 10); return Number.isFinite(n) ? n : null; };
const yes = (v) => String(v ?? "").trim().toLowerCase() === "yes";
// The extract writes the literal string "Unknown" into job_title for 5,041 of 8,225 people. That is
// absence, not a title — treating it as filled is what makes the coverage look like 96% when the
// real figure is ~35%.
const titleOf = (v) => { const t = String(v ?? "").trim(); return !t || /^unknown$/i.test(t) ? null : t; };
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

// ── Import ──────────────────────────────────────────────────────────────────────────────────────
// The CSVs hold customer PII, so they are never committed to the repo — they are uploaded into the
// engine and live only in Mongo. Re-uploading a fresh extract overwrites cleanly: company and
// commercial fields are replaced, while everything the enrichment pass discovered is preserved, so
// refreshing the churn numbers never costs the LinkedIn work again.
// The two files upload separately (each is bigger than the JSON body limit, and companies.csv alone
// is 2.3MB). Order does not matter for correctness — but companies first is better, because the
// people import copies company context onto each person as it goes.
export async function importCreatorCompanies(companiesCsv = "") {
  const started = new Date();
  const companies = parseCsv(companiesCsv);
  if (!companies.length) return { ok: false, error: "no rows parsed — is this companies.csv?" };
  if (!("company_id" in companies[0])) return { ok: false, error: "companies.csv must have a company_id column" };

  {
    const ops = [];
    for (const c of companies) {
      const id = c.company_id;
      if (!id) continue;
      const doc = {
        company_id: id,
        contact_priority: c.contact_priority || null,
        priority_rank: RANK[c.contact_priority] ?? 99,
        priority_reason: c.priority_reason || null,
        free_status: c.free_status || null,
        company_name: c.company_name || null,
        company_domain: (c.company_domain || "").toLowerCase() || null,
        primary_email: (c.primary_email || "").toLowerCase() || null,
        team_name: c.team_name || null,
        signup_date: c.signup_date || null,
        first_invoice_date: c.first_invoice_date || null,
        days_to_convert: intOf(c.days_to_convert),
        customer_age_days: intOf(c.customer_age_days),
        lifetime_spend: numOf(c.lifetime_spend) ?? 0,
        window_spend: numOf(c.window_spend),
        avg_monthly_baseline: numOf(c.avg_monthly_baseline),
        recent_monthly_runrate: numOf(c.recent_monthly_runrate),
        drop_vs_normal_pct: numOf(c.drop_vs_normal_pct),
        churn_band: c.churn_band || null,
        trend_direction: c.trend_direction || null,
        trend_slope: numOf(c.trend_slope),
        months_since_last_invoice: intOf(c.months_since_last_invoice),
        peak_month_spend: numOf(c.peak_month_spend),
        active_months: intOf(c.active_months),
        invoice_count: intOf(c.invoice_count),
        guard_flags: c.guard_flags || null,
        subscription_status: c.subscription_status || null,
        credits_balance: numOf(c.credits_balance),
        is_blocked: yes(c.is_blocked),
        mailbox_count_active: intOf(c.mailbox_count_active),
        mailbox_count_failed: intOf(c.mailbox_count_failed),
        mailboxes_deleted_120d: intOf(c.mailboxes_deleted_120d),
        top_deletion_reason: c.top_deletion_reason || null,
        domain_count_active: intOf(c.domain_count_active),
        slot_change_direction: c.slot_change_direction || null,
        domains_added_180d: intOf(c.domains_added_180d),
        mailboxes_added_180d: intOf(c.mailboxes_added_180d),
        user_count: intOf(c.user_count),
        company_size: c.company_size || null,
        staff_count: intOf(c.staff_count),
        industry: c.industry || null,
        company_type: c.company_type || null,
        segment: c.segment || null,
        company_linkedin_url: c.company_linkedin_url || null,
        country: c.country || null,
        city: c.city || null,
        enrichment_status: c.enrichment_status || null,
        importedAt: started,
      };
      Object.assign(doc, growthOf(doc));
      ops.push({ updateOne: { filter: { _id: id }, update: { $set: doc }, upsert: true } });
    }
    for (let i = 0; i < ops.length; i += 1000) await creatorCompanies().bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    await creatorRuns().insertOne({ kind: "import-companies", startedAt: started, finishedAt: new Date(), companies: ops.length });
    log.info("creator companies imported", { companies: ops.length });
    return { ok: true, companies: ops.length };
  }
}

// spend_monthly.csv — the month-by-month revenue behind every churn and growth number. Only
// non-zero buckets are written by the extract, so a missing month is a real zero and is filled in
// as one; without that a customer who stopped paying would look like they have no data rather than
// no revenue, which is the whole point of the chart.
export async function importCreatorSpend(spendCsv = "") {
  const started = new Date();
  const rows = parseCsv(spendCsv);
  if (!rows.length) return { ok: false, error: "no rows parsed — is this spend_monthly.csv?" };
  if (!("bucket" in rows[0])) return { ok: false, error: "spend_monthly.csv must have a bucket column" };

  const byCompany = new Map();
  for (const r of rows) {
    const id = r.company_id;
    if (!id) continue;
    const m = /^M(\d+)$/i.exec((r.bucket || "").trim());
    if (!m) continue;
    const idx = parseInt(m[1], 10);            // M1 = most recent 30 days
    const b = byCompany.get(id) || byCompany.set(id, new Map()).get(id);
    b.set(idx, { spend: numOf(r.spend_usd) ?? 0, start: r.bucket_start || null, end: r.bucket_end || null });
  }

  const ops = [];
  for (const [id, b] of byCompany) {
    const width = Math.max(...b.keys());
    // Oldest first, so the array reads left-to-right the way the chart is drawn.
    const buckets = [];
    for (let i = width; i >= 1; i--) {
      const v = b.get(i);
      buckets.push({ m: `M${i}`, spend: v?.spend ?? 0, start: v?.start ?? null, end: v?.end ?? null });
    }
    ops.push({ updateOne: { filter: { _id: id }, update: { $set: { buckets } } } });
  }
  for (let i = 0; i < ops.length; i += 1000) await creatorCompanies().bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  await creatorRuns().insertOne({ kind: "import-spend", startedAt: started, finishedAt: new Date(), companies: ops.length, rows: rows.length });
  log.info("creator spend imported", { companies: ops.length, rows: rows.length });
  return { ok: true, companies: ops.length, rows: rows.length };
}

export async function importCreatorUsers(usersCsv = "") {
  const started = new Date();
  const users = parseCsv(usersCsv);
  if (!users.length) return { ok: false, error: "no rows parsed — is this company_users.csv?" };
  if (!("user_email" in users[0])) return { ok: false, error: "company_users.csv must have a user_email column" };

  // Company context, loaded once. 6,356 small docs — cheap enough to hold, and it means a person's
  // row carries everything outreach needs without a join at read time.
  const byCompany = new Map();
  for await (const c of creatorCompanies().find({})) byCompany.set(c._id, c);

  // One doc per PERSON. The same human appears on several teams, so rows are merged by email and the
  // person is filed under their HIGHEST-priority team — a churning account outranks a healthy one,
  // because that is the more urgent conversation to have with that human.
  const merged = new Map();
  let skipped = 0;
  for (const u of users) {
    const email = (u.user_email || "").trim().toLowerCase();
    if (!EMAIL_RX.test(email)) { skipped++; continue; }
    const tier = u.contact_priority || null;
    const rank = RANK[tier] ?? 99;
    const co = byCompany.get(u.company_id) || {};
    const prev = merged.get(email);
    const row = {
      email,
      user_name: u.user_name || null,
      job_title: titleOf(u.job_title),
      role: u.role || null,
      active: yes(u.active),
      country: u.country || co.country || null,
      engagement_score: numOf(u.engagement_score),
      unsubscribed: yes(u.unsubscribed),
      contact_priority: tier,
      priority_rank: rank,
      priority_reason: u.priority_reason || co.priority_reason || null,
      free_status: u.free_status || co.free_status || null,
      company_id: u.company_id || null,
      company_name: u.company_name || co.company_name || null,
      company_domain: (u.company_domain || co.company_domain || "").toLowerCase() || null,
      churn_band: u.churn_band || co.churn_band || null,
      trend_direction: co.trend_direction || null,
      // The maths behind the verdict, carried onto the row so a churn call can be justified where
      // it is made instead of "RED, trust me". baseline = this customer's own normal over the
      // 6-month window; runrate = what they spend now (last 60 days); drop = the change between
      // them, which is the number the band is cut from.
      avg_monthly_baseline: co.avg_monthly_baseline ?? null,
      recent_monthly_runrate: co.recent_monthly_runrate ?? null,
      drop_vs_normal_pct: co.drop_vs_normal_pct ?? null,
      peak_month_spend: co.peak_month_spend ?? null,
      window_spend: co.window_spend ?? null,
      active_months: co.active_months ?? null,
      invoice_count: co.invoice_count ?? null,
      // M6 (oldest) -> M1 (most recent), one number per 30-day bucket. This is the raw evidence:
      // every churn and growth figure can be re-derived from it by hand.
      buckets: co.buckets || null,
      lifetime_spend: numOf(u.lifetime_spend) ?? co.lifetime_spend ?? 0,
      // Carried onto the person so outreach can be written straight off this row, no join needed.
      segment: co.segment || null,
      industry: co.industry || null,
      staff_count: co.staff_count ?? null,
      company_linkedin_url: co.company_linkedin_url || null,
      subscription_status: co.subscription_status || null,
      mailbox_count_active: co.mailbox_count_active ?? null,
      mailbox_count_failed: co.mailbox_count_failed ?? null,
      top_deletion_reason: co.top_deletion_reason || null,
      months_since_last_invoice: co.months_since_last_invoice ?? null,
      slot_change_direction: co.slot_change_direction || null,
      domains_added_180d: co.domains_added_180d ?? null,
      mailboxes_added_180d: co.mailboxes_added_180d ?? null,
      guard_flags: co.guard_flags || null,
      teams: [u.company_id].filter(Boolean),
    };
    Object.assign(row, growthOf(row));
    if (!prev) { merged.set(email, row); continue; }
    // Keep the more urgent tier; keep the larger spend; union the teams.
    const teams = [...new Set([...(prev.teams || []), ...(row.teams || [])])];
    const winner = row.priority_rank < prev.priority_rank ? row : prev;
    merged.set(email, {
      ...winner,
      teams,
      lifetime_spend: Math.max(prev.lifetime_spend || 0, row.lifetime_spend || 0),
      job_title: winner.job_title || prev.job_title || row.job_title || null,
      unsubscribed: prev.unsubscribed || row.unsubscribed,
    });
  }

  const ops = [...merged.values()].map((p) => ({
    updateOne: {
      filter: { _id: p.email },
      update: {
        $set: { ...p, importedAt: started },
        // Enrichment survives a re-import: only set on first insert, never overwritten.
        $setOnInsert: { enrich_status: "pending", creator_fit: "UNRESOLVED", li_url: null },
      },
      upsert: true,
    },
  }));
  for (let i = 0; i < ops.length; i += 1000) await creatorPeople().bulkWrite(ops.slice(i, i + 1000), { ordered: false });

  const matched = await matchOwnAudience();
  await creatorRuns().insertOne({
    kind: "import", startedAt: started, finishedAt: new Date(),
    companies: byCompany.size, usersRows: users.length, people: merged.size, skipped, audienceMatched: matched,
  });
  log.info("creator people imported", { companies: byCompany.size, rows: users.length, people: merged.size, skipped });
  return {
    ok: true, companies: byCompany.size, rows: users.length, people: merged.size,
    duplicatesMerged: users.length - merged.size - skipped, skipped, audienceMatched: matched,
  };
}

// ── Our own audience ────────────────────────────────────────────────────────────────────────────
// The network angle, done with data we already own rather than by scraping strangers.
//
// The engine's `leads` collection is 83k people built from LinkedIn engagement on posts in our own
// categories — deliverability, infra, sequencers, agencies. Where a customer also appears there, we
// already know they are active on LinkedIn, in our topic, and inside our network. That is a far
// better creator signal than any bought follower count, and it costs nothing.
export async function matchOwnAudience() {
  let matched = 0;
  const cursor = creatorPeople().find({}, { projection: { _id: 1, li_url: 1 } });
  const batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const emails = batch.map((b) => b._id);
    const urls = batch.map((b) => b.li_url).filter(Boolean);
    const hits = await leads().find(
      { $or: [{ email: { $in: emails } }, ...(urls.length ? [{ linkedin_url: { $in: urls } }] : [])] },
      { projection: { email: 1, linkedin_url: 1, score: 1, status: 1, categories: 1, company: 1 } }
    ).toArray();
    const byEmail = new Map(), byUrl = new Map();
    for (const h of hits) {
      if (h.email) byEmail.set(String(h.email).toLowerCase(), h);
      if (h.linkedin_url) byUrl.set(h.linkedin_url, h);
    }
    const ops = [];
    for (const b of batch) {
      const h = byEmail.get(b._id) || (b.li_url ? byUrl.get(b.li_url) : null);
      if (!h) continue;
      matched++;
      ops.push({ updateOne: { filter: { _id: b._id }, update: { $set: {
        in_audience: true,
        audience_score: h.score ?? null,
        audience_status: h.status || null,
        audience_categories: h.categories || [],
        // A lead doc is keyed by linkedin_url, so a match hands us the profile for free — no
        // reverse lookup, no SERP call, no credit spent.
        ...(h.linkedin_url && !b.li_url ? { li_url: h.linkedin_url, li_source: "own-audience", enrich_status: "hit" } : {}),
      } } } });
    }
    if (ops.length) await creatorPeople().bulkWrite(ops, { ordered: false });
    batch.length = 0;
  };
  for await (const p of cursor) { batch.push(p); if (batch.length >= 1000) await flush(); }
  await flush();
  log.info("creator own-audience match", { matched });
  return matched;
}

// ── Growth ──────────────────────────────────────────────────────────────────────────────────────
// Growth is a REVENUE fact, and it only exists where two things are true at once:
//
//   1. The customer PAYS. A free account has $0 lifetime spend — there is no revenue to grow, so
//      "a growing free signup" is a contradiction, not a segment.
//   2. There is enough history to measure it. A customer younger than the 6-month window has empty
//      early buckets simply because they did not exist yet, so a least-squares slope over those
//      buckets comes out positive automatically. That is being NEW, not growing.
//
// Both guards were missing in the first cut and it produced nonsense: 25 "growing" people inside
// P1_CHURN, and growth inside the free tiers.
//
// Two signals were tried and REMOVED — do not add them back without re-checking the data:
//
//   * slot_change_direction === "UP" — not an upgrade signal. Only 594 companies have any
//     slots_*_prev above zero, yet 766 read UP: every sampled case was 0 -> 10 or 0 -> 30, so UP
//     mostly means "has slots recorded now", not "bought more". It was the sole source of the
//     phantom growth in P1_CHURN (all 10 of those companies are RED/CHURNED, several at -100%)
//     and of all growth in the free tiers.
//   * domains/mailboxes added in 180d — real activity, but true of 2,218 companies and not revenue.
//     Adding a domain is something a shrinking account does too.
//
// What survives is what the money actually supports: 134 companies, $1.36M, all of them P2_PAYING.
const GROWTH_RANK = ["EXPANDING", "GROWING", "RISING"];

export function growthOf(p) {
  const paying = (p.lifetime_spend || 0) > 0;
  // guard_flags carries INSUFFICIENT_HISTORY / ONE_TIME_BUYER / NO_WINDOW_SPEND — every case where
  // the extract itself says the trend cannot be scored honestly. 1,327 of the 1,463 RISING
  // companies carry INSUFFICIENT_HISTORY, i.e. nearly all of "rising" was young accounts.
  const scorable = !String(p.guard_flags || "").trim();
  if (!paying || !scorable) return { growth: "NONE", growth_reasons: [], is_growing: false };

  const reasons = [];
  if (p.churn_band === "EXPANDING") reasons.push("EXPANDING");
  else if (p.churn_band === "GROWING") reasons.push("GROWING");
  // The quiet climber, and the exact mirror of P1b: the band says nothing is happening while the
  // slope says the account is going up. 57 companies read STABLE + RISING and no band shows them.
  else if (p.churn_band === "STABLE" && p.trend_direction === "RISING") reasons.push("RISING");

  const growth = GROWTH_RANK.find((g) => reasons.includes(g)) || "NONE";
  return { growth, growth_reasons: reasons, is_growing: growth !== "NONE" };
}

// ── Creator gates ───────────────────────────────────────────────────────────────────────────────
// Applied WITHIN a tier. `creator_fit` is a label, never a delete:
//   UNRESOLVED — enrichment has not reached this person yet
//   NO_PROFILE — we looked and found no LinkedIn. Not a creator; still gets normal outreach
//   WEAK       — profile found, audience below the floor. Case-study / testimonial material
//   CANDIDATE  — profile + audience clear the floor. Ready for the posting/topic pass
//   QUALIFIED  — cleared the posting and topic gates too
export function scoreCreator(p, gates = DEFAULT_GATES) {
  const g = { ...DEFAULT_GATES, ...(gates || {}) };
  if (!p.li_url) {
    return p.enrich_status === "pending"
      ? { creator_fit: "UNRESOLVED", creator_reason: "not enriched yet", audience: null, audience_source: null }
      : { creator_fit: "NO_PROFILE", creator_reason: "no LinkedIn profile found", audience: null, audience_source: null };
  }
  // A profile nobody could tie back to this customer is not evidence about this customer. It stays
  // on the row to be looked at, but it never earns a creator label.
  if (p.li_verified === false) {
    return { creator_fit: "UNVERIFIED", creator_reason: p.li_verify_note || "profile could not be confirmed as this person", audience: null, audience_source: null };
  }
  // Real followers beat a connection count, which LinkedIn caps at 500 and so cannot separate a
  // 500-connection consultant from a 200,000-follower creator.
  const followers = typeof p.li_followers === "number" ? p.li_followers : null;
  const audience = followers ?? (typeof p.li_connections === "number" ? p.li_connections : null);
  const source = followers != null ? "followers" : audience != null ? "connections" : null;
  const reasons = [];
  if (g.requirePublic && p.li_public === false) {
    return { creator_fit: "WEAK", creator_reason: "profile is private — cannot post publicly", audience, audience_source: source };
  }
  const floor = source === "followers" ? g.minFollowers : g.minAudience;
  if (audience == null) reasons.push("audience size unknown");
  else if (audience < floor) reasons.push(`${source} ${audience} below floor ${floor}`);
  if (reasons.length) return { creator_fit: "WEAK", creator_reason: reasons.join("; "), audience, audience_source: source };

  const capped = source === "connections" && p.li_connections_capped;
  const base = capped ? "full network (500+ connections, true size unknown)" : `${audience} ${source}`;
  if (p.posts_90d == null) {
    return { creator_fit: "CANDIDATE", creator_reason: `${base} — posting activity not checked yet`, audience, audience_source: source };
  }
  if (!p.posts_90d) return { creator_fit: "WEAK", creator_reason: "has not posted in 90 days", audience, audience_source: source };
  const topical = (p.topic_hits || 0) > 0;
  return {
    creator_fit: "QUALIFIED",
    creator_reason: `${base}, ${p.posts_90d} posts/90d${topical ? ", posts on our topics" : ", off-topic"}`,
    audience, audience_source: source,
  };
}

// ── Is this actually our customer? ──────────────────────────────────────────────────────────────
// The SERP resolver answers "who on LinkedIn looks like this name", not "which human is this
// email". Its matcher accepts a hit when ANY single name token appears anywhere in the snippet, it
// falls back to a name-only query when name+company finds nothing, and when nothing matches at all
// it still returns the first result. So a customer called Sukhvir Sharma resolves to whichever
// Sharma is most famous, and the company it scrapes out of the snippet is never compared to ours.
//
// For a creator programme a wrong profile is worse than no profile: we would score a stranger's
// audience and then pitch the wrong human. So a SERP result is a CANDIDATE until something ties it
// back to this customer. Checks run cheapest first and the profile is dropped if none of them hold.
//
// Results reached any other way need no check: a reverse-email-lookup hit came FROM the email, and
// an own-audience match came from our engagement DB keyed on the same address.
const alphaOnly = (v) => String(v || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const domainRoot = (d) => String(d || "").toLowerCase().replace(/^www\./, "").split(".")[0];

function nameLooksRight(name, ...hay) {
  const toks = String(name || "").split(/\s+/).map(alphaOnly).filter((t) => t.length >= 3);
  if (!toks.length) return true;
  const h = alphaOnly(hay.join(" "));
  // EVERY token, not any — "any" is what lets a shared surname through.
  return toks.every((t) => h.includes(t));
}

function companyLooksRight(theirs, ours, ourDomain) {
  const a = alphaOnly(theirs);
  if (!a) return false;
  for (const b of [alphaOnly(ours), alphaOnly(domainRoot(ourDomain))]) {
    if (b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  }
  return false;
}

export async function verifySerpProfile({ url, name, serpCompany, company, domain, usePnd = true }) {
  const vanity = (url || "").split("/in/")[1] || "";
  if (!nameLooksRight(name, vanity, serpCompany)) {
    // The vanity slug rarely carries a full name, so this only rejects an outright different person.
    if (!nameLooksRight(name, vanity)) return { ok: false, why: "name does not match the profile" };
  }
  // Free: the company the SERP snippet exposed, against the company we already know.
  if (companyLooksRight(serpCompany, company, domain)) return { ok: true, how: "serp-company" };

  // Paid, and the only definitive check available: read the profile's CURRENT employer straight
  // from LinkedIn and compare its exact website to the customer's domain, which the extract has on
  // 100% of companies. Cached per profile, so a retry is free. Skipped when PND is out of credit —
  // in that case the profile is kept but flagged unverified rather than silently trusted.
  if (usePnd && !paidBlocked()) {
    try {
      const p = await pndExactDomain(url);
      if (p) {
        if (p.domain && domain && domainRoot(p.domain) === domainRoot(domain)) return { ok: true, how: "pnd-domain", company: p.company };
        if (companyLooksRight(p.company, company, domain)) return { ok: true, how: "pnd-company", company: p.company };
        // A profile that resolves to a DIFFERENT employer is the exact failure we are hunting.
        if (p.domain || p.company) return { ok: false, why: `profile works at ${p.company || p.domain}, not ${company || domain}` };
      }
    } catch { /* fall through to unverified */ }
  }
  return { ok: null, why: "could not confirm this is the same person" };
}

// ── Enrichment run ──────────────────────────────────────────────────────────────────────────────
// Two tiers, cheapest first, in the fixed priority order so budget always lands on P1 before P3c:
//   1. enrich.so reverse email lookup — 10 credits, refunded on a miss. ~7% hit on this base.
//   2. SERP resolver (self-hosted, free) — name + company -> profile, for everyone tier 1 missed.
// Nobody is skipped: a miss on both is recorded as NO_PROFILE and keeps its place in outreach.
let state = { running: false, phase: "idle", done: 0, total: 0, hits: 0, pndHits: 0, serpHits: 0, unverified: 0, rejected: 0, noCompanyPage: 0, misses: 0, errors: 0, pndCap: 0, startedAt: null, finishedAt: null, tiers: [], stopping: false };
export const creatorEnrichStatus = () => ({ ...state, pndUsed: pndBudget().used, pndLeft: pndBudget().left });
export function stopCreatorEnrich() { if (state.running) state.stopping = true; return { ok: state.running }; }

export async function startCreatorEnrich({ tiers = [], limit = 0, redo = false, usePnd = true, useSerp = true, verifyWithPnd = true, pndCap = 0, gates = DEFAULT_GATES } = {}) {
  if (state.running) return { ok: false, error: "already running" };
  const q = {};
  // Scope accepts segments, so "P2 growing" can be enriched ahead of the rest of the paying base.
  if (tiers.length) q.$or = tiers.map(segmentQuery);
  if (!redo) q.enrich_status = "pending";
  const total = await creatorPeople().countDocuments(q);
  if (!total) return { ok: false, error: "nothing to enrich for that selection" };

  // Declare the paid budget up front. Without this a run can quietly drain a wallet — which is
  // exactly what the first one did.
  setPndBudget(pndCap);
  state = { running: true, phase: "reverse-lookup", done: 0, total: limit ? Math.min(limit, total) : total, hits: 0, pndHits: 0, serpHits: 0, unverified: 0, rejected: 0, noCompanyPage: 0, misses: 0, errors: 0, pndCap, startedAt: new Date(), finishedAt: null, tiers, stopping: false };
  const runAt = state.startedAt;
  creatorRuns().insertOne({ kind: "enrich", startedAt: runAt, tiers, limit, redo, useSerp, gates }).catch(() => {});

  (async () => {
    try {
      // Priority order is the work order — P1 is enriched before P2, always.
      const cur = creatorPeople().find(q, {
        projection: { _id: 1, user_name: 1, company_name: 1, company_domain: 1, contact_priority: 1, enrich_status: 1, posts_90d: 1, topic_hits: 1 },
      }).sort({ priority_rank: 1, lifetime_spend: -1 });
      const people = [];
      for await (const p of cur) { people.push(p); if (limit && people.length >= limit) break; }

      await runPool(people, async (p) => {
        if (state.stopping) return;
        let profile = null, source = null, verify = null;
        const r = await reverseEmailLookup(p._id);
        // Verified by construction: we handed it this email and it returned this person.
        if (r.ok) { profile = r.profile; source = "enrich"; verify = { ok: true, how: "email" }; state.hits++; }
        else if (r.status === "error") state.errors++;

        // Tier 2: LinkedIn's own people search, constrained to the company we already know. It
        // asks "is there a Peter O'Hanlon AT Mad Social", not "who is called Peter O'Hanlon", so a
        // hit is our customer by construction and needs no separate verification. Costs ~1 credit
        // per attempt, which is why it is pointed at the short high-value tiers rather than at
        // 6,000 rows.
        if (!profile && usePnd && !state.stopping && !paidBlocked() && pndBudget().left > 0) {
          try {
            // One cached lookup per company, shared by everyone who works there. A company with no
            // LinkedIn page rules out all of its people for free instead of each of them paying for
            // a search that cannot succeed.
            const onLi = await pndCompanyOnLinkedin(p.company_domain);
            const hit = onLi ? await pndFindPerson({ name: p.user_name || "", company: onLi }) : null;
            if (!onLi) state.noCompanyPage++;
            if (hit?.url) {
              profile = { li_url: normaliseLinkedin(hit.url) || hit.url, li_headline: hit.headline, li_name: hit.name, li_location: hit.location };
              source = "pnd-search";
              verify = { ok: true, how: hit.candidates === 1 ? "pnd-company-exact" : "pnd-company" };
              state.pndHits++;
            }
          } catch { /* fall through to the SERP */ }
        }

        // Tier 3, last resort: a generic web search. It finds people the others have never heard
        // of, but it answers the wrong question, so anything it returns must be verified.
        if (!profile && useSerp && !state.stopping) {
          try {
            const hit = await resolveVanity({ name: p.user_name || "", company: p.company_name || p.company_domain || "" });
            const url = hit?.url ? normaliseLinkedin(hit.url) : null;
            if (url) {
              const v = await verifySerpProfile({
                url, name: p.user_name || "", serpCompany: hit.company || null,
                company: p.company_name || null, domain: p.company_domain || null, usePnd: verifyWithPnd,
              });
              if (v.ok === false) { state.rejected++; }        // a different human — discard it
              else {
                profile = { li_url: url, li_company: v.company || hit.company || null };
                source = "serp"; verify = v;
                if (v.ok) state.serpHits++; else state.unverified++;
              }
            }
          } catch { /* resolver already logs; a miss is a miss */ }
        }

        const set = profile
          ? {
            ...profile, li_source: source, enrich_status: "hit", enriched_at: new Date(),
            // An unverified profile is kept and labelled, never silently trusted: creator scoring
            // ignores it, so a wrong match cannot become a creator pitch to the wrong human.
            li_verified: verify?.ok === true,
            li_verify: verify?.ok === true ? verify.how : "unverified",
            li_verify_note: verify?.ok === true ? null : (verify?.why || null),
          }
          : { enrich_status: "miss", enriched_at: new Date() };
        if (!profile) state.misses++;
        const scored = scoreCreator({ ...p, ...set }, gates);
        await creatorPeople().updateOne({ _id: p._id }, { $set: { ...set, ...scored } }).catch(() => {});
        state.done++;
      }, { concurrency: 8 });
    } catch (e) {
      log.warn("creator enrich run threw", { err: e.message });
    } finally {
      state.running = false; state.phase = state.stopping ? "stopped" : "done"; state.finishedAt = new Date();
      creatorRuns().updateOne({ kind: "enrich", startedAt: runAt }, { $set: {
        finishedAt: state.finishedAt, done: state.done, hits: state.hits, pndHits: state.pndHits, serpHits: state.serpHits, misses: state.misses, errors: state.errors,
      } }).catch(() => {});
      log.info("creator enrich finished", { done: state.done, hits: state.hits, serpHits: state.serpHits, misses: state.misses });
    }
  })();

  return { ok: true, started: true, total: state.total };
}

// ── Audience pass ───────────────────────────────────────────────────────────────────────────────
// Follower counts for the profiles already resolved. FREE — it reads the number off the public
// profile page through the existing rotating proxy pool, because no API sells it: PND has no
// follower endpoint at all and its profile call returns skills and job history but no audience
// numbers, while LinkedIn keeps the connection and follower LISTS private to the person themselves.
//
// This matters more than it sounds. Until now the gates only had a connection count, which LinkedIn
// caps at "500+" — so a consultant with a full address book and a creator with 41,000 followers
// looked identical. Measured on 15 real resolved customers: 8 came back on the first pass, ranging
// from 843 to 41,000 followers. The 7 that did not were blocked exit IPs (HTTP 999), not missing
// profiles, so re-running picks them up.
let audState = { running: false, done: 0, total: 0, found: 0, blocked: 0, startedAt: null, finishedAt: null, stopping: false };
export const creatorAudienceStatus = () => ({ ...audState, scrape: linkedinPublicStats() });
export function stopCreatorAudience() { if (audState.running) audState.stopping = true; return { ok: audState.running }; }

export async function startCreatorAudience({ tiers = [], limit = 0, redo = false, gates = DEFAULT_GATES } = {}) {
  if (audState.running) return { ok: false, error: "already running" };
  const q = { li_url: { $ne: null } };
  if (tiers.length) q.$or = tiers.map(segmentQuery);
  // A profile we already have a follower count for is skipped, so a re-run only chases the ones
  // that were blocked last time.
  if (!redo) q.li_followers = null;
  const total = await creatorPeople().countDocuments(q);
  if (!total) return { ok: false, error: "no resolved profiles need a follower count" };

  audState = { running: true, done: 0, total: limit ? Math.min(limit, total) : total, found: 0, blocked: 0, startedAt: new Date(), finishedAt: null, stopping: false };
  (async () => {
    try {
      const cur = creatorPeople().find(q, { projection: { _id: 1, li_url: 1, li_connections: 1, li_connections_capped: 1, li_public: 1, enrich_status: 1, li_verified: 1, li_verify_note: 1, posts_90d: 1, topic_hits: 1 } })
        .sort({ priority_rank: 1, lifetime_spend: -1 });
      const people = [];
      for await (const x of cur) { people.push(x); if (limit && people.length >= limit) break; }

      await runPool(people, async (x) => {
        if (audState.stopping) return;
        const r = await fetchPublicProfile(x.li_url, { attempts: 6 });
        if (r && r.followers != null) {
          const set = {
            li_followers: r.followers, li_followers_raw: r.followers_raw,
            li_connections_raw: r.connections_raw, followers_at: r.at,
          };
          await creatorPeople().updateOne({ _id: x._id }, { $set: { ...set, ...scoreCreator({ ...x, ...set }, gates) } }).catch(() => {});
          audState.found++;
        } else audState.blocked++;
        audState.done++;
      }, { concurrency: 6 });
    } catch (e) { log.warn("creator audience run threw", { err: e.message }); }
    finally {
      audState.running = false; audState.finishedAt = new Date();
      log.info("creator audience finished", { done: audState.done, found: audState.found, blocked: audState.blocked });
    }
  })();
  return { ok: true, started: true, total: audState.total };
}

// Re-run the gates over everyone without touching an API — this is how a threshold change in the UI
// takes effect. Cheap on purpose: tuning the filter must never cost a credit.
export async function rescoreCreators(gates = DEFAULT_GATES) {
  let n = 0;
  const cur = creatorPeople().find({}, { projection: {
    _id: 1, li_url: 1, li_connections: 1, li_connections_capped: 1, li_followers: 1, li_public: 1,
    enrich_status: 1, li_verified: 1, li_verify_note: 1, posts_90d: 1, topic_hits: 1,
  } });
  let ops = [];
  for await (const p of cur) {
    ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: scoreCreator(p, gates) } } });
    if (ops.length >= 1000) { await creatorPeople().bulkWrite(ops, { ordered: false }); n += ops.length; ops = []; }
  }
  if (ops.length) { await creatorPeople().bulkWrite(ops, { ordered: false }); n += ops.length; }
  return { ok: true, rescored: n };
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────
export async function creatorStats() {
  // Revenue is a COMPANY fact. The extract denormalises it onto every person, so summing it over
  // people multiplies a company's spend by its headcount — it reported $25.4M against a true $6.11M.
  // Money therefore comes from creator_companies (one row per company); headcount and creator
  // coverage come from creator_people.
  const money = await creatorCompanies().aggregate([
    { $addFields: { seg: SEG_EXPR } },
    { $group: { _id: "$seg", spend: { $sum: "$lifetime_spend" }, companies: { $sum: 1 } } },
  ]).toArray();
  const spendByTier = Object.fromEntries(money.map((m) => [m._id, { spend: m.spend, companies: m.companies }]));

  const rows = await creatorPeople().aggregate([
    { $addFields: { seg: SEG_EXPR } },
    { $group: {
      _id: "$seg",
      rank: { $min: "$priority_rank" },
      people: { $sum: 1 },
      resolved: { $sum: { $cond: [{ $ifNull: ["$li_url", false] }, 1, 0] } },
      pending: { $sum: { $cond: [{ $eq: ["$enrich_status", "pending"] }, 1, 0] } },
      inAudience: { $sum: { $cond: ["$in_audience", 1, 0] } },
      growing: { $sum: { $cond: ["$is_growing", 1, 0] } },
      qualified: { $sum: { $cond: [{ $eq: ["$creator_fit", "QUALIFIED"] }, 1, 0] } },
      candidate: { $sum: { $cond: [{ $eq: ["$creator_fit", "CANDIDATE"] }, 1, 0] } },
      weak: { $sum: { $cond: [{ $eq: ["$creator_fit", "WEAK"] }, 1, 0] } },
      noProfile: { $sum: { $cond: [{ $eq: ["$creator_fit", "NO_PROFILE"] }, 1, 0] } },
    } },
  ]).toArray();
  rows.sort((a, b) => (SEG_RANK[a._id] ?? 99) - (SEG_RANK[b._id] ?? 99));
  for (const r of rows) {
    r.spend = spendByTier[r._id]?.spend ?? 0;
    r.companies = spendByTier[r._id]?.companies ?? 0;
  }
  // Per-label growth counts, per tier and overall. The union alone is misleading: it is dominated by
  // RISING (a climbing slope off any base, so broad and low-precision), while EXPANDING and GROWING
  // are the sharp cut and UPGRADED is the one where the customer actually paid for more. Showing the
  // split is the difference between "2,531 are growing" and knowing which 163 to talk to first.
  const gb = await creatorPeople().aggregate([
    { $match: { growth_reasons: { $exists: true, $ne: [] } } },
    { $addFields: { seg: SEG_EXPR } },
    { $unwind: "$growth_reasons" },
    { $group: { _id: { tier: "$seg", reason: "$growth_reasons" }, n: { $sum: 1 } } },
  ]).toArray();
  const growthByTier = {}, growthTotals = {};
  for (const g of gb) {
    const { tier, reason } = g._id;
    (growthByTier[tier] || (growthByTier[tier] = {}))[reason] = g.n;
    growthTotals[reason] = (growthTotals[reason] || 0) + g.n;
  }
  for (const r of rows) r.growthBreakdown = growthByTier[r._id] || {};

  const companies = await creatorCompanies().estimatedDocumentCount();
  const totals = rows.reduce((a, r) => ({
    people: a.people + r.people, spend: a.spend + r.spend, resolved: a.resolved + r.resolved,
    pending: a.pending + r.pending, inAudience: a.inAudience + r.inAudience,
    growing: a.growing + r.growing,
    qualified: a.qualified + r.qualified, candidate: a.candidate + r.candidate,
    weak: a.weak + r.weak, noProfile: a.noProfile + r.noProfile,
  }), { people: 0, spend: 0, resolved: 0, pending: 0, inAudience: 0, growing: 0, qualified: 0, candidate: 0, weak: 0, noProfile: 0 });
  const lastImport = await creatorRuns().findOne({ kind: "import" }, { sort: { startedAt: -1 } });
  return { tiers: rows.map((r) => ({ tier: r._id, ...r, _id: undefined })), totals, growthTotals, companies, lastImport };
}

export function creatorFilter({ tier = "", fit = "", audience = "", q = "", inAudience = false, role = "", growth = "" } = {}) {
  const f = {};
  if (tier) Object.assign(f, segmentQuery(tier));
  if (fit) f.creator_fit = fit;
  if (role) f.role = role;
  if (inAudience) f.in_audience = true;
  // "any" is the union of the signals that actually separate accounts — SCALING alone is true of
  // nearly every paying customer, so it is reachable only by asking for it by name.
  if (growth === "any") f.is_growing = true;
  else if (growth) f.growth_reasons = growth;
  if (audience === "resolved") f.li_url = { $ne: null };
  else if (audience === "unresolved") f.li_url = null;
  if (q) {
    const rx = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    f.$or = [{ _id: { $regex: rx, $options: "i" } }, { user_name: { $regex: rx, $options: "i" } }, { company_name: { $regex: rx, $options: "i" } }, { company_domain: { $regex: rx, $options: "i" } }];
  }
  return f;
}

export async function creatorList(query = {}) {
  const f = creatorFilter(query);
  const page = Math.max(0, parseInt(query.page || "0", 10));
  const size = Math.min(500, Math.max(1, parseInt(query.size || "100", 10)));
  // Default sort is the outreach running order. Sorting by audience is opt-in, and even then it
  // stays inside the tier — the tiers themselves never reshuffle.
  const sort = query.sort === "audience" ? { priority_rank: 1, audience: -1 } : { priority_rank: 1, lifetime_spend: -1 };
  const [items, count] = await Promise.all([
    creatorPeople().find(f).sort(sort).skip(page * size).limit(size).toArray(),
    creatorPeople().countDocuments(f),
  ]);
  return { items, count, page, size };
}

const CSV_COLS = [
  "email", "user_name", "job_title", "role", "contact_priority", "priority_reason", "churn_band",
  "trend_direction", "avg_monthly_baseline", "recent_monthly_runrate", "drop_vs_normal_pct",
  "peak_month_spend", "active_months", "growth", "growth_reasons", "lifetime_spend", "company_name", "company_domain", "segment", "industry",
  "li_url", "li_headline", "li_company", "audience", "audience_source", "li_source",
  "li_verified", "li_verify", "li_verify_note",
  "creator_fit", "creator_reason", "in_audience", "audience_status", "audience_score",
  "subscription_status", "mailbox_count_active", "top_deletion_reason", "months_since_last_invoice",
];
export async function creatorCsv(query = {}) {
  const rows = await creatorPeople().find(creatorFilter(query)).sort({ priority_rank: 1, lifetime_spend: -1 }).limit(50000).toArray();
  const cell = (v) => {
    if (v == null) return "";
    const s = Array.isArray(v) ? v.join("|") : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLS.join(","), ...rows.map((r) => CSV_COLS.map((c) => cell(c === "email" ? r._id : r[c])).join(","))].join("\n");
}
