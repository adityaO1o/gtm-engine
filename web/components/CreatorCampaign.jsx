"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import Pager from "@/components/Pager";
import { num, pctOf, ts } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useToast } from "@/lib/toast";

// The outreach running order, fixed by the extract. Creator scoring filters INSIDE a tier — it
// never reorders these, which is why they are hard-coded here rather than sorted from the response.
// The colour ramp runs leaving -> slipping -> healthy -> free -> cold and is reused everywhere the
// tier appears, so the order is readable without reading the labels.
const TIERS = [
  { id: "P1_CHURN", label: "P1 · Churn", short: "P1", note: "paid before, spend collapsed ≥30%", play: "Win-back. Most urgent. Check why they deleted mailboxes — they often said." },
  { id: "P1b_AT_RISK", label: "P1b · At risk", short: "P1b", note: "looks stable, trend is falling", play: "Reach them before they become P1. Highest revenue at stake of any tier." },
  { id: "P2_GROWING", label: "P2 · Growing", short: "P2g", note: "paying, and their spend is going UP", play: "The Creator Programme's core. They are already winning with the product, so they have something real to say." },
  { id: "P2_PAYING", label: "P2 · Paying", short: "P2", note: "healthy paying customers, spend flat", play: "The rest of the paying base. Steady, but no growth story to lead with." },
  { id: "P3a_FREE_ACTIVATED", label: "P3a · Free, activated", short: "P3a", note: "never paid, live mailbox running", play: "Warmest free lead in the business — already getting value." },
  { id: "P3b_FREE_TRIED", label: "P3b · Free, tried", short: "P3b", note: "set something up, then stopped", play: "Activation problem. Something blocked them — ask what." },
  { id: "P3c_FREE_DORMANT", label: "P3c · Free, dormant", short: "P3c", note: "signed up, never used anything", play: "Cold. Bulk nurture only, low expectations." },
];
const tierOf = (id) => TIERS.find((t) => t.id === id);

const FIT = {
  QUALIFIED: { label: "Qualified", cls: "p-verified", hint: "profile + audience + posting + on-topic" },
  CANDIDATE: { label: "Candidate", cls: "p-review", hint: "profile + audience clear the floor; posting not checked yet" },
  WEAK: { label: "Weak", cls: "p-unverified", hint: "profile found, but below the creator bar — still worth a testimonial" },
  UNVERIFIED: { label: "Unverified", cls: "p-unverified", hint: "a profile was found but nothing ties it to this customer — not scored as a creator" },
  NO_PROFILE: { label: "No profile", cls: "p-role-based", hint: "no LinkedIn found. Still gets normal outreach" },
  UNRESOLVED: { label: "Unresolved", cls: "p-no-email", hint: "not enriched yet" },
};

// Growth: the opposite of the churn signal — but ONLY where the money supports it. A growing
// account must actually pay us (a free signup has no revenue to grow) and must be old enough to
// score (a customer younger than the 6-month window has empty early buckets, so its trend line
// slopes up automatically — that is being new, not growing).
//
// Slot upgrades and "added a domain" were tried as signals and dropped: slots_prev is zero on
// almost every account, so "UP" meant "has slots" and put 25 CHURNED customers in the growing
// column, and adding a domain is something a shrinking account does too.
const GROWTH = {
  EXPANDING: { label: "Expanding", hint: "spend more than doubled against their own normal" },
  GROWING: { label: "Growing", hint: "spend up 30%+ against their own normal" },
  RISING: { label: "Rising", hint: "band reads stable, trend line is climbing — the mirror of P1b, and no band shows it" },
};

const usd = (n) => "$" + Math.round(n ?? 0).toLocaleString();
const handle = (url) => (url || "").replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "").replace(/\/$/, "");

const mo = (n) => (n == null ? null : "$" + Math.round(n).toLocaleString());

// The evidence behind a band. A row that says "RED" without showing the money is asking to be
// trusted; this shows the six 30-day buckets, the customer's own normal, and what they spend now —
// which is exactly the comparison the band is cut from, so anyone can check it on the spot.
function SpendCell({ p }) {
  const b = Array.isArray(p.buckets) ? p.buckets : null;
  const base = p.avg_monthly_baseline, now = p.recent_monthly_runrate, d = p.drop_vs_normal_pct;
  if (!b && base == null && !p.lifetime_spend) return <span className="muted">never paid</span>;
  const dir = d == null ? "flat" : d <= -5 ? "down" : d >= 5 ? "up" : "flat";
  const max = b ? Math.max(...b.map((x) => x.spend), 1) : 1;
  return (
    <>
      {b ? (
        <div className={`spark ${dir}`} title={b.map((x) => `${x.m} ${x.start || ""}: ${mo(x.spend)}`).join(String.fromCharCode(10))}>
          {b.map((x, i) => <i key={i} style={{ height: `${Math.max(2, Math.round((x.spend / max) * 20))}px`, opacity: x.spend ? 1 : 0.25 }} />)}
        </div>
      ) : null}
      {base != null || now != null ? (
        <div className="wasnow">
          <b>{mo(base) ?? "—"}</b><span className="ar">→</span><b>{mo(now) ?? "$0"}</b> /mo
        </div>
      ) : null}
      {d != null ? <div className={`delta ${dir}`}>{d > 0 ? "+" : ""}{Math.round(d)}% vs their normal</div>
        : p.guard_flags ? <div className="via">{String(p.guard_flags).replace(/_/g, " ").toLowerCase()}</div> : null}
    </>
  );
}

const TierBadge = ({ id }) => {
  const t = tierOf(id);
  return <span className={`tb tb-${id}`}><i />{t ? t.label : id || "—"}</span>;
};

export default function CreatorCampaign() {
  const toast = useToast();
  const [stats, setStats] = useState(null);
  const [run, setRun] = useState({});
  // null = the funnel. A string = drilled into that tier. "" = drilled into everyone.
  const [drill, setDrill] = useState(null);
  const [setup, setSetup] = useState(false);
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(100);
  const [fit, setFit] = useState("");
  const [audience, setAudience] = useState("");
  const [role, setRole] = useState("");
  const [growth, setGrowth] = useState("");
  const [onlyAudience, setOnlyAudience] = useState(false);
  const [sort, setSort] = useState("priority");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [busy, setBusy] = useState("");
  const [runTiers, setRunTiers] = useState([]);
  const [limit, setLimit] = useState(0);
  const [usePnd, setUsePnd] = useState(true);
  const [useSerp, setUseSerp] = useState(true);
  const [verifyPnd, setVerifyPnd] = useState(true);
  const [gates, setGates] = useState({ minAudience: 500, minFollowers: 1000, requirePublic: true });
  const timer = useRef(null);

  useEffect(() => { const t = setTimeout(() => { setDq(q); setPage(0); }, 300); return () => clearTimeout(t); }, [q]);

  const loadStats = useCallback(() => {
    j("/api/creator/stats").then((d) => { setStats(d); setRun(d.run || {}); if (d.gates) setGates((g) => ({ ...g, ...d.gates })); }).catch(() => {});
  }, []);

  const params = useCallback(() => {
    const p = new URLSearchParams();
    if (drill) p.set("tier", drill);
    if (fit) p.set("fit", fit);
    if (audience) p.set("audience", audience);
    if (role) p.set("role", role);
    if (growth) p.set("growth", growth);
    if (onlyAudience) p.set("inAudience", "1");
    if (dq) p.set("q", dq);
    return p;
  }, [drill, fit, audience, role, growth, onlyAudience, dq]);

  // People are fetched ONLY inside a drill-down. The funnel is a summary — it never dumps the base
  // underneath itself, which is what made clicking a tier look like it had done nothing.
  const loadRows = useCallback(() => {
    if (drill === null) { setRows([]); setCount(0); return; }
    const p = params();
    p.set("page", page); p.set("size", size); p.set("sort", sort);
    j(`/api/creator/people?${p}`).then((d) => { setRows(d.items || []); setCount(d.count || 0); }).catch(() => {});
  }, [drill, params, page, size, sort]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadRows(); }, [loadRows]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!run.running) return;
    timer.current = setTimeout(() => {
      j("/api/creator/enrich/status").then((s) => {
        setRun(s);
        if (!s.running) { loadStats(); loadRows(); toast(`Enrichment finished — ${num(s.hits + s.serpHits)} profiles found`, "good"); }
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer.current);
  }, [run, loadStats, loadRows, toast]);

  const openTier = (id) => { setDrill(id); setPage(0); setFit(""); setAudience(""); setRole(""); setGrowth(""); setOnlyAudience(false); setQ(""); setDq(""); };
  const back = () => { setDrill(null); setRows([]); setCount(0); setGrowth(""); };
  // Clicking a growth count on the funnel should land you IN that list, not just tick a filter on a
  // summary — so it opens the drill-down with the pick intact.
  const openTierKeepGrowth = (id, g) => { setDrill(id); setPage(0); setFit(""); setAudience(""); setRole(""); setOnlyAudience(false); setQ(""); setDq(""); setGrowth(g); };

  async function upload(kind, file) {
    if (!file) return;
    setBusy(kind);
    try {
      const body = await file.text();
      const r = await fetch(`/api/creator/import/${kind}`, { method: "POST", headers: { "Content-Type": "text/csv" }, body });
      const d = await r.json();
      if (d.ok) {
        toast(kind === "companies" ? `Imported ${num(d.companies)} companies`
          : kind === "spend" ? `Monthly revenue for ${num(d.companies)} companies (${num(d.rows)} buckets)`
          : `${num(d.people)} people from ${num(d.rows)} rows · ${num(d.duplicatesMerged)} duplicates merged · ${num(d.audienceMatched)} already in our audience`, "good");
        loadStats(); loadRows();
      } else toast(d.error || "Import failed", "bad");
    } catch (e) { toast(e.message || "Import failed", "bad"); }
    setBusy("");
  }

  async function startEnrich() {
    const scope = runTiers.length ? runTiers.map((t) => tierOf(t)?.label).join(", ") : "the whole base, in priority order";
    if (!confirm(`Resolve LinkedIn profiles for ${scope}.\n\nenrich.so reverse lookup runs first (10 credits, refunded on a miss)${useSerp ? ", then the free SERP resolver picks up everyone it missed" : ""}.\n\nNobody is dropped — a miss is recorded as "no profile" and keeps its place in outreach.`)) return;
    setBusy("enrich");
    try {
      const r = await post("/api/creator/enrich", { tiers: runTiers, limit: Number(limit) || 0, usePnd, useSerp, verifyWithPnd: verifyPnd, gates });
      if (r.ok) { toast(`Enriching ${num(r.total)} people`, "info"); setRun({ running: true, done: 0, total: r.total, hits: 0, serpHits: 0, misses: 0 }); }
      else toast(r.error || "Could not start", "bad");
    } catch { toast("Could not start", "bad"); }
    setBusy("");
  }

  async function act(url, body, msg) {
    setBusy(url);
    try {
      const r = await post(url, body);
      toast(msg(r), r.ok === false ? "bad" : "good");
      loadStats(); loadRows();
    } catch { toast("Failed", "bad"); }
    setBusy("");
  }

  const t = stats?.totals;
  const byTier = Object.fromEntries((stats?.tiers || []).map((r) => [r.tier, r]));
  const empty = !t || !t.people;

  // ── Import ─────────────────────────────────────────────────────────────────────────────────
  const importBlock = (
    <div className="blk">
      <div className="blk-h"><Icon name="inbox" /><b>Import the extract</b><div className="grow" />
        {stats?.lastImport ? <span className="via">last import {ts(stats.lastImport.startedAt)}</span> : null}
      </div>
      <div className="blk-b">
        <div className="lede">
          These CSVs hold customer PII, so they are never committed anywhere — they upload straight into the
          engine. Upload in this order — <b>companies</b>, then <b>spend</b>, then <b>people</b> — because each
          one copies context onto the next. Re-uploading a fresh extract refreshes the churn numbers and
          <b> keeps</b> every LinkedIn profile already resolved, so a refresh never costs the enrichment work again.
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer" }}>
            {busy === "companies" ? "Reading…" : "companies.csv"}
            <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
              onChange={(e) => { upload("companies", e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer" }}>
            {busy === "spend" ? "Reading…" : "spend_monthly.csv"}
            <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
              onChange={(e) => { upload("spend", e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer" }}>
            {busy === "users" ? "Reading…" : "company_users.csv"}
            <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
              onChange={(e) => { upload("users", e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {stats?.companies ? <span className="resn"><b>{num(stats.companies)}</b> companies · <b>{num(t?.people)}</b> people</span> : null}
        </div>
      </div>
    </div>
  );

  if (empty) {
    return (
      <>
        <div className="note"><Icon name="spark" /><div>
          Two separate things live on this page. <b>Commercial priority</b> — P1 Churn → P1b At-risk → P2 Paying
          → P3 Free — comes from the extract and is <b>fixed</b>. <b>Creator fit</b> is a filter applied
          <b> inside</b> each tier. Failing it never removes anyone from outreach; it only changes the message.
        </div></div>
        {importBlock}
        <div className="empty">Upload <b>companies.csv</b> first, then <b>company_users.csv</b>. The people file is the contact list — the companies file supplies the churn, spend and segment context copied onto every person.</div>
      </>
    );
  }

  // ── Drill-down: one tier (or everyone), and nothing else ───────────────────────────────────
  if (drill !== null) {
    const info = tierOf(drill);
    const r = byTier[drill] || {};
    const scoped = drill ? r : { ...t, companies: stats.companies };
    const exportUrl = `/api/creator/people.csv?${params()}`;
    return (
      <>
        <div className="crumb" onClick={back}><Icon name="back" />All tiers</div>

        <div className="thead-d">
          {drill ? <TierBadge id={drill} /> : <span className="tb tb-P2_PAYING"><i />Everyone</span>}
          <h2>{drill ? info?.label : "All people"}</h2>
          <div className="grow" style={{ flex: 1 }} />
          <a className="btn btn-ghost btn-sm" href={exportUrl}><Icon name="download" />Export CSV</a>
        </div>
        {drill && info ? <div className="note" style={{ marginTop: 0 }}><Icon name="mega" /><div><b>{info.note}.</b> {info.play}</div></div> : null}

        <div className="grid g-stat" style={{ marginBottom: "var(--s4)" }}>
          {drill ? <div className="card"><div className="kh"><Icon name="flag" />Companies</div><div className="v">{num(scoped.companies)}</div></div> : null}
          <div className="card"><div className="kh"><Icon name="users" />People</div><div className="v">{num(scoped.people)}</div></div>
          <div className="card"><div className="kh"><Icon name="trend" />Lifetime spend</div><div className="v">{usd(scoped.spend)}</div></div>
          <div className="card pri"><div className="kh"><Icon name="external" />LinkedIn</div><div className="v">{num(scoped.resolved)}</div><div className="sub">{pctOf(scoped.resolved, scoped.people)}% resolved</div></div>
          <div className="card"><div className="kh"><Icon name="trend" />Growing</div><div className="v" style={{ color: "var(--good)" }}>{num(scoped.growing)}</div><div className="sub">paying customers whose spend is up</div></div>
          <div className="card rec"><div className="kh"><Icon name="radio" />In our audience</div><div className="v">{num(scoped.inAudience)}</div></div>
          <div className="card"><div className="kh"><Icon name="check" />Creator pool</div><div className="v">{num((scoped.qualified || 0) + (scoped.candidate || 0))}</div><div className="sub">{num(scoped.qualified)} qualified · {num(scoped.candidate)} candidate</div></div>
        </div>

        <div className="toolbar">
          <input className="search" placeholder="name, email, company…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="field"><select value={fit} onChange={(e) => { setFit(e.target.value); setPage(0); }}>
            <option value="">Any creator fit</option>{Object.entries(FIT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select></div>
          <div className="field"><select value={audience} onChange={(e) => { setAudience(e.target.value); setPage(0); }}>
            <option value="">LinkedIn: any</option><option value="resolved">resolved</option><option value="unresolved">not resolved</option>
          </select></div>
          <div className="field"><select value={role} onChange={(e) => { setRole(e.target.value); setPage(0); }}>
            <option value="">Any role</option><option value="admin">admin</option><option value="member">member</option>
          </select></div>
          <div className="field"><select value={growth} onChange={(e) => { setGrowth(e.target.value); setPage(0); }}>
            <option value="">Any growth</option>
            <option value="any">Growing (any signal)</option>
            {Object.entries(GROWTH).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select></div>
          <span className={`chip${onlyAudience ? " on" : ""}`} onClick={() => { setOnlyAudience((v) => !v); setPage(0); }}>In our audience</span>
          <div className="field"><select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="priority">Sort: spend</option><option value="audience">Sort: audience</option>
          </select></div>
        </div>

        <div className="tablewrap">
          <table>
            <thead><tr>
              <th>Person</th><th>Company</th>{drill ? null : <th>Tier</th>}<th>Churn</th><th>Growth</th><th>Spend · was → now</th><th>Lifetime</th>
              <th>LinkedIn</th><th>Audience</th><th>Creator fit</th><th>Why</th>
            </tr></thead>
            <tbody>
              {rows.map((p) => {
                const f = FIT[p.creator_fit] || FIT.UNRESOLVED;
                return (
                  <tr key={p._id}>
                    <td>
                      <div className="nm">{p.user_name || <span className="muted">—</span>}
                        {p.in_audience ? <span className="cat" style={{ marginLeft: 6 }} title="already engages with our LinkedIn posts">our audience</span> : null}</div>
                      <div className="sub mono">{p._id}</div>
                      {p.job_title ? <div className="sub">{p.job_title}</div> : null}
                    </td>
                    <td><div>{p.company_name || <span className="muted">—</span>}</div><div className="sub mono">{p.company_domain}</div></td>
                    {drill ? null : <td><TierBadge id={p.contact_priority} /></td>}
                    <td>{p.churn_band
                      ? <><span className={`cb cb-${p.churn_band}`}>{p.churn_band.replace(/_/g, " ")}</span>{p.trend_direction ? <span className={`trend ${p.trend_direction}`}>{p.trend_direction}</span> : null}</>
                      : <span className="muted">—</span>}</td>
                    <td>{p.growth && p.growth !== "NONE"
                      ? <span className={`gw gw-${p.growth}`} title={(GROWTH[p.growth] || {}).hint}>{(GROWTH[p.growth] || {}).label || p.growth}</span>
                      : <span className="muted">—</span>}
                      {(p.growth_reasons || []).length > 1 ? <div className="via">+{p.growth_reasons.length - 1} more</div> : null}</td>
                    <td><SpendCell p={p} /></td>
                    <td className="score">{p.lifetime_spend ? usd(p.lifetime_spend) : <span className="muted">$0</span>}</td>
                    <td>{p.li_url
                      ? <><a className="li" href={p.li_url} target="_blank" rel="noreferrer"><Icon name="external" />{handle(p.li_url) || "profile"}</a>
                          <div className="via" title={p.li_verify_note || ""} style={p.li_verified === false ? { color: "var(--hot)" } : undefined}>
                            {p.li_verified === false ? "unverified" : `verified · ${p.li_verify || p.li_source}`}
                          </div></>
                      : <span className="muted">—</span>}</td>
                    <td className="score">{p.audience != null
                      ? <>{num(p.audience)}{p.li_connections_capped && p.audience_source === "connections" ? "+" : ""}<div className="via">{p.audience_source}</div></>
                      : <span className="muted">—</span>}</td>
                    <td><span className={`pill ${f.cls}`} title={f.hint}>{f.label}</span></td>
                    <td><span className="sub trunc" style={{ maxWidth: 250, display: "inline-block" }}>{p.creator_reason || "—"}</span></td>
                  </tr>
                );
              })}
              {!rows.length ? <tr><td colSpan={11} className="empty">Nothing matches these filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager count={count} page={page} setPage={setPage} size={size} setSize={setSize} />
      </>
    );
  }

  // ── Funnel: the running order, and how far creator resolution has got in each tier ──────────
  return (
    <>
      <div className="note"><Icon name="spark" /><div>
        Two separate things live on this page. <b>Commercial priority</b> — P1 Churn → P1b At-risk → P2 Paying
        → P3 Free — comes from the extract and is <b>fixed</b>; work it top to bottom. <b>Creator fit</b> is a
        filter applied <b>inside</b> each tier: of the people we are contacting anyway, who has an audience worth
        a creator ask. Failing the creator filter never removes anyone from outreach — it only means they get the
        normal win-back or upsell message instead. <b>Click a tier to open it.</b>
      </div></div>

      <div className="grid g-stat" style={{ marginBottom: "var(--s4)" }}>
        <div className="card"><div className="kh"><Icon name="users" />People</div><div className="v">{num(t.people)}</div><div className="sub">deduplicated humans</div></div>
        <div className="card"><div className="kh"><Icon name="trend" />Lifetime spend</div><div className="v">{usd(t.spend)}</div><div className="sub">{num(stats.companies)} companies</div></div>
        <div className="card pri"><div className="kh"><Icon name="external" />LinkedIn resolved</div><div className="v">{num(t.resolved)}</div><div className="sub">{pctOf(t.resolved, t.people)}% of people</div></div>
        <div className="card"><div className="kh"><Icon name="trend" />Growing</div><div className="v" style={{ color: "var(--good)" }}>{num(t.growing)}</div><div className="sub">the opposite of the churn signal</div></div>
        <div className="card rec"><div className="kh"><Icon name="radio" />In our audience</div><div className="v">{num(t.inAudience)}</div><div className="sub">already engage with our posts</div></div>
        <div className="card"><div className="kh"><Icon name="check" />Creator pool</div><div className="v">{num(t.qualified + t.candidate)}</div><div className="sub">{num(t.qualified)} qualified · {num(t.candidate)} candidate</div></div>
      </div>

      <div className="blk">
        <div className="blk-h"><Icon name="mega" /><b>Outreach order</b><div className="grow" />
          <span className="via" onClick={() => openTier("")} style={{ cursor: "pointer" }}>open everyone →</span>
        </div>
        <div className="tablewrap" style={{ border: "none", boxShadow: "none" }}>
          <table>
            <thead><tr>
              <th>#</th><th>Tier</th><th>Companies</th><th>People</th><th>Lifetime spend</th><th title="Expanding: spend more than doubled · Growing: up 30%+ · Rising: band stable but the trend climbing">Growth split</th><th>LinkedIn</th>
              <th>In audience</th><th>Qualified</th><th>Candidate</th><th>Weak</th><th>No profile</th><th>Pending</th><th />
            </tr></thead>
            <tbody>
              {TIERS.map((tr, i) => {
                const r = byTier[tr.id] || {};
                return (
                  <tr key={tr.id} className={`trow c-${tr.id}`} onClick={() => openTier(tr.id)}>
                    <td className="muted">{i + 1}</td>
                    <td><TierBadge id={tr.id} /><div className="sub" style={{ whiteSpace: "normal", maxWidth: 230, marginTop: 4 }}>{tr.note}</div></td>
                    <td className="muted">{num(r.companies)}</td>
                    <td><b>{num(r.people)}</b></td>
                    <td className="score">{usd(r.spend)}</td>
                    <td>{["EXPANDING", "GROWING", "RISING"].some((g) => (r.growthBreakdown || {})[g])
                      ? <span style={{ display: "inline-flex", gap: 4 }}>
                          {["EXPANDING", "GROWING", "RISING"].map((g) => (r.growthBreakdown || {})[g]
                            ? <span key={g} className={`gw gw-${g}`} title={GROWTH[g].hint}
                                onClick={(e) => { e.stopPropagation(); openTierKeepGrowth(tr.id, g); }} style={{ cursor: "pointer" }}>
                                {GROWTH[g].label} {num(r.growthBreakdown[g])}
                              </span>
                            : null)}
                        </span>
                      : <span className="muted">—</span>}</td>
                    <td>{num(r.resolved)} <span className="muted">({pctOf(r.resolved, r.people)}%)</span></td>
                    <td>{r.inAudience ? <b style={{ color: "var(--good)" }}>{num(r.inAudience)}</b> : <span className="muted">0</span>}</td>
                    <td>{r.qualified ? <b>{num(r.qualified)}</b> : <span className="muted">0</span>}</td>
                    <td>{num(r.candidate)}</td>
                    <td className="muted">{num(r.weak)}</td>
                    <td className="muted">{num(r.noProfile)}</td>
                    <td className="muted">{num(r.pending)}</td>
                    <td className="go"><Icon name="chev" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="blk-b" style={{ borderTop: "1px solid var(--line)", paddingTop: 12, paddingBottom: 12 }}>
          <div className="sub" style={{ margin: 0 }}>
            <b>P2 Growing is split out of P2 Paying</b> so it can be worked as its own step rather than hunted for
            inside a 3,000-person tier. Its split: <b>Expanding</b> = spend more than doubled against their own
            normal · <b>Growing</b> = up 30%+ · <b>Rising</b> = the band reads stable but the trend line is climbing,
            the mirror of P1b, and no band shows it. All three need the customer to actually pay us and to be old
            enough to measure, which is why the churn and free tiers read zero.<br /><br />
            Spend is counted per <b>company</b> — it is a company fact the extract copies onto every person, so
            adding it across people would multiply it by headcount. People are counted per <b>human</b>: 8,225
            rows are 6,664 distinct people, and anyone on several teams is filed under their most urgent tier,
            so a tier can hold fewer people here than in the extract.
          </div>
        </div>
      </div>

      <div className="crumb" onClick={() => setSetup((v) => !v)}>
        <Icon name={setup ? "chev" : "plus"} />{setup ? "Hide setup" : "Enrichment, gates and import"}
        {run.running ? <span className="via" style={{ marginLeft: 8 }}>· running {num(run.done)}/{num(run.total)}</span> : null}
      </div>

      {setup ? (
        <>
          {/* ── Enrichment ────────────────────────────────────────────────────────────────── */}
          <div className="blk">
            <div className="blk-h"><Icon name="bolt" /><b>Resolve LinkedIn profiles</b><div className="grow" />
              {run.running
                ? <button className="btn btn-no btn-sm" onClick={() => act("/api/creator/enrich/stop", {}, () => "Stopping after the in-flight batch")}><Icon name="pause" />Stop</button>
                : <button className="btn btn-ok btn-sm" disabled={busy === "enrich"} onClick={startEnrich}><Icon name="bolt" />Start</button>}
            </div>
            <div className="blk-b">
              <div className="lede">
                The extract carries no person-level LinkedIn at all, so every creator signal starts here.
                Three tiers, in order. <b>enrich.so reverse lookup</b> — 10 credits, refunded on a miss, and verified by
                construction since we hand it the email; it lands around 7% here, because these customers are mostly
                small agencies on their own domain. <b>LinkedIn people search</b> — asks for the name inside the
                company we already know, so a hit is the right human; ~1 credit, best pointed at the short high-value
                tiers. <b>Web search</b> — free and finds people the others miss, but it answers "who is called this",
                so everything it returns is verified against the customer&apos;s real employer before it is trusted.
                Work always walks the base in priority order, so P1 is resolved before P3c.
              </div>
              <div className="fg" style={{ marginBottom: "var(--s3)" }}>
                <label>Scope — no tier picked runs the whole base</label>
                <div className="toolbar" style={{ marginBottom: 0 }}>
                  {TIERS.map((tr) => (
                    <span key={tr.id} className={`chip${runTiers.includes(tr.id) ? " on" : ""}`}
                      onClick={() => setRunTiers((v) => v.includes(tr.id) ? v.filter((x) => x !== tr.id) : [...v, tr.id])}>
                      {tr.label}
                    </span>
                  ))}
                  {runTiers.length ? <span className="chip x" onClick={() => setRunTiers([])}>clear</span> : null}
                </div>
              </div>
              <div className="fgrid">
                <div className="fg"><label>Cap this run</label>
                  <input type="number" min="0" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="0" />
                  <div className="hint">0 = everyone in scope.</div>
                </div>
                <div className="fg"><label>LinkedIn people search</label>
                  <div className="fg-chk"><input type="checkbox" checked={usePnd} onChange={(e) => setUsePnd(e.target.checked)} /> on (PND, ~1 credit)</div>
                  <div className="hint">Asks LinkedIn for that name <b>inside that company</b>, so a hit is our customer by construction. The endpoint is flaky — the same query returns a result, then nothing, then a result — so an empty answer is retried before it is believed.</div>
                </div>
                <div className="fg"><label>SERP fallback</label>
                  <div className="fg-chk"><input type="checkbox" checked={useSerp} onChange={(e) => setUseSerp(e.target.checked)} /> on (free, self-hosted)</div>
                  <div className="hint">One search per person enrich.so missed.</div>
                </div>
                <div className="fg"><label>Verify SERP matches</label>
                  <div className="fg-chk"><input type="checkbox" checked={verifyPnd} onChange={(e) => setVerifyPnd(e.target.checked)} /> check the employer via PND</div>
                  <div className="hint">A search finds whoever shares the name. This reads the profile&apos;s real employer and drops it if it is not this customer. Costs PND credits; without it a SERP match is kept but marked unverified.</div>
                </div>
                <div className="fg"><label>Our own audience</label>
                  <button className="btn btn-ghost btn-sm" style={{ width: "100%" }} disabled={!!busy}
                    onClick={() => act("/api/creator/match-audience", {}, (r) => `${num(r.matched)} people matched to our own audience`)}>
                    <Icon name="radio" />Re-match
                  </button>
                  <div className="hint">Cross-checks the base against our 83k-lead engagement DB. Free, and hands back the profile where it hits.</div>
                </div>
              </div>
              {run.total ? (
                <>
                  <div className={`prog${run.running ? " on" : ""}`} style={{ marginTop: "var(--s4)" }}><i style={{ width: `${pctOf(run.done, run.total)}%` }} /></div>
                  <div className="resn" style={{ marginTop: 8 }}>
                    <b>{num(run.done)}</b> / {num(run.total)} · enrich.so <b>{num(run.hits)}</b> · LinkedIn search <b>{num(run.pndHits)}</b> · SERP verified <b>{num(run.serpHits)}</b> · unverified <b>{num(run.unverified)}</b> · wrong person dropped <b>{num(run.rejected)}</b> · no profile <b>{num(run.misses)}</b>
                    {run.errors ? <> · errors <b>{num(run.errors)}</b></> : null}
                    {run.running ? " · running" : run.phase === "stopped" ? " · stopped" : ""}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {/* ── Gates ─────────────────────────────────────────────────────────────────────── */}
          <div className="blk">
            <div className="blk-h"><Icon name="shield" /><b>Creator gates</b><div className="grow" />
              <button className="btn btn-ghost btn-sm" disabled={!!busy}
                onClick={() => act("/api/creator/rescore", { gates }, (r) => `Re-scored ${num(r.rescored)} people`)}>
                <Icon name="refresh" />Re-score
              </button>
            </div>
            <div className="blk-b">
              <div className="lede">
                Where the bar sits for a creator ask. Re-scoring is a pure recompute over data we already hold — it
                never spends a credit, so tune freely. Nobody is deleted by a change here; only their label moves.
              </div>
              <div className="fgrid">
                <div className="fg"><label>Min connections</label>
                  <input type="number" min="0" value={gates.minAudience} onChange={(e) => setGates({ ...gates, minAudience: +e.target.value })} />
                  <div className="hint">LinkedIn caps a connection count at 500, so it cannot separate a well-connected consultant from a large creator.</div>
                </div>
                <div className="fg"><label>Min followers</label>
                  <input type="number" min="0" value={gates.minFollowers} onChange={(e) => setGates({ ...gates, minFollowers: +e.target.value })} />
                  <div className="hint">Real audience size. Wins over the connection count wherever we have it.</div>
                </div>
                <div className="fg"><label>Visibility</label>
                  <div className="fg-chk"><input type="checkbox" checked={gates.requirePublic} onChange={(e) => setGates({ ...gates, requirePublic: e.target.checked })} /> profile must be public</div>
                  <div className="hint">A private profile cannot carry a public post.</div>
                </div>
              </div>
            </div>
          </div>

          {importBlock}
        </>
      ) : null}
    </>
  );
}
