// One-time cleanup: source (influencer/hub) leads collected BEFORE topic-routing existed all
// landed in the empty "Influencer Engagers" / "Hub Engagers" campaigns. Those campaigns have no
// email copy, so nobody got wrongly emailed — but nobody got the RIGHT email either. This
// re-routes every such lead into the topic campaign whose email fits its interest, using the
// lead's accumulated categories (we don't have the original post text, so brand-level routing
// isn't possible here — category routing is; new leads still get full brand routing).

import { leads } from "../db/mongo.js";
import { routeSourceEngager, campaignByKey } from "../services/campaigns.js";
import { upsertLeads, addLeadsToCampaign, reassignEmailCampaign, removeFromCampaign, campaignMembers } from "../services/sendkit.js";
import { log } from "../lib/logger.js";

// same weights as score.js — pick the strongest interest a lead has shown
const CAT_WEIGHT = { "infra-competitor": 5, deliverability: 5, infra: 3, sequencer: 2, "gtm-eng": 2, "data-tools": 2, "cold-email": 1 };
const topCategory = (cats = []) =>
  (cats.slice().sort((a, b) => (CAT_WEIGHT[b] || 0) - (CAT_WEIGHT[a] || 0))[0]) || "cold-email";

const SOURCE_CAMPAIGN_KEYS = ["Influencer Engagers - InboxKit", "LinkedIn Hub Engagers - InboxKit"];

let running = false;
let status = { running: false, phase: "idle", processed: 0, total: 0, moved: 0, byCampaign: {}, startedAt: null, finishedAt: null };
export function rerouteStatus() { return status; }

export async function rerouteSourceLeads() {
  if (running) return { alreadyRunning: true, ...status };
  running = true;
  const tagsFor = (d) => ["gtm-auto", ...(d.categories || []).map((c) => "cat:" + c), "score:" + d.score, "seen:" + d.times_seen, (d.status || "cold") + "-lead", ...(d.source ? ["source:" + d.source] : [])];

  try {
    // verified source leads currently sitting in an empty source campaign
    const docs = await leads().find({
      source: { $in: ["influencer", "hub"] },
      email_status: "verified",
      email: { $ne: null },
      campaigns: { $in: SOURCE_CAMPAIGN_KEYS },
    }).toArray();

    status = { running: true, phase: "routing", processed: 0, total: docs.length, moved: 0, byCampaign: {}, startedAt: new Date(), finishedAt: null };

    // group target -> {emails, leadUpdates} so SendKit pushes are batched (avoids rate limits)
    const byCampaign = new Map(); // sendkitId -> { key, emails:Set, leads:[] }
    for (const d of docs) {
      const camp = routeSourceEngager("", topCategory(d.categories));
      if (!camp || SOURCE_CAMPAIGN_KEYS.includes(camp.key)) { status.processed++; continue; } // no better home
      if (!byCampaign.has(camp.sendkitId)) byCampaign.set(camp.sendkitId, { key: camp.key, emails: new Set(), leads: [] });
      const g = byCampaign.get(camp.sendkitId);
      g.emails.add(d.email.trim().toLowerCase());
      g.leads.push(d);
      status.byCampaign[camp.key] = (status.byCampaign[camp.key] || 0) + 1;
      status.processed++;
    }

    // per target campaign: bulk upsert leads (fresh tags) + add them, then update Mongo campaigns[]
    status.phase = "pushing";
    for (const [cid, g] of byCampaign) {
      const upserts = g.leads.map((d) => { const [f, ...r] = (d.name || "").split(" "); return { email: d.email.trim().toLowerCase(), firstName: f, lastName: r.join(" "), companyName: d.company || "", jobTitle: d.headline || "", linkedinUrl: d.linkedin_url, tags: tagsFor(d) }; });
      await upsertLeads(upserts);
      const r = await addLeadsToCampaign(cid, [...g.emails]);
      status.moved += r.added;
      for (const e of g.emails) await reassignEmailCampaign(e, cid); // this move overrides the uniqueness lock
      for (const d of g.leads) {
        await leads().updateOne({ linkedin_url: d.linkedin_url }, {
          $addToSet: { campaigns: g.key, campaign_ids: cid, sendkit_campaigns: cid },
          $set: { rerouted_to: g.key, updated_at: new Date() },
        });
      }
    }

    // Pull the moved leads OUT of the empty source campaigns — otherwise each lead now sits in BOTH
    // its old source campaign and its new topic campaign, which is the exact double-membership the
    // uniqueness lock exists to prevent. removeFromCampaign needs the per-campaign campaignLeadId,
    // which campaignMembers() resolves from the email.
    status.phase = "cleanup";
    const movedEmails = new Set();
    for (const [, g] of byCampaign) for (const e of g.emails) movedEmails.add(e);
    if (movedEmails.size) {
      for (const srcKey of SOURCE_CAMPAIGN_KEYS) {
        const src = campaignByKey(srcKey);
        if (!src?.sendkitId) continue;
        const members = await campaignMembers(src.sendkitId).catch(() => []);
        const ids = members.filter((m) => movedEmails.has((m.email || "").trim().toLowerCase())).map((m) => m.campaignLeadId).filter(Boolean);
        if (ids.length) {
          const rr = await removeFromCampaign(src.sendkitId, ids).catch(() => ({ removed: 0 }));
          log.info("reroute pulled leads from source campaign", { srcKey, removed: rr.removed });
        }
        await leads().updateMany({ email: { $in: [...movedEmails] }, campaigns: srcKey },
          { $pull: { campaigns: srcKey, sendkit_campaigns: src.sendkitId, campaign_ids: src.sendkitId } }).catch(() => {});
      }
    }
  } catch (e) {
    log.error("reroute error", { err: e.message });
  }

  status = { ...status, running: false, phase: "done", finishedAt: new Date() };
  running = false;
  log.info("reroute done", { moved: status.moved, byCampaign: status.byCampaign });
  return { moved: status.moved, byCampaign: status.byCampaign };
}
