// Teach the engine who is ALREADY being emailed, by reading SendKit instead of trusting our own
// write log.
//
// `email_campaign` (the "one email, one campaign" lock) is a write-side ledger: it only ever
// recorded pushes the engine itself made. Any membership created another way — a CSV/UI load, a
// one-off script, a teammate — is invisible to it. That is how 1.0 got 9,939 members the engine
// knew nothing about: on the next engagement the lock came back empty, intakeCampaign() wrote 2.0,
// and pushed — putting 703 people into BOTH campaigns and two sequences at once.
//
// SendKit's API cannot answer "which campaigns is this email in?" — there is no lead->campaigns
// lookup, no campaign filter on /v1/leads, and no email/search filter on /v1/campaigns/:id/leads
// (it accepts `search` and ignores it). The only direction that exists is campaign -> leads. So
// the membership has to be pulled in full and held locally. That is what this does.
//
// Safe to run repeatedly: it only ever writes locks that match what SendKit already holds, and it
// pushes nothing. Conflict rule for an email in BOTH active campaigns: the one it was ADDED TO
// FIRST wins, matching the engine's own first-writer-wins principle.

import { emailCampaign } from "../db/mongo.js";
import { CAMPAIGNS, isActiveCampaignId } from "../services/campaigns.js";
import { campaignMembers, currentEmailCampaign, reassignEmailCampaign, intakeCampaign, addToCampaign } from "../services/sendkit.js";
import { log } from "../lib/logger.js";

// ── Enrolment guard ───────────────────────────────────────────────────────────────────────────
// ENROLMENT HAPPENS ONCE PER PERSON, NOT ONCE PER TOUCH.
//
// Every push site used to call intakeCampaign() + addToCampaign() directly, on every repeat
// engagement, every retry, every audit pass. The only thing stopping a second membership was the
// lock — and the lock is blind to any membership made outside the engine. So a person already
// being emailed in 1.0 got re-pushed into 2.0 and landed in two sequences at once.
//
// These two funnel every push site through the same question first: is this person ALREADY
// enrolled somewhere active? If yes, there is nothing to push. We push only when we have no
// evidence of an enrolment — i.e. genuinely new, or a verified lead whose earlier push failed and
// who would otherwise be stranded with no campaign at all.
//
// `sendkitCampaigns` is the lead doc's own membership record, used as a second witness: if it
// knows about an enrolment the lock has not heard of, we believe it AND repair the lock, so the
// next caller (and the batch paths) get the same answer.

// Returns { campaignId, pushed }. campaignId is where they now live; pushed says whether we
// actually wrote to SendKit.
export async function enrollOnce(email, desired, sendkitCampaigns = []) {
  const key = String(email || "").trim().toLowerCase();
  if (!key || !desired) return { campaignId: null, pushed: false };

  const lockedTo = await currentEmailCampaign(key);
  if (isActiveCampaignId(lockedTo)) return { campaignId: lockedTo, pushed: false };

  const fromDoc = (sendkitCampaigns || []).find(isActiveCampaignId);
  if (fromDoc) {
    await reassignEmailCampaign(key, fromDoc);   // converge the lock onto what we already know
    return { campaignId: fromDoc, pushed: false };
  }

  const cid = await intakeCampaign(key, desired);
  const ok = await addToCampaign(cid, key);
  return { campaignId: cid, pushed: ok };
}

// Batch form, for the bulk push paths (sync / audit / bulk-approve). Takes
// [{ email, sendkitCampaigns }] and returns what to actually send:
//   { toPush: Map(campaignId -> Set(email)), placed: Map(email -> campaignId), skipped }
// `placed` covers EVERY input email — including the skipped ones — so callers can still record
// the campaign each lead belongs to without pushing them again.
export async function planEnrolment(items = [], desired) {
  const toPush = new Map(), placed = new Map();
  let skipped = 0;
  const rows = (items || [])
    .map((it) => ({ email: String(it?.email || "").trim().toLowerCase(), docs: it?.sendkitCampaigns || [] }))
    .filter((r) => r.email);
  if (!rows.length || !desired) return { toPush, placed, skipped };

  // One bulk read of the lock instead of a round trip per email.
  const locks = new Map();
  const emails = [...new Set(rows.map((r) => r.email))];
  for (let i = 0; i < emails.length; i += 5000) {
    const found = await emailCampaign()
      .find({ _id: { $in: emails.slice(i, i + 5000) } }, { projection: { campaignId: 1 } })
      .toArray()
      .catch(() => []);
    for (const f of found) locks.set(f._id, f.campaignId);
  }

  for (const { email, docs } of rows) {
    if (placed.has(email)) continue;
    const lockedTo = locks.get(email);
    if (isActiveCampaignId(lockedTo)) { placed.set(email, lockedTo); skipped++; continue; }
    const fromDoc = (docs || []).find(isActiveCampaignId);
    if (fromDoc) {
      await reassignEmailCampaign(email, fromDoc);
      placed.set(email, fromDoc); skipped++;
      continue;
    }
    const cid = await intakeCampaign(email, desired);
    placed.set(email, cid);
    if (!toPush.has(cid)) toPush.set(cid, new Set());
    toPush.get(cid).add(email);
  }
  return { toPush, placed, skipped };
}

let running = false;
let last = null;
export function campaignLockStatus() { return { running, last }; }

export async function syncCampaignLocks({ apply = true } = {}) {
  if (running) return { alreadyRunning: true, last };
  running = true;
  const startedAt = new Date();
  try {
    // The campaigns that still receive intake — the same set isActiveCampaignId() trusts.
    const active = CAMPAIGNS.filter((c) => c.manualTarget);
    if (!active.length) throw new Error("no manualTarget campaigns configured");

    // email -> { campaignId, at }, earliest membership wins.
    const truth = new Map();
    const perCampaign = {};
    let inMoreThanOne = 0;
    for (const c of active) {
      const members = await campaignMembers(c.sendkitId);
      perCampaign[c.label] = members.length;
      // A campaign that returns nothing is far more likely to be a failed/rate-limited read than a
      // genuinely empty campaign. Writing locks from that would be writing from a hole in the data,
      // so bail out rather than half-teach the engine.
      if (!members.length) throw new Error(`campaign "${c.label}" returned 0 members — refusing to sync from a partial read`);
      for (const m of members) {
        const email = String(m.email || "").trim().toLowerCase();
        if (!email) continue;
        const at = m.addedAt ? new Date(m.addedAt).getTime() : Infinity;
        const prev = truth.get(email);
        if (!prev) { truth.set(email, { campaignId: c.sendkitId, at }); continue; }
        inMoreThanOne++;
        if (at < prev.at) truth.set(email, { campaignId: c.sendkitId, at });
      }
    }

    // Compare with the lock so the report says what actually changed (and so a dry run is useful).
    const emails = [...truth.keys()];
    const existing = new Map();
    for (let i = 0; i < emails.length; i += 5000) {
      const rows = await emailCampaign()
        .find({ _id: { $in: emails.slice(i, i + 5000) } }, { projection: { campaignId: 1 } })
        .toArray();
      for (const r of rows) existing.set(r._id, r.campaignId);
    }

    const ops = [];
    let already = 0, missing = 0, wrong = 0;
    for (const [email, { campaignId }] of truth) {
      const cur = existing.get(email);
      if (cur === campaignId) { already++; continue; }
      if (cur === undefined) missing++; else wrong++;
      ops.push({ updateOne: { filter: { _id: email }, update: { $set: { campaignId, at: new Date(), reconciled: true } }, upsert: true } });
    }

    let written = 0;
    if (apply) {
      for (let i = 0; i < ops.length; i += 1000) {
        const r = await emailCampaign().bulkWrite(ops.slice(i, i + 1000), { ordered: false });
        written += (r.upsertedCount || 0) + (r.modifiedCount || 0);
      }
    }

    last = {
      startedAt, finishedAt: new Date(), apply,
      perCampaign, emails: truth.size, inMoreThanOne,
      alreadyCorrect: already, lockMissing: missing, lockWrong: wrong,
      toWrite: ops.length, written,
    };
    log.info(apply ? "campaign locks synced" : "campaign locks dry run", last);
    return last;
  } catch (e) {
    last = { startedAt, finishedAt: new Date(), error: e.message };
    log.error("campaign lock sync failed", { err: e.message });
    throw e;
  } finally {
    running = false;
  }
}
