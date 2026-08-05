// Repair the leads that ended up in BOTH active campaigns (1.0 and 2.0) — people currently
// receiving two cold sequences in parallel.
//
// The live fix (enrollOnce/planEnrolment + the daily lock reconcile) stops NEW overlap. This
// removes the overlap that already exists, by dropping the surplus membership — NOT by DNC'ing
// anyone. A DNC silences the person in every campaign forever, which is what the 30 Jul
// `dnc-to-1.0.txt` patch did to ~559 people (49 of them are still dead in both). removeFromCampaign
// is the right tool and it exists.
//
//   docker compose exec app node scripts/fix-campaign-overlap.js            # DRY RUN
//   docker compose exec app node scripts/fix-campaign-overlap.js --apply
//   ...add --no-activity to skip the per-member timeline fetch (faster, decides on addedAt alone)
//
// WHICH MEMBERSHIP IS KEPT, in order:
//   1. replied in exactly one campaign -> keep that one. Never cut a live conversation.
//   2. replied in both                 -> SKIPPED, listed for manual review.
//   3. clearly more engaged in one     -> keep that one (opens/clicks/sequence progress).
//   4. otherwise                       -> keep the one they were ADDED TO FIRST.
//
// Rule 3 is why this pulls each member's timeline (GET /campaigns/:id/leads/:campaignLeadId —
// emailsSent, opens, clicks, currentSequenceStep). Deciding on addedAt alone would happily pull
// someone out of the campaign they are actually reading. The fetch is best-effort: any member whose
// detail can't be read simply falls through to rule 4.
//
// SendKit hard-deletes a membership with no send history and soft-deletes one with history
// (status -> "removed", sending stops). Either way the person stays a lead and keeps the other
// campaign — nobody is deleted from the workspace.

import { MongoClient } from "mongodb";
import { config } from "../src/config.js";
import { CAMPAIGNS } from "../src/services/campaigns.js";
import { campaignMembers, campaignLeadDetail, removeFromCampaign } from "../src/services/sendkit.js";

const APPLY = process.argv.includes("--apply");
const WITH_ACTIVITY = !process.argv.includes("--no-activity");
const ACTIVE = CAMPAIGNS.filter((c) => c.manualTarget);
const DEAD = new Set(["skipped", "removed", "bounced"]);

// How much has this person actually engaged with this campaign? Clicks outrank opens outrank
// simply having been sent to. Only used to BREAK A TIE between two live memberships.
const engagement = (a) => !a ? 0 : (a.clicked * 5) + (a.opened * 2) + Math.max(a.sent, a.step || 0);

// Run `fn` over `items` with a small concurrency cap — this is ~1.4k API calls on the full set.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

async function main() {
  if (ACTIVE.length < 2) { console.error("[overlap] need at least 2 active campaigns"); return; }

  const seen = new Map();   // email -> [{ c, m }]
  for (const c of ACTIVE) {
    const members = await campaignMembers(c.sendkitId);
    console.log(`[overlap] ${c.label.padEnd(24)} members=${members.length}`);
    // An empty read is far more likely to be a failed/rate-limited fetch than an empty campaign,
    // and acting on it would compute a bogus overlap. Bail rather than guess.
    if (!members.length) { console.error(`[overlap] "${c.label}" returned 0 members — aborting rather than act on a partial read`); process.exit(1); }
    for (const m of members) {
      const email = String(m.email || "").trim().toLowerCase();
      if (!email || !m.campaignLeadId) continue;
      if (!seen.has(email)) seen.set(email, []);
      seen.get(email).push({ c, m });
    }
  }

  const dupes = [...seen.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n[overlap] emails in more than one active campaign: ${dupes.length}`);
  if (!dupes.length) { console.log("[overlap] nothing to do."); return; }

  // Pull each duplicated membership's timeline (both sides), so rule 3 has something to judge on.
  if (WITH_ACTIVITY) {
    const pairs = dupes.flatMap(([, entries]) => entries);
    console.log(`[overlap] fetching activity for ${pairs.length} memberships…`);
    let done = 0;
    await mapLimit(pairs, 8, async (p) => {
      p.activity = await campaignLeadDetail(p.c.sendkitId, p.m.campaignLeadId);
      if (++done % 200 === 0) console.log(`[overlap]   …${done}/${pairs.length}`);
    });
    const missing = pairs.filter((p) => !p.activity).length;
    if (missing) console.log(`[overlap] activity unavailable for ${missing} memberships — those fall back to added-first`);
  }

  const removals = new Map();   // campaignId -> { label, leadIds:[], emails:[] }
  const keepOf = new Map();     // email -> campaignId kept
  const manual = [], alreadyDead = [];
  const reasons = { replied: 0, engagement: 0, addedFirst: 0 };

  for (const [email, entries] of dupes) {
    const repliedIn = entries.filter((e) => e.m.status === "replied" || e.activity?.replied);
    if (repliedIn.length > 1) {
      manual.push({ email, in: entries.map((e) => `${e.c.label}:${e.m.status}`) });
      continue;
    }

    let keep, why;
    if (repliedIn.length === 1) { keep = repliedIn[0]; why = "replied"; }
    else {
      const ranked = entries.slice().sort((a, b) => engagement(b.activity) - engagement(a.activity));
      if (WITH_ACTIVITY && engagement(ranked[0].activity) > engagement(ranked[1].activity)) {
        keep = ranked[0]; why = "engagement";
      } else {
        keep = entries.slice().sort((a, b) =>
          new Date(a.m.addedAt || 0).getTime() - new Date(b.m.addedAt || 0).getTime())[0];
        why = "addedFirst";
      }
    }
    reasons[why]++;
    keepOf.set(email, keep.c.sendkitId);

    if (entries.every((e) => DEAD.has(e.m.status))) {
      alreadyDead.push({ email, in: entries.map((e) => `${e.c.label}:${e.m.status}`) });
    }

    for (const e of entries) {
      if (e.c.sendkitId === keep.c.sendkitId) continue;
      if (!removals.has(e.c.sendkitId)) removals.set(e.c.sendkitId, { label: e.c.label, leadIds: [], emails: [] });
      const g = removals.get(e.c.sendkitId);
      g.leadIds.push(e.m.campaignLeadId);
      g.emails.push(email);
    }
  }

  console.log(`\n[overlap] kept because they REPLIED there        : ${reasons.replied}`);
  console.log(`[overlap] kept because they ENGAGE there more    : ${reasons.engagement}`);
  console.log(`[overlap] kept because they were ADDED there first: ${reasons.addedFirst}`);
  console.log(`[overlap] replied in BOTH — left alone           : ${manual.length}`);
  console.log(`[overlap] already dead in every campaign (DNC'd/bounced — reported, not fixed here): ${alreadyDead.length}`);
  console.log("");
  let total = 0;
  for (const [, g] of removals) { console.log(`[overlap] remove ${String(g.leadIds.length).padStart(5)} memberships from ${g.label}`); total += g.leadIds.length; }
  console.log(`[overlap] total memberships to remove: ${total}`);

  if (manual.length) {
    console.log("\n[overlap] REPLIED IN BOTH — decide these by hand:");
    for (const m of manual) console.log(`   ${m.email}  (${m.in.join(", ")})`);
  }
  if (alreadyDead.length) {
    console.log(`\n[overlap] dead everywhere (first 20 of ${alreadyDead.length}) — the DNC'd ones, recoverable if you un-DNC:`);
    for (const m of alreadyDead.slice(0, 20)) console.log(`   ${m.email}  (${m.in.join(", ")})`);
  }

  if (!APPLY) {
    console.log("\n[overlap] DRY RUN — nothing changed. Re-run with --apply to remove them.");
    return;
  }

  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(config.mongoDb);

  let removed = 0, failed = 0;
  for (const [cid, g] of removals) {
    const r = await removeFromCampaign(cid, g.leadIds);
    removed += r.removed; failed += r.failed;
    console.log(`[overlap] removed ${r.removed}/${g.leadIds.length} from ${g.label}${r.failed ? ` (failed ${r.failed})` : ""}`);
  }

  // Pin the lock (and our own membership record) to the campaign we kept, so neither a push site
  // nor the next daily reconcile can put them back.
  const lockOps = [], leadOps = [];
  for (const [email, cid] of keepOf) {
    lockOps.push({ updateOne: { filter: { _id: email }, update: { $set: { campaignId: cid, at: new Date(), reconciled: true } }, upsert: true } });
    leadOps.push({ updateMany: { filter: { email }, update: { $set: { sendkit_campaigns: [cid] } } } });
  }
  for (let i = 0; i < lockOps.length; i += 1000) await db.collection("email_campaign").bulkWrite(lockOps.slice(i, i + 1000), { ordered: false }).catch(() => {});
  for (let i = 0; i < leadOps.length; i += 1000) await db.collection("leads").bulkWrite(leadOps.slice(i, i + 1000), { ordered: false }).catch(() => {});

  console.log(`\n[overlap] done. removed=${removed} failed=${failed} locks-pinned=${lockOps.length}`);
  await client.close();
}

main().catch((e) => { console.error("[overlap] fatal", e); process.exit(1); });
