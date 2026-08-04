"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { num, ts } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useToast } from "@/lib/toast";

const STATUS_PILL = { clean: "p-verified", listed: "p-competitor", error: "p-review", pending: "p-review", checking: "p-review" };

// Fields worth surfacing from the blacklist API's DNS/WHOIS enrichment blob, in display order.
const ENRICH_FIELDS = [
  ["registrar", "Registrar"], ["nsProvider", "Nameserver"], ["mxProvider", "Mail (MX)"],
  ["spf", "SPF"], ["dmarc", "DMARC"], ["asn", "ASN"], ["registrantCountry", "Country"],
  ["createdDate", "Registered"], ["ageBucket", "Domain age"],
];

// Click a result row -> slide-in drawer showing WHERE the domain is blacklisted: every DNSBL zone
// listing it (with provider family + why), its risk score, DNS/WHOIS enrichment, and listing history.
function DetailDrawer({ open, domain, detail, loading, onClose }) {
  const d = detail?.domain || {};
  const zones = d.summary?.listedZones || [];
  const events = detail?.events || [];
  // zone -> family, harvested from the listing events so each zone row can show who runs it.
  const familyOf = {};
  for (const e of events) if (e.zone && e.family) familyOf[e.zone] = e.family;
  const enr = detail?.enrichment || {};
  const enrRows = ENRICH_FIELDS.filter(([k]) => enr[k] != null && enr[k] !== "");

  return (
    <div className={`drawer${open ? " open" : ""}`}>
      <span className="x" onClick={onClose}><Icon name="x" style={{ width: 20, height: 20, stroke: "var(--dim)" }} /></span>
      <h3 className="mono" style={{ wordBreak: "break-all" }}>{domain}</h3>

      {loading ? (
        <div className="muted" style={{ marginTop: "var(--s4)" }}><span className="spin" /> Loading blacklist detail…</div>
      ) : !detail ? (
        <div className="muted" style={{ marginTop: "var(--s4)" }}>No blacklist record found for this domain.</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
            <span className={`pill ${STATUS_PILL[d.status] || ""}`}>
              <Icon name={d.status === "listed" ? "warn" : "check"} />{d.status}
            </span>
            <span className="resn">Risk score <b style={{ color: d.riskScore >= 40 ? "var(--hot)" : d.riskScore ? "var(--warm)" : "var(--good)" }}>{d.riskScore ?? 0}</b>/100</span>
            <span className="resn muted">{d.summary?.checkedZones ?? 0} zones checked</span>
          </div>

          <div className="section-t" style={{ marginTop: "var(--s4)" }}>
            <Icon name="warn" />Blacklisted on {zones.length} {zones.length === 1 ? "list" : "lists"}
          </div>
          {zones.length ? (
            <div className="tablewrap">
              <table>
                <thead><tr><th>Blacklist zone</th><th>Provider</th></tr></thead>
                <tbody>
                  {zones.map((z) => (
                    <tr key={z}>
                      <td><span className="mono sm">{z}</span></td>
                      <td><span className="sm muted">{familyOf[z] || "—"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="note ok"><Icon name="check" /><div>Clean — not listed on any of the {d.summary?.checkedZones ?? 0} DNSBL zones checked.</div></div>
          )}

          {enrRows.length ? (
            <>
              <div className="section-t"><Icon name="radio" />Domain intel</div>
              <div className="tablewrap"><table><tbody>
                {enrRows.map(([k, label]) => (
                  <tr key={k}><td className="muted" style={{ width: 130 }}>{label}</td><td className="sm">{String(enr[k])}</td></tr>
                ))}
              </tbody></table></div>
            </>
          ) : null}

          {events.length ? (
            <>
              <div className="section-t"><Icon name="refresh" />Listing history</div>
              <div style={{ marginTop: 4 }}>
                {events.slice(0, 20).map((e, i) => (
                  <div key={i} className="tl">
                    <div>
                      <span className={`pill ${e.type === "listed" ? "p-competitor" : "p-verified"}`} style={{ marginRight: 6 }}>{e.type}</span>
                      <strong className="mono sm">{e.zone}</strong>
                    </div>
                    <div className="c">{e.family || ""}{e.reason ? ` · ${e.reason}` : ""} · {ts(e.at)}</div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function csvEscape(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }
function downloadCsv(job) {
  const rows = [["domain", "status", "riskScore", "listedZones"]];
  for (const r of job.results || []) rows.push([r.domain, r.status, r.riskScore ?? "", (r.listedZones || []).join("|")]);
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${job.seedDomain}-domain-scan.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function DomainScan() {
  const toast = useToast();
  const [domain, setDomain] = useState("");
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [listedOnly, setListedOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [detailFor, setDetailFor] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const timer = useRef(null);

  const openDetail = useCallback(async (dom) => {
    setDetailFor(dom);
    setDetail(null);
    setDetailLoading(true);
    try { setDetail(await j(`/api/domainscan/domain-detail?domain=${encodeURIComponent(dom)}`)); }
    catch { setDetail(null); }
    setDetailLoading(false);
  }, []);

  const loadHistory = useCallback(() => { j("/api/domainscan").then((d) => setHistory(d.items || [])).catch(() => {}); }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const poll = useCallback(async function p(id) {
    clearTimeout(timer.current);
    const s = await j(`/api/domainscan/${id}`).catch(() => null);
    if (!s) return;
    setJob(s);
    if (s.status === "running") timer.current = setTimeout(() => p(id), 1200);
    else loadHistory();
  }, [loadHistory]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function startScan() {
    const d = domain.trim().toLowerCase();
    if (!d) return;
    setStarting(true);
    try {
      const r = await post("/api/domainscan", { domain: d });
      if (r.error) { toast(r.error, "bad"); return; }
      toast(`Scanning ${r.seedDomain} — ${num(r.totalCandidates)} candidates`, "info");
      setJob({ status: "running", seedDomain: r.seedDomain, totalCandidates: r.totalCandidates, dnsChecked: 0, dnsPassed: 0, redirectChecked: 0, redirectConfirmed: 0, blacklistChecked: 0, listedCount: 0, results: [] });
      poll(r.id);
    } catch { toast("Scan failed to start", "bad"); }
    setStarting(false);
  }

  const running = job?.status === "running";
  const pctDns = job?.totalCandidates ? Math.min(100, Math.round((job.dnsChecked / job.totalCandidates) * 100)) : 0;
  const rows = (job?.results || []).filter((r) => !listedOnly || r.status === "listed")
    .slice().sort((a, b) => (b.status === "listed") - (a.status === "listed") || (b.riskScore || 0) - (a.riskScore || 0));

  return (
    <>
      <div className="note"><Icon name="search" /><div>
        Enter a company's domain. We generate ~500-1000 plausible alt-domains (send-subdomains, TLD swaps,
        brand prefixes/suffixes), find which ones are <b>live and actually redirect back into the seed domain</b>
        (real sending-infra, not noise), then check each against our own blacklist checker. A <b>listed</b> result
        is a company whose sending infra is broken — the outreach angle writes itself.
      </div></div>

      <div className="toolbar">
        <input
          className="search" style={{ maxWidth: 320 }} placeholder="acme.com"
          value={domain} onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !running && startScan()}
        />
        <button className="btn" disabled={running || starting || !domain.trim()} onClick={startScan}>
          <Icon name={running ? "refresh" : "search"} />{running ? "Scanning…" : "Scan"}
        </button>
        <div className="grow" />
        {job?.results?.length ? (
          <>
            <label className="resn" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={listedOnly} onChange={(e) => setListedOnly(e.target.checked)} />Listed only
            </label>
            <button className="btn btn-ghost btn-sm" onClick={() => downloadCsv(job)}><Icon name="download" />Export CSV</button>
          </>
        ) : null}
      </div>

      {job ? (
        <div className={`jobbox${running ? " on" : ""}`}>
          <div className="jobh">
            <Icon name={running ? "refresh" : job.status === "error" ? "warn" : "check"} />
            <span>
              <b>{job.seedDomain}</b>
              {" · "}DNS <b>{num(job.dnsChecked)}</b>/{num(job.totalCandidates)}
              {" · "}live <b>{num(job.dnsPassed)}</b>
              {" · "}redirects to seed <b className="ok">{num(job.redirectConfirmed)}</b>
              {" · "}blacklist checked <b>{num(job.blacklistChecked)}</b>
              {" · "}<b style={{ color: job.listedCount ? "var(--hot)" : "inherit" }}>{num(job.listedCount)}</b> listed
              {job.status === "error" ? <> · <b style={{ color: "var(--hot)" }}>failed: {job.error}</b></> : null}
            </span>
          </div>
          <div className={`prog${running ? " on" : ""}`}><i style={{ width: `${running ? Math.max(pctDns, 3) : 100}%` }} /></div>
        </div>
      ) : null}

      {job?.results?.length ? (
        <div className="tablewrap">
          <table>
            <thead><tr>
              <th>Domain</th><th>Status</th><th>Risk score</th><th>Listed on</th><th>Checked</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.domain} className="click" onClick={() => openDetail(r.domain)}>
                  <td><span className="nm mono">{r.domain}</span></td>
                  <td><span className={`pill ${STATUS_PILL[r.status] || ""}`}><Icon name={r.status === "listed" ? "warn" : "check"} />{r.status}</span></td>
                  <td className="num-c">{r.riskScore ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className="trunc sm muted" title={(r.listedZones || []).join(", ")}>{(r.listedZones || []).slice(0, 3).join(", ") || "—"}</span>
                    {(r.listedZones || []).length > 3 ? <span className="sm muted"> +{r.listedZones.length - 3}</span> : null}
                  </td>
                  <td className="tstamp">{ts(r.checkedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : job && !running ? (
        <div className="tablewrap"><div className="empty"><Icon name="search" /><b>No live redirecting domains found</b>Nothing in the permutation set both resolved and redirected back to {job.seedDomain}.</div></div>
      ) : null}

      {history.length ? (
        <>
          <div className="section-t"><Icon name="refresh" />Past scans</div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Seed domain</th><th>Status</th><th>Candidates</th><th>Confirmed</th><th>Listed</th><th>Started</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h._id} className="click" onClick={() => poll(h._id)}>
                    <td><span className="nm">{h.seedDomain}</span></td>
                    <td><span className={`pill ${h.status === "listed" ? "p-competitor" : h.status === "error" ? "p-review" : "p-verified"}`}>{h.status}</span></td>
                    <td className="num-c">{num(h.totalCandidates)}</td>
                    <td className="num-c">{num(h.redirectConfirmed)}</td>
                    <td className="num-c" style={{ color: h.listedCount ? "var(--hot)" : "inherit" }}>{num(h.listedCount)}</td>
                    <td className="tstamp">{ts(h.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {detailFor ? <div className="drawer-scrim" onClick={() => setDetailFor(null)} /> : null}
      <DetailDrawer open={!!detailFor} domain={detailFor} detail={detail} loading={detailLoading} onClose={() => setDetailFor(null)} />
    </>
  );
}
