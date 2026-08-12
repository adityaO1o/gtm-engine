"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import Pager from "@/components/Pager";
import { num } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useToast } from "@/lib/toast";

const REPORT_HOST = "https://blacklist-report.com";
const ago = (d) => {
  if (!d) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const ts = (d) => (d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

const STAGE = {
  queued: { label: "queued", cls: "p-role-based" },
  extracting: { label: "reading case studies", cls: "p-review" },
  scanning: { label: "scanning clients", cls: "p-review" },
  hit: { label: "clients blacklisted", cls: "p-competitor" },
  "no-hit": { label: "all clean", cls: "p-verified" },
  "no-case-studies": { label: "no case studies", cls: "p-role-based" },
  unreachable: { label: "unreachable", cls: "p-role-based" },
};

export default function Agencies() {
  const toast = useToast();
  const [view, setView] = useState("list");
  const [runs, setRuns] = useState([]);
  const [run, setRun] = useState(null);
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(100);
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [onlyHits, setOnlyHits] = useState(false);
  const [domains, setDomains] = useState("");
  const [starting, setStarting] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [minHits, setMinHits] = useState(1);
  const [openRow, setOpenRow] = useState(null);
  const [clients, setClients] = useState([]);
  const timer = useRef(null);

  useEffect(() => { const t = setTimeout(() => { setDq(q); setPage(0); }, 300); return () => clearTimeout(t); }, [q]);

  const loadRuns = useCallback(() => { j("/api/agency").then((d) => setRuns(d.items || [])).catch(() => {}); }, []);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  const poll = useCallback(function p(id) {
    clearTimeout(timer.current);
    const qs = `page=${page}&size=${size}&q=${encodeURIComponent(dq)}${onlyHits ? "&onlyHits=1" : ""}`;
    Promise.all([j(`/api/agency/${id}`), j(`/api/agency/${id}/results?${qs}`)]).then(([r, res]) => {
      if (!r || r.error) return;
      setRun(r); setRows(res.items || []); setCount(res.count || 0);
      // Queue depth is the only honest "still working?" signal — agency counts sit still for
      // minutes while thousands of pages are in flight.
      // Poll while the RUN is running, not only while the queue happens to be non-empty: between
      // stages the queue empties for a moment, and stopping there is what made a live crawl look dead.
      const busy = r.status === "running" || Object.values(r.queue || {}).some((s) => (s.queued || 0) + (s.leased || 0) > 0);
      if (busy) timer.current = setTimeout(() => p(id), 3000);
      else loadRuns();
    }).catch(() => {});
  }, [page, size, dq, onlyHits, loadRuns]);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (run?.id) poll(run.id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, size, dq, onlyHits]);

  const open = (id) => { setView("detail"); setRun(null); setRows([]); setOpenRow(null); setPage(0); poll(id); };

  async function start() {
    const list = domains.trim();
    if (!list) return;
    setStarting(true);
    try {
      const r = await post("/api/agency", { domains: list });
      if (r.ok) { toast(`Crawling ${num(r.agencies)} agencies`, "good"); setDomains(""); loadRuns(); open(r.id); }
      else toast(r.error || "Could not start", "bad");
    } catch { toast("Could not start", "bad"); }
    setStarting(false);
  }

  async function enrich() {
    const n = run?.funnel?.agenciesWithHits || 0;
    if (!confirm(`Run Prospeo on the ${num(n)} agencies with ${minHits}+ blacklisted client(s)?\n\nThis spends Prospeo credits — roughly 1 search plus up to 5 email reveals per agency.\n\nClients are never enriched.`)) return;
    setEnriching(true);
    try {
      const r = await post(`/api/agency/${run.id}/enrich`, { minHits });
      if (r.ok) toast(`Enriching ${num(r.queued)} agencies`, "info");
      else toast(r.error || "Enrichment failed", "bad");
    } catch { toast("Enrichment failed", "bad"); }
    setEnriching(false);
  }

  async function showClients(domain) {
    if (openRow === domain) { setOpenRow(null); return; }
    setOpenRow(domain); setClients([]);
    try { const r = await j(`/api/agency/${run.id}/clients?domain=${encodeURIComponent(domain)}`); setClients(r.items || []); }
    catch { /* ignore */ }
  }

  if (view === "list") {
    return (
      <>
        <div className="note"><Icon name="flag" /><div>
          Paste agency domains. We read each one's case studies — those are its clients — and check
          every client's sending infrastructure. The agency is the prospect: they run outbound for all
          of them, so one agency is worth many single companies. <b>No Prospeo credits are spent by a
          crawl</b>; agency contacts are pulled later, by button, and only for agencies that have
          something worth telling them about.
        </div></div>

        <div className="card" style={{ padding: "var(--s4)", marginBottom: "var(--s4)" }}>
          <textarea
            className="search" style={{ width: "100%", minHeight: 120, resize: "vertical", fontFamily: "var(--mono, monospace)", fontSize: 13 }}
            placeholder={"agency-one.com\nagency-two.co.uk\n… one domain per line"}
            value={domains} onChange={(e) => setDomains(e.target.value)}
          />
        <div className="toolbar" style={{ marginTop: "var(--s3)" }}>
          <button className="btn" disabled={starting || !domains.trim()} onClick={start}>
            <Icon name={starting ? "refresh" : "spark"} />{starting ? "Starting…" : "Crawl agencies"}
          </button>
          <div className="grow" />
          <span className="resn muted">{num(domains.split(/[\s,]+/).filter(Boolean).length)} domains pasted</span>
        </div>
        </div>

        <div className="section-t"><Icon name="refresh" />Runs</div>
        {runs.length ? (
          <div className="tablewrap">
            <table>
              <thead><tr><th>Started</th><th>Agencies</th><th>Status</th><th>Stage</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r._id} className="click" onClick={() => open(r._id)}>
                    <td className="tstamp">{ts(r.createdAt)}</td>
                    <td className="num-c">{num(r.seedCount)}</td>
                    <td><span className={`pill ${r.status === "running" ? "p-review" : "p-verified"}`}>{r.status}</span></td>
                    <td className="sm muted">{r.stage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="tablewrap"><div className="empty"><Icon name="flag" /><b>No agency runs yet</b>Paste domains above.</div></div>}
      </>
    );
  }

  const f = run?.funnel || {};
  const queue = run?.queue || {};
  const inFlight = Object.values(queue).reduce((a, s) => a + (s.queued || 0) + (s.leased || 0), 0);
  const failed = Object.values(queue).reduce((a, s) => a + (s.failed || 0), 0);

  return (
    <>
      <div className="toolbar">
        <button className="btn btn-ghost btn-sm" onClick={() => { clearTimeout(timer.current); setView("list"); loadRuns(); }}><Icon name="back" />All runs</button>
        {run ? <span className="resn">{inFlight ? <><span className="spin" /> <b>{num(inFlight)}</b> jobs in flight</> : <b>idle</b>} · {num(run.seedCount)} agencies</span> : null}
        <div className="grow" />
        {failed ? (
          <button className="btn btn-ghost btn-sm" onClick={() => post(`/api/agency/${run.id}/retry`, {}).then((r) => { toast(`Requeued ${num(r.requeued)}`, "good"); poll(run.id); })}>
            <Icon name="sync" />Retry {num(failed)} failed
          </button>
        ) : null}
        {inFlight ? (
          <button className="btn btn-ghost btn-sm" onClick={() => post(`/api/agency/${run.id}/stop`, {}).then(() => { toast("Stopped", "info"); poll(run.id); })}>
            <Icon name="x" />Stop
          </button>
        ) : null}
        {f.agenciesWithHits ? (
          <>
            <span className="resn muted">min clients</span>
            <input className="search" type="number" min="1" value={minHits} onChange={(e) => setMinHits(+e.target.value || 1)} style={{ maxWidth: 62 }} />
            <button className="btn btn-ghost btn-sm" disabled={enriching} onClick={enrich}
              title="Prospeo on the AGENCY domains only — never on their clients. Spends credits.">
              <Icon name={enriching ? "refresh" : "mail"} />{enriching ? "Enriching…" : `Enrich agencies (${num(f.agenciesWithHits)})`}
            </button>
            <a className="btn btn-ghost btn-sm" href={`/api/agency/${run.id}/leads.csv?minHits=${minHits}`} download>
              <Icon name="download" />Leads CSV
            </a>
          </>
        ) : null}
      </div>

      {run?.activity?.length ? (
        <div className="card" style={{ padding: "var(--s3) var(--s4)", marginBottom: "var(--s4)" }}>
          <div className="section-t" style={{ marginTop: 0 }}>
            {inFlight ? <><span className="spin" />Working — {num(inFlight)} jobs in flight</> : <>Idle</>}
            {run.lastActivityAt ? <span className="resn muted" style={{ marginLeft: 8 }}>last update {ago(run.lastActivityAt)}</span> : null}
          </div>
          <div style={{ maxHeight: 168, overflowY: "auto" }}>
            {run.activity.map((a, i) => (
              <div key={i} className="sm" style={{ display: "flex", gap: 8, padding: "3px 0", borderBottom: "1px solid var(--line)" }}>
                <span className="muted" style={{ width: 52, flexShrink: 0 }}>{a.what}</span>
                <span className="mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                <span className="muted">{a.detail}</span>
                {a.extra ? <span style={{ color: "var(--good)" }}>{a.extra}</span> : null}
                <span className="muted" style={{ width: 54, textAlign: "right", flexShrink: 0 }}>{ago(a.at)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {run ? (
        <div className="grid g-hero" style={{ marginBottom: "var(--s4)" }}>
          {[
            { k: "Agencies", v: f.agencies, h: "submitted" },
            { k: "Clients found", v: f.clientsFound, h: "from case studies" },
            { k: "Clients scanned", v: f.clientsScanned, h: "blacklist checked" },
            { k: "Agencies with hits", v: f.agenciesWithHits, h: "worth mailing" },
            { k: "Enriched", v: f.enriched, h: "contacts pulled" },
          ].map((c) => (
            <div key={c.k} className="hero"><div className="hk">{c.k}</div><div className="hv">{num(c.v || 0)}</div><div className="hs">{c.h}</div></div>
          ))}
        </div>
      ) : <div className="tablewrap"><div className="loading"><span className="spin" />Loading run…</div></div>}

      <div className="toolbar">
        <input className="search" style={{ maxWidth: 280 }} placeholder="Search an agency domain…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="resn muted" title="Clients discovered so far — this fills in live as case studies are read">
          {num(f.clientsFound || 0)} clients found · {num(f.clientsScanned || 0)} scanned
        </span>
        {q ? <button className="btn btn-ghost btn-sm" onClick={() => setQ("")}><Icon name="x" />Clear</button> : null}
        <button className={`btn btn-sm ${onlyHits ? "" : "btn-ghost"}`} onClick={() => { setOnlyHits((v) => !v); setPage(0); }}>
          <Icon name="warn" />Only with hits
        </button>
        <div className="grow" />
        <span className="resn"><b>{num(count)}</b> agenc{count === 1 ? "y" : "ies"}</span>
      </div>

      {rows.length ? (
        <>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Agency</th><th>Clients</th><th>Blacklisted</th><th>Top clients</th><th>Stage</th><th>Report</th></tr></thead>
              <tbody>
                {rows.map((a) => {
                  const st = STAGE[a.stage] || { label: a.stage, cls: "p-role-based" };
                  return (
                    <tr key={a.domain} className="click" onClick={() => showClients(a.domain)}>
                      <td><span className="nm mono">{a.domain}</span>{a.companyName ? <div className="sm muted">{a.companyName}</div> : null}</td>
                      <td className="num-c">{a.clientsFound ? <b>{num(a.clientsFound)}</b> : <span className="muted">—</span>}</td>
                      <td className="num-c"><b style={{ color: a.clientsBlacklisted ? "var(--bad)" : "inherit" }}>{num(a.clientsBlacklisted || 0)}</b></td>
                      <td className="sm muted">{(a.topClients || []).slice(0, 3).map((c) => `${c.domain} (${c.blacklisted})`).join(", ") || "—"}</td>
                      <td><span className={`pill ${st.cls}`}>{st.label}</span></td>
                      <td>{a.reportToken ? <a href={`${REPORT_HOST}/r/${a.reportToken}`} target="_blank" rel="noreferrer" className="mono sm" onClick={(e) => e.stopPropagation()}>/r/{a.reportToken}</a> : <span className="muted sm">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager count={count} page={page} setPage={setPage} size={size} setSize={setSize} />
        </>
      ) : run ? <div className="tablewrap"><div className="empty"><Icon name="search" /><b>{onlyHits ? "No agency has a blacklisted client yet" : "Nothing here"}</b>{onlyHits ? "Turn off \"Only with hits\" to see every agency." : "The crawl may still be running."}</div></div> : null}

      {openRow ? (
        <>
          <div className="section-t"><Icon name="users" />{openRow} — clients</div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Client</th><th>Blacklisted</th><th>Source</th><th>Found via</th></tr></thead>
              <tbody>
                {clients.length ? clients.map((c) => (
                  <tr key={c._id}>
                    <td><span className="nm mono">{c.clientDomain || <span className="muted">{c.clientName} (unresolved)</span>}</span></td>
                    <td className="num-c">{c.scanned ? num(c.blacklistedCount || 0) : <span className="muted sm">pending</span>}</td>
                    <td className="sm muted">{c.source || (c.skipped ? c.skipped : "—")}</td>
                    <td className="sm muted">{c.confidence || "—"}</td>
                  </tr>
                )) : <tr><td colSpan={4} className="muted sm">Loading…</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}
