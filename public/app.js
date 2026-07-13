const $ = (s) => document.querySelector(s);
const esc = (s) => (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const j = async (u, opt) => (await fetch(u, opt)).json();
const post = (u, body) => j(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const num = (n) => (n ?? 0).toLocaleString();
const ts = (d) => (d ? new Date(d).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const ic = (n) => `<svg class="ico"><use href="#i-${n}"/></svg>`;
const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : "");

let VIEW = "overview", CAMPAIGNS = [], BAL = {}, STATS = {};
let SIZE = 50, PAGE = 0;
let F = { status: "", email: "", cat: "", campaign: "", q: "", sort: "score", recovered: "", dnc: "" };
let SELECTED = new Set();
let ACTIVE_CAMPAIGN = null;
let CARD_METRICS = ["total", "verified", "hot", "noEmail"];
let LAST_COUNT = 0;
// Long-running jobs live on the SERVER, so a page refresh never loses their progress —
// we just re-read these on load and keep painting.
let JOBS = { retry: {}, sync: {}, sources: {} };

const pctOf = (done, total) => (total ? Math.min(100, Math.round((done / total) * 100)) : 0);
const bar = (pct, running) => `<div class="prog${running ? " on" : ""}"><i style="width:${Math.max(pct, running ? 3 : 0)}%"></i></div>`;

const STATUS_ICON = { hot: "bolt", warm: "warn", cold: "" };
const EMAIL_ICON = { verified: "check", "no-email": "x", review: "warn", competitor: "flag", unverified: "warn", "role-based": "x" };
const statusBadge = (s) => { s = s || "cold"; return `<span class="badge b-${s}">${STATUS_ICON[s] ? ic(STATUS_ICON[s]) : ""}${s}</span>`; };
const emailPill = (s) => { s = s || "no-email"; return `<span class="pill p-${s}">${ic(EMAIL_ICON[s] || "x")}${s}</span>`; };
function methodLabel(m) {
  if (!m) return '<span class="muted">—</span>';
  const [p, how] = m.split(":");
  return `<span class="src"><b>${p === "enrich" ? "Enrich" : "Prospeo"}</b> · ${how === "name+domain" ? "name+domain" : how === "url" ? "URL" : how}</span>`;
}
const verifiedCell = (r) => r.email
  ? `<span class="prov-chip" data-reverify="${esc(r.linkedin_url)}">${ic("check")}${r.verified_by ? cap(r.verified_by) : "verify"}${ic("chev")}</span>`
  : '<span class="muted">—</span>';

// ---------------- top bar ----------------
async function loadTop() {
  const [d, s] = await Promise.all([j("/api/campaigns"), j("/api/stats")]);
  CAMPAIGNS = d.campaigns || []; BAL = { trigify: d.trigify, prospeo: d.prospeo }; STATS = s;
  let bh = "";
  if (d.trigify) { const pct = d.trigify.limit ? Math.min(100, d.trigify.used / d.trigify.limit * 100) : 0;
    bh += `<div class="balc">Trigify · <b>${num(d.trigify.remaining)}</b> left<div class="bar"><i style="width:${pct}%"></i></div></div>`; }
  if (d.prospeo) bh += `<div class="balc">Prospeo · <b>${num(d.prospeo.remaining)}</b> left</div>`;
  if (d.jina) bh += `<div class="balc" title="Jina SERP resolves obfuscated liker URNs. ~10k tokens per lookup; proxies take over when it runs out.">Jina · <b>${num(d.jina.searches)}</b> lookups left</div>`;
  $("#bals").innerHTML = bh;
  // DISTINCT counts from /stats — NOT the sum of per-campaign totals. A lead can sit in two
  // campaigns, so summing campaign rows double-counts it (that was the sidebar/overview mismatch).
  $("#c-leads").textContent = num(s.total);
  $("#c-handoff").textContent = num(s.noEmail);
  $("#c-review").textContent = num(s.review);
  $("#c-comp").textContent = num(s.competitor);
  $("#c-camp").textContent = num(CAMPAIGNS.length);
}

// ---------------- charts ----------------
function donut(segs) {
  const total = segs.reduce((a, s) => a + s.value, 0) || 1;
  let a0 = -Math.PI / 2, cx = 60, cy = 60, r = 46, w = 18, paths = "";
  for (const s of segs) {
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    if (s.value > 0) {
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      paths += `<path d="M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}" stroke="${s.color}" stroke-width="${w}" fill="none"/>`;
    }
    a0 = a1;
  }
  return `<svg viewBox="0 0 120 120" width="120" height="120">${paths}<text x="60" y="65" text-anchor="middle" font-size="20" font-weight="600" fill="#15151C" font-family="PlexNum, Suisse">${num(total)}</text></svg>`;
}
function area(series) {
  if (!series.length) return '<div class="muted" style="padding:40px 0;text-align:center">Not enough data yet</div>';
  const W = 600, H = 150, pad = 6, max = Math.max(1, ...series.map((s) => s.total));
  const X = (i) => pad + i * (W - 2 * pad) / Math.max(1, series.length - 1);
  const Y = (v) => H - pad - v / max * (H - 2 * pad);
  const line = (key, color, fill) => {
    const pts = series.map((s, i) => `${X(i)},${Y(s[key])}`).join(" ");
    return (fill ? `<polygon points="${X(0)},${H - pad} ${pts} ${X(series.length - 1)},${H - pad}" fill="${color}" opacity="0.09"/>` : "") + `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`;
  };
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${line("total", "#6C47FF", true)}${line("verified", "#0C8A45", false)}</svg>`;
}
function funnel(f) {
  const steps = [["Scraped", f.scraped], ["Email found", f.emailFound], ["Verified", f.verified], ["Pushed", f.verified]];
  const max = Math.max(1, f.scraped);
  return steps.map(([l, v]) => `<div class="funnel-row"><span class="lbl">${l}</span><span class="track"><i style="width:${v / max * 100}%"></i></span><span class="num">${num(v)}</span></div>`).join("");
}

// ---------------- Overview ----------------
async function renderOverview() {
  const [a, s] = await Promise.all([j("/api/analytics"), j("/api/stats")]);
  const card = (icon, k, v, cls) => `<div class="card ${cls || ""}"><div class="kh">${ic(icon)}${k}</div><div class="v">${num(v)}</div></div>`;
  $("#v-overview").innerHTML = `
    <div class="section-t">${ic("trend")}Leads</div>
    <div class="grid g-stat" style="margin-bottom:var(--s2)">
      ${card("users", "Total", s.total)}${card("bolt", "Hot", s.hot, "hot")}${card("warn", "Warm", s.warm, "warm")}
      ${card("users", "Cold", s.cold, "cold")}${card("mail", "Verified", s.verified, "good")}
      ${card("inbox", "No-email", s.noEmail)}${card("refresh", "Recovered", s.recovered, "rec")}${card("warn", "Review", s.review, "warm")}${card("flag", "Competitors", s.competitor)}${card("x", "DNC · never emailed", s.dnc, "dncc")}
    </div>
    <div class="charts">
      <div class="chartbox"><h4>Status split</h4>${donut([{ value: a.status.hot, color: "#DC2B2B" }, { value: a.status.warm, color: "#B26B00" }, { value: a.status.cold, color: "#2E90D9" }])}
        <div class="legend"><span><i style="background:#DC2B2B"></i>Hot ${num(a.status.hot)}</span><span><i style="background:#B26B00"></i>Warm ${num(a.status.warm)}</span><span><i style="background:#2E90D9"></i>Cold ${num(a.status.cold)}</span></div></div>
      <div class="chartbox"><h4>Leads over time</h4>${area(a.series)}
        <div class="legend"><span><i style="background:#6C47FF"></i>Total</span><span><i style="background:#0C8A45"></i>Verified</span></div></div>
    </div>
    <div class="chartbox" style="margin-top:var(--s3)"><h4>Email funnel</h4>${funnel(a.funnel)}
      <div class="legend"><span>No-email ${num(a.funnel.noEmail)}</span><span><b style="color:var(--good)">Recovered by retry ${num(s.recovered)}</b></span><span>Review ${num(a.funnel.review)}</span><span>Competitors ${num(a.funnel.competitor)}</span><span>Unverified ${num(a.funnel.unverified)}</span></div></div>`;
}

// ---------------- table ----------------
function tableHTML(rows) {
  if (!rows.length) return `<div class="tablewrap"><div class="empty">${ic("users")}<b>No leads here</b>Nothing matches this view yet.</div></div>`;
  const r = (x) => `<tr class="click" data-lead="${esc(x.linkedin_url)}" data-name="${esc(x.name)}">
    <td class="chkcol"><input type="checkbox" class="chk" data-sel="${esc(x.linkedin_url)}" ${SELECTED.has(x.linkedin_url) ? "checked" : ""}></td>
    <td><span class="nm trunc" title="${esc(x.name)}">${esc(x.name) || "—"}</span>${x.email ? `<span class="em trunc mono" title="${esc(x.email)}">${esc(x.email)}</span>` : ""}</td>
    <td><span class="trunc sm muted" title="${esc(x.company || "")}">${esc(x.company || "")}</span></td>
    <td>${statusBadge(x.status)}</td><td class="score">${x.score ?? 0}</td>
    <td>${emailPill(x.email_status)}${x.recovered ? `<span class="tag-rec">${ic("check")}rec</span>` : ""}${x.personal_email ? '<span class="tag-pers">personal</span>' : ""}${x.dnc ? `<span class="tag-dnc" title="On SendKit DNC — will never be emailed">DNC</span>` : ""}</td>
    <td>${methodLabel(x.email_method)}</td><td>${verifiedCell(x)}</td>
    <td><div class="cats">${(x.categories || []).map((c) => `<span class="cat">${c}</span>`).join("")}</div></td>
    <td class="tstamp">${x.times_seen || 1}×</td><td class="tstamp">${ts(x.last_engagement_at)}</td></tr>`;
  return `<div class="tablewrap"><table><thead><tr>
    <th class="chkcol"><input type="checkbox" class="chk" data-selall></th><th>Person</th><th>Company</th><th>Status</th><th>Score</th>
    <th>Email</th><th>Found by</th><th>Verified</th><th>Categories</th><th>Seen</th><th>Last seen</th>
  </tr></thead><tbody>${rows.map(r).join("")}</tbody></table></div>`;
}
function pagerHTML(count) {
  const from = count ? PAGE * SIZE + 1 : 0, to = Math.min(count, (PAGE + 1) * SIZE), last = Math.max(0, Math.ceil(count / SIZE) - 1);
  return `<div class="pager"><span>Rows</span><select data-size>${[25, 50, 100, 200].map((n) => `<option ${n === SIZE ? "selected" : ""}>${n}</option>`).join("")}</select>
    <span>${num(from)}–${num(to)} of ${num(count)}</span>
    <button class="btn btn-ghost btn-sm" data-pg="prev" ${PAGE <= 0 ? "disabled" : ""}>Prev</button>
    <button class="btn btn-ghost btn-sm" data-pg="next" ${PAGE >= last ? "disabled" : ""}>Next</button></div>`;
}
function toolbarHTML(withCampaign, count = 0) {
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
  const campSel = withCampaign ? `<select data-f="campaign"><option value="">All campaigns</option>${CAMPAIGNS.map((c) => opt(c.campaign, c.label, F.campaign)).join("")}</select>` : "";
  return `<div class="toolbar">
    ${campSel}
    <select data-f="status">${opt("", "All status", F.status)}${opt("hot", "Hot", F.status)}${opt("warm", "Warm", F.status)}${opt("cold", "Cold", F.status)}</select>
    <select data-f="email">${opt("", "All emails", F.email)}${opt("verified", "Verified", F.email)}${opt("no-email", "No email", F.email)}${opt("review", "Review", F.email)}${opt("unverified", "Unverified", F.email)}${opt("competitor", "Competitor", F.email)}${opt("discarded", "Discarded", F.email)}</select>
    <select data-f="cat">${opt("", "All categories", F.cat)}${["infra-competitor", "deliverability", "infra", "sequencer", "gtm-eng", "data-tools", "cold-email"].map((c) => opt(c, c, F.cat)).join("")}</select>
    <select data-f="recovered">${opt("", "All", F.recovered)}${opt("1", "Recovered", F.recovered)}</select>
    <select data-f="dnc">${opt("", "All (DNC)", F.dnc)}${opt("1", "DNC only", F.dnc)}</select>
    <select data-f="sort">${opt("score", "Sort · score", F.sort)}${opt("recent", "Sort · recent", F.sort)}</select>
    <input class="search" data-f="q" placeholder="Search name, email, company" value="${esc(F.q)}" />
    <div class="grow"></div>
    <span class="resn"><b>${num(count)}</b> result${count === 1 ? "" : "s"}</span>
    <button class="btn btn-ghost btn-sm" data-selpage>${ic("check")}Select all</button>
    <button class="btn btn-ghost btn-sm" data-export="filtered">${ic("download")}Export</button>
    <button class="btn btn-sm" data-export="selected">${ic("download")}Selected · <span id="selCount">${SELECTED.size}</span></button>
  </div>`;
}
function leadQuery(extra) {
  const p = new URLSearchParams(), f = { ...F, ...extra };
  ["status", "campaign", "cat", "sort", "q", "recovered", "dnc"].forEach((k) => { if (f[k]) p.set(k === "cat" ? "category" : k, f[k]); });
  if (f.email) p.set("email_status", f.email);
  p.set("limit", SIZE); p.set("skip", PAGE * SIZE);
  return p;
}
async function renderLeads() {
  const { rows, count } = await j("/api/leads?" + leadQuery().toString());
  LAST_COUNT = count;
  $("#v-leads").innerHTML = toolbarHTML(true, count) + tableHTML(rows) + pagerHTML(count);
}

// ---------------- Hand-off (campaign batches only) ----------------
// The TRUE number of leads a retry will touch comes from the server (distinct count).
// Never sum the per-campaign no-email columns — a lead in two campaigns appears in both.
let batchT;
function updateBatchSel() {
  const el = $("#batchSel"); if (!el) return;
  const checked = [...document.querySelectorAll("[data-batch]:checked")];
  const camps = checked.map((c) => c.dataset.batch);
  el.innerHTML = checked.length
    ? `<b>${checked.length}</b> campaign${checked.length === 1 ? "" : "s"} selected · <span class="muted">counting…</span>`
    : `<span class="muted">0 selected — Retry runs <b>all</b> campaigns</span> · <b>${num(STATS.noEmail)}</b> leads`;
  clearTimeout(batchT);
  batchT = setTimeout(async () => {
    const { count } = await j("/api/reprocess/count?campaigns=" + camps.map(encodeURIComponent).join(","));
    const e2 = $("#batchSel"); if (!e2) return;
    e2.innerHTML = checked.length
      ? `<b>${checked.length}</b> campaign${checked.length === 1 ? "" : "s"} selected · <b>${num(count)}</b> leads to retry`
      : `<span class="muted">0 selected — Retry runs <b>all</b> campaigns</span> · <b>${num(count)}</b> leads`;
  }, 150);
}
async function renderHandoff() {
  const batches = CAMPAIGNS.filter((c) => c.noEmail > 0 || c.recovered > 0).sort((a, b) => b.noEmail - a.noEmail);
  const totRec = CAMPAIGNS.reduce((a, c) => a + (c.recovered || 0), 0);
  const rows = batches.map((c) => `<tr><td class="chkcol"><input type="checkbox" class="chk" data-batch="${esc(c.campaign)}" data-noemail="${c.noEmail || 0}"></td>
    <td class="nm">${esc(c.label)}</td><td class="score">${num(c.noEmail)}</td>
    <td class="num-c" style="color:var(--good);font-weight:600">${num(c.recovered || 0)}</td>
    <td class="muted">${num(c.total)}</td><td class="muted">${num(c.verified)}</td></tr>`).join("");
  $("#v-handoff").innerHTML = `
    <div class="note">${ic("inbox")}<div>Leads whose email wasn't found. Tick campaigns and <b>Retry</b> re-runs those batches through the Enrich-first waterfall (name+domain → URL → Prospeo). <b>Recovered</b> = emails rescued by a retry — <b>${num(totRec)}</b> so far.</div></div>
    <div class="toolbar">
      <span class="resn" id="batchSel"></span>
      <button class="btn btn-ghost btn-sm" data-batchallbtn>${ic("check")}Select all</button>
      <div class="grow"></div>
      <button class="btn btn-ghost btn-sm" data-export="handoff">${ic("download")}Export list</button>
      <button class="btn btn-sm" data-retry>${ic("refresh")}Retry selected</button></div>
    <div id="retryBox">${jobBox("retry", JOBS.retry)}</div>
    ${batches.length ? `<div class="tablewrap"><table><thead><tr><th class="chkcol"><input type="checkbox" class="chk" data-batchall></th><th>Campaign</th><th>No-email</th><th>Recovered</th><th>Total</th><th>Verified</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="tablewrap"><div class="empty">${ic("check")}<b>All caught up</b>No hand-off leads — every campaign's emails were found.</div></div>`}`;
  updateBatchSel();
}

// ---------------- Review (you adjudicate the name-match guard) ----------------
// These are emails the guard held back because the local-part didn't plausibly match the
// person's name (providers do sometimes return the WRONG person's address). You decide:
// Approve -> treated as verified and pushed to every campaign the lead is in.
// Discard -> never sent; if it already reached SendKit, it's DNC'd so it can't be emailed.
async function renderReview() {
  const { rows, count } = await j("/api/leads?" + leadQuery({ email: "review" }).toString());
  const r = (x) => `<tr>
    <td class="chkcol"><input type="checkbox" class="chk" data-sel="${esc(x.linkedin_url)}" ${SELECTED.has(x.linkedin_url) ? "checked" : ""}></td>
    <td><span class="nm trunc" title="${esc(x.name)}">${esc(x.name) || "—"}</span>
        <span class="em trunc mono" title="${esc(x.email || "")}">${esc(x.email || "")}</span></td>
    <td><span class="trunc sm muted" title="${esc(x.company || "")}">${esc(x.company || "—")}</span></td>
    <td>${methodLabel(x.email_method)}</td>
    <td>${x.personal_email ? '<span class="tag-pers">personal</span>' : ""}${x.dnc ? '<span class="tag-dnc">DNC</span>' : ""}</td>
    <td><div class="cats">${(x.categories || []).map((c) => `<span class="cat">${c}</span>`).join("")}</div></td>
    <td class="score">${x.score ?? 0}</td>
    <td><div class="rowact">
      <button class="btn btn-sm btn-ok" data-decide="approve" data-url="${esc(x.linkedin_url)}">${ic("check")}Approve</button>
      <button class="btn btn-sm btn-no" data-decide="discard" data-url="${esc(x.linkedin_url)}">${ic("x")}Discard</button>
    </div></td></tr>`;
  $("#v-review").innerHTML = `
    <div class="note">${ic("warn")}<div>Emails our <b>name-match guard</b> held back — the address doesn't obviously belong to this person (email finders sometimes return the <b>wrong person's</b> address). You decide.<br>
      <b>Approve</b> → marked verified and pushed into every campaign the lead is in. <b>Discard</b> → never sent (and DNC'd if it already reached SendKit).</div></div>
    <div class="toolbar">
      <span class="resn"><b>${num(count)}</b> to review · <b id="selCount">${SELECTED.size}</b> selected</span>
      <button class="btn btn-ghost btn-sm" data-selpage>${ic("check")}Select all</button>
      <div class="grow"></div>
      <button class="btn btn-sm btn-ok" data-decide="approve">${ic("check")}Approve selected</button>
      <button class="btn btn-sm btn-no" data-decide="discard">${ic("x")}Discard selected</button>
    </div>
    <div id="revMsg" class="muted" style="font-size:12px;margin-bottom:10px"></div>
    ${rows.length
      ? `<div class="tablewrap"><table><thead><tr><th class="chkcol"><input type="checkbox" class="chk" data-selall></th>
          <th>Person / email</th><th>Company</th><th>Found by</th><th></th><th>Categories</th><th>Score</th><th>Decision</th>
        </tr></thead><tbody>${rows.map(r).join("")}</tbody></table></div>${pagerHTML(count)}`
      : `<div class="tablewrap"><div class="empty">${ic("check")}<b>Nothing to review</b>Every held-back email has been decided.</div></div>`}`;
}

// ---------------- Competitors ----------------
async function renderCompetitors() {
  const { rows, count } = await j("/api/leads?" + leadQuery({ email: "competitor" }).toString());
  $("#v-competitors").innerHTML = `
    <div class="note">${ic("flag")}<div>Engagers who work at a competitor (matched by company or email domain). Saved for your review — <b>never sent to SendKit</b>.</div></div>
    <div class="toolbar"><div class="grow"></div><span class="resn"><b>${num(count)}</b> result${count === 1 ? "" : "s"}</span>
      <button class="btn btn-ghost btn-sm" data-selpage>${ic("check")}Select all</button>
      <button class="btn btn-ghost btn-sm" data-export="competitors">${ic("download")}Export</button></div>
    ${tableHTML(rows)}${pagerHTML(count)}`;
}

// ---------------- Campaigns ----------------
function renderCampaignList() {
  setCrumb(`<h2 id="pageTitle">Campaigns</h2>`);
  const rows = CAMPAIGNS.map((c) => `<tr class="click" data-camp="${esc(c.campaign)}"><td class="nm">${esc(c.label)}</td>
    <td class="score">${num(c.total)}</td><td>${num(c.hot)}</td><td>${num(c.warm)}</td><td class="num-c" style="color:var(--good)">${num(c.verified)}</td>
    <td class="num-c" style="color:var(--primary-2);font-weight:600">${num(c.verifiedEmails ?? c.verified)}</td>
    <td>${num(c.noEmail)}</td><td class="num-c" style="color:var(--good)">${num(c.recovered || 0)}</td><td>${num(c.competitor)}</td><td class="num-c" style="color:var(--hot);font-weight:600">${num(c.dnc || 0)}</td>
    <td class="num-c">${num(c.credits.trigify)}</td><td class="num-c">${num(c.credits.prospeo)}</td></tr>`).join("");
  $("#v-campaigns").innerHTML = CAMPAIGNS.length
    ? `<div class="tablewrap"><table><thead><tr><th>Campaign</th><th>Leads</th><th>Hot</th><th>Warm</th><th title="Verified lead records (one per LinkedIn profile)">Verified</th><th title="Distinct email addresses — this is what SendKit holds. Two LinkedIn profiles can share one email.">In SendKit</th><th>No-email</th><th title="Emails rescued by a hand-off retry">Recovered</th><th>Competitors</th><th title="On SendKit's Do-Not-Contact list — blocked at send time, can never be emailed">DNC</th><th>Trigify</th><th>Prospeo</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="tablewrap"><div class="empty">${ic("mega")}<b>No campaigns yet</b>Leads will appear here as posts flow in.</div></div>`;
}
const METRICS = { total: "Leads", verified: "Verified", hot: "Hot", warm: "Warm", cold: "Cold", noEmail: "No-email", recovered: "Recovered", review: "Review", competitor: "Competitors", unverified: "Unverified", verifyRate: "Verify rate %" };
async function renderCampaignDetail(campaign) {
  const c = CAMPAIGNS.find((x) => x.campaign === campaign) || {};
  setCrumb(`<span class="crumb" data-back style="cursor:pointer">Campaigns</span>${ic("chev")}<b>${esc(c.label || campaign)}</b>`);
  const s = await j("/api/stats?campaign=" + encodeURIComponent(campaign));
  s.verifyRate = s.total ? Math.round(s.verified / s.total * 100) : 0;
  const cards = CARD_METRICS.map((mk, i) => `<div class="card pri"><div class="kh"><select data-card="${i}">${Object.entries(METRICS).map(([k, l]) => `<option value="${k}" ${k === mk ? "selected" : ""}>${l}</option>`).join("")}</select></div><div class="v">${num(s[mk])}</div></div>`).join("");
  F.campaign = campaign;
  const { rows, count } = await j("/api/leads?" + leadQuery().toString());
  $("#v-campaigns").innerHTML = `
    <div class="toolbar"><button class="btn btn-ghost btn-sm" data-back>${ic("back")}All campaigns</button><div class="grow"></div>
      <button class="btn btn-ghost btn-sm" data-sync="${esc(campaign)}">${ic("sync")}Sync SendKit</button>
      <button class="btn btn-ghost btn-sm" data-pause="${esc(campaign)}">${ic("pause")}Pause</button></div>
    <div class="muted" id="campMsg" style="font-size:12px;margin:-4px 0 0"></div>
    <div id="syncBox" style="margin:0 0 var(--s3)">${jobBox("sync", JOBS.sync)}</div>
    <div class="grid g-cred">${cards}</div>
    ${toolbarHTML(false, count)}${tableHTML(rows)}${pagerHTML(count)}`;
}

// ---------------- reverify menu ----------------
function closeMenu() { document.querySelector(".menu")?.remove(); }
function openReverifyMenu(url, anchor) {
  closeMenu();
  const m = document.createElement("div"); m.className = "menu";
  m.innerHTML = `<div class="mh">Re-verify this email</div>
    <button data-prov="prospeo" data-url="${esc(url)}">${ic("check")}Verify with Prospeo</button>
    <button data-prov="enrich" data-url="${esc(url)}">${ic("check")}Verify with Enrich</button>
    <button data-prov="refind" data-url="${esc(url)}">${ic("refresh")}Re-find email</button>`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - 210) + "px";
  m.style.top = (r.bottom + 5) + "px";
}

// ---------------- views ----------------
const TITLES = { overview: "Overview", leads: "Leads", handoff: "Hand-off · No email", review: "Review · Decide these emails", competitors: "Competitors", campaigns: "Campaigns", sources: "Sources" };
function setCrumb(html) { $("#crumb").innerHTML = html; }
function show(v) {
  VIEW = v; PAGE = 0; ACTIVE_CAMPAIGN = null; if (v !== "leads") F.campaign = "";
  document.querySelectorAll(".nav-i").forEach((n) => n.classList.toggle("on", n.dataset.v === v));
  ["overview", "leads", "handoff", "review", "competitors", "campaigns", "sources"].forEach((x) => $("#v-" + x).style.display = x === v ? "" : "none");
  if (v !== "campaigns" || !ACTIVE_CAMPAIGN) setCrumb(`<h2 id="pageTitle">${TITLES[v]}</h2>`);
  render();
}
function render() {
  if (VIEW === "overview") renderOverview();
  else if (VIEW === "leads") renderLeads();
  else if (VIEW === "handoff") renderHandoff();
  else if (VIEW === "review") renderReview();
  else if (VIEW === "competitors") renderCompetitors();
  else if (VIEW === "sources") renderSources();
  else if (VIEW === "campaigns") ACTIVE_CAMPAIGN ? renderCampaignDetail(ACTIVE_CAMPAIGN) : renderCampaignList();
}

// ---------------- Sources (hubs + influencers) ----------------
async function renderSources() {
  const d = await j("/api/sources");
  const st = d.status || {};
  $("#c-src") && ($("#c-src").textContent = (d.sources || []).length || "");
  const srcRows = (type) => {
    const rows = (d.sources || []).filter((s) => s.type === type);
    if (!rows.length) return `<tr><td colspan="5" class="muted" style="padding:16px">None yet</td></tr>`;
    return rows.map((s) => `<tr>
      <td class="nm">${esc(s.label || "—")}${s.harvestedFrom
        ? '<span class="tag-harv" title="Auto-discovered by us from a hub page">harvested</span>'
        : '<span class="tag-man" title="Added by you">manual</span>'}</td>
      <td><span class="trunc mono muted" title="${esc(s.url)}">${esc(s.url)}</span></td>
      <td class="num-c">${s.lastPosts != null ? num(s.lastPosts) : '<span class="muted">—</span>'}</td>
      <td class="tstamp">${s.lastRun ? ts(s.lastRun) : "never"}</td>
      <td><button class="btn btn-ghost btn-sm" data-delsrc="${s._id}">${ic("trash")}</button></td></tr>`).join("");
  };
  const nInfl = (d.sources || []).filter((s) => s.type === "influencer").length;
  const nHub = (d.sources || []).filter((s) => s.type === "hub").length;
  $("#v-sources").innerHTML = `
    <div class="note">${ic("radio")}<div>Scrape big cold-email <b>influencers'</b> posts and LinkedIn <b>top-content hubs</b>. Each post is auto-classified (infra / sequencer / data / …) and its engagers routed to the Influencer/Hub campaigns with that category tag. Runs daily.<br>
      <span class="tag-harv">harvested</span> = we auto-found this person on a hub page · <span class="tag-man">manual</span> = you added them. Same thing either way — both get scraped every run.</div></div>
    <div class="toolbar">
      <span class="resn"><b>${nInfl}</b> influencers · <b>${nHub}</b> hubs</span>
      <div class="grow"></div>
      <button class="btn btn-sm" data-runsrc ${st.running ? "disabled" : ""}>${ic("refresh")}${st.running ? "Running…" : "Run now"}</button></div>
    <div id="srcBox">${jobBox("sources", st)}</div>
    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--s3);align-items:start">
      <div class="chartbox" style="min-width:0;overflow:hidden"><h4>Influencers</h4>
        <div class="toolbar" style="margin-bottom:var(--s3)"><input class="search" id="in-infl" placeholder="LinkedIn profile URL or handle" style="flex:1;min-width:0"><button class="btn btn-sm" data-addsrc="influencer">${ic("plus")}Add</button></div>
        <div class="tablewrap" style="border:none"><table><thead><tr><th>Name</th><th>Profile</th><th title="Posts found for this person on the last run">Posts</th><th>Last run</th><th></th></tr></thead><tbody>${srcRows("influencer")}</tbody></table></div></div>
      <div class="chartbox" style="min-width:0;overflow:hidden"><h4>Hubs</h4>
        <div class="toolbar" style="margin-bottom:var(--s3)"><input class="search" id="in-hub" placeholder="linkedin.com/top-content/... URL" style="flex:1;min-width:0"><button class="btn btn-sm" data-addsrc="hub">${ic("plus")}Add</button></div>
        <div class="tablewrap" style="border:none"><table><thead><tr><th>Hub</th><th>URL</th><th>Posts</th><th>Last run</th><th></th></tr></thead><tbody>${srcRows("hub")}</tbody></table></div></div>
    </div>`;
}

// ---------------- events (CSP-safe delegation) ----------------
document.addEventListener("click", async (e) => {
  if (!e.target.closest(".menu")) closeMenu();
  const t = e.target.closest("[data-v],[data-x],[data-lead],[data-reverify],[data-prov],[data-pg],[data-export],[data-camp],[data-back],[data-pause],[data-sync],[data-retry],[data-addsrc],[data-delsrc],[data-runsrc],[data-decide],[data-selpage],[data-batchallbtn]");
  if (!t) return;
  if (t.dataset.v) return show(t.dataset.v);
  if (t.hasAttribute("data-x")) return $("#drawer").classList.remove("open");
  if (t.dataset.reverify) { e.stopPropagation(); return openReverifyMenu(t.dataset.reverify, t); }
  if (t.dataset.lead) return openDrawer(t.dataset.lead, t.dataset.name);
  if (t.dataset.prov) {
    const menu = t.closest(".menu"); menu.querySelector(".res")?.remove();
    const r = document.createElement("div"); r.className = "res muted"; r.textContent = "running…"; menu.appendChild(r);
    const res = await post(`/api/leads/${encodeURIComponent(t.dataset.url)}/reverify`, { provider: t.dataset.prov });
    r.textContent = res.ok ? `✓ ${res.provider || res.action}: ${res.result || res.email || "ok"}` : `✗ ${res.result || res.message || "not found"}`;
    r.style.color = res.ok ? "var(--good)" : "var(--hot)"; render(); return;
  }
  if (t.dataset.pg) { PAGE += t.dataset.pg === "next" ? 1 : -1; if (PAGE < 0) PAGE = 0; return render(); }
  if (t.dataset.export) {
    const p = leadQuery();
    if (t.dataset.export === "selected") { if (!SELECTED.size) return; location = "/api/export?urls=" + [...SELECTED].map(encodeURIComponent).join(","); return; }
    if (t.dataset.export === "handoff") p.set("email_status", "no-email");
    if (t.dataset.export === "competitors") p.set("email_status", "competitor");
    p.delete("limit"); p.delete("skip"); location = "/api/export?" + p.toString(); return;
  }
  if (t.dataset.camp) { ACTIVE_CAMPAIGN = t.dataset.camp; PAGE = 0; return renderCampaignDetail(t.dataset.camp); }
  if (t.hasAttribute("data-back")) { ACTIVE_CAMPAIGN = null; F.campaign = ""; PAGE = 0; return renderCampaignList(); }
  if (t.dataset.pause) { const r = await post(`/api/campaigns/${encodeURIComponent(t.dataset.pause)}/pause`, { paused: true }); $("#campMsg").textContent = r.ok ? "✓ Trigify workflow paused." : "Pause failed: " + (r.error || ""); return; }
  if (t.dataset.sync) { await post("/api/sync", { campaign: t.dataset.sync }); return pollJobs(); }
  if (t.hasAttribute("data-retry")) {
    // send the EXACT selection — previously anything other than a single campaign silently
    // fell back to retrying every campaign
    const camps = [...document.querySelectorAll("[data-batch]:checked")].map((c) => c.dataset.batch);
    await post("/api/reprocess", { campaigns: camps });
    return pollJobs();
  }
  if (t.dataset.decide) {
    const urls = t.dataset.url ? [t.dataset.url] : [...SELECTED];
    if (!urls.length) { const m = $("#revMsg"); if (m) m.textContent = "Pick at least one lead first."; return; }
    const msg = $("#revMsg"); if (msg) msg.textContent = t.dataset.decide === "approve" ? "Approving…" : "Discarding…";
    const r = await post("/api/leads/decision", { urls, action: t.dataset.decide });
    if (!t.dataset.url) SELECTED.clear();
    await loadTop();                       // every number on the dashboard refreshes
    await render();
    const m2 = $("#revMsg");
    if (m2) m2.textContent = r.ok
      ? (t.dataset.decide === "approve"
          ? `✓ Approved ${num(r.approved)} · pushed ${num(r.pushed)} into their campaigns`
          : `✓ Discarded ${num(r.discarded)}${r.dnc ? ` · ${num(r.dnc)} DNC'd (already in SendKit)` : ""}`)
      : `✗ ${r.error || "failed"}`;
    return;
  }
  if (t.hasAttribute("data-selpage")) {
    document.querySelectorAll("[data-sel]").forEach((c) => { c.checked = true; SELECTED.add(c.dataset.sel); });
    const el = $("#selCount"); if (el) el.textContent = SELECTED.size;
    const all = document.querySelector("[data-selall]"); if (all) all.checked = true;
    return;
  }
  if (t.hasAttribute("data-batchallbtn")) {
    document.querySelectorAll("[data-batch]").forEach((c) => { c.checked = true; });
    const all = document.querySelector("[data-batchall]"); if (all) all.checked = true;
    return updateBatchSel();
  }
  if (t.dataset.addsrc) {
    const inp = $(t.dataset.addsrc === "hub" ? "#in-hub" : "#in-infl");
    const url = inp?.value.trim(); if (!url) return;
    await post("/api/sources", { type: t.dataset.addsrc, url });
    renderSources(); return;
  }
  if (t.dataset.delsrc) { await fetch("/api/sources/" + t.dataset.delsrc, { method: "DELETE" }); renderSources(); return; }
  if (t.hasAttribute("data-runsrc")) { await post("/api/sources/run", {}); return pollJobs(); }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.f !== undefined) { F[t.dataset.f] = t.value; PAGE = 0; if (t.dataset.f === "campaign" || t.dataset.f === "email") loadTop(); return render(); }
  if (t.hasAttribute("data-size")) { SIZE = +t.value; PAGE = 0; return render(); }
  if (t.hasAttribute("data-selall")) { document.querySelectorAll("[data-sel]").forEach((c) => { c.checked = t.checked; c.checked ? SELECTED.add(c.dataset.sel) : SELECTED.delete(c.dataset.sel); }); const el = $("#selCount"); if (el) el.textContent = SELECTED.size; return; }
  if (t.dataset.sel) { t.checked ? SELECTED.add(t.dataset.sel) : SELECTED.delete(t.dataset.sel); const el = $("#selCount"); if (el) el.textContent = SELECTED.size; return; }
  if (t.hasAttribute("data-batchall")) { document.querySelectorAll("[data-batch]").forEach((c) => c.checked = t.checked); return updateBatchSel(); }
  if (t.dataset.batch) return updateBatchSel();
  if (t.dataset.card !== undefined) { CARD_METRICS[+t.dataset.card] = t.value; return renderCampaignDetail(ACTIVE_CAMPAIGN); }
});
let qt; document.addEventListener("input", (e) => { if (e.target.dataset.f === "q") { F.q = e.target.value; clearTimeout(qt); qt = setTimeout(() => { PAGE = 0; render(); }, 300); } });

// ---------------- jobs: retry / sync / sources ----------------
// The SERVER owns each job's progress, so refreshing the page (or switching tabs) never
// loses it — we simply re-read the status and keep painting.
function jobBox(kind, s) {
  if (!s || (!s.running && !s.finishedAt)) return "";
  const C = {
    retry: { done: s.processed, total: s.total, verb: "Retrying", extra: `<b class="ok">${num(s.newlyFound || 0)}</b> emails recovered` },
    sync: { done: s.processed, total: s.total, verb: "Syncing", extra: `<b class="ok">${num(s.pushed || 0)}</b> added · ${num(s.alreadyIn || 0)} already in · <b>${num(s.dnc || 0)}</b> DNC’d · ${num(s.failed || 0)} failed` },
    sources: { done: s.postsProcessed, total: s.totalPosts, verb: "Scraping posts", extra: `<b>${num(s.uniqueEngagers || 0)}</b> unique people · <b class="ok">${num(s.newlyFound || 0)}</b> sent` },
  }[kind];
  const done = C.done || 0, total = C.total || 0, pct = pctOf(done, total);
  const head = s.running
    ? `${C.verb} <b>${num(done)}</b> / <b>${num(total)}</b> · ${pct}% · ${C.extra}${kind === "sources" && s.phase ? ` <span class="muted">(${esc(s.phase)})</span>` : ""}`
    : `Done · ${num(done)} processed · ${C.extra}`;
  return `<div class="jobbox${s.running ? " on" : ""}"><div class="jobh">${ic(s.running ? "refresh" : "check")}<span>${head}</span></div>${bar(s.running ? pct : 100, s.running)}</div>`;
}
function paintJobs() {
  const set = (sel, html) => { const el = $(sel); if (el) el.innerHTML = html; };
  set("#retryBox", jobBox("retry", JOBS.retry));
  set("#syncBox", jobBox("sync", JOBS.sync));
  set("#srcBox", jobBox("sources", JOBS.sources));
}
let jobTimer = null;
async function pollJobs() {
  clearTimeout(jobTimer);                       // safe to call from a handler — never double-loops
  const [retry, sync, sources] = await Promise.all([
    j("/api/reprocess/status").catch(() => ({})),
    j("/api/sync/status").catch(() => ({})),
    j("/api/sources/status").catch(() => ({})),
  ]);
  const was = JOBS.retry.running || JOBS.sync.running || JOBS.sources.running;
  JOBS = { retry, sync, sources };
  paintJobs();
  const now = retry.running || sync.running || sources.running;
  if (was && !now) { await loadTop(); render(); }   // a job just finished — refresh the numbers
  jobTimer = setTimeout(pollJobs, now ? 1500 : 10000);
}

async function openDrawer(url, name) {
  $("#d-name").textContent = name || "—"; $("#d-sub").textContent = url;
  const { rows } = await j("/api/leads/" + encodeURIComponent(url) + "/timeline");
  $("#d-timeline").innerHTML = rows.map((e) => `<div class="tl"><div><strong>${esc(e.category)}</strong> · ${e.engagement}</div>
    <div class="c">${esc(e.campaign || "")} · ${new Date(e.created_at).toLocaleString()}</div>
    ${e.comment_text ? `<div class="c">“${esc(e.comment_text)}”</div>` : ""}
    <div class="c"><a href="${esc(e.post_url)}" target="_blank" rel="noopener">post ↗</a></div></div>`).join("") || '<div class="muted">no timeline</div>';
  $("#drawer").classList.add("open");
}

document.querySelectorAll(".nav-i").forEach((n) => n.addEventListener("click", () => show(n.dataset.v)));
window.addEventListener("scroll", closeMenu, true);
// Boot. pollJobs() re-reads server-side job state, so a refresh mid-retry/mid-sync/mid-scrape
// picks the progress bar right back up instead of losing it.
(async () => { await loadTop(); render(); pollJobs(); })();
setInterval(() => { loadTop(); if (VIEW === "overview") render(); }, 25000);
