const $ = (s) => document.querySelector(s);
const esc = (s) => (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const j = async (u, opt) => (await fetch(u, opt)).json();
const post = (u, body) => j(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const num = (n) => (n ?? 0).toLocaleString();
const ts = (d) => (d ? new Date(d).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const ic = (n) => `<svg class="ico"><use href="#i-${n}"/></svg>`;

let VIEW = "overview";
let CAMPAIGNS = [], BAL = {};
let SIZE = 50, PAGE = 0;
let F = { status: "", email: "", cat: "", campaign: "", q: "", sort: "score", recovered: "" };
let SELECTED = new Set();
let ACTIVE_CAMPAIGN = null;                 // when drilled into a campaign
let CARD_METRICS = ["total", "verified", "hot", "noEmail"]; // campaign detail cards (Google-Ads style)

const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : "");
const statusBadge = (s) => `<span class="badge ${({ hot: "b-hot", warm: "b-warm", cold: "b-cold" }[s]) || "b-cold"}">${s || "cold"}</span>`;
const emailPill = (s) => `<span class="pill p-${s || "no-email"}">${s || "—"}</span>`;
function methodLabel(m) {
  if (!m) return '<span class="muted">—</span>';
  const [p, how] = m.split(":");
  return `<span class="src"><b>${p === "enrich" ? "Enrich" : "Prospeo"}</b> <span class="via">· ${how === "name+domain" ? "name+domain" : how === "url" ? "URL" : how}</span></span>`;
}

// ---------------- top bar + campaign list ----------------
async function loadTop() {
  const d = await j("/api/campaigns");
  CAMPAIGNS = d.campaigns || []; BAL = { trigify: d.trigify, prospeo: d.prospeo };
  let bh = "";
  if (d.trigify) { const pct = d.trigify.limit ? Math.min(100, d.trigify.used / d.trigify.limit * 100) : 0;
    bh += `<div class="balc">Trigify · <b>${num(d.trigify.remaining)}</b> left<div class="bar"><i style="width:${pct}%"></i></div></div>`; }
  if (d.prospeo) bh += `<div class="balc">Prospeo · <b>${num(d.prospeo.remaining)}</b> left</div>`;
  $("#bals").innerHTML = bh;
  const sum = (k) => CAMPAIGNS.reduce((a, c) => a + (c[k] || 0), 0);
  $("#c-leads").textContent = num(sum("total"));
  $("#c-handoff").textContent = num(sum("noEmail"));
  $("#c-comp").textContent = num(sum("competitor"));
  $("#c-camp").textContent = num(CAMPAIGNS.length);
}

// ---------------- charts (dependency-free inline SVG) ----------------
function donut(segs) {
  const total = segs.reduce((a, s) => a + s.value, 0) || 1;
  let a0 = -Math.PI / 2, cx = 60, cy = 60, r = 46, w = 18, paths = "";
  for (const s of segs) {
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    paths += `<path d="M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}" stroke="${s.color}" stroke-width="${w}" fill="none"/>`;
    a0 = a1;
  }
  return `<svg viewBox="0 0 120 120" width="120" height="120">${paths}<text x="60" y="64" text-anchor="middle" font-size="20" font-weight="600" fill="#16161D">${num(total)}</text></svg>`;
}
function area(series) {
  if (!series.length) return '<div class="muted">no data yet</div>';
  const W = 560, H = 150, pad = 6;
  const max = Math.max(1, ...series.map((s) => s.total));
  const X = (i) => pad + i * (W - 2 * pad) / Math.max(1, series.length - 1);
  const Y = (v) => H - pad - v / max * (H - 2 * pad);
  const line = (key, color, fill) => {
    const pts = series.map((s, i) => `${X(i)},${Y(s[key])}`).join(" ");
    const areaP = `M${X(0)},${H - pad} L${pts.replace(/ /g, " L")} L${X(series.length - 1)},${H - pad} Z`;
    return (fill ? `<path d="${areaP}" fill="${color}" opacity="0.10"/>` : "") + `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`;
  };
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${line("total", "#6C47FF", true)}${line("verified", "#0E8F49", false)}</svg>`;
}
function funnel(f) {
  const steps = [["Scraped", f.scraped], ["Email found", f.emailFound], ["Verified", f.verified], ["Pushed", f.verified]];
  const max = Math.max(1, f.scraped);
  return steps.map(([l, v]) => `<div class="funnel-row"><span class="lbl">${l}</span><span class="track"><i style="width:${v / max * 100}%"></i></span><span class="num">${num(v)}</span></div>`).join("");
}

// ---------------- Overview ----------------
async function renderOverview() {
  const a = await j("/api/analytics");
  const s = await j("/api/stats");
  const card = (icon, k, v, cls) => `<div class="card ${cls || ""}"><div class="kh">${ic(icon)}${k}</div><div class="v">${num(v)}</div></div>`;
  $("#v-overview").innerHTML = `
    <div class="section-t">${ic("trend")}Leads</div>
    <div class="grid g-stat" style="margin-bottom:8px">
      ${card("users", "Total", s.total)}${card("check", "Hot", s.hot, "hot")}${card("check", "Warm", s.warm, "warm")}
      ${card("check", "Cold", s.cold, "cold")}${card("mail", "Verified", s.verified, "good")}
      ${card("inbox", "No-email", s.noEmail)}${card("warn", "Review", s.review, "warm")}${card("flag", "Competitors", s.competitor)}
    </div>
    <div class="charts">
      <div class="chartbox"><h4>Status split</h4>${donut([
        { label: "Hot", value: a.status.hot, color: "#E0322F" }, { label: "Warm", value: a.status.warm, color: "#B7791F" }, { label: "Cold", value: a.status.cold, color: "#5B636E" }])}
        <div class="legend"><span><i style="background:#E0322F"></i>Hot ${num(a.status.hot)}</span><span><i style="background:#B7791F"></i>Warm ${num(a.status.warm)}</span><span><i style="background:#5B636E"></i>Cold ${num(a.status.cold)}</span></div>
      </div>
      <div class="chartbox"><h4>Leads over time</h4>${area(a.series)}
        <div class="legend"><span><i style="background:#6C47FF"></i>Total</span><span><i style="background:#0E8F49"></i>Verified</span></div>
      </div>
    </div>
    <div class="chartbox" style="margin-top:12px"><h4>Email funnel</h4>${funnel(a.funnel)}
      <div class="legend"><span>No-email ${num(a.funnel.noEmail)}</span><span>Review ${num(a.funnel.review)}</span><span>Competitors ${num(a.funnel.competitor)}</span><span>Unverified ${num(a.funnel.unverified)}</span></div>
    </div>`;
}

// ---------------- shared leads table ----------------
function toolbarHTML() {
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
  const camps = CAMPAIGNS.map((c) => opt(c.campaign, c.label, F.campaign)).join("");
  return `<div class="toolbar">
    <select data-f="campaign"><option value="">All campaigns</option>${camps}</select>
    <select data-f="status">${opt("", "All status", F.status)}${opt("hot", "Hot", F.status)}${opt("warm", "Warm", F.status)}${opt("cold", "Cold", F.status)}</select>
    <select data-f="email">${opt("", "All emails", F.email)}${opt("verified", "Verified", F.email)}${opt("no-email", "No email", F.email)}${opt("review", "Review", F.email)}${opt("unverified", "Unverified", F.email)}${opt("competitor", "Competitor", F.email)}</select>
    <select data-f="cat">${opt("", "All categories", F.cat)}${["infra-competitor", "deliverability", "infra", "sequencer", "gtm-eng", "data-tools", "cold-email"].map((c) => opt(c, c, F.cat)).join("")}</select>
    <select data-f="recovered">${opt("", "All", F.recovered)}${opt("1", "Recovered only", F.recovered)}</select>
    <select data-f="sort">${opt("score", "Sort: score", F.sort)}${opt("recent", "Sort: recent", F.sort)}</select>
    <input data-f="q" placeholder="search name / email / company" value="${esc(F.q)}" />
    <div class="grow"></div>
    <button class="btn btn-ghost btn-sm" data-export="filtered">${ic("download")}Export view</button>
    <button class="btn btn-sm" data-export="selected">${ic("download")}Export selected (<span id="selCount">0</span>)</button>
  </div>`;
}
function rowsTable(rows) {
  if (!rows.length) return '<div id="empty">No leads in this view.</div>';
  const r = (x) => `<tr>
    <td><input type="checkbox" class="chk" data-sel="${esc(x.linkedin_url)}" ${SELECTED.has(x.linkedin_url) ? "checked" : ""}></td>
    <td class="click" data-lead="${esc(x.linkedin_url)}" data-name="${esc(x.name)}"><div class="nm">${esc(x.name) || "—"}</div>${x.email ? `<div class="em mono">${esc(x.email.slice(0, 40))}</div>` : ""}</td>
    <td class="muted">${esc(x.company || "")}</td>
    <td>${statusBadge(x.status)}</td><td class="score">${x.score ?? 0}</td>
    <td>${emailPill(x.email_status)}${x.recovered ? '<span class="tag-rec">recovered</span>' : ""}${x.personal_email ? '<span class="tag-pers">personal</span>' : ""}</td>
    <td>${methodLabel(x.email_method)}</td>
    <td>${x.email ? `<span class="vby" data-reverify="${esc(x.linkedin_url)}">${x.verified_by ? cap(x.verified_by) : "verify"} ${ic("chev")}</span>` : '<span class="muted">—</span>'}</td>
    <td><div class="cats">${(x.categories || []).map((c) => `<span class="cat">${c}</span>`).join("")}</div></td>
    <td class="tstamp">${x.times_seen || 1}×</td><td class="tstamp">${ts(x.created_at)}</td><td class="tstamp">${ts(x.last_engagement_at)}</td>
  </tr>`;
  return `<div class="tablewrap"><table><thead><tr>
    <th><input type="checkbox" class="chk" data-selall></th><th>Person</th><th>Company</th><th>Status</th><th>Score</th>
    <th>Email</th><th>Found by</th><th>Verified</th><th>Categories</th><th>Seen</th><th>First seen</th><th>Last seen</th>
  </tr></thead><tbody>${rows.map(r).join("")}</tbody></table></div>`;
}
function pagerHTML(count) {
  const from = count ? PAGE * SIZE + 1 : 0, to = Math.min(count, (PAGE + 1) * SIZE), last = Math.max(0, Math.ceil(count / SIZE) - 1);
  return `<div class="pager">
    <span>Rows</span><select data-size>${[25, 50, 100, 200].map((n) => `<option ${n === SIZE ? "selected" : ""}>${n}</option>`).join("")}</select>
    <span>${from}–${to} of ${num(count)}</span>
    <button class="btn btn-ghost btn-sm" data-pg="prev" ${PAGE <= 0 ? "disabled" : ""}>Prev</button>
    <button class="btn btn-ghost btn-sm" data-pg="next" ${PAGE >= last ? "disabled" : ""}>Next</button></div>`;
}
function leadQuery(extra) {
  const p = new URLSearchParams();
  const f = { ...F, ...extra };
  ["status", "campaign", "cat", "sort", "q", "recovered"].forEach((k) => { if (f[k]) p.set(k === "cat" ? "category" : k, f[k]); });
  if (f.email) p.set("email_status", f.email);
  p.set("limit", SIZE); p.set("skip", PAGE * SIZE);
  return p;
}
async function renderLeads() {
  const { rows, count } = await j("/api/leads?" + leadQuery().toString());
  $("#v-leads").innerHTML = toolbarHTML() + rowsTable(rows) + pagerHTML(count);
  $("#selCount").textContent = SELECTED.size;
}

// ---------------- Hand-off ----------------
async function renderHandoff() {
  const batches = CAMPAIGNS.filter((c) => c.noEmail > 0).map((c) =>
    `<tr><td><input type="checkbox" class="chk" data-batch="${esc(c.campaign)}"></td><td class="nm">${esc(c.label)}</td><td>${num(c.noEmail)}</td></tr>`).join("");
  const { rows, count } = await j("/api/leads?" + leadQuery({ email: "no-email" }).toString());
  $("#v-handoff").innerHTML = `
    <div class="toolbar"><div class="grow"></div>
      <button class="btn btn-ghost btn-sm" data-export="handoff">${ic("download")}Export list</button>
      <button class="btn btn-sm" data-retry><span id="retryLbl">${ic("refresh")}Retry email lookup</span></button></div>
    <div class="grid" style="grid-template-columns:1fr 1.4fr;gap:12px;align-items:start">
      <div class="chartbox"><h4>Retry by campaign</h4>
        <div class="tablewrap" style="border:none"><table><thead><tr><th></th><th>Campaign</th><th>No-email</th></tr></thead><tbody>${batches || '<tr><td colspan="3" class="muted" style="padding:16px">none</td></tr>'}</tbody></table></div>
        <div class="muted" style="font-size:11.5px;margin-top:8px" id="retryMsg">Tick campaigns → Retry runs those batches through the Enrich-first waterfall.</div>
      </div>
      <div>${rowsTable(rows)}${pagerHTML(count)}</div>
    </div>`;
}

// ---------------- Competitors ----------------
async function renderCompetitors() {
  const { rows, count } = await j("/api/leads?" + leadQuery({ email: "competitor" }).toString());
  $("#v-competitors").innerHTML = `
    <div class="note">Engagers who work at a competitor (by company or email domain). Saved for your review — never sent to SendKit.</div>
    <div class="toolbar"><div class="grow"></div><button class="btn btn-ghost btn-sm" data-export="competitors">${ic("download")}Export</button></div>
    ${rowsTable(rows)}${pagerHTML(count)}`;
}

// ---------------- Campaigns ----------------
function renderCampaignList() {
  const rows = CAMPAIGNS.map((c) => `<tr class="click" data-camp="${esc(c.campaign)}"><td class="nm">${esc(c.label)}</td>
    <td>${num(c.total)}</td><td>${num(c.hot)}</td><td>${num(c.warm)}</td><td>${num(c.verified)}</td><td>${num(c.noEmail)}</td><td>${num(c.competitor)}</td>
    <td>${num(c.credits.trigify)}</td><td>${num(c.credits.prospeo)}</td><td>${num(c.credits.sendkit)}</td></tr>`).join("");
  $("#v-campaigns").innerHTML = `<div class="tablewrap"><table><thead><tr>
    <th>Campaign</th><th>Leads</th><th>Hot</th><th>Warm</th><th>Verified</th><th>No-email</th><th>Competitors</th><th>Trigify</th><th>Prospeo</th><th>SendKit</th>
    </tr></thead><tbody>${rows || '<tr><td colspan="10" class="muted" style="padding:20px">No campaigns yet</td></tr>'}</tbody></table></div>`;
}
const METRICS = { total: "Leads", verified: "Verified", hot: "Hot", warm: "Warm", cold: "Cold", noEmail: "No-email", review: "Review", competitor: "Competitors", unverified: "Unverified", verifyRate: "Verify rate %" };
async function renderCampaignDetail(campaign) {
  const c = CAMPAIGNS.find((x) => x.campaign === campaign) || {};
  const s = await j("/api/stats?campaign=" + encodeURIComponent(campaign));
  s.verifyRate = s.total ? Math.round(s.verified / s.total * 100) : 0;
  const cardsHtml = CARD_METRICS.map((mk, i) => `<div class="card pri"><div class="kh">
      <select data-card="${i}">${Object.entries(METRICS).map(([k, l]) => `<option value="${k}" ${k === mk ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="v">${num(s[mk])}</div></div>`).join("");
  const { rows, count } = await j("/api/leads?" + leadQuery({ campaign }).toString());
  $("#v-campaigns").innerHTML = `
    <div class="toolbar"><button class="btn btn-ghost btn-sm" data-back>${ic("chev")}All campaigns</button>
      <h2 style="margin:0 0 0 6px;font-size:16px">${esc(c.label || campaign)}</h2><div class="grow"></div>
      <button class="btn btn-ghost btn-sm" data-sync="${esc(campaign)}">${ic("sync")}Sync SendKit</button>
      <button class="btn btn-sm" data-pause="${esc(campaign)}">${ic("pause")}Pause</button></div>
    <div class="muted" style="font-size:11.5px;margin:-4px 0 12px" id="campMsg"></div>
    <div class="grid g-cred">${cardsHtml}</div>
    ${rowsTable(rows)}${pagerHTML(count)}`;
}

// ---------------- reverify menu ----------------
function closeMenu() { document.querySelector(".menu")?.remove(); }
function openReverifyMenu(url, anchor) {
  closeMenu();
  const m = document.createElement("div"); m.className = "menu";
  m.innerHTML = `<button data-prov="prospeo" data-url="${esc(url)}">${ic("check")}Verify with Prospeo</button>
    <button data-prov="enrich" data-url="${esc(url)}">${ic("check")}Verify with Enrich</button>
    <button data-prov="refind" data-url="${esc(url)}">${ic("refresh")}Re-find email</button>`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - 200) + "px"; m.style.top = (r.bottom + 4) + "px";
}

// ---------------- view switching ----------------
const TITLES = { overview: "Overview", leads: "Leads", handoff: "Hand-off · No email", competitors: "Competitors", campaigns: "Campaigns" };
function show(v) {
  VIEW = v; PAGE = 0; ACTIVE_CAMPAIGN = null;
  document.querySelectorAll(".nav-i").forEach((n) => n.classList.toggle("on", n.dataset.v === v));
  ["overview", "leads", "handoff", "competitors", "campaigns"].forEach((x) => $("#v-" + x).style.display = x === v ? "" : "none");
  $("#pageTitle").textContent = TITLES[v];
  render();
}
function render() {
  if (VIEW === "overview") renderOverview();
  else if (VIEW === "leads") renderLeads();
  else if (VIEW === "handoff") renderHandoff();
  else if (VIEW === "competitors") renderCompetitors();
  else if (VIEW === "campaigns") ACTIVE_CAMPAIGN ? renderCampaignDetail(ACTIVE_CAMPAIGN) : renderCampaignList();
}

// ---------------- global event delegation (CSP-safe: no inline handlers) ----------------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-v],[data-x],[data-lead],[data-reverify],[data-prov],[data-pg],[data-export],[data-camp],[data-back],[data-pause],[data-sync],[data-retry]");
  if (e.target.closest(".menu")) { /* handled below */ } else closeMenu();
  if (!t) return;
  if (t.dataset.v) return show(t.dataset.v);
  if (t.hasAttribute("data-x")) return $("#drawer").classList.remove("open");
  if (t.dataset.lead) return openDrawer(t.dataset.lead, t.dataset.name);
  if (t.dataset.reverify) { e.stopPropagation(); return openReverifyMenu(t.dataset.reverify, t); }
  if (t.dataset.prov) {
    const menu = t.closest(".menu"); menu.querySelector(".res")?.remove();
    const r = document.createElement("div"); r.className = "res muted"; r.textContent = "running…"; menu.appendChild(r);
    const res = await post(`/api/leads/${encodeURIComponent(t.dataset.url)}/reverify`, { provider: t.dataset.prov });
    r.textContent = res.ok ? `✓ ${res.provider || res.action}: ${res.result || res.email || "ok"}` : `✗ ${res.result || res.message || "failed"}`;
    r.className = "res " + (res.ok ? "" : "muted"); r.style.color = res.ok ? "var(--good)" : "var(--hot)";
    render(); return;
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
  if (t.hasAttribute("data-back")) { ACTIVE_CAMPAIGN = null; return renderCampaignList(); }
  if (t.dataset.pause) { const r = await post(`/api/campaigns/${encodeURIComponent(t.dataset.pause)}/pause`, { paused: true }); $("#campMsg").textContent = r.ok ? "Workflow paused." : "Pause failed: " + (r.error || ""); return; }
  if (t.dataset.sync) { $("#campMsg").textContent = "Syncing…"; await post("/api/sync", { campaign: t.dataset.sync }); pollSync(); return; }
  if (t.hasAttribute("data-retry")) {
    const camps = [...document.querySelectorAll("[data-batch]:checked")].map((c) => c.dataset.batch);
    $("#retryLbl").innerHTML = "Starting…";
    await post("/api/reprocess", { campaign: camps.length === 1 ? camps[0] : "" });
    pollRetry(); return;
  }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.f !== undefined) { F[t.dataset.f] = t.value; PAGE = 0; if (t.dataset.f === "campaign" || t.dataset.f === "email") loadTop(); return render(); }
  if (t.hasAttribute("data-size")) { SIZE = +t.value; PAGE = 0; return render(); }
  if (t.hasAttribute("data-selall")) { document.querySelectorAll("[data-sel]").forEach((c) => { c.checked = t.checked; c.checked ? SELECTED.add(c.dataset.sel) : SELECTED.delete(c.dataset.sel); }); $("#selCount") && ($("#selCount").textContent = SELECTED.size); return; }
  if (t.dataset.sel) { t.checked ? SELECTED.add(t.dataset.sel) : SELECTED.delete(t.dataset.sel); $("#selCount") && ($("#selCount").textContent = SELECTED.size); return; }
  if (t.dataset.card !== undefined) { CARD_METRICS[+t.dataset.card] = t.value; return renderCampaignDetail(ACTIVE_CAMPAIGN); }
});
let qt; document.addEventListener("input", (e) => { if (e.target.dataset.f === "q") { F.q = e.target.value; clearTimeout(qt); qt = setTimeout(() => { PAGE = 0; render(); }, 300); } });

async function pollRetry() {
  const s = await j("/api/reprocess/status");
  const el = $("#retryLbl"); if (!el) return;
  if (s.running) { el.textContent = `Retrying ${s.processed}/${s.total} · ${s.newlyFound} found`; setTimeout(pollRetry, 2000); }
  else { el.innerHTML = `${ic("refresh")}Retry email lookup`; loadTop(); render(); }
}
async function pollSync() {
  const s = await j("/api/sync/status"); const el = $("#campMsg"); if (!el) return;
  if (s.running) { el.textContent = `Syncing ${s.processed}/${s.total} · ${s.pushed} pushed · ${s.reFound} methods re-found`; setTimeout(pollSync, 2000); }
  else { el.textContent = `Sync done · ${s.pushed} pushed · ${s.reFound} methods re-found`; loadTop(); }
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
async function boot() { await loadTop(); render(); }
boot();
setInterval(() => { loadTop(); if (VIEW === "overview" || VIEW === "campaigns") render(); }, 25000);
