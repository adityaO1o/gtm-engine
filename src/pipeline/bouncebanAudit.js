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
import { upsertLead, addToCampaign, addToDnc, fetchDncEmails } from "../services/sendkit.js";
import { reconcileDnc } from "./dncSync.js";
import { sendkitIdsFor } from "../services/campaigns.js";
import { log } from "../lib/logger.js";

let running = false;
let status = { running: false, processed: 0, total: 0, confirmed: 0, rejected: 0, dnc: 0, pushed: 0, pushFailed: 0, skippedDnc: 0, startedAt: null, finishedAt: null };
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

async function auditOne(d, blockedSet) {
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
    const blocked = blockedSet.has(String(d.email).trim().toLowerCase());
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
          for (const cid of sendkitIdsFor(d.campaigns)) if (await addToCampaign(cid, d.email)) landed.push(cid);
          if (landed.length) await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { sendkit_campaigns: landed } });
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
        await addToDnc([d.email]);
        await leads().updateOne({ linkedin_url: d.linkedin_url }, { $set: { dnc: true, dnc_at: new Date(), dnc_reason: "bounceban-rejected" } });
        status.dnc++;
      } catch (e) { log.warn("bb audit dnc failed", { err: e.message }); }
    }
    status.rejected++;
  }
}

export async function runBouncebanAudit({ concurrency = 8, campaigns = [], limit = 0 } = {}) {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  const all = await leads().find(auditQuery(campaigns)).toArray();
  const list = limit ? all.slice(0, limit) : all;
  status = { running: true, processed: 0, total: list.length, confirmed: 0, rejected: 0, dnc: 0, pushed: 0, pushFailed: 0, skippedDnc: 0, campaigns, startedAt: new Date(), finishedAt: null };

  // Pull SendKit's block list FIRST, so a "deliverable" verdict can never re-push someone SendKit
  // is deliberately holding back, and so our own dnc flags stop drifting from SendKit's truth.
  let blockedSet = new Set();
  try {
    const r = await reconcileDnc();
    blockedSet = r.emails;
    status.dncSynced = r.marked;
    status.dncListSize = r.emails.size;
  } catch (e) { log.warn("bb audit dnc preload failed", { err: e.message }); }

  let idx = 0;
  const worker = async () => {
    while (idx < list.length) {
      const d = list[idx++];
      try { await auditOne(d, blockedSet); } catch (e) { log.warn("bb audit one failed", { err: e.message }); }
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

// PROOF: don't take this pipeline's word for anything. Ask SendKit for its own block list and
// check it against every lead BounceBan rejected. The question being answered is the only one that
// matters: "can an address BounceBan rejected still be emailed?"
//
//   blocked  — rejected AND on SendKit's DNC list      -> can never be emailed  ✅
//   neverSent— rejected, not on DNC, never pushed      -> nothing to block      ✅
//   LEAKED   — rejected, not on DNC, but IS in SendKit -> could still be emailed ❌
export async function bouncebanProof() {
  const { emails: dnc, truncated } = await fetchDncEmails();
  const has = (e) => dnc.has(String(e || "").trim().toLowerCase());

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

  return {
    checkedAt: new Date(),
    dncListSize: dnc.size,
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
    clean: !truncated && leaked.length === 0,
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
