// PUBLIC blacklist report pages + the landing page that captures requests for them.
//
// Mounted BEFORE the dashboard's basic-auth (same pattern as /mcp): the prospect who receives a link
// has no login and must never be asked for one. Access control on a report is the unguessable token
// in the URL and nothing else, so pages carry noindex and a wrong token reveals only "not found".
//
// DELIBERATELY UNBRANDED. This surface is shared by more than one product, and a visitor must not be
// able to tell which one sent them here. Nothing on these pages names a product unless REPORT_BRAND
// is set, and the default says nothing.
import { Router } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import { readReport, createRequest } from "../pipeline/report.js";

export const reportRouter = Router();

const BRAND = process.env.REPORT_BRAND || "Blacklist Report";
const BRAND_URL = process.env.REPORT_BRAND_URL || "";

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

const CSS = `
  :root {
    --bg:#f6f7f9; --card:#fff; --ink:#12151a; --muted:#697386; --line:#e3e7ee;
    --bad:#c0392b; --bad-bg:#fdecea; --ok:#1a7f5a; --ok-bg:#e8f6ef; --accent:#1c4ed8;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1216; --card:#161a20; --ink:#e8eaed; --muted:#9aa3b2; --line:#252b34;
            --bad:#ff6b5a; --bad-bg:#2a1614; --ok:#4ecfa0; --ok-bg:#12241d; --accent:#7aa2ff; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:880px; margin:0 auto; padding:32px 20px 64px; }
  .narrow { max-width:560px; }
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
  .why { padding-left:20px; margin:0; }
  .why li { margin-bottom:8px; }
  .foot { color:var(--muted); font-size:12px; text-align:center; margin-top:28px; line-height:1.7; }
  .note { background:var(--bad-bg); color:var(--bad); border-radius:8px; padding:10px 14px; font-size:13px; margin-top:14px; }
  label { display:block; font-size:13px; font-weight:600; margin:16px 0 6px; }
  input[type=text], input[type=email] {
    width:100%; padding:11px 13px; font:15px inherit; color:var(--ink); background:var(--bg);
    border:1px solid var(--line); border-radius:8px;
  }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  .hint { font-size:12.5px; color:var(--muted); margin:6px 0 0; }
  button.go {
    margin-top:20px; width:100%; padding:12px 16px; font:600 15px inherit; color:#fff;
    background:var(--accent); border:0; border-radius:8px; cursor:pointer;
  }
  button.go:hover { filter:brightness(1.08); }
  .err { background:var(--bad-bg); color:var(--bad); border-radius:8px; padding:11px 14px; font-size:13.5px; margin-top:16px; }
  .okbox { background:var(--ok-bg); color:var(--ok); border-radius:10px; padding:18px 20px; font-size:14.5px; }
  .steps { padding-left:18px; margin:12px 0 0; font-size:14px; color:var(--muted); }
  .steps li { margin-bottom:6px; }
  @media print { body { background:#fff; } .card { break-inside:avoid; border-color:#ccc; } }
`;

const shell = (title, body, extraHead = "") => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(title)}</title>
<style>${CSS}</style>${extraHead}
</head><body>${body}</body></html>`;

// ── Landing page ───────────────────────────────────────────────────────────────────────────────
// One job: take a work email and the matching company domain. The domain match is stated up front,
// because a visitor who reads it after being rejected feels tricked.
function landing({ error = "", email = "", domain = "", done = null } = {}) {
  if (done) {
    return shell(`Request received · ${BRAND}`, `<div class="wrap narrow">
      <div class="card">
        <h1>Request received</h1>
        <p class="sub">We're pulling the blacklist report for <b>${esc(done.seed)}</b>.</p>
        <div class="okbox" style="margin-top:18px">
          Your report will be emailed to <b>${esc(done.email)}</b> within 24 hours.
        </div>
        <ol class="steps">
          <li>We scan every sending domain that routes into ${esc(done.seed)}.</li>
          <li>Each one is checked against ~90 public blacklists.</li>
          <li>You get the full list — which domains, which blacklists, how bad.</li>
        </ol>
        <p class="hint">Nothing else is needed from you. If the address above is wrong, just submit the form again with the right one.</p>
      </div>
      <p class="foot">${esc(BRAND)}</p>
    </div>`);
  }

  return shell(BRAND, `<div class="wrap narrow">
    <div class="card">
      <h1>Is your outbound infrastructure blacklisted?</h1>
      <p class="sub">
        Most companies send from far more domains than they realise — and any one of them can be sitting
        on a public blocklist right now, quietly pushing mail to spam with no bounce to warn you.
      </p>
      <p class="sub" style="margin-top:12px">
        Enter your work email and your company domain. We'll scan your full sending footprint against
        ~90 public blacklists and email you the report.
      </p>

      <form method="POST" action="/request">
        <label for="email">Work email</label>
        <input type="email" id="email" name="email" required autocomplete="email"
               placeholder="you@yourcompany.com" value="${esc(email)}">

        <label for="domain">Company domain</label>
        <input type="text" id="domain" name="domain" required
               placeholder="yourcompany.com" value="${esc(domain)}">
        <p class="hint">Both must be the same company — we only send a company's report to someone who works there.</p>

        ${error ? `<div class="err">${esc(error)}</div>` : ""}

        <button class="go" type="submit">Get my report</button>
      </form>
    </div>
    <p class="foot">Reports are built from public blacklist data.<br>${esc(BRAND)}</p>
  </div>`);
}

// ── Report page ────────────────────────────────────────────────────────────────────────────────
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

  return shell(`Blacklist report · ${company}`, `<div class="wrap">

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

  <p class="foot">
    Data from public DNSBL sources, checked ${esc(day(r.scannedAt || r.generatedAt))}. Blacklist status changes over time — this page is a snapshot, not a live feed.<br>
    ${BRAND_URL ? `<a href="${esc(BRAND_URL)}" style="color:inherit">${esc(BRAND)}</a>` : esc(BRAND)}
  </p>

</div>`);
}

const NOT_FOUND = shell("Report not found", `<div class="wrap narrow"><div class="card" style="text-align:center">
  <h1 style="font-size:20px">This report link isn't valid</h1>
  <p class="sub">It may have been removed, or the link may be incomplete — check that the whole URL was copied.</p>
</div></div>`);

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────
// A plain HTML form post, so the page works with no JavaScript at all. Tighter than the dashboard's
// limiter because this one is genuinely open to the internet and every hit writes to the database.
const formLimiter = rateLimit({ windowMs: 15 * 60_000, max: 12, standardHeaders: true, legacyHeaders: false });

export const reportLanding = (req, res) => res.type("html").send(landing());

reportRouter.post("/request", formLimiter, express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
  const email = String(req.body?.email || "").slice(0, 200);
  const domain = String(req.body?.domain || "").slice(0, 200);
  const r = await createRequest(email, domain, { ip: req.ip, userAgent: req.get("user-agent") }).catch(() => ({ ok: false, error: "Something went wrong — please try again." }));
  if (!r.ok) return res.status(400).type("html").send(landing({ error: r.error, email, domain }));
  res.type("html").send(landing({ done: { seed: r.seed, email: r.email } }));
});

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
