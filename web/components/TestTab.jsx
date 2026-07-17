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

const Hero = ({ k, v, sub, cls }) => (
  <div className={`hero ${cls || ""}`}>
    <div className="hk">{k}</div>
    <div className="hv">{typeof v === "number" ? num(v) : v}</div>
    <div className="hs">{sub}</div>
  </div>
);

// Headline result cards. While the audit runs these track the LIVE job; once it finishes they show
// the cumulative picture across every audit.
function ResultCards({ job, card }) {
  const live = !!job.running;
  const o = card?.overall || {};
  const checked = live ? job.processed || 0 : o.audited || 0;
  const confirmed = live ? job.confirmed || 0 : o.confirmed || 0;
  const rejected = live ? job.rejected || 0 : o.rejected || 0;
  if (!checked && !live) return null;
  const rate = checked ? Math.round((confirmed / checked) * 100) : 0;
  return (
    <div className="grid g-hero">
      <Hero k="Emails checked" v={checked} sub={live ? `of ${num(job.total || 0)} · running…` : "put through BounceBan"} />
      <Hero k="Verified" v={confirmed} sub={`${rate}% deliverable · pushed to SendKit`} cls="pri" />
      <Hero k="Unverified" v={rejected} sub="rejected · DNC’d, never emailed" cls="bad" />
      <Hero k="Rescued" v={card?.rescued ?? 0} sub="were written off — actually fine" cls="good" />
    </div>
  );
}

// One card per provider: of what IT called "verified", how much did BounceBan throw out?
function ProviderCards({ card }) {
  if (!card?.providers?.length) return null;
  return (
    <>
      <div className="section-t"><Icon name="trend" />How accurate were they really? — of what each one called “verified”</div>
      <div className="grid g-hero">
        {card.providers.map((p) => (
          <div key={p.provider} className="hero">
            <div className="hk">{cap(p.provider)} said verified</div>
            <div className="hv" style={{ color: p.accuracy >= 85 ? "var(--good)" : p.accuracy >= 70 ? "var(--warm)" : "var(--hot)" }}>{p.accuracy}%</div>
            <div className="hs">
              <b style={{ color: "var(--hot)" }}>{num(p.rejected)}</b> rejected by BounceBan · {num(p.confirmed)}/{num(p.total)} held up
              {p.acceptAll ? <> · {num(p.acceptAll)} catch-all</> : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// Proof, checked against SendKit's own block list rather than our counters. The only question it
// answers: can an address BounceBan rejected still be emailed?
function ProofPanel({ proof, busy, onRun, onDnc }) {
  return (
    <>
      <div className="section-t">
        <Icon name="check" />Proof — verified against SendKit itself
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={onRun}>
          <Icon name={busy ? "refresh" : "shield"} />{busy ? "Checking…" : proof ? "Re-check" : "Run proof"}
        </button>
      </div>

      {!proof ? (
        <div className="note"><Icon name="shield" /><div>
          Reads SendKit’s entire Do-Not-Contact list live and cross-checks it against every lead BounceBan rejected.
          Nothing here trusts this dashboard’s own numbers. Takes ~30–60s.
        </div></div>
      ) : (
        <>
          <div className={`note ${proof.clean ? "ok" : "bad"}`}>
            <Icon name={proof.clean ? "check" : "warn"} />
            <div>{proof.truncated ? (
              <><b>Inconclusive.</b> SendKit’s DNC list could not be read all the way to the end, so this is <b>not</b> a clean bill of health. Re-run it.</>
            ) : proof.clean ? (
              <><b>Clean, both directions.</b> {num(proof.rejected)} rejected addresses can never be emailed ({num(proof.blocked)} blocked in SendKit,
                {" "}{num(proof.neverSent)} never reached it) — and all {num(proof.emailable)} emailable addresses are BounceBan-verified.</>
            ) : proof.unvouched && !proof.leaked ? (
              <><b>{num(proof.unvouched)} emailable address{proof.unvouched === 1 ? "" : "es"} BounceBan never approved.</b> No rejected lead can be emailed
                ({num(proof.blocked)} blocked, 0 leaks), but these got into a campaign from outside our pipeline.</>
            ) : (
              <><b>{num(proof.leaked)} LEAK{proof.leaked === 1 ? "" : "S"}.</b> These were rejected by BounceBan, reached SendKit, and are <b>not</b> blocked —
                they can still be emailed: {proof.leakSample?.map((x) => x.email).join(", ")}</>
            )}</div>
          </div>

          <div className="grid g-hero">
            <Hero k="Rejected + blocked" v={proof.blocked} sub="on SendKit’s own DNC list" cls="good" />
            <Hero k="Leaks" v={proof.leaked} sub={proof.leaked ? "rejected but still emailable" : "none — the guarantee holds"} cls={proof.leaked ? "bad" : "good"} />
            <Hero k="Emailable" v={proof.emailable} sub="addresses SendKit can actually send to" />
            <Hero k="Not BounceBan-approved" v={proof.unvouched}
              sub={proof.unvouched ? "emailable without a BounceBan verdict" : "every emailable address is BounceBan-verified"}
              cls={proof.unvouched ? "bad" : "good"} />
          </div>

          {proof.unvouched ? (
            <div className="toolbar" style={{ marginTop: "var(--s3)" }}>
              <span className="resn">
                <b>{num(proof.unvouched)}</b> emailable address{proof.unvouched === 1 ? "" : "es"} BounceBan never approved — strays from outside our pipeline
                (old imports). {proof.unvouchedSample?.slice(0, 3).join(", ")}{proof.unvouched > 3 ? "…" : ""}
              </span>
              <div className="grow" />
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onDnc}><Icon name="x" />Block all {num(proof.unvouched)}</button>
            </div>
          ) : null}
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            SendKit’s DNC list: <b>{num(proof.dncListSize)}</b> addresses · <b>{num(proof.confirmedOnDnc)}</b> BounceBan-approved leads are blocked by SendKit for other reasons
            (competitors, complaints) and are deliberately not pushed · checked {ts(proof.checkedAt)}.
          </div>
        </>
      )}
    </>
  );
}

// Per-campaign before/after. The column that trips people up is "In SendKit": it does not fall when
// leads are removed, because SendKit keeps blocked leads as campaign members and skips them at send
// time. "Emailable now" is the number that decides who actually gets contacted.
function CampaignReport({ rep, busy, onRun }) {
  const t = rep?.totals;
  return (
    <>
      <div className="section-t">
        <Icon name="mega" />Per-campaign · before vs now
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={onRun}>
          <Icon name={busy ? "refresh" : "trend"} />{busy ? "Building…" : rep ? "Refresh" : "Build report"}
        </button>
      </div>

      {!rep ? (
        <div className="note"><Icon name="mega" /><div>
          What each campaign looked like before the BounceBan audit vs now, read <b>from SendKit itself</b> — its member list,
          its <code>addedAt</code>, its send status. Takes ~1–2 min (it walks every member of every campaign).
        </div></div>
      ) : (
        <>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>Campaign</th>
                <th title="SendKit's total member count. It never falls — blocked leads stay members and are skipped at send time">Members</th>
                <th title="SendKit already had them before the audit started (its own addedAt)">Before</th>
                <th title="We added them during the audit / repair — the rescued ones">Added</th>
                <th title="Members SendKit will actually email — total minus blocked. This is the number that matters">Emailable</th>
                <th title="Members SendKit will skip at send time: DNC'd or on a blocked domain">Blocked</th>
                <th title="Rejected by BounceBan, still a member, but blocked — they can never be emailed">Rejected, held</th>
              </tr></thead>
              <tbody>
                {rep.campaigns.map((c) => (
                  <tr key={c.key}>
                    <td><span className="nm trunc" title={c.key}>{c.label}</span></td>
                    <td className="num-c muted">{num(c.members)}</td>
                    <td className="num-c muted">{num(c.before)}</td>
                    <td className="num-c" style={{ color: c.added ? "var(--good)" : "var(--dim)", fontWeight: c.added ? 600 : 400 }}>
                      {c.added ? "+" : ""}{num(c.added)}
                    </td>
                    <td className="num-c"><b>{num(c.emailable)}</b></td>
                    <td className="num-c" style={{ color: c.blocked ? "var(--hot)" : "var(--dim)" }}>{num(c.blocked)}</td>
                    <td className="num-c muted">{num(c.rejectedStillIn)}</td>
                  </tr>
                ))}
                {t && (
                  <tr style={{ fontWeight: 700, borderTop: "2px solid var(--line)" }}>
                    <td>Total</td>
                    <td className="num-c">{num(t.members)}</td>
                    <td className="num-c">{num(t.before)}</td>
                    <td className="num-c" style={{ color: "var(--good)" }}>+{num(t.added)}</td>
                    <td className="num-c">{num(t.emailable)}</td>
                    <td className="num-c" style={{ color: "var(--hot)" }}>{num(t.blocked)}</td>
                    <td className="num-c">{num(t.rejectedStillIn)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            Every column here is <b>SendKit’s own record</b>, not ours — “Before” is its <code>addedAt</code> against the audit start, because our verified flags
            were inflated by pushes that silently failed and can’t answer that question honestly. <b>Members never falls</b> on removal (SendKit has no
            remove-from-campaign endpoint): the {num(t?.rejectedStillIn || 0)} rejected leads still counted as members are blocked and skipped at send time.
            <b> Emailable</b> is who actually gets contacted · built {ts(rep.checkedAt)}.
          </div>
        </>
      )}
    </>
  );
}

export default function TestTab() {
  const { openLead, openReverify, refreshTop, refreshData } = useDash();
  const toast = useToast();
  const L = useLeadList({ email: "has-email" });
  const [job, setJob] = useState({});
  const [card, setCard] = useState(null);
  const [count, setCount] = useState(null);
  const [proof, setProof] = useState(null);
  const [proofBusy, setProofBusy] = useState(false);
  const [repair, setRepair] = useState({});
  const [rep, setRep] = useState(null);
  const [repBusy, setRepBusy] = useState(false);
  const timer = useRef(null);
  const rtimer = useRef(null);

  async function runReport() {
    setRepBusy(true);
    try { setRep(await j("/api/bounceban/campaign-report")); }
    catch { toast("Campaign report failed", "bad"); }
    setRepBusy(false);
  }

  const pollRepair = useCallback(async function p() {
    clearTimeout(rtimer.current);
    const s = await j("/api/bounceban/repair/status").catch(() => ({}));
    setRepair(s);
    if (s.running) rtimer.current = setTimeout(p, 2000);
    else if (s.finishedAt) refreshData();
  }, [refreshData]);
  useEffect(() => { pollRepair(); return () => clearTimeout(rtimer.current); }, [pollRepair]);

  async function runRepair() {
    if (!window.confirm("Re-push every BounceBan-confirmed lead to SendKit?\n\nThe first audit lost ~2,700 of them to SendKit's rate limit and wrongly reported them as pushed. This re-sends them over the bulk path.\n\nThis puts real people into live email campaigns. Costs no BounceBan credits. Leads SendKit blocks are skipped.")) return;
    await post("/api/bounceban/repair", {});
    toast("Repair started — re-pushing confirmed leads", "info");
    pollRepair();
  }

  async function dncUnvouched() {
    if (!window.confirm(`Block ${num(proof?.unvouched ?? 0)} emailable addresses BounceBan never approved?

They reached a campaign from outside our pipeline (old imports), so there is no lead of ours to fix — DNC is the only lever. They can never be emailed after this.`)) return;
    setProofBusy(true);
    try {
      const r = await post("/api/bounceban/dnc-unvouched", {});
      toast(r.skipped ? r.reason : `Blocked ${num(r.added || 0)} of ${num(r.unvouched || 0)}`, r.skipped || r.failed ? "bad" : "good");
      await runProof();
    } catch { toast("Blocking failed", "bad"); }
    setProofBusy(false);
  }

  async function runProof() {
    setProofBusy(true);
    try {
      const p = await j("/api/bounceban/proof");
      setProof(p);
      toast(p.truncated ? "Proof inconclusive — could not read the whole DNC list"
        : p.clean ? `Clean · 0 leaks · all ${num(p.emailable)} emailable are BounceBan-verified`
        : p.leaked ? `${num(p.leaked)} leaks found` : `${num(p.unvouched)} emailable without a BounceBan verdict`,
        p.clean && !p.truncated ? "good" : "bad");
    } catch { toast("Proof check failed", "bad"); }
    setProofBusy(false);
  }

  const loadCard = useCallback(() => { j("/api/bounceban/scorecard").then(setCard).catch(() => {}); }, []);
  useEffect(() => {
    j("/api/bounceban/count").then((d) => setCount(d.count)).catch(() => {});
    loadCard();
  }, [loadCard]);

  const poll = useCallback(async function p() {
    clearTimeout(timer.current);
    const s = await j("/api/bounceban/audit/status").catch(() => ({}));
    setJob(s);
    loadCard(); // keep the provider cards climbing live while the audit runs
    if (s.running) timer.current = setTimeout(p, 2500);
    else { refreshTop(); refreshData(); }   // finished — refresh counts + the table's badges
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
        <button className="btn btn-ghost" disabled={repair.running || job.running} onClick={runRepair} title="Re-push confirmed leads the first audit lost to SendKit's rate limit">
          <Icon name={repair.running ? "refresh" : "sync"} />{repair.running ? "Repairing…" : "Repair pushes"}
        </button>
        <button className="btn" disabled={job.running || repair.running} onClick={runAudit}>
          <Icon name={job.running ? "refresh" : "check"} />{job.running ? "Verifying…" : "Verify with BounceBan"}
        </button>
      </div>

      {(repair.running || repair.finishedAt) && (
        <div className={`jobbox${repair.running ? " on" : ""}`}>
          <div className="jobh"><Icon name={repair.running ? "refresh" : repair.failed ? "warn" : "check"} />
            <span>{repair.running ? <>Repairing · <b>{repair.phase}</b></> : <>Repair {repair.phase === "failed" ? "failed" : "done"}</>}
              {" · "}<b>{num(repair.uniqueEmails || 0)}</b> unique emails from {num(repair.total || 0)} leads
              {" · "}<b className="ok">{num(repair.added || 0)}</b> newly added · {num(repair.alreadyIn || 0)} already in
              {repair.skippedDnc ? <> · {num(repair.skippedDnc)} skipped (blocked)</> : null}
              {repair.failed ? <> · <b style={{ color: "var(--hot)" }}>{num(repair.failed)}</b> failed</> : null}</span>
          </div>
          {repair.running && <div className="prog on"><i style={{ width: "100%" }} /></div>}
        </div>
      )}

      {(job.running || job.finishedAt) && (
        <div className={`jobbox${job.running ? " on" : ""}`}>
          <div className="jobh"><Icon name={job.running ? "refresh" : "check"} />
            <span>{job.running ? <>Verifying <b>{num(job.processed)}</b> / <b>{num(job.total)}</b> · {pct}%</> : <>Done · {num(job.processed)} checked</>}
              {" · "}<b className="ok">{num(job.confirmed || 0)}</b> confirmed · <b style={{ color: "var(--hot)" }}>{num(job.rejected || 0)}</b> rejected · {num(job.dnc || 0)} DNC’d
              {job.pushFailed ? <> · <b style={{ color: "var(--hot)" }}>{num(job.pushFailed)}</b> push failed</> : null}
              {job.dncFailed ? <> · <b style={{ color: "var(--hot)" }}>{num(job.dncFailed)}</b> DNC failed</> : null}
              {job.skippedDnc ? <> · {num(job.skippedDnc)} skipped (already blocked)</> : null}</span>
          </div>
          <div className={`prog${job.running ? " on" : ""}`}><i style={{ width: `${Math.max(job.running ? pct : 100, job.running ? 3 : 0)}%` }} /></div>
        </div>
      )}

      <ResultCards job={job} card={card} />
      <ProviderCards card={card} />
      <CampaignReport rep={rep} busy={repBusy} onRun={runReport} />
      <ProofPanel proof={proof} busy={proofBusy} onRun={runProof} onDnc={dncUnvouched} />

      <div className="section-t"><Icon name="mail" />Every lead with an email</div>
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
