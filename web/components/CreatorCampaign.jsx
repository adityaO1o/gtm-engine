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
  { id: "P2_PAYING", label: "P2 · Paying", short: "P2", note: "healthy paying customers", play: "Creator Programme core. Start with the ones already growing." },
  { id: "P3a_FREE_ACTIVATED", label: "P3a · Free, activated", short: "P3a", note: "never paid, live mailbox running", play: "Warmest free lead in the business — already getting value." },
  { id: "P3b_FREE_TRIED", label: "P3b · Free, tried", short: "P3b", note: "set something up, then stopped", play: "Activation problem. Something blocked them — ask what." },
  { id: "P3c_FREE_DORMANT", label: "P3c · Free, dormant", short: "P3c", note: "signed up, never used anything", play: "Cold. Bulk nurture only, low expectations." },
];
const tierOf = (id) => TIERS.find((t) => t.id === id);

const FIT = {
  QUALIFIED: { label: "Qualified", cls: "p-verified", hint: "profile + audience + posting + on-topic" },
  CANDIDATE: { label: "Candidate", cls: "p-review", hint: "profile + audience clear the floor; posting not checked yet" },
  WEAK: { label: "Weak", cls: "p-unverified", hint: "profile found, but below the creator bar — still worth a testimonial" },
  NO_PROFILE: { label: "No profile", cls: "p-role-based", hint: "no LinkedIn found. Still gets normal outreach" },
  UNRESOLVED: { label: "Unresolved", cls: "p-no-email", hint: "not enriched yet" },
};

// Growth: the opposite of the churn signal, and the reason the Programme has a core at all.
// Ordered strongest first. SCALING is listed but is NOT counted as "growing" on its own — adding a
// domain in six months is true of 2,218 companies, so by itself it separates nobody.
const GROWTH = {
  EXPANDING: { label: "Expanding", hint: "spend more than doubled against their own normal" },
  GROWING: { label: "Growing", hint: "spend up 30%+ against their own normal" },
  RISING: { label: "Rising", hint: "trend line climbing — the mirror of P1b, and no band shows it" },
  UPGRADED: { label: "Upgraded", hint: "bought more mailbox slots — straight from the account record" },
  SCALING: { label: "Scaling", hint: "added domains or mailboxes in the last 180 days (corroboration only)" },
};

const usd = (n) => "$" + Math.round(n ?? 0).toLocaleString();
const handle = (url) => (url || "").replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "").replace(/\/$/, "");

const TierBadge = ({ id }) => {
  const t = tierOf(id);
  return <span className={`tb tb-${id}`}><i />{t ? t.label : id || "—"}</span>;
};

// The union count on its own ("2,531 growing") hides that it is mostly RISING, which is broad.
// Showing the split — and letting a click set the filter — is what turns it into a target list.
function GrowthStrip({ counts, value, onPick }) {
  if (!counts) return null;
  const any = Object.entries(counts).filter(([k]) => k !== "SCALING").reduce((a, [, v]) => a + v, 0);
  return (
    <div className="gstrip">
      <div className={`gi${value === "any" ? " on" : ""}`} onClick={() => onPick(value === "any" ? "" : "any")}>
        <div className="gk"><Icon name="trend" />Growing</div>
        <div className="gv" style={{ color: "var(--good)" }}>{num(any)}</div>
        <div className="gh">any real signal</div>
      </div>
      {Object.entries(GROWTH).map(([k, v]) => (
        <div key={k} className={`gi${value === k ? " on" : ""}${k === "SCALING" ? " soft" : ""}`}
          onClick={() => onPick(value === k ? "" : k)} title={v.hint}>
          <div className="gk"><span className={`gw gw-${k}`} style={{ padding: "1px 6px" }}>{v.label}</span></div>
          <div className="gv">{num(counts[k] || 0)}</div>
          <div className="gh">{v.hint}</div>
        </div>
      ))}
    </div>
  );
}

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
  const [useSerp, setUseSerp] = useState(true);
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
        toast(kind === "companies"
          ? `Imported ${num(d.companies)} companies`
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
      const r = await post("/api/creator/enrich", { tiers: runTiers, limit: Number(limit) || 0, useSerp, gates });
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
          engine. Re-uploading a fresh extract refreshes the churn numbers and <b>keeps</b> every LinkedIn
          profile already resolved, so a refresh never costs the enrichment work again.
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer" }}>
            {busy === "companies" ? "Reading…" : "companies.csv"}
            <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
              onChange={(e) => { upload("companies", e.target.files?.[0]); e.target.value = ""; }} />
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
          <div className="card"><div className="kh"><Icon name="trend" />Growing</div><div className="v" style={{ color: "var(--good)" }}>{num(scoped.growing)}</div><div className="sub">expanding, growing, rising or upgraded</div></div>
          <div className="card rec"><div className="kh"><Icon name="radio" />In our audience</div><div className="v">{num(scoped.inAudience)}</div></div>
          <div className="card"><div className="kh"><Icon name="check" />Creator pool</div><div className="v">{num((scoped.qualified || 0) + (scoped.candidate || 0))}</div><div className="sub">{num(scoped.qualified)} qualified · {num(scoped.candidate)} candidate</div></div>
        </div>

        <GrowthStrip counts={drill ? r.growthBreakdown : stats.growthTotals} value={growth}
          onPick={(g) => { setGrowth(g); setPage(0); }} />

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
              <th>Person</th><th>Company</th>{drill ? null : <th>Tier</th>}<th>Churn</th><th>Growth</th><th>Spend</th>
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
                    <td className="score">{p.lifetime_spend ? usd(p.lifetime_spend) : <span className="muted">$0</span>}</td>
                    <td>{p.li_url
                      ? <><a className="li" href={p.li_url} target="_blank" rel="noreferrer"><Icon name="external" />{handle(p.li_url) || "profile"}</a>
                          {p.li_source ? <div className="via">via {p.li_source}</div> : null}</>
                      : <span className="muted">—</span>}</td>
                    <td className="score">{p.audience != null
                      ? <>{num(p.audience)}{p.li_connections_capped && p.audience_source === "connections" ? "+" : ""}<div className="via">{p.audience_source}</div></>
                      : <span className="muted">—</span>}</td>
                    <td><span className={`pill ${f.cls}`} title={f.hint}>{f.label}</span></td>
                    <td><span className="sub trunc" style={{ maxWidth: 250, display: "inline-block" }}>{p.creator_reason || "—"}</span></td>
                  </tr>
                );
              })}
              {!rows.length ? <tr><td colSpan={10} className="empty">Nothing matches these filters.</td></tr> : null}
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

      <GrowthStrip counts={stats.growthTotals} value={growth}
        onPick={(g) => { setGrowth(g); openTierKeepGrowth("", g); }} />

      <div className="blk">
        <div className="blk-h"><Icon name="mega" /><b>Outreach order</b><div className="grow" />
          <span className="via" onClick={() => openTier("")} style={{ cursor: "pointer" }}>open everyone →</span>
        </div>
        <div className="tablewrap" style={{ border: "none", boxShadow: "none" }}>
          <table>
            <thead><tr>
              <th>#</th><th>Tier</th><th>Companies</th><th>People</th><th>Lifetime spend</th><th>Growing</th><th>LinkedIn</th>
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
                    <td>{r.growing ? <b style={{ color: "var(--good)" }}>{num(r.growing)}</b> : <span className="muted">0</span>}</td>
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
                enrich.so reverse lookup runs first — 10 credits, refunded on a miss — and lands around <b>7%</b> on
                this base, because most of these customers are small agencies on their own domain rather than staff
                at companies its data covers. The free self-hosted SERP resolver then picks up the rest. Work always
                walks the base in priority order, so P1 is resolved before P3c.
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
                <div className="fg"><label>SERP fallback</label>
                  <div className="fg-chk"><input type="checkbox" checked={useSerp} onChange={(e) => setUseSerp(e.target.checked)} /> on (free, self-hosted)</div>
                  <div className="hint">One search per person enrich.so missed.</div>
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
                    <b>{num(run.done)}</b> / {num(run.total)} · enrich.so <b>{num(run.hits)}</b> · SERP <b>{num(run.serpHits)}</b> · no profile <b>{num(run.misses)}</b>
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
