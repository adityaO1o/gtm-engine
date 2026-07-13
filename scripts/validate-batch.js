// Enrich.so batch email validation for a CSV of emails.
//   node --env-file=.env scripts/validate-batch.js <input.csv> [outDir]
//
// Submits one batch (Enrich dedupes case-insensitively and charges 1 credit per
// unique email), polls until complete, pages through results, and writes:
//   validated-all.csv   every email + verdict
//   validated-good.csv  only the ones we'd actually mail (see `good`)
// A batchId is written to .batch-id so a crashed run can resume without re-paying.

import fs from "node:fs";
import path from "node:path";
import axios from "axios";

const BASE = "https://dev.enrich.so/api/v3";
const KEY = process.env.ENRICH_KEY;
if (!KEY) { console.error("ENRICH_KEY missing — run with: node --env-file=.env scripts/validate-batch.js <csv>"); process.exit(1); }

const inputPath = process.argv[2];
const outDir = process.argv[3] || path.dirname(inputPath || ".");
if (!inputPath || !fs.existsSync(inputPath)) { console.error(`input csv not found: ${inputPath}`); process.exit(1); }

const http = axios.create({
  baseURL: BASE,
  headers: { "x-api-key": KEY, "Content-Type": "application/json" },
  timeout: 60000,
  validateStatus: () => true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /^[^\s@,;"']+@[^\s@,;"']+\.[a-z]{2,}$/i;

// Only high-confidence deliverable mailboxes are worth sending to. Mirrors the
// gate in src/services/enrich.js so this file and the live pipeline agree.
const GOOD_CONF = new Set(["definitive", "high", "medium"]);
const isGood = (r) => r.result === "valid" && GOOD_CONF.has(r.confidence);

function readEmails(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const header = (lines[0] || "").toLowerCase().trim();
  const body = header === "email" || header.startsWith("email,") ? lines.slice(1) : lines;
  const seen = new Set();
  const emails = [];
  let skipped = 0;
  for (const line of body) {
    const e = line.split(",")[0].trim().replace(/^"|"$/g, "").toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) { skipped++; continue; }
    if (seen.has(e)) continue;
    seen.add(e);
    emails.push(e);
  }
  return { emails, skipped };
}

const csvCell = (v) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function submit(emails) {
  const r = await http.post("/email-validation/batch", { emails });
  if (r.status !== 200 || !r.data?.success) {
    throw new Error(`submit failed (${r.status}): ${JSON.stringify(r.data)}`);
  }
  return r.data;
}

// The status/results endpoints return the payload flat, not under `data` as the
// docs claim, and use processedCount/totalEmails. Accept either shape.
const unwrap = (body) => body?.data ?? body ?? {};

async function pollUntilDone(batchId) {
  let lastPct = -1;
  for (;;) {
    const r = await http.get(`/email-validation/batch/${batchId}`);
    if (r.status === 429) { await sleep(30000); continue; }
    if (r.status !== 200) throw new Error(`status failed (${r.status}): ${JSON.stringify(r.data)}`);
    const d = unwrap(r.data);
    const done = d.processedCount ?? d.processedItems ?? 0;
    const total = d.totalEmails ?? d.totalItems ?? 0;
    const pct = Math.round(d.progress ?? 0);
    if (pct !== lastPct) {
      console.log(`  ${d.status}  ${done}/${total}  (${pct}%)  valid ${d.validCount ?? "?"} / invalid ${d.invalidCount ?? "?"} / risky ${d.riskyCount ?? "?"}`);
      lastPct = pct;
    }
    if (d.status === "completed") return d;
    if (d.status === "failed") throw new Error(`batch failed: ${JSON.stringify(d)}`);
    await sleep(10000);
  }
}

async function fetchAllResults(batchId) {
  const out = [];
  const limit = 1000;
  for (let page = 1; ; page++) {
    const r = await http.get(`/email-validation/batch/${batchId}/results`, { params: { page, limit } });
    if (r.status === 429) { await sleep(30000); page--; continue; }
    if (r.status !== 200) throw new Error(`results failed (${r.status}): ${JSON.stringify(r.data)}`);
    const d = unwrap(r.data);
    const rows = d.results || [];
    out.push(...rows);
    console.log(`  page ${page}: +${rows.length} (total ${out.length})`);
    if (rows.length < limit) return { rows: out, meta: r.data.meta || {} };
    await sleep(500);
  }
}

const { emails, skipped } = readEmails(inputPath);
console.log(`input: ${inputPath}`);
console.log(`unique valid-syntax emails: ${emails.length}${skipped ? `  (skipped ${skipped} malformed)` : ""}`);
console.log(`credits this will consume: ~${emails.length}\n`);

const idFile = path.join(outDir, ".batch-id");
let batchId = process.env.BATCH_ID || (fs.existsSync(idFile) ? fs.readFileSync(idFile, "utf8").trim() : "");

if (batchId) {
  console.log(`resuming existing batch ${batchId} (no new credits spent)\n`);
} else {
  const res = await submit(emails);
  batchId = res.data.batchId;
  fs.writeFileSync(idFile, batchId);
  console.log(`submitted batch ${batchId}`);
  console.log(`  queued ${res.data.itemCount} (dupes removed by Enrich: ${res.data.duplicatesRemoved ?? 0})`);
  console.log(`  credits reserved: ${res.meta?.creditsReserved ?? "?"}\n`);
}

console.log("polling…");
await pollUntilDone(batchId);

console.log("\nfetching results…");
const { rows, meta } = await fetchAllResults(batchId);

const header = "email,result,confidence,isCatchAll,provider,message,good";
const line = (r) => [r.email, r.result, r.confidence, r.isCatchAll, r.provider, r.message, isGood(r)].map(csvCell).join(",");

const allPath = path.join(outDir, "validated-all.csv");
const goodPath = path.join(outDir, "validated-good.csv");
const good = rows.filter(isGood);

fs.writeFileSync(allPath, [header, ...rows.map(line)].join("\n") + "\n");
fs.writeFileSync(goodPath, ["email", ...good.map((r) => csvCell(r.email))].join("\n") + "\n");

const tally = rows.reduce((a, r) => { a[r.result] = (a[r.result] || 0) + 1; return a; }, {});
const catchAll = rows.filter((r) => r.isCatchAll).length;
const pct = (n) => `${((n / (rows.length || 1)) * 100).toFixed(1)}%`;

console.log(`\n─── ${rows.length} emails validated ───`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(8)} ${String(v).padStart(6)}  ${pct(v)}`);
console.log(`  catch-all${String(catchAll).padStart(5)}  ${pct(catchAll)}`);
console.log(`\n  SENDABLE (valid + definitive/high/medium): ${good.length}  ${pct(good.length)}`);
console.log(`\n  credits used: ${meta.creditsUsed ?? "?"}   refunded: ${meta.creditsRefunded ?? "?"}   remaining: ${meta.creditsRemaining ?? "?"}`);
console.log(`\nwrote:\n  ${allPath}\n  ${goodPath}`);
