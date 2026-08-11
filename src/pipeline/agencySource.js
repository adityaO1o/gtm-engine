// Sourcing agency domains, rather than writing a list by hand.
//
// A hand-written list of fifty was already part stale; two thousand written the same way would be
// mostly wrong, and every wrong one still costs a crawl. Search knows which agencies exist today —
// so this runs a matrix of buyer-intent queries across countries and harvests the domains that come
// back, which is both current and checkable.
//
// The expensive mistake here is harvesting DIRECTORIES. Every query for "b2b lead generation agency"
// returns Clutch, DesignRush and Sortlist above the agencies themselves, and those pages have
// thousands of case-study-shaped URLs that are not their own clients. They are excluded by name, and
// the crawl's furniture detection catches whatever slips through.
import axios from "axios";
import { splitDomain } from "../lib/permute.js";
import { agencySources } from "../db/mongo.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

// What agencies that run outbound FOR OTHERS call themselves. Deliberately not "marketing agency" —
// that returns brand and design shops, whose case studies name clients they never send mail for.
const TERMS = [
  "b2b lead generation agency",
  "cold email agency",
  "outbound marketing agency",
  "appointment setting company",
  "sales development agency",
  "SDR outsourcing company",
  "demand generation agency",
  "b2b appointment setting services",
  "outbound lead generation services",
  "email outreach agency",
  "linkedin lead generation agency",
  "b2b sales agency case studies",
  "lead generation company clients",
  "outsourced sdr agency",
  "b2b demand gen agency case study",
];

// gl codes drive Google's own regional ranking, which surfaces genuinely different agencies rather
// than the same global names reordered.
const GEOS = [
  { gl: "us", label: "United States" }, { gl: "gb", label: "United Kingdom" },
  { gl: "ca", label: "Canada" }, { gl: "au", label: "Australia" },
  { gl: "in", label: "India" }, { gl: "de", label: "Germany" },
  { gl: "nl", label: "Netherlands" }, { gl: "sg", label: "Singapore" },
  { gl: "ae", label: "UAE" }, { gl: "za", label: "South Africa" },
  { gl: "ie", label: "Ireland" }, { gl: "es", label: "Spain" },
  { gl: "fr", label: "France" }, { gl: "se", label: "Sweden" },
  { gl: "ph", label: "Philippines" }, { gl: "pl", label: "Poland" },
];

// Directories, marketplaces, publishers and tooling. These outrank real agencies for exactly these
// queries, and a directory's "case studies" are other companies' — crawling one is pure waste.
const NOT_AN_AGENCY = new Set([
  "clutch.co", "designrush.com", "sortlist.com", "goodfirms.co", "themanifest.com", "upcity.com",
  "agencyspotter.com", "expertise.com", "g2.com", "capterra.com", "trustpilot.com", "trustradius.com",
  "yelp.com", "glassdoor.com", "indeed.com", "linkedin.com", "facebook.com", "twitter.com", "x.com",
  "instagram.com", "youtube.com", "tiktok.com", "reddit.com", "quora.com", "medium.com", "substack.com",
  "wikipedia.org", "crunchbase.com", "producthunt.com", "forbes.com", "inc.com", "entrepreneur.com",
  "hubspot.com", "salesforce.com", "semrush.com", "ahrefs.com", "gartner.com", "statista.com",
  "cognism.com", "apollo.io", "zoominfo.com", "lusha.com", "lemlist.com", "instantly.ai", "smartlead.ai",
  "reply.io", "woodpecker.co", "mailshake.com", "outreach.io", "salesloft.com", "clay.com",
  "upwork.com", "fiverr.com", "toptal.com", "google.com", "bing.com", "amazon.com", "wordpress.com",
  "wix.com", "squarespace.com", "webflow.com", "canva.com", "pinterest.com", "vimeo.com",
]);

const KEYS = () => (config.serperKeys || []).map((key) => ({ key }));
let rr = 0;

async function search(q, gl, num = 100) {
  const keys = KEYS();
  if (!keys.length) return { ok: false, error: "no SERPER_KEYS configured" };
  let lastStatus = null, lastBody = "";

  // Rotate keys so one key's quota doesn't carry the whole sweep.
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(rr++) % keys.length];
    const r = await axios.post("https://google.serper.dev/search",
      { q, gl, num },
      { headers: { "X-API-KEY": k.key, "Content-Type": "application/json" }, timeout: 25000, validateStatus: () => true },
    ).catch((e) => ({ status: 0, data: e.message }));

    lastStatus = r.status;
    lastBody = typeof r.data === "string" ? r.data.slice(0, 200) : JSON.stringify(r.data || {}).slice(0, 200);
    if (r.status === 200) return { ok: true, results: r.data?.organic || [] };
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500)); continue; }  // throttled, try the next key
    if (r.status === 401 || r.status === 402) { log.warn("serper key rejected", { status: r.status }); continue; }
    log.warn("serper search failed", { status: r.status, q, body: lastBody });
    break;
  }
  // Carry the status and body back to the caller. Reporting only "it failed" is what made the first
  // attempt unreadable: nine failures and nothing anywhere saying whether it was the key, the quota
  // or the request itself.
  return { ok: false, error: `serper ${lastStatus}`, status: lastStatus, body: lastBody };
}

function domainOf(url) {
  try {
    const { label, tld } = splitDomain(new URL(url).hostname);
    if (!label || !tld) return "";
    const bits = label.split(".").filter(Boolean);
    return `${bits[bits.length - 1]}.${tld}`;   // registrable form — drop www./blog./uk.
  } catch { return ""; }
}

// Harvest until `target` unique, previously-unseen agency domains exist — or the query matrix runs
// out. Each search costs one Serper credit and returns up to 100 results, so a few hundred credits
// covers a few thousand domains.
export async function sourceAgencies({ target = 2000, maxQueries = 300 } = {}) {
  if (!config.serperKeys?.length) return { ok: false, error: "SERPER_KEYS is not set" };

  // Everything already sourced or already crawled — no point paying to rediscover it.
  const known = new Set((await agencySources().find({}, { projection: { _id: 1 } }).toArray().catch(() => [])).map((d) => d._id));
  const before = known.size;

  const queries = [];
  for (const geo of GEOS) for (const term of TERMS) queries.push({ q: term, ...geo });

  const found = new Map();   // domain -> { title, query, geo }
  let used = 0, failed = 0;
  let lastError = null;

  for (const { q, gl, label } of queries) {
    if (found.size >= target || used >= maxQueries) break;
    const r = await search(q, gl);
    used++;
    if (!r.ok) { failed++; lastError = { error: r.error, status: r.status, body: r.body }; if (failed > 8) break; continue; }

    for (const item of r.results) {
      const d = domainOf(item.link || "");
      if (!d || NOT_AN_AGENCY.has(d) || known.has(d) || found.has(d)) continue;
      found.set(d, { title: (item.title || "").slice(0, 160), query: q, geo: label });
    }
    // Serper is fine with this pace and it keeps a long sweep from looking like an attack.
    await new Promise((s) => setTimeout(s, 250));
  }

  if (found.size) {
    const now = new Date();
    const ops = [...found.entries()].map(([domain, meta]) => ({
      updateOne: {
        filter: { _id: domain },
        update: { $setOnInsert: { _id: domain, ...meta, sourcedAt: now, used: false } },
        upsert: true,
      },
    }));
    for (let i = 0; i < ops.length; i += 1000) {
      await agencySources().bulkWrite(ops.slice(i, i + 1000), { ordered: false }).catch((e) => log.warn("agency source write partial", { err: e.message }));
    }
  }

  log.info("sourced agency domains", { found: found.size, queriesUsed: used, failed, alreadyKnown: before });
  return {
    ok: true, found: found.size, queriesUsed: used, creditsSpent: used,
    alreadyKnown: before, failedQueries: failed, lastError,
    domains: [...found.keys()],
  };
}

export async function listAgencySources({ unusedOnly = false, limit = 5000 } = {}) {
  const q = unusedOnly ? { used: { $ne: true } } : {};
  const items = await agencySources().find(q).sort({ sourcedAt: -1 }).limit(limit).toArray();
  return { ok: true, count: items.length, items };
}

export async function markSourcesUsed(domains) {
  if (!domains?.length) return 0;
  const { modifiedCount } = await agencySources().updateMany({ _id: { $in: domains } }, { $set: { used: true, usedAt: new Date() } });
  return modifiedCount;
}
