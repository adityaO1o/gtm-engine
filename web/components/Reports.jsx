"use client";
import { useCallback, useEffect, useState } from "react";
import Icon from "@/components/Icon";
import Pager from "@/components/Pager";
import { num } from "@/lib/format";
import { j, post, del } from "@/lib/api";
import { useToast } from "@/lib/toast";

// The public host reports are shared from. Reports render on whatever domain serves them, so before
// blacklist-report.com is mapped the same token still works on the dashboard host — this only decides
// which URL gets copied into an email.
const REPORT_HOST = "https://blacklist-report.com";
const linkFor = (token) => `${REPORT_HOST}/r/${token}`;

const day = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");

export default function Reports() {
  const toast = useToast();
  const [tab, setTab] = useState("reports");           // "reports" | "requests"

  // ── reports list ──
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [loading, setLoading] = useState(true);

  // ── requests list ──
  const [reqs, setReqs] = useState([]);
  const [reqCount, setReqCount] = useState(0);
  const [reqPage, setReqPage] = useState(0);
  const [reqSize, setReqSize] = useState(50);

  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [minBl, setMinBl] = useState(5);

  // Typing shouldn't fire a query per keystroke — the collection is large and the regex isn't indexed.
  useEffect(() => { const t = setTimeout(() => { setDebouncedQ(q); setPage(0); }, 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await j(`/api/reports?q=${encodeURIComponent(debouncedQ)}&page=${page}&size=${size}`);
      setItems(r.items || []); setCount(r.count || 0);
    } catch { /* ignore */ }
    setLoading(false);
  }, [debouncedQ, page, size]);
  useEffect(() => { load(); }, [load]);

  const loadReqs = useCallback(async () => {
    try {
      const r = await j(`/api/report-requests?page=${reqPage}&size=${reqSize}`);
      setReqs(r.items || []); setReqCount(r.count || 0);
    } catch { /* ignore */ }
  }, [reqPage, reqSize]);
  useEffect(() => { loadReqs(); }, [loadReqs]);

  async function create(force = false) {
    const s = seed.trim();
    if (!s) return;
    setBusy(true);
    try {
      const r = await post("/api/reports", { seed: s, force });
      if (r.ok) {
        await navigator.clipboard.writeText(linkFor(r.token)).catch(() => {});
        toast(r.reused ? "Report already existed — link copied" : `Report ready · ${num(r.blacklistedCount)} blacklisted — link copied`, "good");
        setSeed(""); load();
      } else toast(r.error || "Could not build that report", "bad");
    } catch { toast("Could not build that report", "bad"); }
    setBusy(false);
  }

  async function bulk() {
    // Free: every one of these reads blacklist data a funnel run already paid for.
    if (!confirm(`Generate reports for every already-scanned company with ${minBl}+ blacklisted domains?\n\nCosts nothing — the data is already stored.`)) return;
    setBulkBusy(true);
    try {
      const r = await post("/api/reports/bulk", { minBlacklisted: minBl, limit: 2000 });
      if (r.ok) { toast(`${num(r.created)} created · ${num(r.alreadyHadReport)} already had one${r.failed ? ` · ${num(r.failed)} failed` : ""}`, "good"); load(); }
      else toast(r.error || "Bulk generation failed", "bad");
    } catch { toast("Bulk generation failed", "bad"); }
    setBulkBusy(false);
  }

  async function remove(token, s) {
    if (!confirm(`Delete the report for ${s}?\n\nAnyone you already sent this link to will see "report not found".`)) return;
    await del(`/api/reports/${token}`);
    toast("Report deleted", "info"); load();
  }

  async function mark(id, status) {
    await post(`/api/report-requests/${id}`, { status });
    loadReqs();
  }

  const copy = async (token) => {
    await navigator.clipboard.writeText(linkFor(token)).catch(() => {});
    toast("Link copied", "good");
  };

  const newReqs = reqs.filter((r) => r.status === "new").length;

  return (
    <>
      <div className="note"><Icon name="shield" /><div>
        Shareable proof for the prospect who replies <i>"send me the report"</i>. No login on their side —
        the link is the only key. Each report is a <b>snapshot with its scan date on the page</b>, so it
        can't quietly empty out later and make your email look wrong. Re-check builds a new one and
        leaves the old link working.
      </div></div>

      <div className="toolbar">
        <button className={`btn btn-sm ${tab === "reports" ? "" : "btn-ghost"}`} onClick={() => setTab("reports")}>
          <Icon name="shield" />Reports{count ? ` (${num(count)})` : ""}
        </button>
        <button className={`btn btn-sm ${tab === "requests" ? "" : "btn-ghost"}`} onClick={() => setTab("requests")}>
          <Icon name="inbox" />Requests{newReqs ? ` (${num(newReqs)} new)` : ""}
        </button>
      </div>

      {tab === "reports" ? (
        <>
          <div className="toolbar">
            <input
              className="search" style={{ maxWidth: 250 }} placeholder="acme.com — build a report"
              value={seed} onChange={(e) => setSeed(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create(false)}
            />
            <button className="btn" disabled={busy || !seed.trim()} onClick={() => create(false)}>
              <Icon name={busy ? "refresh" : "spark"} />{busy ? "Building…" : "Build report"}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy || !seed.trim()} onClick={() => create(true)}
              title="Build a fresh report even if this company already has one. The old link keeps working with its old date.">
              <Icon name="refresh" />Re-check
            </button>
            <div className="grow" />
            <span className="resn muted">min</span>
            <input className="search" type="number" min="1" value={minBl}
              onChange={(e) => setMinBl(+e.target.value || 1)} style={{ maxWidth: 62 }} />
            <button className="btn btn-ghost btn-sm" disabled={bulkBusy} onClick={bulk}
              title="Generate reports for every company a funnel already scanned. Free — the data is already stored.">
              <Icon name={bulkBusy ? "refresh" : "mega"} />{bulkBusy ? "Generating…" : "Bulk generate"}
            </button>
          </div>

          <div className="toolbar">
            <input className="search" style={{ maxWidth: 300 }} placeholder="Search company or domain…"
              value={q} onChange={(e) => setQ(e.target.value)} />
            {q ? <button className="btn btn-ghost btn-sm" onClick={() => setQ("")}><Icon name="x" />Clear</button> : null}
            <div className="grow" />
            <span className="resn"><b>{num(count)}</b> report{count === 1 ? "" : "s"}</span>
          </div>

          {loading ? <div className="loading">Loading…</div>
            : !items.length ? (
              <div className="empty">
                {debouncedQ ? `Nothing matches "${debouncedQ}".` : "No reports yet — build one above, or bulk-generate from the companies you've already scanned."}
              </div>
            ) : (
              <>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr><th>Company</th><th>Seed</th><th>Blacklisted</th><th>Of</th><th>Built</th><th>Views</th><th>Link</th><th /></tr>
                    </thead>
                    <tbody>
                      {items.map((r) => (
                        <tr key={r.token}>
                          <td><b>{r.companyName || r.seed}</b></td>
                          <td><span className="nm mono sm">{r.seed}</span></td>
                          <td className="num-c"><b>{num(r.blacklistedCount)}</b></td>
                          <td className="num-c muted">{r.totalDomains == null ? "—" : num(r.totalDomains)}</td>
                          <td className="sm muted">{day(r.generatedAt)}</td>
                          <td className="num-c muted">{num(r.views || 0)}</td>
                          <td><a href={linkFor(r.token)} target="_blank" rel="noreferrer" className="mono sm">/r/{r.token}</a></td>
                          <td>
                            <button className="btn btn-ghost btn-sm" onClick={() => copy(r.token)} title="Copy the shareable link"><Icon name="external" /></button>
                            <button className="btn btn-ghost btn-sm" onClick={() => remove(r.token, r.seed)} title="Delete this report"><Icon name="trash" /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager count={count} page={page} setPage={setPage} size={size} setSize={setSize} />
              </>
            )}
        </>
      ) : (
        <>
          <div className="note"><Icon name="inbox" /><div>
            People who filled in the form on the public site. Their work email had to match the company
            domain they asked about. Where we'd already scanned that company, the report is built and
            linked here — just send it and mark it sent.
          </div></div>

          {!reqs.length ? <div className="empty">No requests yet.</div> : (
            <>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr><th>Email</th><th>Company domain</th><th>Report</th><th>Received</th><th>Status</th><th /></tr>
                  </thead>
                  <tbody>
                    {reqs.map((r) => (
                      <tr key={r._id}>
                        <td><b>{r.email}</b></td>
                        <td><span className="nm mono sm">{r.seed}</span></td>
                        <td>
                          {r.reportToken
                            ? <a href={linkFor(r.reportToken)} target="_blank" rel="noreferrer" className="mono sm">/r/{r.reportToken}</a>
                            : <span className="muted sm">not scanned yet</span>}
                        </td>
                        <td className="sm muted">{day(r.createdAt)}</td>
                        <td>
                          <span className={`pill ${r.status === "sent" ? "p-verified" : r.status === "ignored" ? "p-review" : "p-competitor"}`}>{r.status}</span>
                        </td>
                        <td>
                          {r.reportToken ? <button className="btn btn-ghost btn-sm" onClick={() => copy(r.reportToken)} title="Copy the link"><Icon name="external" /></button> : null}
                          {r.status !== "sent" ? <button className="btn btn-ghost btn-sm" onClick={() => mark(r._id, "sent")} title="Mark as sent"><Icon name="check" /></button> : null}
                          {r.status === "new" ? <button className="btn btn-ghost btn-sm" onClick={() => mark(r._id, "ignored")} title="Ignore"><Icon name="x" /></button> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager count={reqCount} page={reqPage} setPage={setReqPage} size={reqSize} setSize={setReqSize} />
            </>
          )}
        </>
      )}
    </>
  );
}
