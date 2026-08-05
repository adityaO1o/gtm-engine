// One-off runner for the campaign-lock reconcile. The logic lives in src/pipeline/campaignLocks.js
// so the engine (daily auto tick + POST /api/campaign-locks/sync) and this script share one
// implementation — there is no second copy to drift.
//
//   docker compose exec app node --env-file=.env scripts/sync-campaign-locks.js          # DRY RUN
//   docker compose exec app node --env-file=.env scripts/sync-campaign-locks.js --apply
//
// MUST run where it can reach BOTH Mongo (compose-internal, no published port) and SendKit.

import { connect } from "../src/db/mongo.js";
import { syncCampaignLocks } from "../src/pipeline/campaignLocks.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  await connect();
  const r = await syncCampaignLocks({ apply: APPLY });

  console.log("\n[locks] membership read from SendKit:");
  for (const [label, n] of Object.entries(r.perCampaign)) console.log(`   ${label.padEnd(24)} ${n}`);
  console.log(`\n[locks] distinct emails        : ${r.emails}`);
  console.log(`[locks] in more than one campaign: ${r.inMoreThanOne}`);
  console.log(`[locks] lock already correct   : ${r.alreadyCorrect}`);
  console.log(`[locks] lock MISSING entirely  : ${r.lockMissing}   <- these are the ones that leak`);
  console.log(`[locks] lock pointing elsewhere: ${r.lockWrong}`);
  console.log(`[locks] locks to write         : ${r.toWrite}`);

  if (!APPLY) console.log("\n[locks] DRY RUN — nothing changed. Re-run with --apply to write them.");
  else console.log(`\n[locks] done. written=${r.written}`);
  process.exit(0);
}

main().catch((e) => { console.error("[locks] fatal", e); process.exit(1); });
