// BounceBan audit — re-verify EVERY lead we ever found an email for (verified + unverified) against
// BounceBan, and make BounceBan the source of truth:
//   • deliverable  -> keep/mark verified, push to SendKit (only BounceBan-approved addresses go out)
//   • not deliverable -> mark unverified, badge it, and pull it back out of SendKit
//
// It preserves the ORIGINAL verdict (bb_prev_verified_by / bb_prev_status) so the dashboard can show
// "Enrich said verified — BounceBan says no", i.e. a real scorecard of how good Enrich vs Prospeo
// actually were. Re-running never overwrites that original provider, so the scorecard stays honest.
//
// NOTE on "removing from SendKit": SendKit has no remove-from-campaign endpoint. DNC is the real
// guarantee — campaigns run skipDNC:true, so a DNC'd address is skipped at send time and can never
// be emailed. That is how a rejected lead is pulled back.

import { leads, bouncebanRuns } from "../db/mongo.js";
import { bouncebanVerify } from "../services/bounceban.js";
import { upsertLead, upsertLeads, addToCampaign, addLeadsToCampaign, addToDnc, fetchDncEmails, isBlockedBy, campaignMembers, assignEmailCampaign } from "../services/sendkit.js";
import { reconcileDnc } from "./dncSync.js";
import { sendkitIdsFor, CAMPAIGNS } from "../services/campaigns.js";
import { log } from "../lib/logger.js";

let running = false;
let status = { running: false, processed: 0, total: 0, confirmed: 0, rejected: 0, dnc: 0, dncFailed: 0, pushed: 0, pushFailed: 0, skippedDnc: 0, startedAt: null, finishedAt: null };
export function bouncebanAuditStatus() { return status; }

// Every lead we ever produced an email for — verified AND unverified.
export function auditQuery(campaigns = []) {
  const q = { email: { $nin: [null, ""] }, email_status: { $in: ["verified", "unverified"] } };
  if (campaigns.length) q.campaigns = { $in: campaigns };
  return q;
}

const tagsFor = (d) => [
  "gtm-auto", ...(d.categories || []).map((c) => "cat:" + c),
  "score:" + d.score, "seen:" + d.times_seen, d.status + "-lead", "bounceban-verified",
];

async function auditOne(d, dnc) {
  const b = await bouncebanVerify(d.email);
  if (!b) return; // BounceBan unusable for this one — leave the lead exactly as it was

  // Keep the ORIGINAL pre-audit verdict forever (a re-run must not overwrite it, or the scorecard
  // would slowly rewrite itself to "bounceban vs bounceban" and tell us nothing).
  const firstAudit = !d.bb_verdict;
  const set = {
    bb_checked_at: new Date(), bb_result: b.result, bb_score: b.score,
    bb_accept_all: b.acceptAll, bb_role: b.role, bb_free: b.free, bb_disposable: b.disposable,
  };
  if (firstAudit) { set.bb_prev_verified_by = d.verified_by || null; set.bb_prev_status = d.email_status || null; }

  if (b.deliverable) {
    Object.assign(set, {
      bb_verdict: "confirmed", email_status: "verified", unverified: false, needs_email: false,
      verified_by: "bounceban", verify_detail: `bounceban:${b.result}/${b.score}${b.acceptAll ? "/accept-all" : ""}`,
    });
    // SendKit is already blocking this address for a reason that has nothing to do with
    // deliverability (a competitor, a complaint, a manual block). BounceBan saying "deliverable"
    // is not a licence to push it back into a campaign.
    const blocked = isBlockedBy(dnc, d.email);
    if (blocked) set.dnc = true;
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: set });

    if (blocked) {
      status.skippedDnc++;
    } else {
      // Only BounceBan-approved addresses are pushed — and only count it pushed if it LANDED.
      try {
        const [first, ...rest] = (d.name || "").split(" ");
        const ok = await upsertLead({ email: d.email, firstName: first, lastName: rest.join(" "), companyName: d.company || "", jobTitle: d.headline || "", linkedinUrl: d.linkedin_url, tags: tagsFor(d) });
        if (!ok) {
          // Never let a failed push count as a push: that is exactly how ~2.7k leads showed as
          // "pushed" while SendKit had never heard of them.
          status.pushFailed++;
          await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { bb_push_failed: true } });
        } else {
          const landed = [];
          const desired = sendkitIdsFor(d.campaigns)[0];
          if (desired) { const cid = await assignEmailCampaign(d.email, desired); if (await addToCampaign(cid, d.email)) landed.push(cid); }
          if (landed.length) await leads().updateOne({ linkedin_url: d.linkedin_url }, { $addToSet: { sendkit_campaigns: { $each: landed } } });
          await leads().updateOne({ linkedin_url: d.linkedin_url }, { $unset: { bb_push_failed: "" } });
          status.pushed++;
        }
      } catch (e) { status.pushFailed++; log.warn("bb audit push failed", { email: d.email, err: e.message }); }
    }
    status.confirmed++;
  } else {
    Object.assign(set, {
      bb_verdict: "rejected", email_status: "unverified", unverified: true,
      verify_detail: `bounceban:${b.result}${b.score != null ? "/" + b.score : ""}`,
    });
    await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: set });
    // Pull it back out of SendKit: DNC is the only real guarantee (no remove endpoint exists).
    if (d.sendkit_campaigns?.length || d.email_status === "verified") {
      try {
        // addToDnc swallows its own errors and returns {added, failed} — it does NOT throw. Ignoring
        // that is how mark@stackoptimise.com ended up flagged dnc:true in our DB while SendKit had
        // never blocked him. A block we only *believe* in is worse than no block at all.
        const r = await addToDnc([d.email]);
        if (r.failed) {
          status.dncFailed++;
          await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { dnc_failed: true } });
          log.warn("bb audit dnc did not land", { email: d.email });
        } else {
          await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { dnc: true, dnc_at: new Date(), dnc_reason: "bounceban-rejected" }, $unset: { dnc_failed: "" } });
          status.dnc++;
        }
      } catch (e) { status.dncFailed++; log.warn("bb audit dnc failed", { email: d.email, err: e.message }); }
    }
    status.rejected++;
  }
}

export async function runBouncebanAudit({ concurrency = 8, campaigns = [], limit = 0 } = {}) {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  const all = await leads().find(auditQuery(campaigns)).toArray();
  const list = limit ? all.slice(0, limit) : all;
  status = { running: true, processed: 0, total: list.length, confirmed: 0, rejected: 0, dnc: 0, dncFailed: 0, pushed: 0, pushFailed: 0, skippedDnc: 0, campaigns, startedAt: new Date(), finishedAt: null };

  // Pull SendKit's block list FIRST, so a "deliverable" verdict can never re-push someone SendKit
  // is deliberately holding back, and so our own dnc flags stop drifting from SendKit's truth.
  let dncList = { emails: new Set(), domains: new Set() };
  try {
    const r = await reconcileDnc();
    dncList = r;
    status.dncSynced = r.marked;
    status.dncListSize = r.emails.size + r.domains.size;
  } catch (e) { log.warn("bb audit dnc preload failed", { err: e.message }); }

  let idx = 0;
  const worker = async () => {
    while (idx < list.length) {
      const d = list[idx++];
      try { await auditOne(d, dncList); } catch (e) { log.warn("bb audit one failed", { err: e.message }); }
      status.processed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));

  const finishedAt = new Date();
  status = { ...status, running: false, finishedAt };
  running = false;
  try {
    await bouncebanRuns().insertOne({
      startedAt: status.startedAt, finishedAt, campaigns,
      processed: status.processed, confirmed: status.confirmed, rejected: status.rejected, dnc: status.dnc,
      pushed: status.pushed, pushFailed: status.pushFailed, skippedDnc: status.skippedDnc,
    });
  } catch (e) { log.warn("bb audit run log failed", { err: e.message }); }
  log.info("bounceban audit done", { processed: status.processed, confirmed: status.confirmed, rejected: status.rejected, dnc: status.dnc, pushed: status.pushed, pushFailed: status.pushFailed, skippedDnc: status.skippedDnc });
  return { processed: status.processed, confirmed: status.confirmed, rejected: status.rejected, dnc: status.dnc, pushed: status.pushed, pushFailed: status.pushFailed };
}

// REPAIR: re-push every lead BounceBan confirmed, over the BULK path.
//
// The first audit pushed one HTTP call per lead at 8x concurrency, hit the rate limit, and (because
// upsertLead had no retry and its result was ignored) reported ~2.7k leads as pushed that SendKit
// never received. upsertLead is fixed now, but the leads it lost are still missing — this is the
// clean-up. Costs no BounceBan credits: every lead here was already verified.
//
// Idempotent by construction: SendKit upserts by email, and a lead already in a campaign comes back
// as "skipped", not an error. Safe to run twice.
let repairRunning = false;
let repairStatus = { running: false, phase: "idle", total: 0, uniqueEmails: 0, upserted: 0, added: 0, alreadyIn: 0, failed: 0, skippedDnc: 0, startedAt: null, finishedAt: null };
export function bouncebanRepairStatus() { return repairStatus; }

export async function runBouncebanRepair() {
  if (repairRunning) return { alreadyRunning: true, ...repairStatus };
  repairRunning = true;
  repairStatus = { running: true, phase: "reconciling dnc", total: 0, uniqueEmails: 0, upserted: 0, added: 0, alreadyIn: 0, failed: 0, skippedDnc: 0, startedAt: new Date(), finishedAt: null };

  try {
    // Pull SendKit's block list first — a repair must not quietly re-contact someone SendKit blocks.
    let blocked = { emails: new Set(), domains: new Set() };
    try { blocked = await reconcileDnc(); } catch (e) { log.warn("repair dnc preload failed", { err: e.message }); }
    const isBlocked = (e) => isBlockedBy(blocked, e);

    const docs = await leads().find({ bb_verdict: "confirmed", email: { $nin: [null, ""] } }).toArray();
    repairStatus.total = docs.length;

    // Dedupe by email: two LinkedIn profiles can resolve to the same address, and SendKit stores
    // ONE lead per email — pushing both is just an overwrite race.
    repairStatus.phase = "upserting";
    const byEmail = new Map();
    for (const d of docs) {
      const e = String(d.email).trim().toLowerCase();
      if (isBlocked(e)) { repairStatus.skippedDnc++; continue; }
      if (byEmail.has(e)) continue;
      const [first, ...rest] = (d.name || "").split(" ");
      byEmail.set(e, { email: e, firstName: first, lastName: rest.join(" "), companyName: d.company || "", jobTitle: d.headline || "", linkedinUrl: d.linkedin_url, tags: tagsFor(d) });
    }
    repairStatus.uniqueEmails = byEmail.size;

    const up = await upsertLeads([...byEmail.values()]);
    repairStatus.upserted = up.ok || 0;
    repairStatus.failed += up.failed || 0;

    // Then put each campaign's addresses in, 100 at a time.
    repairStatus.phase = "adding to campaigns";
    const perCampaign = new Map();
    for (const d of docs) {
      const e = String(d.email).trim().toLowerCase();
      if (isBlocked(e)) continue;
      const desired = sendkitIdsFor(d.campaigns)[0];
      if (!desired) continue;
      const cid = await assignEmailCampaign(e, desired); // global email→campaign lock
      if (!perCampaign.has(cid)) perCampaign.set(cid, new Set());
      perCampaign.get(cid).add(e);
    }
    for (const [cid, set] of perCampaign) {
      const r = await addLeadsToCampaign(cid, [...set]);
      repairStatus.added += r.added || 0;
      repairStatus.alreadyIn += r.skipped || 0;
      repairStatus.failed += r.failed || 0;
    }

    // Only clear the failure flag if the bulk push actually went through.
    if (!repairStatus.failed) await leads().updateMany({ bb_verdict: "confirmed" }, { $unset: { bb_push_failed: "" } });

    repairStatus = { ...repairStatus, running: false, phase: "done", finishedAt: new Date() };
    log.info("bounceban repair done", { total: repairStatus.total, uniqueEmails: repairStatus.uniqueEmails, upserted: repairStatus.upserted, added: repairStatus.added, alreadyIn: repairStatus.alreadyIn, failed: repairStatus.failed, skippedDnc: repairStatus.skippedDnc });
  } catch (e) {
    repairStatus = { ...repairStatus, running: false, phase: "failed", error: e.message, finishedAt: new Date() };
    log.warn("bounceban repair failed", { err: e.message });
  } finally { repairRunning = false; }
  return repairStatus;
}

// PROOF: don't take this pipeline's word for anything. Ask SendKit for its own block list and
// check it against every lead BounceBan rejected. The question being answered is the only one that
// matters: "can an address BounceBan rejected still be emailed?"
//
//   blocked  — rejected AND on SendKit's DNC list      -> can never be emailed  ✅
//   neverSent— rejected, not on DNC, never pushed      -> nothing to block      ✅
//   LEAKED   — rejected, not on DNC, but IS in SendKit -> could still be emailed ❌
export async function bouncebanProof() {
  const dnc = await fetchDncEmails();
  const { emails, domains, truncated } = dnc;
  const has = (e) => isBlockedBy(dnc, e);

  const proj = { projection: { email: 1, dnc: 1, sendkit_campaigns: 1, bb_prev_status: 1, bb_push_failed: 1, status: 1, name: 1 } };
  const [rejected, confirmed] = await Promise.all([
    leads().find({ bb_verdict: "rejected" }, proj).toArray(),
    leads().find({ bb_verdict: "confirmed" }, proj).toArray(),
  ]);

  // A rejected lead only needs blocking if it ever actually reached SendKit.
  const reached = (d) => !!d.sendkit_campaigns?.length || d.bb_prev_status === "verified";
  const blocked = rejected.filter((d) => has(d.email));
  const leaked = rejected.filter((d) => !has(d.email) && reached(d));
  const neverSent = rejected.filter((d) => !has(d.email) && !reached(d));

  // The inverse: BounceBan approved them, but SendKit blocks them anyway (competitors, complaints).
  const confirmedOnDnc = confirmed.filter((d) => has(d.email));
  const pushFailed = confirmed.filter((d) => d.bb_push_failed);

  // The OTHER direction, and the one that actually gets asked: of everyone SendKit can email, who
  // vouched for them? "No rejected lead can be emailed" does not imply "everyone emailable is
  // BounceBan-verified" — the first run of this found 34 addresses that were emailable without a
  // BounceBan verdict (32 from an old CSV import our pipeline never touched, 2 from the Enrich
  // fallback that no longer exists). Strangers only get in from outside our pipeline, so this has
  // to read SendKit's members rather than our leads.
  const okEmails = new Set(confirmed.map((d) => String(d.email).trim().toLowerCase()));
  const bbVerified = new Set(
    (await leads().find({ verified_by: "bounceban", email: { $nin: [null, ""] } }, { projection: { email: 1 } }).toArray())
      .map((d) => String(d.email).trim().toLowerCase())
  );
  const emailable = new Set();
  for (const c of CAMPAIGNS) {
    for (const m of await campaignMembers(c.sendkitId)) if (!has(m.email)) emailable.add(m.email);
  }
  const unvouched = [...emailable].filter((e) => !okEmails.has(e) && !bbVerified.has(e));

  return {
    checkedAt: new Date(),
    dncListSize: emails.size,
    dncDomains: domains.size,
    truncated, // if true the proof is INCOMPLETE — say so rather than claim a clean bill
    rejected: rejected.length,
    blocked: blocked.length,
    neverSent: neverSent.length,
    leaked: leaked.length,
    leakSample: leaked.slice(0, 10).map((d) => ({ email: d.email, name: d.name })),
    confirmed: confirmed.length,
    confirmedOnDnc: confirmedOnDnc.length,
    confirmedOnDncSample: confirmedOnDnc.slice(0, 10).map((d) => ({ email: d.email, status: d.status })),
    pushFailed: pushFailed.length,
    emailable: emailable.size,
    unvouched: unvouched.length,
    unvouchedSample: unvouched.slice(0, 10),
    clean: !truncated && leaked.length === 0 && unvouched.length === 0,
  };
}

// DNC every address SendKit can email that BounceBan never approved. These are strays from outside
// our pipeline (old CSV imports), so there is no lead of ours to fix — the block is the only lever.
export async function dncUnvouched() {
  const p = await bouncebanProof();
  if (p.truncated) return { skipped: true, reason: "DNC list read short — refusing to act on an incomplete picture" };
  if (!p.unvouched) return { dnc: 0, unvouched: 0 };
  const all = [];
  const { emails, domains } = await fetchDncEmails();
  const dnc = { emails, domains };
  for (const c of CAMPAIGNS) {
    for (const m of await campaignMembers(c.sendkitId)) if (!isBlockedBy(dnc, m.email)) all.push(m.email);
  }
  const okEmails = new Set((await leads().find({ $or: [{ bb_verdict: "confirmed" }, { verified_by: "bounceban" }] }, { projection: { email: 1 } }).toArray())
    .map((d) => String(d.email).trim().toLowerCase()));
  const targets = [...new Set(all.filter((e) => !okEmails.has(e)))];
  const r = await addToDnc(targets);
  log.info("dnc'd unvouched emailable addresses", { targeted: targets.length, added: r.added, failed: r.failed });
  return { unvouched: targets.length, added: r.added, failed: r.failed, sample: targets.slice(0, 10) };
}

// Per-campaign before/after, built from SendKit's OWN member list rather than our belief about it.
//
// The first version of this reported "before" from bb_prev_status (= "our DB called it verified, so
// it must have been in the campaign"). That was fiction: of 861 rejected Cold Email addresses, only
// 67 had ever actually been members — the other 794 were leads the silent upsertLead failure never
// delivered. Any "before" derived from our own flags inherits that lie, so this reads SendKit's
// addedAt instead and compares it to when the audit started.
//
//   before  — SendKit had this member before the audit ran
//   added   — we put them there during/after it (the rescued ones)
//   blocked — a member SendKit will skip at send time (DNC / blocked domain)
//   emailable — members who will actually receive an email. This is the number that matters.
//
// Membership never falls: SendKit has no remove-from-campaign endpoint, so a rejected lead stays a
// member and is skipped. rejectedStillIn counts exactly those.
//
// Costs ~1 API call per 100 members (~120 for the full workspace), so it is on-demand, not cached.
export async function bouncebanCampaignReport() {
  const dnc = await fetchDncEmails();

  // When the first audit started — the line between "was already in the campaign" and "we put it
  // there". SendKit's addedAt is compared against this, so `before` is SendKit's record, not ours.
  const firstRun = await bouncebanRuns().find({}).sort({ startedAt: 1 }).limit(1).next();
  const since = firstRun?.startedAt ? new Date(firstRun.startedAt) : null;

  // Which addresses BounceBan rejected — used to label members, not to count them.
  const rejectedDocs = await leads().find({ bb_verdict: "rejected" }, { projection: { email: 1 } }).toArray();
  const rejected = new Set(rejectedDocs.map((d) => String(d.email).trim().toLowerCase()));

  const rows = [];
  for (const c of CAMPAIGNS) {
    const members = await campaignMembers(c.sendkitId);
    const r = { key: c.key, label: c.label, sendkitId: c.sendkitId, members: members.length, before: 0, added: 0, emailable: 0, blocked: 0, rejectedStillIn: 0, byStatus: {} };
    for (const m of members) {
      r.byStatus[m.status] = (r.byStatus[m.status] || 0) + 1;
      if (since && m.addedAt && new Date(m.addedAt) >= since) r.added++; else r.before++;
      if (isBlockedBy(dnc, m.email)) {
        r.blocked++;
        if (rejected.has(m.email)) r.rejectedStillIn++;
      } else r.emailable++;
    }
    rows.push(r);
  }

  const sum = (f) => rows.reduce((a, x) => a + x[f], 0);
  return {
    checkedAt: new Date(),
    since,
    truncated: dnc.truncated,
    campaigns: rows.filter((r) => r.members).sort((a, b) => b.emailable - a.emailable),
    totals: { members: sum("members"), before: sum("before"), added: sum("added"), emailable: sum("emailable"), blocked: sum("blocked"), rejectedStillIn: sum("rejectedStillIn") },
  };
}

// Scorecard: of the leads each provider ORIGINALLY verified, how many does BounceBan confirm/reject?
// This is the honest answer to "how good were Enrich and Prospeo actually?".
export async function bouncebanScorecard() {
  const rows = await leads().aggregate([
    { $match: { bb_verdict: { $in: ["confirmed", "rejected"] } } },
    { $group: {
      _id: { by: { $ifNull: ["$bb_prev_verified_by", "none"] }, was: { $ifNull: ["$bb_prev_status", "none"] } },
      n: { $sum: 1 },
      confirmed: { $sum: { $cond: [{ $eq: ["$bb_verdict", "confirmed"] }, 1, 0] } },
      rejected: { $sum: { $cond: [{ $eq: ["$bb_verdict", "rejected"] }, 1, 0] } },
      acceptAll: { $sum: { $cond: ["$bb_accept_all", 1, 0] } },
    } },
  ]).toArray();

  // Only leads a provider had marked VERIFIED are a fair test of that provider.
  const byProvider = {};
  for (const r of rows) {
    if (r._id.was !== "verified") continue;
    const k = r._id.by || "none";
    byProvider[k] = byProvider[k] || { provider: k, total: 0, confirmed: 0, rejected: 0, acceptAll: 0 };
    byProvider[k].total += r.n; byProvider[k].confirmed += r.confirmed;
    byProvider[k].rejected += r.rejected; byProvider[k].acceptAll += r.acceptAll;
  }
  const providers = Object.values(byProvider).map((p) => ({ ...p, accuracy: p.total ? Math.round((p.confirmed / p.total) * 100) : 0 }))
    .sort((a, b) => b.total - a.total);

  // And of the ones everyone had written off as unverified, how many are actually fine?
  const rescued = rows.filter((r) => r._id.was === "unverified").reduce((a, r) => a + r.confirmed, 0);
  const overall = rows.reduce((a, r) => ({
    audited: a.audited + r.n, confirmed: a.confirmed + r.confirmed,
    rejected: a.rejected + r.rejected, acceptAll: a.acceptAll + r.acceptAll,
  }), { audited: 0, confirmed: 0, rejected: 0, acceptAll: 0 });
  return { providers, rescued, overall, totalAudited: overall.audited };
}
