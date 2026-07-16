"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { num, ts, cap } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useDash } from "@/lib/ctx";
import { useToast } from "@/lib/toast";
import { useLeadList } from "@/hooks/useLeadList";
import Pager from "./Pager";

// BounceBan's verdict on a lead, plus WHO had originally verified it — so a row reads
// "Enrich said verified · BounceBan says undeliverable" at a glance.
function VerdictCell({ x }) {
  if (!x.bb_verdict) return <span className="muted">—</span>;
  const ok = x.bb_verdict === "confirmed";
  return (
    <span className={`pill ${ok ? "p-verified" : "p-competitor"}`} title={`${x.bb_result || ""}${x.bb_score != null ? " · score " + x.bb_score : ""}`}>
      <Icon name={ok ? "check" : "x"} />{ok ? "confirmed" : "rejected"}
    </span>
  );
}

function Scorecard({ card }) {
  if (!card?.providers?.length) return null;
  return (
    <div className="chartbox" style={{ marginBottom: "var(--s3)" }}>
      <h4><Icon name="trend" />Provider scorecard <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>· of what each one called “verified”, how many does BounceBan confirm?</span></h4>
      <div className="tablewrap" style={{ border: "none" }}>
        <table><thead><tr><th>Verified by</th><th>Checked</th><th>Confirmed</th><th>Rejected</th><th>Accuracy</th><th>Catch-all</th></tr></thead>
          <tbody>{card.providers.map((p) => (
            <tr key={p.provider}>
              <td className="nm">{cap(p.provider)}</td>
              <td className="num-c">{num(p.total)}</td>
              <td className="num-c" style={{ color: "var(--good)", fontWeight: 600 }}>{num(p.confirmed)}</td>
              <td className="num-c" style={{ color: "var(--hot)", fontWeight: 600 }}>{num(p.rejected)}</td>
              <td className="num-c"><b>{p.accuracy}%</b></td>
              <td className="num-c muted">{num(p.acceptAll)}</td>
            </tr>
          ))}</tbody></table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        {num(card.rescued)} lead{card.rescued === 1 ? "" : "s"} everyone had written off as <b>unverified</b> turned out to be deliverable · {num(card.totalAudited)} audited in total.
      </div>
    </div>
  );
}

export default function TestTab() {
  const { openLead, openReverify, refreshTop, refreshData } = useDash();
  const toast = useToast();
  const L = useLeadList({ email: "has-email" });
  const [job, setJob] = useState({});
  const [card, setCard] = useState(null);
  const [count, setCount] = useState(null);
  const timer = useRef(null);

  const loadCard = useCallback(() => { j("/api/bounceban/scorecard").then(setCard).catch(() => {}); }, []);
  useEffect(() => {
    j("/api/bounceban/count").then((d) => setCount(d.count)).catch(() => {});
    loadCard();
  }, [loadCard]);

  const poll = useCallback(async function p() {
    clearTimeout(timer.current);
    const s = await j("/api/bounceban/audit/status").catch(() => ({}));
    setJob(s);
    if (s.running) timer.current = setTimeout(p, 2000);
    else { loadCard(); refreshTop(); refreshData(); }
  }, [loadCard, refreshTop, refreshData]);
  useEffect(() => { poll(); return () => clearTimeout(timer.current); }, [poll]);

  async function runAudit() {
    if (!window.confirm(`Re-verify ${num(count ?? 0)} leads (verified + unverified) with BounceBan?\n\nOnly BounceBan-approved addresses stay in SendKit. Rejected ones are marked unverified and DNC'd so they can never be emailed. Uses ~${num(count ?? 0)} BounceBan credits.`)) return;
    await post("/api/bounceban/audit", {});
    toast("BounceBan audit started", "info");
    poll();
  }

  const rows = L.data.rows;
  const pct = job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;

  return (
    <>
      <div className="note"><Icon name="spark" /><div>
        Every lead we ever found an email for — <b>verified and unverified</b>. <b>Verify with BounceBan</b> re-checks them all and makes BounceBan the source of truth:
        approved addresses stay in SendKit, rejected ones are marked unverified, badged, and <b>DNC’d</b> so they can never be emailed.<br />
        Each row keeps its <b>original</b> verdict — so the scorecard shows how accurate Enrich and Prospeo actually were.
      </div></div>

      <div className="toolbar">
        <span className="resn"><b>{num(count ?? L.data.count)}</b> leads with an email · <b>{num(L.data.count)}</b> in view</span>
        <div className="grow" />
        <button className="btn" disabled={job.running} onClick={runAudit}>
          <Icon name={job.running ? "refresh" : "check"} />{job.running ? "Verifying…" : "Verify with BounceBan"}
        </button>
      </div>

      {(job.running || job.finishedAt) && (
        <div className={`jobbox${job.running ? " on" : ""}`}>
          <div className="jobh"><Icon name={job.running ? "refresh" : "check"} />
            <span>{job.running ? <>Verifying <b>{num(job.processed)}</b> / <b>{num(job.total)}</b> · {pct}%</> : <>Done · {num(job.processed)} checked</>}
              {" · "}<b className="ok">{num(job.confirmed || 0)}</b> confirmed · <b style={{ color: "var(--hot)" }}>{num(job.rejected || 0)}</b> rejected · {num(job.dnc || 0)} DNC’d</span>
          </div>
          <div className={`prog${job.running ? " on" : ""}`}><i style={{ width: `${Math.max(job.running ? pct : 100, job.running ? 3 : 0)}%` }} /></div>
        </div>
      )}

      <Scorecard card={card} />

      {L.loading && !rows.length ? (
        <div className="tablewrap"><div className="loading"><span className="spin" />Loading leads…</div></div>
      ) : !rows.length ? (
        <div className="tablewrap"><div className="empty"><Icon name="mail" /><b>No leads with an email yet</b>Scrape a post first.</div></div>
      ) : (
        <>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>Person / email</th><th>Company</th><th>Status now</th>
                <th title="Who verified it BEFORE the BounceBan audit">Was verified by</th>
                <th>BounceBan</th><th>Score</th><th>Flags</th><th>Checked</th>
              </tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.linkedin_url} className="click" onClick={() => openLead(x.linkedin_url, x.name)}>
                    <td>
                      <span className="nm trunc" title={x.name}>{x.name || "—"}</span>
                      <span className="em trunc mono" title={x.email}>{x.email}</span>
                    </td>
                    <td><span className="trunc sm muted" title={x.company || ""}>{x.company || "—"}</span></td>
                    <td>
                      <span className={`pill p-${x.email_status}`}><Icon name={x.email_status === "verified" ? "check" : "warn"} />{x.email_status}</span>
                      {x.dnc ? <span className="tag-dnc" title={x.dnc_reason === "bounceban-rejected" ? "DNC'd because BounceBan rejected it" : "On SendKit DNC"}>DNC</span> : null}
                    </td>
                    <td>{x.bb_prev_verified_by
                      ? <span className="src"><b>{cap(x.bb_prev_verified_by)}</b>{x.bb_prev_status === "verified" ? " · said verified" : " · unverified"}</span>
                      : <span className="muted">{x.verified_by ? cap(x.verified_by) : "—"}</span>}</td>
                    <td><VerdictCell x={x} /></td>
                    <td className="num-c">{x.bb_score != null ? x.bb_score : <span className="muted">—</span>}</td>
                    <td>
                      {x.bb_accept_all ? <span className="tag-man" title="Catch-all domain — accepts every address, so deliverability isn't provable">catch-all</span> : null}
                      {x.bb_role ? <span className="tag-man">role</span> : null}
                      {x.bb_free ? <span className="tag-pers">free</span> : null}
                    </td>
                    <td className="tstamp">{x.bb_checked_at ? ts(x.bb_checked_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager count={L.data.count} page={L.page} setPage={L.setPage} size={L.size} setSize={L.setSize} />
        </>
      )}
    </>
  );
}
