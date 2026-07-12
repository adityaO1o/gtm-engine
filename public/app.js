const $ = (s) => document.querySelector(s);
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const j = async (u) => (await fetch(u)).json();
const num = (n) => (n ?? 0).toLocaleString();

let CURRENT = "";            // "" = all campaigns
let CAMPAIGNS = [];          // from /api/campaigns

function qp() { return CURRENT ? "?campaign=" + encodeURIComponent(CURRENT) : ""; }

// ---- campaign tabs + per-campaign credits ----
async function loadCampaigns() {
  const d = await j("/api/campaigns");
  CAMPAIGNS = d.campaigns || [];

  // top-right Trigify balance
  const b = d.trigify;
  if (b) {
    const pct = b.limit ? Math.min(100, (b.used / b.limit) * 100) : 0;
    $("#bal").innerHTML =
      `Trigify credits · <b>${num(b.remaining)}</b> left of ${num(b.limit)}
       <div class="bar"><i style="width:${pct}%"></i></div>`;
  }

  // tabs
  const allTotal = CAMPAIGNS.reduce((s, c) => s + c.total, 0);
  let tabs = `<div class="tab ${CURRENT === "" ? "on" : ""}" data-c="">All campaigns<span class="c">${num(allTotal)}</span></div>`;
  tabs += CAMPAIGNS.map((c) =>
    `<div class="tab ${CURRENT === c.campaign ? "on" : ""}" data-c="${esc(c.campaign)}">${esc(c.campaign)}<span class="c">${num(c.total)}</span></div>`
  ).join("");
  $("#tabs").innerHTML = tabs;
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => { CURRENT = t.dataset.c; refresh(); })
  );

  // credits strip (selected campaign, or summed for "all")
  let tg = 0, pr = 0, sk = 0;
  const pick = CURRENT ? CAMPAIGNS.filter((c) => c.campaign === CURRENT) : CAMPAIGNS;
  pick.forEach((c) => { tg += c.credits.trigify; pr += c.credits.prospeo; sk += c.credits.sendkit; });
  $("#credits").innerHTML = `
    <div class="cred tg"><div><div class="k">Trigify</div><div class="v">${num(tg)}</div></div></div>
    <div class="cred"><div><div class="k">Prospeo</div><div class="v">${num(pr)}</div></div></div>
    <div class="cred"><div><div class="k">SendKit</div><div class="v">${num(sk)}</div></div></div>`;
}

async function loadStats() {
  const s = await j("/api/stats" + qp());
  $("#proxysub").textContent = `${num(s.proxies)} proxies · ${num(s.engagements)} engagements`;
  $("#stats").innerHTML = `
    <div class="stat"><div class="n">${num(s.total)}</div><div class="l">Total leads</div></div>
    <div class="stat hot"><div class="n">${num(s.hot)}</div><div class="l">🔥 Hot</div></div>
    <div class="stat warm"><div class="n">${num(s.warm)}</div><div class="l">🟡 Warm</div></div>
    <div class="stat cold"><div class="n">${num(s.cold)}</div><div class="l">🔵 Cold</div></div>
    <div class="stat good"><div class="n">${num(s.verified)}</div><div class="l">Verified email</div></div>
    <div class="stat"><div class="n">${num(s.noEmail)}</div><div class="l">No email · hand-off</div></div>
    <div class="stat"><div class="n">${num(s.unverified)}</div><div class="l">Unverified</div></div>`;
}

const badge = (st) => `<span class="badge ${({ hot: "b-hot", warm: "b-warm", cold: "b-cold" }[st]) || "b-cold"}">${st || "cold"}</span>`;

// "found by Prospeo · verified by Enrich"
function provenance(r) {
  if (!r.email) return "";
  const cap = (x) => x ? x[0].toUpperCase() + x.slice(1) : "";
  const parts = [];
  if (r.email_source) parts.push(`found by <b>${cap(r.email_source)}</b>`);
  if (r.verified_by) parts.push(`verified by <b>${cap(r.verified_by)}</b>`);
  return parts.length ? `<div class="prov">${parts.join(" · ")}</div>` : "";
}

async function loadLeads() {
  const p = new URLSearchParams();
  if (CURRENT) p.set("campaign", CURRENT);
  const st = $("#f-status").value, em = $("#f-email").value, cat = $("#f-cat").value, q = $("#f-q").value;
  if (st) p.set("status", st);
  if (em) p.set("email_status", em);
  if (cat) p.set("category", cat);
  if (q) p.set("q", q);
  p.set("sort", $("#f-sort").value);
  p.set("limit", "300");

  const { rows } = await j("/api/leads?" + p.toString());
  $("#empty").style.display = rows.length ? "none" : "block";
  $("#rows").innerHTML = rows.map((r) => `
    <tr onclick='openDrawer(${JSON.stringify(r.linkedin_url)}, ${JSON.stringify(esc(r.name))})'>
      <td>
        <div class="name">${esc(r.name) || "—"}</div>
        ${r.email ? `<div class="email mono">${esc(r.email.slice(0, 38))}</div>` : ""}
        ${provenance(r)}
      </td>
      <td>${badge(r.status)}</td>
      <td><span class="score">${r.score ?? 0}</span></td>
      <td><span class="em em-${r.email_status || "no-email"}">${r.email_status || "—"}</span></td>
      <td><div class="cats">${(r.categories || []).map((c) => `<span class="cat">${c}</span>`).join("")}</div></td>
      <td><span class="seen">${r.times_seen || 1}×</span></td>
      <td class="muted">${esc(r.company || "")}</td>
    </tr>`).join("");
}

window.openDrawer = async (url, name) => {
  $("#d-name").textContent = name || "—";
  $("#d-sub").textContent = url;
  const { rows } = await j("/api/leads/" + encodeURIComponent(url) + "/timeline");
  $("#d-timeline").innerHTML = rows.map((e) => `
    <div class="tl">
      <div><strong>${esc(e.category)}</strong> · ${e.engagement}</div>
      <div class="c">${esc(e.campaign || "")} · ${new Date(e.created_at).toLocaleString()}</div>
      ${e.comment_text ? `<div class="c">“${esc(e.comment_text)}”</div>` : ""}
      <div class="c"><a href="${esc(e.post_url)}" target="_blank">post ↗</a></div>
    </div>`).join("") || '<div class="muted">no timeline</div>';
  $("#drawer").classList.add("open");
};
window.closeDrawer = () => $("#drawer").classList.remove("open");

function refresh() {
  loadCampaigns();
  loadStats();
  loadLeads();
}

["f-status", "f-email", "f-cat", "f-sort"].forEach((id) => $("#" + id).addEventListener("change", loadLeads));
let t; $("#f-q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(loadLeads, 300); });

refresh();
setInterval(refresh, 20000);
