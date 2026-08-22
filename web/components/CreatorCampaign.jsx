"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import Pager from "@/components/Pager";
import { num, pctOf, ts } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useToast } from "@/lib/toast";

// The outreach running order, fixed by the extract. Creator scoring filters INSIDE a tier — it
// never reorders these, which is why they are hard-coded here rather than sorted from the response.
const TIERS = [
  { id: "P1_CHURN", label: "P1 · Churn", note: "paid before, spend collapsed ≥30%" },
  { id: "P1b_AT_RISK", label: "P1b · At risk", note: "looks stable, trend is falling" },
  { id: "P2_PAYING", label: "P2 · Paying", note: "healthy paying customers" },
  { id: "P3a_FREE_ACTIVATED", label: "P3a · Free, activated", note: "never paid, live mailbox running" },
  { id: "P3b_FREE_TRIED", label: "P3b · Free, tried", note: "set something up, then stopped" },
  { id: "P3c_FREE_DORMANT", label: "P3c · Free, dormant", note: "signed up, never used anything" },
];

const FIT = {
  QUALIFIED: { label: "Qualified", cls: "p-verified", hint: "profile + audience + posting + on-topic" },
  CANDIDATE: { label: "Candidate", cls: "p-review", hint: "profile + audience clear the floor; posting not checked yet" },
  WEAK: { label: "Weak", cls: "p-unverified", hint: "profile found, but below the creator bar — still worth a testimonial" },
  NO_PROFILE: { label: "No profile", cls: "p-role-based", hint: "no LinkedIn found. Still gets normal outreach" },
  UNRESOLVED: { label: "Unresolved", cls: "p-no-email", hint: "not enriched yet" },
};

const usd = (n) => "$" + Math.round(n ?? 0).toLocaleString();

export default function CreatorCampaign() {
  const toast = useToast();
  const [stats, setStats] = useState(null);
  const [run, setRun] = useState({});
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(100);
  const [tier, setTier] = useState("");
  const [fit, setFit] = useState("");
  const [audience, setAudience] = useState("");
  const [role, setRole] = useState("");
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

  const loadRows = useCallback(() => {
    const p = new URLSearchParams({ page, size, sort });
    if (tier) p.set("tier", tier);
    if (fit) p.set("fit", fit);
    if (audience) p.set("audience", audience);
    if (role) p.set("role", role);
    if (onlyAudience) p.set("inAudience", "1");
    if (dq) p.set("q", dq);
    j(`/api/creator/people?${p}`).then((d) => { setRows(d.items || []); setCount(d.count || 0); }).catch(() => {});
  }, [page, size, sort, tier, fit, audience, role, onlyAudience, dq]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadRows(); }, [loadRows]);

  // Poll only while a run is live; the enrichment walks the base in priority order so the counters
  // move steadily rather than in one jump at the end.
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
          : `Imported ${num(d.people)} people from ${num(d.rows)} rows (${num(d.duplicatesMerged)} duplicates merged, ${num(d.audienceMatched)} already in our audience)`, "good");
        loadStats(); loadRows();
      } else toast(d.error || "Import failed", "bad");
    } catch (e) { toast(e.message || "Import failed", "bad"); }
    setBusy("");
  }

  async function startEnrich() {
    const scope = runTiers.length ? runTiers.map((t) => TIERS.find((x) => x.id === t)?.label).join(", ") : "the whole base, in priority order";
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

  const exportUrl = () => {
    const p = new URLSearchParams();
    if (tier) p.set("tier", tier);
    if (fit) p.set("fit", fit);
    if (audience) p.set("audience", audience);
    if (role) p.set("role", role);
    if (onlyAudience) p.set("inAudience", "1");
    if (dq) p.set("q", dq);
    return `/api/creator/people.csv?${p}`;
  };

  const t = stats?.totals;
  const byTier = Object.fromEntries((stats?.tiers || []).map((r) => [r.tier, r]));
  const empty = !t || !t.people;

  return (
    <>
      <div className="note"><Icon name="spark" /><div>
        Two separate things live on this page. <b>Commercial priority</b> — P1 Churn → P1b At-risk → P2 Paying
        → P3 Free — comes from the extract and is <b>fixed</b>; work it top to bottom. <b>Creator fit</b> is a
        filter applied <b>inside</b> each tier: of the people we are contacting anyway, who has an audience worth
        a creator ask. Failing the creator filter never removes anyone from outreach — it only means they get the
        normal win-back or upsell message instead.
      </div></div>

      {/* ── Import ─────────────────────────────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: "var(--s4)", marginBottom: "var(--s4)" }}>
        <div className="kh"><Icon name="inbox" />Import the extract</div>
        <div className="sub" style={{ marginBottom: 12 }}>
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
          {stats?.lastImport ? <span className="resn muted">last import {ts(stats.lastImport.startedAt)}</span> : null}
        </div>
      </div>

      {empty ? (
        <div className="empty">Upload <b>companies.csv</b> first, then <b>company_users.csv</b>. The people file is the contact list — the companies file supplies the churn, spend and segment context that gets copied onto every person.</div>
      ) : (
        <>
          {/* ── Headline ─────────────────────────────────────────────────────────────────── */}
          <div className="grid g-stat" style={{ marginBottom: "var(--s4)" }}>
            <div className="card"><div className="kh"><Icon name="users" />People</div><div className="v">{num(t.people)}</div><div className="sub">deduplicated humans</div></div>
            <div className="card"><div className="kh"><Icon name="trend" />Lifetime spend</div><div className="v">{usd(t.spend)}</div><div className="sub">across the base</div></div>
            <div className="card pri"><div className="kh"><Icon name="external" />LinkedIn resolved</div><div className="v">{num(t.resolved)}</div><div className="sub">{pctOf(t.resolved, t.people)}% of people</div></div>
            <div className="card rec"><div className="kh"><Icon name="radio" />In our audience</div><div className="v">{num(t.inAudience)}</div><div className="sub">already engage with our posts</div></div>
            <div className="card"><div className="kh"><Icon name="check" />Creator pool</div><div className="v">{num(t.qualified + t.candidate)}</div><div className="sub">{num(t.qualified)} qualified · {num(t.candidate)} candidate</div></div>
          </div>

          {/* ── Funnel, in the fixed running order ───────────────────────────────────────── */}
          <div className="section-t">Outreach order · creator fit within each tier</div>
          <div className="tablewrap" style={{ marginBottom: "var(--s4)" }}>
            <table>
              <thead><tr>
                <th>#</th><th>Tier</th><th>Companies</th><th>People</th><th>Lifetime spend</th><th>LinkedIn</th>
                <th>In audience</th><th>Qualified</th><th>Candidate</th><th>Weak</th><th>No profile</th><th>Pending</th>
              </tr></thead>
              <tbody>
                {TIERS.map((tr, i) => {
                  const r = byTier[tr.id] || {};
                  return (
                    <tr key={tr.id} style={{ cursor: "pointer" }} onClick={() => { setTier(tier === tr.id ? "" : tr.id); setPage(0); }}>
                      <td className="muted">{i + 1}</td>
                      <td><b>{tr.label}</b><div className="sub" style={{ whiteSpace: "normal", maxWidth: 240 }}>{tr.note}</div></td>
                      <td className="muted">{num(r.companies)}</td>
                      <td>{num(r.people)}</td>
                      <td>{usd(r.spend)}</td>
                      <td>{num(r.resolved)} <span className="muted">({pctOf(r.resolved, r.people)}%)</span></td>
                      <td>{r.inAudience ? <b style={{ color: "var(--good)" }}>{num(r.inAudience)}</b> : <span className="muted">0</span>}</td>
                      <td>{r.qualified ? <b>{num(r.qualified)}</b> : <span className="muted">0</span>}</td>
                      <td>{num(r.candidate)}</td>
                      <td className="muted">{num(r.weak)}</td>
                      <td className="muted">{num(r.noProfile)}</td>
                      <td className="muted">{num(r.pending)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="sub" style={{ margin: "-10px 0 var(--s4)" }}>
            Spend is counted per <b>company</b> — it is a company fact the extract copies onto every person, so
            adding it up across people would multiply it by headcount. People are counted per <b>human</b>: the
            file's 8,225 rows are 6,664 distinct people, and anyone sitting on several teams is filed under
            their most urgent one, which is why a tier can hold fewer people here than in the extract.
          </div>

          {/* ── Enrichment ──────────────────────────────────────────────────────────────── */}
          <div className="card" style={{ padding: "var(--s4)", marginBottom: "var(--s4)" }}>
            <div className="kh"><Icon name="bolt" />Resolve LinkedIn profiles</div>
            <div className="sub" style={{ marginBottom: 12 }}>
              The extract carries no person-level LinkedIn at all, so every creator signal starts here.
              enrich.so reverse lookup runs first — 10 credits, refunded on a miss — and on this customer base
              it lands around <b>7%</b>, because most of them are small agencies on their own domain rather than
              staff at companies its data covers. The free self-hosted SERP resolver then picks up the rest.
              Work always walks the base in priority order, so P1 is resolved before P3c.
            </div>
            <div className="toolbar">
              {TIERS.map((tr) => (
                <span key={tr.id} className={`chip${runTiers.includes(tr.id) ? " on" : ""}`}
                  onClick={() => setRunTiers((v) => v.includes(tr.id) ? v.filter((x) => x !== tr.id) : [...v, tr.id])}>
                  {tr.label}
                </span>
              ))}
              {runTiers.length ? <span className="chip x" onClick={() => setRunTiers([])}>clear</span> : <span className="resn muted">no tier picked = whole base</span>}
            </div>
            <div className="toolbar">
              <label className="chk"><input type="checkbox" checked={useSerp} onChange={(e) => setUseSerp(e.target.checked)} /> SERP fallback (free)</label>
              <input type="number" min="0" style={{ width: 130 }} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="limit (0 = all)" />
              {run.running ? (
                <button className="btn btn-no btn-sm" onClick={() => act("/api/creator/enrich/stop", {}, () => "Stopping after the in-flight batch")}><Icon name="pause" />Stop</button>
              ) : (
                <button className="btn btn-ok btn-sm" disabled={busy === "enrich"} onClick={startEnrich}><Icon name="bolt" />Start</button>
              )}
              <button className="btn btn-ghost btn-sm" disabled={!!busy}
                onClick={() => act("/api/creator/match-audience", {}, (r) => `${num(r.matched)} people matched to our own audience`)}>
                <Icon name="radio" />Re-match our audience
              </button>
            </div>
            {run.total ? (
              <>
                <div className={`prog${run.running ? " on" : ""}`} style={{ marginTop: 6 }}><i style={{ width: `${pctOf(run.done, run.total)}%` }} /></div>
                <div className="resn" style={{ marginTop: 8 }}>
                  <b>{num(run.done)}</b> / {num(run.total)} · enrich.so <b>{num(run.hits)}</b> · SERP <b>{num(run.serpHits)}</b> · no profile <b>{num(run.misses)}</b>
                  {run.errors ? <> · errors <b>{num(run.errors)}</b></> : null}
                  {run.running ? " · running" : run.phase === "stopped" ? " · stopped" : ""}
                </div>
              </>
            ) : null}
          </div>

          {/* ── Gates ───────────────────────────────────────────────────────────────────── */}
          <div className="card" style={{ padding: "var(--s4)", marginBottom: "var(--s4)" }}>
            <div className="kh"><Icon name="shield" />Creator gates</div>
            <div className="sub" style={{ marginBottom: 12 }}>
              Where the bar sits for a creator ask. Re-scoring is a pure recompute over data we already hold —
              it never spends a credit, so tune freely. Note that a <b>connection</b> count is capped at 500 by
              LinkedIn, so it cannot tell a well-connected consultant from a large creator; real follower
              numbers come from the posting pass and win over it wherever we have them.
            </div>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <label className="resn">Min connections <input type="number" min="0" style={{ width: 100, marginLeft: 6 }} value={gates.minAudience} onChange={(e) => setGates({ ...gates, minAudience: +e.target.value })} /></label>
              <label className="resn">Min followers <input type="number" min="0" style={{ width: 100, marginLeft: 6 }} value={gates.minFollowers} onChange={(e) => setGates({ ...gates, minFollowers: +e.target.value })} /></label>
              <label className="chk"><input type="checkbox" checked={gates.requirePublic} onChange={(e) => setGates({ ...gates, requirePublic: e.target.checked })} /> profile must be public</label>
              <button className="btn btn-ghost btn-sm" disabled={!!busy}
                onClick={() => act("/api/creator/rescore", { gates }, (r) => `Re-scored ${num(r.rescored)} people`)}>
                <Icon name="refresh" />Re-score
              </button>
            </div>
          </div>

          {/* ── People ──────────────────────────────────────────────────────────────────── */}
          <div className="section-t">People</div>
          <div className="toolbar">
            <input className="search" placeholder="name, email, company…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="field"><select value={tier} onChange={(e) => { setTier(e.target.value); setPage(0); }}>
              <option value="">All tiers</option>{TIERS.map((tr) => <option key={tr.id} value={tr.id}>{tr.label}</option>)}
            </select></div>
            <div className="field"><select value={fit} onChange={(e) => { setFit(e.target.value); setPage(0); }}>
              <option value="">Any creator fit</option>{Object.entries(FIT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select></div>
            <div className="field"><select value={audience} onChange={(e) => { setAudience(e.target.value); setPage(0); }}>
              <option value="">LinkedIn: any</option><option value="resolved">resolved</option><option value="unresolved">not resolved</option>
            </select></div>
            <div className="field"><select value={role} onChange={(e) => { setRole(e.target.value); setPage(0); }}>
              <option value="">Any role</option><option value="admin">admin</option><option value="member">member</option>
            </select></div>
            <span className={`chip${onlyAudience ? " on" : ""}`} onClick={() => { setOnlyAudience((v) => !v); setPage(0); }}>In our audience</span>
            <div className="field"><select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="priority">Sort: priority → spend</option><option value="audience">Sort: priority → audience</option>
            </select></div>
            <div className="grow" />
            <a className="btn btn-ghost btn-sm" href={exportUrl()}><Icon name="download" />Export CSV</a>
          </div>

          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>Person</th><th>Company</th><th>Tier</th><th>Churn</th><th>Spend</th>
                <th>LinkedIn</th><th>Audience</th><th>Creator fit</th><th>Why</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const f = FIT[r.creator_fit] || FIT.UNRESOLVED;
                  return (
                    <tr key={r._id}>
                      <td>
                        <div className="nm">{r.user_name || <span className="muted">—</span>}{r.in_audience ? <span className="cat" style={{ marginLeft: 6 }} title="already engages with our LinkedIn posts">our audience</span> : null}</div>
                        <div className="sub mono">{r._id}</div>
                        {r.job_title ? <div className="sub">{r.job_title}</div> : null}
                      </td>
                      <td><div>{r.company_name || <span className="muted">—</span>}</div><div className="sub mono">{r.company_domain}</div></td>
                      <td><span className="src"><b>{(TIERS.find((x) => x.id === r.contact_priority) || {}).label || r.contact_priority}</b></span></td>
                      <td>{r.churn_band ? <span className="sub">{r.churn_band}{r.trend_direction ? ` · ${r.trend_direction}` : ""}</span> : <span className="muted">—</span>}</td>
                      <td className="score">{r.lifetime_spend ? usd(r.lifetime_spend) : <span className="muted">$0</span>}</td>
                      <td>{r.li_url
                        ? <a className="postlink" href={r.li_url} target="_blank" rel="noreferrer"><Icon name="external" />profile</a>
                        : <span className="muted">—</span>}
                        {r.li_source ? <div className="sub">via {r.li_source}</div> : null}</td>
                      <td className="score">{r.audience != null
                        ? <>{num(r.audience)}{r.li_connections_capped && r.audience_source === "connections" ? "+" : ""}<div className="sub">{r.audience_source}</div></>
                        : <span className="muted">—</span>}</td>
                      <td><span className={`pill ${f.cls}`} title={f.hint}>{f.label}</span></td>
                      <td><span className="sub trunc" style={{ maxWidth: 260, display: "inline-block" }}>{r.creator_reason || "—"}</span></td>
                    </tr>
                  );
                })}
                {!rows.length ? <tr><td colSpan={9} className="empty">Nothing matches these filters.</td></tr> : null}

              </tbody>
            </table>
          </div>
          <Pager count={count} page={page} setPage={setPage} size={size} setSize={setSize} />
        </>
      )}
    </>
  );
}
