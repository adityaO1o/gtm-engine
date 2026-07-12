const $ = (s) => document.querySelector(s);
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const j = async (u) => (await fetch(u)).json();
const num = (n) => (n ?? 0).toLocaleString();
const ts = (d) => (d ? new Date(d).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

let VIEW = "overview";
let CAMPAIGNS = [];
let BAL = { trigify: null, prospeo: null };
const PAGE = { leads: 0, handoff: 0 };
const SIZE = 50;
let F = { status: "", email: "", cat: "", campaign: "", q: "", sort: "score" };

const statusBadge = (s) => `<span class="badge ${({ hot: "b-hot", warm: "b-warm", cold: "b-cold" }[s]) || "b-cold"}">${s || "cold"}</span>`;
const emailPill = (s) => `<span class="pill p-${s || "no-email"}">${s || "—"}</span>`;
function methodLabel(m) {
  if (!m) return '<span class="muted">—</span>';
  const [prov, how] = m.split(":");
  const P = prov === "enrich" ? "Enrich" : "Prospeo";
  const H = how === "name+domain" ? "name+domain" : how === "url" ? "URL" : how || "";
  return `<span class="src"><b>${P}</b> <span class="via">· ${H}</span></span>`;
}
const verifiedBy = (v) => (v ? `<span class="src"><b>${v[0].toUpperCase() + v.slice(1)}</b></span>` : '<span class="muted">—</span>');

// ---------- top bar + overview + campaigns ----------
async function loadTop() {
  const d = await j("/api/campaigns");
  CAMPAIGNS = d.campaigns || [];
  BAL = { trigify: d.trigify, prospeo: d.prospeo };

  // balances (top-right)
  let bh = "";
  if (d.trigify) {
    const pct = d.trigify.limit ? Math.min(100, (d.trigify.used / d.trigify.limit) * 100) : 0;
    bh += `<div class="balc">Trigify · <b>${num(d.trigify.remaining)}</b> left<div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }
  if (d.prospeo) bh += `<div class="balc">Prospeo · <b>${num(d.prospeo.remaining)}</b> left</div>`;
  $("#bals").innerHTML = bh;

  // sums (respect campaign filter for credit cards)
  const pick = F.campaign ? CAMPAIGNS.filter((c) => c.campaign === F.campaign) : CAMPAIGNS;
  let tg = 0, pr = 0, sk = 0, total = 0, noEmail = 0;
  pick.forEach((c) => { tg += c.credits.trigify; pr += c.credits.prospeo; sk += c.credits.sendkit; });
  CAMPAIGNS.forEach((c) => { total += c.total; noEmail += c.noEmail; });

  // nav counts
  $("#c-leads").textContent = num(total);
  $("#c-handoff").textContent = num(noEmail);
  $("#c-camp").textContent = num(CAMPAIGNS.length);

  // credit cards
  const left = (b) => (b ? `<div class="sub">${num(b.remaining)} left</div>` : "");
  $("#credits").innerHTML = `
    <div class="card pri"><div class="k">Trigify · scraped</div><div class="v">${num(tg)}</div>${left(d.trigify)}</div>
    <div class="card pri"><div class="k">Prospeo · finds</div><div class="v">${num(pr)}</div>${left(d.prospeo)}</div>
    <div class="card"><div class="k">SendKit · pushed</div><div class="v">${num(sk)}</div></div>`;

  // campaigns table
  $("#campRows").innerHTML = CAMPAIGNS.map((c) => `
    <tr><td class="nm">${esc(c.campaign)}</td><td>${num(c.total)}</td><td>${num(c.hot)}</td><td>${num(c.warm)}</td>
    <td>${num(c.verified)}</td><td>${num(c.noEmail)}</td>
    <td>${num(c.credits.trigify)}</td><td>${num(c.credits.prospeo)}</td><td>${num(c.credits.sendkit)}</td></tr>`).join("")
    || `<tr><td colspan="9" class="muted" style="padding:24px;text-align:center">No campaigns yet</td></tr>`;
}

async function loadStats() {
  const s = await j("/api/stats" + (F.campaign ? "?campaign=" + encodeURIComponent(F.campaign) : ""));
  $("#sidefoot").textContent = `${num(s.proxies)} proxies · ${num(s.engagements)} engagements`;
  $("#stats").innerHTML = `
    <div class="card"><div class="k">Total</div><div class="v">${num(s.total)}</div></div>
    <div class="card hot"><div class="k">Hot</div><div class="v">${num(s.hot)}</div></div>
    <div class="card warm"><div class="k">Warm</div><div class="v">${num(s.warm)}</div></div>
    <div class="card cold"><div class="k">Cold</div><div class="v">${num(s.cold)}</div></div>
    <div class="card good"><div class="k">Verified</div><div class="v">${num(s.verified)}</div></div>
    <div class="card"><div class="k">No-email</div><div class="v">${num(s.noEmail)}</div></div>
    <div class="card"><div class="k">Unverified</div><div class="v">${num(s.unverified)}</div></div>`;
}

// ---------- leads table (shared by Leads + Hand-off) ----------
function tableHTML(rows) {
  return `<div class="tablewrap"><table>
    <thead><tr>
      <th>Person</th><th>Company</th><th>Status</th><th>Score</th><th>Email</th>
      <th>Found by</th><th>Verified</th><th>Categories</th><th>Seen</th><th>First seen</th><th>Last seen</th>
    </tr></thead><tbody>${rows.map(rowHTML).join("")}</tbody></table></div>`;
}
function rowHTML(r) {
  return `<tr onclick='openDrawer(${JSON.stringify(r.linkedin_url)}, ${JSON.stringify(esc(r.name))})'>
    <td><div class="nm">${esc(r.name) || "—"}</div>${r.email ? `<div class="em mono">${esc(r.email.slice(0, 40))}</div>` : ""}</td>
    <td class="muted">${esc(r.company || "")}</td>
    <td>${statusBadge(r.status)}</td>
    <td class="score">${r.score ?? 0}</td>
    <td>${emailPill(r.email_status)}</td>
    <td>${methodLabel(r.email_method)}</td>
    <td>${verifiedBy(r.verified_by)}</td>
    <td><div class="cats">${(r.categories || []).map((c) => `<span class="cat">${c}</span>`).join("")}</div></td>
    <td class="tstamp">${r.times_seen || 1}×</td>
    <td class="tstamp">${ts(r.created_at)}</td>
    <td class="tstamp">${ts(r.last_engagement_at)}</td>
  </tr>`;
}

async function renderLeads(view) {
  const pageKey = view === "handoff" ? "handoff" : "leads";
  const p = new URLSearchParams();
  if (view === "handoff") { p.set("email_status", "no-email"); }
  else {
    if (F.status) p.set("status", F.status);
    if (F.email) p.set("email_status", F.email);
    if (F.cat) p.set("category", F.cat);
    if (F.campaign) p.set("campaign", F.campaign);
    if (F.q) p.set("q", F.q);
    p.set("sort", F.sort);
  }
  p.set("limit", SIZE);
  p.set("skip", PAGE[pageKey] * SIZE);

  const { rows, count } = await j("/api/leads?" + p.toString());
  const hostId = view === "handoff" ? "#handoffHost" : "#tableHost";
  const pagerId = view === "handoff" ? "#pagerH" : "#pager";
  $(hostId).innerHTML = rows.length ? tableHTML(rows) : '<div id="empty">No leads in this view.</div>';

  const from = count ? PAGE[pageKey] * SIZE + 1 : 0;
  const to = Math.min(count, (PAGE[pageKey] + 1) * SIZE);
  const last = Math.max(0, Math.ceil(count / SIZE) - 1);
  $(pagerId).innerHTML = `<span>${from}–${to} of ${num(count)}</span>
    <button class="btn btn-ghost" ${PAGE[pageKey] <= 0 ? "disabled" : ""} data-pg="prev" data-v="${view}">Prev</button>
    <button class="btn btn-ghost" ${PAGE[pageKey] >= last ? "disabled" : ""} data-pg="next" data-v="${view}">Next</button>`;
  $(pagerId).querySelectorAll("button[data-pg]").forEach((b) => b.addEventListener("click", () => {
    PAGE[pageKey] += b.dataset.pg === "next" ? 1 : -1;
    if (PAGE[pageKey] < 0) PAGE[pageKey] = 0;
    renderLeads(view);
  }));
}

// ---------- leads toolbar ----------
function buildToolbar() {
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
  const camps = CAMPAIGNS.map((c) => opt(c.campaign, c.campaign, F.campaign)).join("");
  $("#leadsToolbar").innerHTML = `
    <select id="f-campaign"><option value="">All campaigns</option>${camps}</select>
    <select id="f-status">${opt("", "All status", F.status)}${opt("hot", "🔥 Hot", F.status)}${opt("warm", "🟡 Warm", F.status)}${opt("cold", "🔵 Cold", F.status)}</select>
    <select id="f-email">${opt("", "All emails", F.email)}${opt("verified", "Verified", F.email)}${opt("no-email", "No email", F.email)}${opt("unverified", "Unverified", F.email)}${opt("role-based", "Role-based", F.email)}</select>
    <select id="f-cat">${opt("", "All categories", F.cat)}${["infra-competitor", "deliverability", "infra", "sequencer", "gtm-eng", "data-tools", "cold-email"].map((c) => opt(c, c, F.cat)).join("")}</select>
    <select id="f-sort">${opt("score", "Sort: score", F.sort)}${opt("recent", "Sort: recent", F.sort)}</select>
    <input id="f-q" placeholder="search name / email / company" value="${esc(F.q)}" />`;
  const bind = (id, key) => $("#" + id).addEventListener("change", (e) => { F[key] = e.target.value; PAGE.leads = 0; loadTop(); renderLeads("leads"); });
  bind("f-campaign", "campaign"); bind("f-status", "status"); bind("f-email", "email"); bind("f-cat", "cat"); bind("f-sort", "sort");
  let t; $("#f-q").addEventListener("input", (e) => { F.q = e.target.value; clearTimeout(t); t = setTimeout(() => { PAGE.leads = 0; renderLeads("leads"); }, 300); });
}

// ---------- view switch ----------
const TITLES = { overview: "Overview", leads: "Leads", handoff: "Hand-off · No email", campaigns: "Campaigns" };
function switchView(v) {
  VIEW = v;
  document.querySelectorAll(".nav-i").forEach((n) => n.classList.toggle("on", n.dataset.v === v));
  ["overview", "leads", "handoff", "campaigns"].forEach((x) => $("#v-" + x).style.display = x === v ? "" : "none");
  $("#pageTitle").textContent = TITLES[v];
  if (v === "leads") { buildToolbar(); renderLeads("leads"); }
  if (v === "handoff") renderLeads("handoff");
}

// ---------- reprocess ----------
async function pollReprocess() {
  const s = await j("/api/reprocess/status");
  if (s.running) {
    $("#reprocessMsg").textContent = `Reprocessing… ${s.processed}/${s.total} · ${s.newlyFound} emails found`;
    setTimeout(pollReprocess, 2000);
  } else {
    $("#reprocessBtn").disabled = false;
    if (s.total) $("#reprocessMsg").textContent = `Done · ${s.newlyFound} of ${s.total} now have emails`;
    loadTop(); loadStats(); renderLeads("handoff");
  }
}
async function startReprocess() {
  $("#reprocessBtn").disabled = true;
  $("#reprocessMsg").textContent = "Starting…";
  await fetch("/api/reprocess", { method: "POST" });
  pollReprocess();
}

// ---------- drawer ----------
window.openDrawer = async (url, name) => {
  $("#d-name").textContent = name || "—";
  $("#d-sub").textContent = url;
  const { rows } = await j("/api/leads/" + encodeURIComponent(url) + "/timeline");
  $("#d-meta").innerHTML = "";
  $("#d-timeline").innerHTML = rows.map((e) => `
    <div class="tl"><div><strong>${esc(e.category)}</strong> · ${e.engagement}</div>
      <div class="c">${esc(e.campaign || "")} · ${new Date(e.created_at).toLocaleString()}</div>
      ${e.comment_text ? `<div class="c">“${esc(e.comment_text)}”</div>` : ""}
      <div class="c"><a href="${esc(e.post_url)}" target="_blank">post ↗</a></div></div>`).join("") || '<div class="muted">no timeline</div>';
  $("#drawer").classList.add("open");
};
window.closeDrawer = () => $("#drawer").classList.remove("open");

// ---------- init ----------
document.querySelectorAll(".nav-i").forEach((n) => n.addEventListener("click", () => switchView(n.dataset.v)));
$("#reprocessBtn").addEventListener("click", startReprocess);

function refresh() { loadTop(); loadStats(); if (VIEW === "leads") renderLeads("leads"); if (VIEW === "handoff") renderLeads("handoff"); }
refresh();
setInterval(refresh, 20000);
