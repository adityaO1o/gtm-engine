// One-off cleanup: pull every lead out of all SendKit campaigns EXCEPT the first one they were
// seen in, undoing the multi-campaign duplication (the old fan-out enrolled one person in up to
// 4 sequences at once). The live fix is already in sendkitIdsFor(); this repairs history.
//
//   node --env-file=.env scripts/dedupe-campaigns.js          # DRY RUN — reports, changes nothing
//   node --env-file=.env scripts/dedupe-campaigns.js --apply  # actually removes the duplicates
//
// MUST run where it can reach BOTH Mongo (compose-internal, no published port) and SendKit
// (external) — i.e. inside the app container on the VPS, e.g.:
//   docker compose exec app node --env-file=.env scripts/dedupe-campaigns.js
//
// "First campaign" = leads.campaigns[0]. That array is built with $addToSet, which preserves
// insertion order, so [0] is the first campaign the person ever engaged with. A lead is removed
// only from campaigns OTHER than their primary, and only if we actually manage them (their email
// is in our `leads` collection) — legacy/non-gtm SendKit leads are never touched.

import { MongoClient } from "mongodb";
import { config } from "../src/config.js";
import { CAMPAIGNS, CAMPAIGN_ID, resolveKey, sendkitIdsFor } from "../src/services/campaigns.js";
import { campaignMembers, removeFromCampaign } from "../src/services/sendkit.js";

const APPLY = process.argv.includes("--apply");
const idToLabel = Object.fromEntries(CAMPAIGNS.map((c) => [c.sendkitId, c.label]));

async function main() {
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const leads = client.db(config.mongoDb).collection("leads");

  // email -> the ONE campaign id this lead belongs in (first-seen). Only managed leads with an
  // email and a resolvable primary campaign are eligible.
  const primaryOf = new Map();
  const cur = leads.find(
    { email: { $ne: null }, campaigns: { $exists: true, $ne: [] } },
    { projection: { email: 1, campaigns: 1 } }
  );
  for await (const d of cur) {
    const primary = sendkitIdsFor(d.campaigns)[0];   // [] -> undefined when campaigns[0] is unmapped
    if (!primary) continue;
    const e = String(d.email).trim().toLowerCase();
    if (e) primaryOf.set(e, primary);
  }
  console.log(`[dedupe] managed leads with a resolvable primary campaign: ${primaryOf.size}`);

  let totalToRemove = 0;
  const perCampaignRemovals = [];   // { campaignId, label, leadIds:[], emails:[] }

  for (const c of CAMPAIGNS) {
    const members = await campaignMembers(c.sendkitId);
    const leadIds = [];
    const emails = [];
    for (const m of members) {
      const primary = primaryOf.get(m.email);
      if (!primary) continue;                 // not a lead we manage / no known primary — leave alone
      if (primary === c.sendkitId) continue;  // this IS their campaign — keep
      if (!m.campaignLeadId) continue;         // can't target without the record id
      leadIds.push(m.campaignLeadId);
      emails.push(m.email);
    }
    if (leadIds.length) {
      perCampaignRemovals.push({ campaignId: c.sendkitId, label: c.label, leadIds, emails });
      totalToRemove += leadIds.length;
      console.log(`[dedupe] ${c.label.padEnd(16)} members=${String(members.length).padStart(5)}  duplicates-to-remove=${leadIds.length}`);
    }
  }

  console.log(`\n[dedupe] total duplicate memberships to remove: ${totalToRemove}`);

  if (!APPLY) {
    console.log("[dedupe] DRY RUN — nothing changed. Re-run with --apply to remove them.");
    await client.close();
    return;
  }

  let removed = 0, failed = 0;
  for (const r of perCampaignRemovals) {
    const res = await removeFromCampaign(r.campaignId, r.leadIds);
    removed += res.removed; failed += res.failed;
    console.log(`[dedupe] removed ${res.removed}/${r.leadIds.length} from ${r.label}${res.failed ? ` (failed ${res.failed})` : ""}`);
    // Reflect reality on our side: each cleaned lead now sits in exactly their primary campaign.
    for (const email of r.emails) {
      const primary = primaryOf.get(email);
      if (primary) await leads.updateOne({ email }, { $set: { sendkit_campaigns: [primary] } });
    }
  }
  console.log(`\n[dedupe] done. removed=${removed} failed=${failed}`);
  await client.close();
}

main().catch((e) => { console.error("[dedupe] fatal", e); process.exit(1); });
