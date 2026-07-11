const $ = (s) => document.querySelector(s);
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function j(url) { const r = await fetch(url); return r.json(); }

async function loadStats() {
  const s = await j("/api/stats");
  $("#proxytag").textContent = `proxies ${s.proxies}`;
  $("#engtag").textContent = `${s.engagements} engagements`;
  $("#stats").innerHTML = `
    <div class="stat"><div class="n">${s.total}</div><div class="l">Total leads</div></div>
    <div class="stat hot"><div class="n">${s.hot}</div><div class="l">🔥 Hot</div></div>
    <div class="stat warm"><div class="n">${s.warm}</div><div class="l">🟡 Warm</div></div>
    <div class="stat cold"><div class="n">${s.cold}</div><div class="l">🔵 Cold</div></div>
    <div class="stat good"><div class="n">${s.verified}</div><div class="l">Verified email</div></div>
    <div class="stat"><div class="n">${s.noEmail}</div><div class="l">No email (hand-off)</div></div>
    <div class="stat"><div class="n">${s.unverified}</div><div class="l">Unverified</div></div>`;
}

function badge(status) {
  const map = { hot: "b-hot", warm: "b-warm", cold: "b-cold" };
  return `<span class="badge ${map[status] || "b-cold"}">${status || "cold"}</span>`;
}

async function loadLeads() {
  const p = new URLSearchParams();
  const st = $("#f-status").value, em = $("#f-email").value, cat = $("#f-cat").value,
        q = $("#f-q").value, sort = $("#f-sort").value;
  if (st) p.set("status", st);
  if (em) p.set("email_status", em);
  if (cat) p.set("category", cat);
  if (q) p.set("q", q);
  p.set("sort", sort);
  p.set("limit", "200");

  const { rows } = await j("/api/leads?" + p.toString());
  const tb = $("#rows");
  $("#empty").style.display = rows.length ? "none" : "block";
  tb.innerHTML = rows.map((r) => `
    <tr onclick='openDrawer(${JSON.stringify(r.linkedin_url)}, ${JSON.stringify(esc(r.name))})'>
      <td><div class="name">${esc(r.name) || "—"}</div>
          <div class="muted">${esc((r.email || "").slice(0, 34))}</div></td>
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
      <div class="c"><a href="${esc(e.post_url)}" target="_blank" style="color:var(--accent)">post ↗</a></div>
    </div>`).join("") || '<div class="muted">no timeline</div>';
  $("#drawer").classList.add("open");
};
window.closeDrawer = () => $("#drawer").classList.remove("open");

function refresh() {
  loadStats();
  loadLeads();
  $("#refreshed").textContent = "updated " + new Date().toLocaleTimeString();
}

["f-status", "f-email", "f-cat", "f-sort"].forEach((id) => $("#" + id).addEventListener("change", loadLeads));
let t; $("#f-q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(loadLeads, 300); });

refresh();
setInterval(refresh, 20000);
