// Repair the leads that ended up in BOTH active campaigns (1.0 and 2.0) — people currently
// receiving two cold sequences in parallel.
//
// Run sync-campaign-locks.js FIRST: that stops new overlap being created. This one cleans up the
// overlap that already exists, by removing the surplus membership (NOT by DNC'ing them — a DNC
// silences the person in every campaign forever, which is what the Jul 30 `dnc-to-1.0.txt` patch
// did to ~559 people; removeFromCampaign is the correct tool and it exists).
//
//   docker compose exec app node --env-file=.env scripts/fix-campaign-overlap.js          # DRY RUN
//   docker compose exec app node --env-file=.env scripts/fix-campaign-overlap.js --apply
//
// Which membership is kept, in order:
//   1. replied in exactly one campaign -> keep that one (never cut a live conversation)
//   2. replied in both                 -> SKIPPED, listed for manual review
//   3. otherwise                       -> keep the one they were ADDED TO FIRST
//
// SendKit hard-deletes a membership with no send history and soft-deletes one with history
// (status -> "removed", sending stops). Either way the person stays a lead and keeps the other
// campaign — nobody is deleted from the workspace.

import { MongoClient } from "mongodb";
import { config } from "../src/config.js";
import { CAMPAIGNS } from "../src/services/campaigns.js";
import { campaignMembers, removeFromCampaign } from "../src/services/sendkit.js";

const APPLY = process.argv.includes("--apply");
const ACTIVE = CAMPAIGNS.filter((c) => c.manualTarget);
const REPLIED = new Set(["replied"]);
const DEAD = new Set(["skipped", "removed", "bounced"]);

async function main() {
  if (ACTIVE.length < 2) { console.error("[overlap] need at least 2 active campaigns"); return; }

  // email -> [{ campaign, member }]
  const seen = new Map();
  for (const c of ACTIVE) {
    const members = await campaignMembers(c.sendkitId);
    console.log(`[overlap] ${c.label.padEnd(22)} members=${members.length}`);
    for (const m of members) {
      const email = String(m.email || "").trim().toLowerCase();
      if (!email || !m.campaignLeadId) continue;
      if (!seen.has(email)) seen.set(email, []);
      seen.get(email).push({ c, m });
    }
  }

  const dupes = [...seen.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n[overlap] emails in more than one active campaign: ${dupes.length}`);

  const removals = new Map();   // campaignId -> { label, leadIds:[], emails:[] }
  const keepOf = new Map();     // email -> campaignId we keep
  const manual = [];            // replied in both — never touched automatically
  const alreadyDead = [];       // already skipped/bounced everywhere — worth a human look
  let byReply = 0, byFirst = 0;

  for (const [email, entries] of dupes) {
    const replied = entries.filter((e) => REPLIED.has(e.m.status));
    if (replied.length > 1) { manual.push({ email, in: entries.map((e) => `${e.c.label}:${e.m.status}`) }); continue; }

    let keep;
    if (replied.length === 1) { keep = replied[0]; byReply++; }
    else {
      keep = entries.slice().sort((a, b) =>
        new Date(a.m.addedAt || 0).getTime() - new Date(b.m.addedAt || 0).getTime())[0];
      byFirst++;
    }
    keepOf.set(email, keep.c.sendkitId);

    if (entries.every((e) => DEAD.has(e.m.status))) alreadyDead.push({ email, in: entries.map((e) => `${e.c.label}:${e.m.status}`) });

    for (const e of entries) {
      if (e.c.sendkitId === keep.c.sendkitId) continue;
      if (!removals.has(e.c.sendkitId)) removals.set(e.c.sendkitId, { label: e.c.label, leadIds: [], emails: [] });
      const g = removals.get(e.c.sendkitId);
      g.leadIds.push(e.m.campaignLeadId);
      g.emails.push(email);
    }
  }

  console.log(`[overlap] kept by "replied here"      : ${byReply}`);
  console.log(`[overlap] kept by "added here first"  : ${byFirst}`);
  console.log(`[overlap] replied in BOTH (skipped)   : ${manual.length}`);
  console.log(`[overlap] already dead in every campaign (DNC'd/bounced — review, not fixed here): ${alreadyDead.length}`);
  console.log("");
  let total = 0;
  for (const [, g] of removals) { console.log(`[overlap] remove ${String(g.leadIds.length).padStart(5)} memberships from ${g.label}`); total += g.leadIds.length; }
  console.log(`[overlap] total memberships to remove: ${total}`);

  if (manual.length) {
    console.log("\n[overlap] REPLIED IN BOTH — decide these by hand:");
    for (const m of manual) console.log(`   ${m.email}  (${m.in.join(", ")})`);
  }
  if (alreadyDead.length) {
    console.log(`\n[overlap] dead everywhere (first 20 of ${alreadyDead.length}) — these are the DNC'd ones, still recoverable if you un-DNC:`);
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

  // Point the lock and our own membership record at the campaign we kept, so nothing re-adds them.
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
