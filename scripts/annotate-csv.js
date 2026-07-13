// Stamp Enrich verdicts back onto the source CSV, in place.
//   node scripts/annotate-csv.js <source.csv> <validated-all.csv>
//
// Adds a `status` column: "verified" for mailboxes that pass the same gate the
// live pipeline uses (valid + definitive/high/medium), otherwise the raw verdict
// (invalid / risky / valid-low / unknown) so nothing is silently thrown away.
// The original file is copied to <source>.backup.csv first.

import fs from "node:fs";
import path from "node:path";

const [srcPath, resultsPath] = process.argv.slice(2);
for (const p of [srcPath, resultsPath]) {
  if (!p || !fs.existsSync(p)) { console.error(`not found: ${p}`); process.exit(1); }
}

const GOOD_CONF = new Set(["definitive", "high", "medium"]);
const splitCsv = (line) => line.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i, a) => i < a.length - 1 || _ !== "");
const cell = (v) => (/[",\n]/.test(v ?? "") ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));

// email -> status, from the validation output
const verdict = new Map();
const rlines = fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean);
const rhead = splitCsv(rlines[0]).map((h) => h.trim());
const ix = (n) => rhead.indexOf(n);
for (const line of rlines.slice(1)) {
  const c = splitCsv(line);
  const email = (c[ix("email")] || "").replace(/^"|"$/g, "").toLowerCase();
  if (!email) continue;
  const result = c[ix("result")] || "";
  const confidence = c[ix("confidence")] || "";
  const status =
    result === "valid" && GOOD_CONF.has(confidence) ? "verified"
    : result === "valid" ? "valid-low"
    : result || "unknown";
  verdict.set(email, status);
}

const slines = fs.readFileSync(srcPath, "utf8").split(/\r?\n/);
const shead = splitCsv(slines[0] || "").map((h) => h.trim().toLowerCase());
const emailCol = Math.max(0, shead.indexOf("email"));
const hasHeader = shead.includes("email");

const out = [];
out.push([...(hasHeader ? splitCsv(slines[0]) : ["email"]), "status"].map(cell).join(","));

const tally = {};
for (const line of slines.slice(hasHeader ? 1 : 0)) {
  if (!line.trim()) continue;
  const c = splitCsv(line);
  const email = (c[emailCol] || "").replace(/^"|"$/g, "").trim().toLowerCase();
  const status = verdict.get(email) || "unknown";
  tally[status] = (tally[status] || 0) + 1;
  out.push([...c, status].map(cell).join(","));
}

const backup = srcPath.replace(/\.csv$/i, "") + ".backup.csv";
fs.copyFileSync(srcPath, backup);
fs.writeFileSync(srcPath, out.join("\n") + "\n");

console.log(`backup:  ${backup}`);
console.log(`updated: ${srcPath}  (${out.length - 1} rows)\n`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(6)}`);
}
