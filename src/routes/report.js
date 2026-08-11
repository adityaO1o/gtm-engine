// PUBLIC blacklist report pages. Mounted BEFORE the dashboard's basic-auth (same pattern as /mcp):
// the prospect who receives the link has no login and must never be asked for one. Access control is
// the unguessable token in the URL and nothing else, so the page carries noindex and the route leaks
// nothing on a wrong token beyond "not found".
import { Router } from "express";
import { readReport } from "../pipeline/report.js";

export const reportRouter = Router();

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const day = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

// What each blacklist family actually is. A prospect who has never heard of SURBL cannot act on a
// bare hostname — and "which list, run by whom" is exactly what they ask when they reply.
const ZONE_INFO = [
  [/spamhaus/i, "Spamhaus", "The most widely enforced blocklist in email. Most corporate filters consult it directly."],
  [/surbl/i, "SURBL", "Flags domains appearing inside spam messages. Used by many enterprise gateways."],
  [/uribl/i, "URIBL", "Blocks based on links found in spam. Widely used by SpamAssassin and Rspamd setups."],
  [/barracuda/i, "Barracuda", "Barracuda's reputation list — enforced by every Barracuda appliance and their cloud filter."],
  [/spfbl/i, "SPFBL", "A reputation service combining SPF results with spam reports."],
  [/uceprotect/i, "UCEPROTECT", "Escalating blocklist — listings widen to the whole network block if ignored."],
  [/suomispam/i, "SuomiSpam", "Nordic spam reputation list, used by mail providers across the region."],
  [/bogons?\.cymru/i, "Team Cymru Bogons", "Flags addresses that should not appear on the public internet at all."],
  [/spamcop/i, "SpamCop", "Built from live spam reports. Listings appear fast when recipients complain."],
  [/sorbs/i, "SORBS", "Long-running blocklist covering spam sources and open relays."],
];
const zoneLabel = (zone) => (ZONE_INFO.find(([re]) => re.test(zone)) || [null, null, null])[1];
function zoneExplainers(zoneSummary) {
  const seen = new Map();
  for (const { zone, count } of zoneSummary) {
    const hit = ZONE_INFO.find(([re]) => re.test(zone));
    if (!hit) continue;
    const [, name, blurb] = hit;
    const prev = seen.get(name);
    seen.set(name, { name, blurb, count: (prev?.count || 0) + count });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
}

function page(r) {
  const pct = r.checkedDomains ? Math.round((r.blacklistedCount / r.checkedDomains) * 100) : null;
  const partial = r.totalDomains != null && r.checkedDomains != null && r.totalDomains > r.checkedDomains;
  const company = r.companyName || r.seed;
  const explainers = zoneExplainers(r.zoneSummary || []);

  const rows = (r.domains || []).map((d) => `
      <tr>
        <td class="mono">${esc(d.domain)}</td>
        <td>${(d.zones || []).map((z) => `<span class="z" title="${esc(z)}">${esc(zoneLabel(z) || z)}</span>`).join(" ") || "<span class=\"muted\">—</span>"}</td>
        <td class="num">${d.riskScore == null ? "—" : esc(d.riskScore)}</td>
      </tr>`).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Blacklist report · ${esc(company)}</title>
<style>
  :root {
    --bg:#f6f7f9; --card:#fff; --ink:#12151a; --muted:#697386; --line:#e3e7ee;
    --bad:#c0392b; --bad-bg:#fdecea; --warn:#b7791f; --accent:#1c4ed8;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1216; --card:#161a20; --ink:#e8eaed; --muted:#9aa3b2; --line:#252b34;
            --bad:#ff6b5a; --bad-bg:#2a1614; --warn:#e0a94f; --accent:#7aa2ff; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:880px; margin:0 auto; padding:32px 20px 64px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; margin-bottom:16px; }
  h1 { font-size:24px; margin:0 0 4px; letter-spacing:-.01em; }
  h2 { font-size:15px; margin:0 0 12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .sub { color:var(--muted); font-size:14px; margin:0; }
  .hero { display:flex; gap:28px; flex-wrap:wrap; align-items:baseline; margin:20px 0 4px; }
  .big { font-size:44px; font-weight:650; line-height:1; letter-spacing:-.02em; color:var(--bad); }
  .big small { font-size:15px; font-weight:400; color:var(--muted); letter-spacing:0; }
  .stat { font-size:26px; font-weight:600; line-height:1; }
  .stat small { display:block; font-size:12px; font-weight:400; color:var(--muted); margin-top:6px; text-transform:uppercase; letter-spacing:.05em; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; padding:0 10px 8px; border-bottom:1px solid var(--line); }
  td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  .num { text-align:right; font-variant-numeric:tabular-nums; width:70px; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; word-break:break-all; }
  .z { display:inline-block; background:var(--bad-bg); color:var(--bad); border-radius:5px; padding:1px 7px; font-size:12px; white-space:nowrap; margin:1px 0; }
  .muted { color:var(--muted); }
  .scroll { overflow-x:auto; }
  .why li { margin-bottom:8px; }
  .why { padding-left:20px; margin:0; }
  .cta { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:12px; padding:20px 24px; }
  .cta a { color:var(--accent); font-weight:600; text-decoration:none; }
  .foot { color:var(--muted); font-size:12px; text-align:center; margin-top:28px; line-height:1.7; }
  .note { background:var(--bad-bg); color:var(--bad); border-radius:8px; padding:10px 14px; font-size:13px; margin-top:14px; }
  @media print { body { background:#fff; } .card,.cta { break-inside:avoid; border-color:#ccc; } }
</style>
</head><body><div class="wrap">

  <div class="card">
    <h1>${esc(company)} — sending domain blacklist report</h1>
    <p class="sub">${esc(r.seed)} · scanned ${esc(day(r.scannedAt || r.generatedAt))}</p>

    <div class="hero">
      <div class="big">${fmt(r.blacklistedCount)}<small> domains blacklisted</small></div>
      <div class="stat">${fmt(r.checkedDomains)}<small>domains checked</small></div>
      ${r.totalDomains != null ? `<div class="stat">${fmt(r.totalDomains)}<small>secondary domains found</small></div>` : ""}
      ${pct != null ? `<div class="stat">${pct}%<small>of checked, listed</small></div>` : ""}
    </div>
    ${partial ? `<div class="note">This scan covered ${fmt(r.checkedDomains)} of the ${fmt(r.totalDomains)} secondary domains we found. The real number is likely higher.</div>` : ""}
  </div>

  ${explainers.length ? `<div class="card">
    <h2>Which blacklists flagged them</h2>
    <div class="scroll"><table>
      <thead><tr><th>Blacklist</th><th>Domains listed</th><th>What it is</th></tr></thead>
      <tbody>${explainers.map((e) => `<tr><td><b>${esc(e.name)}</b></td><td class="num">${fmt(e.count)}</td><td class="muted">${esc(e.blurb)}</td></tr>`).join("")}</tbody>
    </table></div>
  </div>` : ""}

  <div class="card">
    <h2>The blacklisted domains</h2>
    <div class="scroll"><table>
      <thead><tr><th>Domain</th><th>Listed on</th><th>Risk</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>

  <div class="card">
    <h2>What this means</h2>
    <ul class="why">
      <li>Mail sent through a listed domain is filtered before it reaches the inbox — often silently, with no bounce to tell you.</li>
      <li>Listings spread. Several of these lists escalate to the whole sending network if they go unaddressed.</li>
      <li>Reputation follows the domain, not the mailbox. Changing the sending mailbox does not clear a listed domain.</li>
      <li>A listed domain can usually be retired and replaced faster than it can be delisted.</li>
    </ul>
  </div>

  <div class="cta">
    <b>Want the rest of the picture?</b><br>
    <span class="muted">We can scan your full sending footprint — and your clients' — and set up rotation so listed domains are swapped out before they cost you replies.</span><br><br>
    <a href="https://inboxkit.com">inboxkit.com</a>
  </div>

  <p class="foot">
    Data from public DNSBL sources, checked ${esc(day(r.scannedAt || r.generatedAt))}. Blacklist status changes over time — this page is a snapshot, not a live feed.<br>
    Report by InboxKit
  </p>

</div></body></html>`;
}

const NOT_FOUND = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Report not found</title>
<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:18vh auto;padding:0 24px;text-align:center;color:#12151a">
  <h1 style="font-size:20px;margin:0 0 8px">This report link isn't valid</h1>
  <p style="color:#697386;margin:0">It may have been removed, or the link may be incomplete — check that the whole URL was copied.</p>
</div>`;

// Registered BEFORE /r/:token — otherwise that route matches "<token>/raw" first and this is dead.
reportRouter.get("/r/:token/raw", async (req, res) => {
  const r = await readReport(req.params.token).catch(() => null);
  if (!r) return res.status(404).json({ error: "not found" });
  res.set("X-Robots-Tag", "noindex").json(r);
});

reportRouter.get("/r/:token", async (req, res) => {
  const r = await readReport(req.params.token).catch(() => null);
  if (!r) return res.status(404).type("html").send(NOT_FOUND);
  // Private: a shared link is per-prospect, so no CDN or proxy should hold a copy of it.
  res.set("Cache-Control", "private, max-age=60").set("X-Robots-Tag", "noindex, nofollow");
  res.type("html").send(page(r));
});
