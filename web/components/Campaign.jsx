"use client";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { num, ts } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useToast } from "@/lib/toast";

// The funnel stages, in order, with how to read each tally off the campaign's stage counts.
const FUNNEL = [
  { key: "seeds", label: "Seed domains", of: (c) => c.seedCount, hint: "companies you pasted in" },
  { key: "qualified", label: "Passed count gate", of: (c, s) => sum(s, ["discovery_queued", "discovering", "dropped_blacklist", "enrich_queued", "enriching", "done"]), hint: (c) => `≥ ${c.gates?.countGate} redirect domains` },
  { key: "blacklisted", label: "Have blacklisted infra", of: (c, s) => sum(s, ["enrich_queued", "enriching", "done"]), hint: (c) => `≥ ${c.gates?.blacklistGate} blacklisted domains` },
  { key: "enriched", label: "Contacts pulled", of: (c, s) => sum(s, ["done"]), hint: "Prospeo search-person run" },
];
function sum(stages, keys) { return keys.reduce((a, k) => a + (stages?.[k] || 0), 0); }

// Human-readable label + pill colour for each per-seed funnel stage.
const STAGE_META = {
  queued: { label: "queued", cls: "p-review" },
  counting: { label: "counting…", cls: "p-review" },
  dropped_count: { label: "below count gate", cls: "p-role-based" },
  discovery_queued: { label: "queued", cls: "p-review" },
  discovering: { label: "discovering…", cls: "p-review" },
  dropped_blacklist: { label: "not enough blacklisted", cls: "p-role-based" },
  enrich_queued: { label: "queued", cls: "p-review" },
  enriching: { label: "enriching…", cls: "p-review" },
  done: { label: "done", cls: "p-verified" },
  error: { label: "error", cls: "p-competitor" },
  interrupted: { label: "interrupted (redeploy)", cls: "p-role-based" },
};

function csvEscape(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }
function exportCsv(rows) {
  const out = [["company", "redirectCount", "blacklistedCount", "blacklistedDomains", "person", "title", "seniority", "department", "email", "email_status", "linkedin"]];
  for (const r of rows) {
    const bl = (r.blacklistedDomains || []).map((d) => d.domain).join("|");
    if (r.people?.length) {
      for (const p of r.people) out.push([r.seed, r.redirectCount, r.blacklistedCount, bl, p.name, p.job_title, p.seniority, p.department, p.email || "", p.email_status || "", p.linkedin_url]);
    } else {
      out.push([r.seed, r.redirectCount, r.blacklistedCount, bl, "", "", "", "", "", "", ""]);
    }
  }
  const csv = out.map((r) => r.map(csvEscape).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "campaign-prospects.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Campaign() {
  const toast = useToast();
  const [view, setView] = useState("list");
  const [seeds, setSeeds] = useState("");
  const [countGate, setCountGate] = useState(50);
  const [blacklistGate, setBlacklistGate] = useState(3);
  const [campaign, setCampaign] = useState(null);
  const [results, setResults] = useState([]);
  const [history, setHistory] = useState([]);
  const [starting, setStarting] = useState(false);
  const [openRow, setOpenRow] = useState(null);
  const [revealing, setRevealing] = useState(null);
  const timer = useRef(null);

  async function revealEmails(seed) {
    if (revealing) return;
    setRevealing(seed);
    try {
      const r = await post(`/api/campaign/${campaign.id || campaign._id}/reveal`, { seed });
      if (r.people) {
        setResults((rows) => rows.map((x) => (x.seed === seed ? { ...x, people: r.people, emailsRevealed: true } : x)));
        const got = r.people.filter((p) => p.email).length;
        toast(got ? `Revealed ${got} email${got === 1 ? "" : "s"}` : "No emails found for these contacts", got ? "good" : "bad");
      }
    } catch { toast("Reveal failed", "bad"); }
    setRevealing(null);
  }

  const loadHistory = useCallback(() => { j("/api/campaign").then((d) => setHistory(d.items || [])).catch(() => {}); }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const poll = useCallback(function p(id) {
    clearTimeout(timer.current);
    Promise.all([j(`/api/campaign/${id}`), j(`/api/campaign/${id}/results`)]).then(([c, r]) => {
      if (!c || c.error) return;
      setCampaign(c); setResults(r.items || []);
      if (c.status === "running") timer.current = setTimeout(() => p(id), 2000);
      else loadHistory();
    }).catch(() => {});
  }, [loadHistory]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const openCampaign = useCallback((id) => { setView("detail"); setCampaign(null); setResults([]); setOpenRow(null); poll(id); }, [poll]);

  async function start() {
    if (!seeds.trim() || starting) return;
    setStarting(true);
    try {
      const r = await post("/api/campaign", { seeds, countGate: +countGate, blacklistGate: +blacklistGate });
      if (r.error) { toast(r.error, "bad"); setStarting(false); return; }
      toast(`Campaign started — ${num(r.seedCount)} seeds`, "info");
      setSeeds("");
      openCampaign(r.id);
    } catch { toast("Failed to start campaign", "bad"); }
    setStarting(false);
  }

  const seedN = (seeds.match(/[^\s,]+/g) || []).length;
  const running = campaign?.status === "running";

  // ── LIST VIEW ────────────────────────────────────────────────────────────────────────────────
  if (view === "list") {
    return (
      <>
        <div className="note"><Icon name="spark" /><div>
          Paste a list of company domains. The funnel filters them down cheaply: <b>host.io redirect count</b> →
          <b> free discovery + blacklist check</b> → <b>Prospeo people lookup</b>, so paid calls only ever hit
          companies that actually have broken, blacklisted sending infra worth pitching.
        </div></div>

        <div className="card" style={{ padding: "var(--s4)", marginBottom: "var(--s4)" }}>
          <textarea
            className="search" style={{ width: "100%", minHeight: 120, resize: "vertical", fontFamily: "var(--mono, monospace)", fontSize: 13 }}
            placeholder={"acme.com\nexample.io\nzapmail.ai\n… one domain per line"}
            value={seeds} onChange={(e) => setSeeds(e.target.value)}
          />
          <div className="toolbar" style={{ marginTop: "var(--s3)" }}>
            <span className="resn"><b>{num(seedN)}</b> domains</span>
            <div className="grow" />
            <label className="resn" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              count gate ≥
              <input type="number" className="search" style={{ width: 66 }} value={countGate} onChange={(e) => setCountGate(e.target.value)} />
            </label>
            <label className="resn" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              blacklisted ≥
              <input type="number" className="search" style={{ width: 56 }} value={blacklistGate} onChange={(e) => setBlacklistGate(e.target.value)} />
            </label>
            <button className="btn" disabled={starting || !seeds.trim()} onClick={start}>
              <Icon name={starting ? "refresh" : "spark"} />{starting ? "Starting…" : "Run campaign"}
            </button>
          </div>
        </div>

        <div className="section-t"><Icon name="refresh" />Campaigns</div>
        {history.length ? (
          <div className="tablewrap">
            <table>
              <thead><tr><th>Started</th><th>Seeds</th><th>Status</th><th>Gates</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h._id} className="click" onClick={() => openCampaign(h._id)}>
                    <td className="tstamp">{ts(h.createdAt)}</td>
                    <td className="num-c">{num(h.seedCount)}</td>
                    <td><span className={`pill ${h.status === "running" ? "p-review" : h.status === "error" ? "p-review" : "p-verified"}`}>
                      {h.status === "running" ? <><span className="spin" style={{ width: 11, height: 11 }} /> {h.stage}</> : h.status}</span></td>
                    <td className="sm muted">count ≥ {h.gates?.countGate} · blacklisted ≥ {h.gates?.blacklistGate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="tablewrap"><div className="empty"><Icon name="spark" /><b>No campaigns yet</b>Paste domains above and run one.</div></div>
        )}
      </>
    );
  }

  // ── DETAIL VIEW ──────────────────────────────────────────────────────────────────────────────
  const stages = campaign?.stages || {};
  return (
    <>
      <div className="toolbar">
        <button className="btn btn-ghost btn-sm" onClick={() => { clearTimeout(timer.current); setView("list"); loadHistory(); }}><Icon name="back" />All campaigns</button>
        {campaign ? <span className="resn">{running ? <><span className="spin" /> <b>{campaign.stage}</b></> : <b>done</b>} · {num(campaign.seedCount)} seeds</span> : null}
        <div className="grow" />
        {results.length ? <button className="btn btn-ghost btn-sm" onClick={() => exportCsv(results)}><Icon name="download" />Export CSV</button> : null}
      </div>

      {campaign ? (
        <div className="grid g-hero" style={{ marginBottom: "var(--s4)" }}>
          {FUNNEL.map((f) => {
            const v = f.of(campaign, stages);
            const hint = typeof f.hint === "function" ? f.hint(campaign) : f.hint;
            return (
              <div key={f.key} className="hero">
                <div className="hk">{f.label}</div>
                <div className="hv">{num(v)}</div>
                <div className="hs">{hint}</div>
              </div>
            );
          })}
        </div>
      ) : <div className="tablewrap"><div className="loading"><span className="spin" />Loading campaign…</div></div>}

      {results.length ? (
        <>
          <div className="section-t"><Icon name="spark" />Every seed — full funnel</div>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>Company</th>
                <th title="Total redirect domains host.io knows about (Stage 1 count)">Redirects</th>
                <th title="Real redirect domains we pulled from host.io and checked (Stage 2 scrape)">Checked</th>
                <th title="Of the checked, how many are blacklisted (Stage 3)">Blacklisted</th>
                <th title="People Prospeo returned (Stage 4)">Contacts</th>
                <th>Stage</th>
              </tr></thead>
              <tbody>
                {results.map((r) => {
                  const st = STAGE_META[r.stage] || { label: r.stage, cls: "p-review" };
                  return (
                  <Fragment key={r._id}>
                    <tr className="click" onClick={() => setOpenRow(openRow === r._id ? null : r._id)}>
                      <td><Icon name="chev" style={{ width: 13, height: 13, opacity: .5, marginRight: 4 }} /><span className="nm mono">{r.seed}</span></td>
                      <td className="num-c">{r.redirectCount == null ? <span className="muted">—</span> : num(r.redirectCount)}</td>
                      <td className="num-c">{num(r.confirmedCount)}</td>
                      <td className="num-c">{r.blacklistedCount ? <b style={{ color: "var(--hot)" }}>{num(r.blacklistedCount)}</b> : <span className="muted">0</span>}</td>
                      <td className="num-c">{r.peopleCount ? num(r.peopleCount) : <span className="muted">0</span>}</td>
                      <td><span className={`pill ${st.cls}`}>{st.label}</span></td>
                    </tr>
                    {openRow === r._id ? (
                      <tr>
                        <td colSpan={6} style={{ background: "var(--bg)" }}>
                          <div style={{ padding: "10px 14px" }}>
                            {/* funnel breakdown for this seed */}
                            <div className="resn muted" style={{ marginBottom: 10 }}>
                              host.io knows <b className="mono">{r.redirectCount == null ? "—" : num(r.redirectCount)}</b> redirects
                              {" → "}we pulled + checked <b className="mono">{num(r.confirmedCount)}</b>
                              {" → "}<b className="mono" style={{ color: r.blacklistedCount ? "var(--hot)" : "inherit" }}>{num(r.blacklistedCount)}</b> blacklisted
                              {r.stage === "dropped_count" ? <> · <span style={{ color: "var(--warm)" }}>stopped: below the count gate</span></> : null}
                              {r.stage === "dropped_blacklist" ? <> · <span style={{ color: "var(--warm)" }}>stopped: fewer than the blacklist gate</span></> : null}
                            </div>

                            {r.blacklistedDomains?.length ? (
                              <>
                                <div className="resn" style={{ marginBottom: 8 }}><b>Blacklisted domains</b> ({num(r.blacklistedCount)})</div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                                  {r.blacklistedDomains.slice(0, 10).map((d) => (
                                    <span key={d.domain} className="pill p-competitor" title={(d.zones || []).join(", ")}>
                                      {d.domain}{d.riskScore != null ? ` · ${d.riskScore}` : ""}
                                    </span>
                                  ))}
                                  {r.blacklistedDomains.length > 10 ? <span className="resn muted">+{r.blacklistedDomains.length - 10} more</span> : null}
                                </div>
                              </>
                            ) : null}

                            {r.stage === "done" || r.people?.length ? (
                              <>
                                <div className="resn" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
                                  <b>Contacts</b> ({num(r.peopleCount)}{r.peopleTotal > r.peopleCount ? ` of ${num(r.peopleTotal)}` : ""})
                                  {r.people?.length && !r.emailsRevealed ? (
                                    <button className="btn btn-ghost btn-sm" disabled={revealing === r.seed}
                                      onClick={(e) => { e.stopPropagation(); revealEmails(r.seed); }}
                                      title={`Enriches each contact via Prospeo — ~${r.peopleCount} credits`}>
                                      <Icon name={revealing === r.seed ? "refresh" : "mail"} />{revealing === r.seed ? "Revealing…" : `Reveal emails (~${num(r.peopleCount)} credits)`}
                                    </button>
                                  ) : null}
                                  {r.emailsRevealed ? <span className="resn muted">emails revealed</span> : null}
                                </div>
                                {r.people?.length ? (
                                  <table><tbody>
                                    {r.people.map((p, i) => (
                                      <tr key={i}>
                                        <td><b className="sm">{p.name || "—"}</b></td>
                                        <td className="sm muted">{p.job_title || "—"}</td>
                                        <td className="sm muted">{p.department || ""}</td>
                                        <td className="sm">{p.email
                                          ? <span className="mono" style={{ color: p.email_status === "VERIFIED" ? "var(--good)" : "var(--ink)" }}>{p.email}</span>
                                          : r.emailsRevealed ? <span className="muted">—</span> : <span className="muted">hidden</span>}</td>
                                        <td>{p.linkedin_url ? <a href={p.linkedin_url} target="_blank" rel="noopener" className="sm">in ↗</a> : null}</td>
                                      </tr>
                                    ))}
                                  </tbody></table>
                                ) : <div className="resn muted">Prospeo returned no contacts{r.prospeoError ? ` (${r.prospeoError})` : ""}.</div>}
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : campaign && !running ? (
        <div className="tablewrap"><div className="empty"><Icon name="search" /><b>No qualifying prospects</b>No company passed both gates. Try lowering the thresholds.</div></div>
      ) : null}
    </>
  );
}
