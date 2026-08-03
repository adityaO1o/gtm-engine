"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { num, ts } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useToast } from "@/lib/toast";

const STATUS_PILL = { clean: "p-verified", listed: "p-competitor", error: "p-review", pending: "p-review", checking: "p-review" };

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
  const timer = useRef(null);

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
                <tr key={r.domain}>
                  <td><span className="nm mono">{r.domain}</span></td>
                  <td><span className={`pill ${STATUS_PILL[r.status] || ""}`}><Icon name={r.status === "listed" ? "warn" : "check"} />{r.status}</span></td>
                  <td className="num-c">{r.riskScore ?? <span className="muted">—</span>}</td>
                  <td><span className="trunc sm muted" title={(r.listedZones || []).join(", ")}>{(r.listedZones || []).slice(0, 3).join(", ") || "—"}</span></td>
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
    </>
  );
}
