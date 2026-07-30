"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { num, ts } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useDash } from "@/lib/ctx";
import { useToast } from "@/lib/toast";
import JobBox from "./JobBox";

function HandoffBucketPicker({ onPick }) {
  const [counts, setCounts] = useState({});
  useEffect(() => {
    Promise.all([j("/api/stats?bucket=2.0"), j("/api/stats?bucket=1.0")])
      .then(([b2, b1]) => setCounts({ "2.0": b2, "1.0": b1 })).catch(() => {});
  }, []);
  const Card = ({ b, title, sub }) => {
    const c = counts[b] || {};
    return (
      <div className="chartbox click" style={{ cursor: "pointer" }} onClick={() => onPick(b)}>
        <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}><Icon name="inbox" />{title}</h4><div className="grow" /><Icon name="external" /></div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{sub}</div>
        <div className="grid g-cred">
          <div className="card pri"><div className="kh">No-email</div><div className="v">{c.noEmail != null ? num(c.noEmail) : "—"}</div></div>
          <div className="card pri"><div className="kh">Recovered</div><div className="v">{c.recovered != null ? num(c.recovered) : "—"}</div></div>
        </div>
      </div>
    );
  };
  return (
    <>
      <div className="note"><Icon name="inbox" /><div>Leads whose email wasn’t found, split by <b>1.0</b> (old) / <b>2.0</b> (new). Pick one to see it by keyword topic and retry.</div></div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "var(--s3)", alignItems: "start" }}>
        <Card b="2.0" title="Cold Email 2.0 — new" sub="No-email leads scraped from 27 Jul onwards." />
        <Card b="1.0" title="Cold Email 1.0 — old" sub="No-email leads from the earlier base." />
      </div>
    </>
  );
}

export default function Handoff() {
  const { campaigns, stats, jobs, pollJobs } = useDash();
  const toast = useToast();
  const [bucket, setBucket] = useState(null);
  const [bRows, setBRows] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const [checked, setChecked] = useState(() => new Set());
  const [runs, setRuns] = useState([]);
  const [reasonLabels, setReasonLabels] = useState({});
  const [batchCount, setBatchCount] = useState(null);

  useEffect(() => { j("/api/reprocess/runs").then((d) => { setRuns(d.runs || []); setReasonLabels(d.reasonLabels || {}); }).catch(() => {}); }, []);
  useEffect(() => { if (bucket) { setBRows(null); j("/api/campaigns?bucket=" + bucket).then((d) => setBRows(d.campaigns || [])); } }, [bucket]);

  const source = bucket ? (bRows || []) : campaigns;
  const batches = source.filter((c) => c.noEmail > 0 || c.recovered > 0).sort((a, b) => b.noEmail - a.noEmail);
  const totRec = stats.recovered ?? 0;

  // NOTE: all hooks must run every render — the bucket-picker early-return lives at the END, after
  // every useEffect, so hook order never changes (fixes React #310).
  useEffect(() => {
    if (!bucket) return;
    const camps = [...checked];
    setBatchCount(null);
    const t = setTimeout(async () => {
      const { count } = await j("/api/reprocess/count?campaigns=" + camps.map(encodeURIComponent).join(",") + "&bucket=" + bucket);
      setBatchCount(count);
    }, 150);
    return () => clearTimeout(t);
  }, [checked, bucket]);

  const toggle = (k) => setChecked((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  async function retry(deep) {
    if (deep && !window.confirm("Deep retry re-runs EVERY stuck lead (incl. hopeless & unverified) and pays for a profile lookup once more. This spends RapidAPI credits. Continue?")) return;
    await post("/api/reprocess", { campaigns: [...checked], deep, bucket });
    toast(`${deep ? "Deep retry" : "Retry"} started — recovering emails in the background`, "info");
    pollJobs();
  }
  const campLabel = (key) => campaigns.find((c) => c.campaign === key)?.label || key;

  const selLine = checked.size
    ? <><b>{checked.size}</b> campaign{checked.size === 1 ? "" : "s"} selected · {batchCount == null ? <span className="muted">counting…</span> : <><b>{num(batchCount)}</b> leads to retry</>}</>
    : <><span className="muted">0 selected — Retry runs <b>all</b> campaigns</span> · <b>{num(batchCount ?? stats.noEmail)}</b> leads</>;

  if (!bucket) return <HandoffBucketPicker onPick={setBucket} />;

  return (
    <>
      <div className="toolbar"><button className="btn btn-ghost btn-sm" onClick={() => { setBucket(null); setChecked(new Set()); }}><Icon name="back" />1.0 / 2.0</button>
        <div className="grow" /><span className="resn">{bucket === "2.0" ? "Cold Email 2.0 · new · no-email by topic" : "Cold Email 1.0 · old · no-email by topic"}</span></div>
      <div className="note"><Icon name="inbox" /><div>Leads whose email wasn’t found (bucket <b>{bucket}</b>). Tick topics and <b>Retry</b> re-runs those through the resolve → find → verify waterfall. <b>Recovered</b> = emails rescued — <b>{num(totRec)}</b> unique overall.</div></div>
      <div className="toolbar">
        <span className="resn">{selLine}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => setChecked(new Set(batches.map((c) => c.campaign)))}><Icon name="check" />Select all</button>
        <div className="grow" />
        <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs((v) => !v)}><Icon name="refresh" />{showLogs ? "Hide logs" : "Logs"}</button>
        <button className="btn btn-ghost btn-sm" title="Ignore backoff/attempt caps — retry EVERY stuck lead (incl. hopeless & unverified), always paying for the profile lookup once more" onClick={() => retry(true)}><Icon name="refresh" />Deep retry</button>
        <button className="btn btn-sm" onClick={() => retry(false)}><Icon name="refresh" />Retry selected</button>
      </div>
      <JobBox kind="retry" s={jobs.retry} />
      {batches.length ? (
        <div className="tablewrap"><table><thead><tr>
          <th className="chkcol"><input type="checkbox" className="chk" checked={checked.size === batches.length && batches.length > 0} onChange={(e) => setChecked(e.target.checked ? new Set(batches.map((c) => c.campaign)) : new Set())} /></th>
          <th>Campaign</th><th>No-email</th><th>Recovered</th><th>Total</th><th>Verified</th></tr></thead>
          <tbody>{batches.map((c) => (
            <tr key={c.campaign}>
              <td className="chkcol"><input type="checkbox" className="chk" checked={checked.has(c.campaign)} onChange={() => toggle(c.campaign)} /></td>
              <td className="nm">{c.label}</td><td className="score">{num(c.noEmail)}</td>
              <td className="num-c" style={{ color: "var(--good)", fontWeight: 600 }}>{num(c.recovered || 0)}</td>
              <td className="muted">{num(c.total)}</td><td className="muted">{num(c.verified)}</td>
            </tr>
          ))}</tbody></table></div>
      ) : (
        <div className="tablewrap"><div className="empty"><Icon name="check" /><b>All caught up</b>No hand-off leads — every campaign’s emails were found.</div></div>
      )}
      {showLogs && runs.length > 0 && (
        <>
          <div className="section-t" style={{ marginTop: "var(--s5)" }}><Icon name="refresh" />Retry history — why leads are still stuck</div>
          <div className="tablewrap"><table><thead><tr><th>When</th><th>Recovered</th><th>Processed</th><th>Scope</th><th>Why the rest missed</th></tr></thead>
            <tbody>{runs.map((r, i) => {
              const misses = Object.entries(r.reasons || {}).filter(([k]) => k !== "recovered").sort((a, b) => b[1] - a[1]);
              return (
                <tr key={i}>
                  <td className="tstamp">{ts(r.finishedAt)}</td>
                  <td className="num-c" style={{ color: "var(--good)", fontWeight: 600 }}>+{num(r.recovered)}</td>
                  <td className="muted">{num(r.processed)}</td>
                  <td>{r.campaigns && r.campaigns.length ? r.campaigns.map(campLabel).join(", ") : <span className="muted">all</span>}</td>
                  <td><div className="misswrap">{misses.length ? misses.map(([k, v]) => <span key={k} className="misschip" title={reasonLabels[k] || k}>{k.replace(/_/g, " ")} <b>{num(v)}</b></span>) : <span className="muted">—</span>}</div></td>
                </tr>
              );
            })}</tbody></table></div>
        </>
      )}
    </>
  );
}
