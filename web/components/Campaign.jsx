"use client";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { num, ts } from "@/lib/format";
import { j, post, del } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useDash } from "@/lib/ctx";
import Pager from "@/components/Pager";

// The funnel stages, in order, with how to read each tally off the campaign's stage counts.
// Stage groups. A seed that cleared the blacklist gate sits in enrich_queued until the (slower)
// enrichment lane picks it up — it must count in both cards below, or the totals visibly jump around
// as seeds shuttle between enrich_queued and enriching.
const PAST_COUNT_GATE = ["scraping", "blacklisting", "dropped_blacklist", "enrich_queued", "enriching", "error", "done", "qualified"];
const PAST_BLACKLIST_GATE = ["enrich_queued", "enriching", "done", "qualified"];

// A blacklist scan drops nothing, so its stage counts say nothing about the funnel — the server
// sends a measured `funnel` for those runs and it wins wherever present.
const FUNNEL = [
  { key: "seeds", label: "Seed domains", of: (c) => c.funnel?.seeds ?? c.seedCount, hint: "companies you pasted in" },
  { key: "qualified", label: "Passed count gate", of: (c, s) => c.funnel?.passedCount ?? sum(s, PAST_COUNT_GATE), hint: (c) => `≥ ${c.gates?.countGate} redirect domains` },
  { key: "blacklisted", label: "Have blacklisted infra", of: (c, s) => c.funnel?.hasBadInfra ?? sum(s, PAST_BLACKLIST_GATE), hint: (c) => `≥ ${c.gates?.blacklistGate} blacklisted domains` },
  { key: "enriched", label: "Contacts pulled", of: (c, s) => c.funnel?.contacts ?? sum(s, ["done"]), hint: "Prospeo search-person run" },
];
function sum(stages, keys) { return keys.reduce((a, k) => a + (stages?.[k] || 0), 0); }

// Human-readable label + pill colour for each per-seed funnel stage.
const STAGE_META = {
  queued: { label: "queued", cls: "p-review" },
  scraping: { label: "scraping…", cls: "p-review" },
  blacklisting: { label: "checking blacklist…", cls: "p-review" },
  dropped_count: { label: "below count gate", cls: "p-role-based" },
  dropped_blacklist: { label: "not enough blacklisted", cls: "p-role-based" },
  enrich_queued: { label: "queued for contacts", cls: "p-review" },
  enriching: { label: "finding contacts…", cls: "p-review" },
  qualified: { label: "qualified · no contacts pulled", cls: "p-verified" },
  done: { label: "done", cls: "p-verified" },
  error: { label: "error", cls: "p-competitor" },
  interrupted: { label: "interrupted (redeploy)", cls: "p-role-based" },
};



export default function Campaign() {
  const toast = useToast();
  const [view, setView] = useState("list");
  const [seeds, setSeeds] = useState("");
  const [countGate, setCountGate] = useState(10);
  const [blacklistGate, setBlacklistGate] = useState(5);
  const [etaText, setEtaText] = useState("");
  const rateRef = useRef({ at: 0, processed: 0 });
  const [campaign, setCampaign] = useState(null);
  const [results, setResults] = useState([]);
  // Results are PAGED server-side: one run holds 22k seeds, each row carrying its people[] and
  // blacklistedDomains[]. Loading them all was megabytes per poll and a table the browser choked on.
  const [resCount, setResCount] = useState(0);
  const [resPage, setResPage] = useState(0);
  const [resSize, setResSize] = useState(100);
  const [resQ, setResQ] = useState("");
  const [debouncedResQ, setDebouncedResQ] = useState("");
  const [contacts, setContacts] = useState(0);
  const [history, setHistory] = useState([]);
  const [histCount, setHistCount] = useState(0);
  const [histPage, setHistPage] = useState(0);
  const [histSize, setHistSize] = useState(25);
  const [starting, setStarting] = useState(false);
  const [enrich, setEnrich] = useState(true); // pull contacts via Prospeo (paid); off = blacklist verdict only
  const [guess, setGuess] = useState(false); // also try permutation-guessed domains (DNS+redirect confirmed), tagged separately
  const [openRow, setOpenRow] = useState(null);
  const [revealing, setRevealing] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [enrichingCompanies, setEnrichingCompanies] = useState(false);
  const [deleting, setDeleting] = useState(null);
  // Push target comes from the sidebar switcher, so it's picked once and applies everywhere.
  const { workspaces = [], workspaceId = "" } = useDash();
  const [preview, setPreview] = useState(null);
  const timer = useRef(null);

  const campId = campaign?.id || campaign?._id;
  // Which SendKit workspace a run was pushed to, by its stored id. Falls back to a generic label when
  // it went to the server's default workspace (id stored as null) or the list hasn't loaded yet.
  const wsLabel = (id) => workspaces.find((w) => w.id === id)?.label || "SendKit";

  async function pushToSendkit() {
    // Ask the server for the run's real contact total — reducing over `results` would only ever count
    // the page currently on screen.
    let total = contacts;
    try { total = (await j(`/api/campaign/${campId}/contacts-count`)).contacts || 0; } catch { /* fall back to the cached count */ }
    if (!total) { toast("No contacts with a revealed email yet", "bad"); return; }

    // Ask the server exactly where this would land, so the prompt states the real target instead of
    // assuming (each workspace has its own campaign, with its own copy).
    setPushing(true);
    let tgt;
    try { tgt = await j(`/api/campaign/${campId}/push-target?workspaceId=${encodeURIComponent(workspaceId)}`); }
    catch { tgt = null; }
    if (!tgt?.ok) { toast(tgt?.error || "Could not resolve the SendKit campaign", "bad"); setPushing(false); return; }

    const where = tgt.exists
      ? `existing campaign "${tgt.campaignName}"\nid: ${tgt.campaignId}  (status: ${tgt.campaignStatus})\nIts sequence/copy is used as-is — nothing is overwritten.`
      : `a NEW campaign "${tgt.campaignName}" (none exists yet in this workspace)\nIt will be created as a DRAFT carrying our blacklist sequence.`;
    if (!window.confirm(
      `Workspace: ${tgt.workspaceLabel}\nTarget: ${where}\n\n` +
      `Pushing ${num(tgt.contacts)} contacts from ${num(tgt.companies)} companies, each with their own variables ` +
      `(blacklisted domain count, example domains, …).\n\nNothing is sent — you start the campaign yourself in SendKit.`
    )) { setPushing(false); return; }
    try {
      const r = await post(`/api/campaign/${campId}/push-sendkit`, { workspaceId });
      if (r.ok) { toast(`Pushed ${num(r.leads)} leads — SendKit campaign is a DRAFT, start it there`, "good"); poll(campId); }
      else toast(r.error || "Push failed", "bad");
    } catch { toast("Push failed", "bad"); }
    setPushing(false);
  }

  // Delete a whole campaign run (its doc + every per-seed row). Anything already pushed to SendKit
  // lives there independently and is untouched. `fromList` decides where we land + what to refresh.
  async function deleteCampaign(id, seeds, fromList) {
    if (deleting) return;
    if (!window.confirm(
      `Delete this campaign run permanently?\n\n${num(seeds)} seed domain${seeds === 1 ? "" : "s"} and all their results will be removed. ` +
      `Anything already pushed to SendKit stays there — only this engine record is deleted.\n\nThis cannot be undone.`
    )) return;
    setDeleting(id);
    try {
      const r = await del(`/api/campaign/${id}`);
      if (r.ok) {
        toast("Campaign deleted", "good");
        if (!fromList) { clearTimeout(timer.current); setView("list"); setCampaign(null); setResults([]); }
        loadHistory();
      } else toast(r.error || "Delete failed", "bad");
    } catch { toast("Delete failed", "bad"); }
    setDeleting(null);
  }

  async function stopRun() {
    try {
      const r = await post(`/api/campaign/${campId}/stop`, {});
      if (r.ok) { toast("Stopped — unfinished seeds stay retryable", "good"); poll(campId); }
      else toast(r.error || "Stop failed", "bad");
    } catch { toast("Stop failed", "bad"); }
  }

  async function resumeRun() {
    if (resuming) return;
    setResuming(true);
    try {
      const r = await post(`/api/campaign/${campId}/resume`, {});
      if (r.ok) { toast(`Resumed — ${num(r.resumed)} to process, ${num(r.alreadySettled)} kept`, "good"); poll(campId); }
      else toast(r.error || "Resume failed", "bad");
    } catch { toast("Resume failed", "bad"); }
    setResuming(false);
  }

  async function backfillContacts() {
    if (backfilling) return;
    setBackfilling(true);
    try {
      const r = await post(`/api/campaign/${campId}/backfill-contacts`, {});
      if (r.ok) { toast(`Filled ${num(r.companiesFilled)} companies with ${num(r.contactsAdded)} of our own leads`, r.companiesFilled ? "good" : "info"); poll(campId); }
      else toast(r.error || "Backfill failed", "bad");
    } catch { toast("Backfill failed", "bad"); }
    setBackfilling(false);
  }

  // Company enrichment: for a blacklist-only run, run Prospeo on the "qualified" companies (blacklisted
  // infra, contacts weren't requested at run time) to pull their decision-makers + emails.
  async function enrichCompanies(includeDone = false) {
    if (enrichingCompanies) return;
    const n = includeDone ? (stages.done || 0) : (stages.qualified || 0);
    if (!window.confirm(
      `Run Prospeo enrichment on ${num(n)} compan${n === 1 ? "y" : "ies"}${includeDone ? " (re-running already-done ones)" : " with blacklisted infra"}?\n\n` +
      `This spends Prospeo credits (~1 search credit per company + a few email-reveal credits each) and pulls ` +
      `their decision-makers' emails so they can be pushed to SendKit.`
    )) return;
    setEnrichingCompanies(true);
    try {
      const r = await post(`/api/campaign/${campId}/enrich-companies`, { includeDone });
      if (r.ok) { toast(`Enriching ${num(r.queued)} companies — emails will fill in`, "info"); poll(campId); }
      else toast(r.error || "Enrichment failed", "bad");
    } catch { toast("Enrichment failed", "bad"); }
    setEnrichingCompanies(false);
  }

  async function showPreview(email) {
    setPreview({ email, loading: true });
    try {
      const r = await j(`/api/campaign/${campId}/preview?email=${encodeURIComponent(email)}&step=1`);
      setPreview(r.ok ? { email, subject: r.subject, body: r.body } : { email, error: r.error });
    } catch { setPreview({ email, error: "preview failed" }); }
  }

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

  const loadHistory = useCallback(() => {
    j(`/api/campaign?page=${histPage}&size=${histSize}`)
      .then((d) => { setHistory(d.items || []); setHistCount(d.count || 0); })
      .catch(() => {});
  }, [histPage, histSize]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Debounced so typing doesn't fire a query per keystroke against a 22k-row collection.
  useEffect(() => { const t = setTimeout(() => { setDebouncedResQ(resQ); setResPage(0); }, 300); return () => clearTimeout(t); }, [resQ]);

  const poll = useCallback(function p(id) {
    clearTimeout(timer.current);
    const qs = `page=${resPage}&size=${resSize}&q=${encodeURIComponent(debouncedResQ)}`;
    Promise.all([j(`/api/campaign/${id}`), j(`/api/campaign/${id}/results?${qs}`)]).then(([c, r]) => {
      if (!c || c.error) return;
      setCampaign(c); setResults(r.items || []); setResCount(r.count || 0);
      // ETA from the processing rate (seeds settled per second) between polls.
      if (c.status === "running" && c.seedCount) {
        const now = Date.now(), prev = rateRef.current;
        const done = c.discovered ?? c.processed;   // discovery is the throughput signal
        if (!prev.at) rateRef.current = { at: now, processed: done };
        else if (done > prev.processed) {
          const rate = (done - prev.processed) / ((now - prev.at) / 1000); // seeds/sec
          const remaining = Math.max(0, c.seedCount - done);
          if (rate > 0) {
            const secs = Math.round(remaining / rate);
            setEtaText(secs > 90 ? `~${Math.ceil(secs / 60)} min left` : `~${secs}s left`);
          }
          // Hold the anchor for 20s rather than 4s: a slow run can settle nothing between two 1.5s
          // polls, and a baseline that keeps resetting never accumulates enough movement to divide.
          if (now - prev.at > 20000) rateRef.current = { at: now, processed: done };
        // functional form: `etaText` isn't a dep of this callback, so reading it would give the
        // first render's value and overwrite a good estimate on every stalled poll.
        } else setEtaText((cur) => cur || "measuring…");
      } else setEtaText("");
      if (c.status === "running") timer.current = setTimeout(() => p(id), 1500);
      else loadHistory();
    }).catch(() => {});
  }, [loadHistory, resPage, resSize, debouncedResQ]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Paging/searching an open campaign refetches it. campId is read through a ref-free guard: poll()
  // already carries the id, so this only fires once a campaign is actually open.
  useEffect(() => { if (campId) poll(campId); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [resPage, resSize, debouncedResQ]);

  const openCampaign = useCallback((id) => {
    setView("detail"); setCampaign(null); setResults([]); setResCount(0); setOpenRow(null);
    setResPage(0); setResQ(""); setDebouncedResQ(""); setEtaText("");
    rateRef.current = { at: 0, processed: 0 };
    j(`/api/campaign/${id}/contacts-count`).then((d) => setContacts(d.contacts || 0)).catch(() => setContacts(0));
    poll(id);
  }, [poll]);

  async function start() {
    if (!seeds.trim() || starting) return;
    setStarting(true);
    try {
      const r = await post("/api/campaign", { seeds, countGate: +countGate, blacklistGate: +blacklistGate, enrich, guess });
      if (r.error) { toast(r.error, "bad"); setStarting(false); return; }
      toast(`Campaign started — ${num(r.seedCount)} seeds${r.excluded ? ` · ${num(r.excluded)} non-ICP excluded` : ""}`, "info");
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
            <label className="resn" style={{ display: "flex", alignItems: "center", gap: 6 }}
              title="ON: after a domain clears both gates, run Prospeo to pull its decision-makers + emails (spends Prospeo credits). OFF: just tell me which seed domains have blacklisted infra — no contacts, no Prospeo — for when you already have their emails.">
              <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} />
              Find contacts (Prospeo)
            </label>
            <label className="resn" style={{ display: "flex", alignItems: "center", gap: 6 }}
              title="ON: per seed, also guess extra domains (prefix/suffix + brand, e.g. tryacme.com) and only keep the ones DNS + an HTTP check confirm actually redirect to the seed. No credits, but slower per seed and coverage is low — most of a company's real footprint isn't brand-name-shaped and only host.io's index knows it. Every domain found this way is tagged 'guessed' so it's never confused with host.io's real list.">
              <input type="checkbox" checked={guess} onChange={(e) => setGuess(e.target.checked)} />
              Also guess extra domains
            </label>
            <button className="btn" disabled={starting || !seeds.trim()} onClick={start}>
              <Icon name={starting ? "refresh" : "spark"} />{starting ? "Starting…" : enrich ? "Run campaign" : "Run (blacklist only)"}
            </button>
          </div>
        </div>

        <div className="section-t"><Icon name="refresh" />Campaigns</div>
        {history.length ? (
          <div className="tablewrap">
            <table>
              <thead><tr><th>Started</th><th>Seeds</th><th>Status</th><th>Gates</th><th>Pushed to</th><th /></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h._id} className="click" onClick={() => openCampaign(h._id)}>
                    <td className="tstamp">{ts(h.createdAt)}</td>
                    <td className="num-c">{num(h.seedCount)}</td>
                    <td><span className={`pill ${h.status === "running" ? "p-review" : h.status === "error" ? "p-review" : "p-verified"}`}>
                      {h.status === "running" ? <><span className="spin" style={{ width: 11, height: 11 }} /> {h.stage}</> : h.status}</span></td>
                    <td className="sm muted">count ≥ {h.gates?.countGate} · blacklisted ≥ {h.gates?.blacklistGate}</td>
                    <td>
                      {h.sendkitCampaignId ? (
                        <span className="pill p-verified" title={`${num(h.sendkitLeadCount || 0)} leads pushed · draft in SendKit`}>
                          <Icon name="check" style={{ width: 11, height: 11 }} />{wsLabel(h.sendkitWorkspaceId)}{h.sendkitLeadCount ? ` · ${num(h.sendkitLeadCount)}` : ""}
                        </span>
                      ) : <span className="muted sm">not pushed</span>}
                    </td>
                    <td className="num-c">
                      <button className="btn btn-ghost btn-sm" disabled={deleting === h._id}
                        onClick={(e) => { e.stopPropagation(); deleteCampaign(h._id, h.seedCount, true); }}
                        title="Delete this campaign run and all its results (SendKit is untouched)">
                        <Icon name={deleting === h._id ? "refresh" : "trash"} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="tablewrap"><div className="empty"><Icon name="spark" /><b>No campaigns yet</b>Paste domains above and run one.</div></div>
        )}
        {histCount > histSize || histPage > 0
          ? <Pager count={histCount} page={histPage} setPage={setHistPage} size={histSize} setSize={setHistSize} />
          : null}
      </>
    );
  }

  // ── DETAIL VIEW ──────────────────────────────────────────────────────────────────────────────
  const stages = campaign?.stages || {};
  // Seeds a resume would pick up: anything without a real verdict. Errors are transient (a blocked
  // scrape, a failed API page), so they stay retryable however the run as a whole ended.
  const retryable = (stages.error || 0) + (stages.interrupted || 0);
  return (
    <>
      <div className="toolbar">
        <button className="btn btn-ghost btn-sm" onClick={() => { clearTimeout(timer.current); setView("list"); loadHistory(); }}><Icon name="back" />All campaigns</button>
        {campaign ? <span className="resn">{running ? <><span className="spin" /> <b>{campaign.stage}</b></> : <b>done</b>} · {num(campaign.seedCount)} seeds</span> : null}
        <div className="grow" />
        {/* A run finishes "done" even when seeds errored — a host.io block left 4,764 of 6,140 in
            error on one run — so gate Resume on there being retryable seeds, not on the status. */}
        {campaign && running ? (
          <button className="btn btn-ghost btn-sm" onClick={stopRun}
            title="Stops the run. Seeds without a verdict stay retryable, so a later Resume continues from here.">
            <Icon name="close" />Stop
          </button>
        ) : null}
        {campaign && !running && (retryable > 0 || campaign.status !== "done") ? (
          <button className="btn btn-ghost btn-sm" disabled={resuming} onClick={resumeRun}
            title="Reprocesses only the seeds without a final verdict — already-enriched companies keep their result">
            <Icon name={resuming ? "refresh" : "sync"} />
            {resuming ? "Resuming…" : retryable > 0 ? `Retry ${num(retryable)} failed` : "Resume"}
          </button>
        ) : null}
        {campaign?.sendkitCampaignId ? (
          <span className="resn" style={{ color: "var(--good)" }}>
            <Icon name="check" />pushed to SendKit ({num(campaign.sendkitLeadCount || 0)} leads) · draft
          </span>
        ) : null}
        {stages.qualified && !running ? (
          <button className="btn btn-ghost btn-sm" disabled={enrichingCompanies} onClick={() => enrichCompanies(false)}
            title="Run Prospeo on the qualified blacklisted-infra companies to pull decision-makers + emails. Spends Prospeo credits.">
            <Icon name={enrichingCompanies ? "refresh" : "mail"} />{enrichingCompanies ? "Enriching…" : `Company enrichment (${num(stages.qualified)})`}
          </button>
        ) : !running && stages.done ? (
          <button className="btn btn-ghost btn-sm" disabled={enrichingCompanies} onClick={() => enrichCompanies(true)}
            title="Re-run Prospeo on the already-done companies (e.g. an old run enriched before this existed, or to refresh contacts). Spends Prospeo credits.">
            <Icon name={enrichingCompanies ? "refresh" : "mail"} />{enrichingCompanies ? "Enriching…" : `Re-enrich contacts (${num(stages.done)})`}
          </button>
        ) : null}
        {resCount && !running ? (
          <button className="btn btn-ghost btn-sm" disabled={backfilling} onClick={backfillContacts}
            title="For companies Prospeo found nobody at, use our own hot/warm engagers on that domain. Free — no Prospeo credits.">
            <Icon name={backfilling ? "refresh" : "users"} />{backfilling ? "Filling…" : "Fill from our leads"}
          </button>
        ) : null}
        {resCount && !running ? (
          <button className="btn btn-ghost btn-sm" disabled={pushing} onClick={pushToSendkit}
            title="Creates a DRAFT SendKit campaign with the blacklist sequence + per-lead variables. Nothing is sent.">
            <Icon name={pushing ? "refresh" : "mega"} />{pushing ? "Pushing…" : "Push to SendKit"}
          </button>
        ) : null}
        {resCount ? (
          <>
            {/* the exact rows that go to SendKit — same payload, same variables */}
            <a className="btn btn-ghost btn-sm" href={`/api/campaign/${campId}/csv`} download>
              <Icon name="download" />Campaign CSV
            </a>
            <a className="btn btn-ghost btn-sm" href={`/api/campaign/${campId}/results.csv`} download>
              <Icon name="download" />Full report
            </a>
          </>
        ) : null}
        {campaign && campId ? (
          <button className="btn btn-ghost btn-sm" style={{ color: "var(--hot)" }} disabled={deleting === campId}
            onClick={() => deleteCampaign(campId, campaign.seedCount, false)}
            title="Delete this campaign run and all its results. Anything already pushed to SendKit is untouched.">
            <Icon name={deleting === campId ? "refresh" : "trash"} />{deleting === campId ? "Deleting…" : "Delete"}
          </button>
        ) : null}
      </div>

      {campaign && running ? (
        <div className="jobbox on" style={{ marginBottom: "var(--s4)" }}>
          <div className="jobh">
            <span className="spin" />
            <span>
              Scanned <b>{num(campaign.discovered ?? campaign.processed ?? 0)}</b> / {num(campaign.seedCount)}
              {sum(stages, ["enrich_queued", "enriching"]) ? <> · <b>{num(sum(stages, ["enrich_queued", "enriching"]))}</b> awaiting contacts</> : null}
              {" · "}<b className="ok">{num(sum(stages, ["done"]))}</b> prospects
              {" · host.io API used "}<b>{num(campaign.apiCallsUsed || 0)}</b>
              {etaText ? <> · <b>{etaText}</b></> : null}
            </span>
          </div>
          <div className="prog on"><i style={{ width: `${campaign.seedCount ? Math.max(2, Math.round(((campaign.discovered ?? campaign.processed) / campaign.seedCount) * 100)) : 2}%` }} /></div>
          {campaign.active?.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {campaign.active.map((a) => (
                <span key={a.seed} className="pill p-review" style={{ fontSize: 11 }}>
                  <span className="spin" style={{ width: 9, height: 9 }} />{a.seed} · {a.activity || a.stage}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

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

      {campaign ? (
        <div className="toolbar">
          <input className="search" style={{ maxWidth: 300 }} placeholder="Search a seed domain…"
            value={resQ} onChange={(e) => setResQ(e.target.value)} />
          {resQ ? <button className="btn btn-ghost btn-sm" onClick={() => setResQ("")}><Icon name="x" />Clear</button> : null}
          <div className="grow" />
          <span className="resn"><b>{num(resCount)}</b> seed{resCount === 1 ? "" : "s"}{debouncedResQ ? " matching" : ""}</span>
        </div>
      ) : null}

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
                              {r.guessedChecked ? <span title="Extra domains we guessed (prefix/suffix + brand), DNS + redirect-confirmed before being checked"> ({num(r.guessedConfirmed)} of {num(r.guessedChecked)} guessed candidates confirmed)</span> : null}
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
                                      <span
                                        className="tag-pers"
                                        title={d.source === "guessed"
                                          ? "Not in host.io's index — we guessed this domain (prefix/suffix + brand) and DNS + an HTTP redirect check confirmed it actually redirects here"
                                          : "Came straight from host.io's real reverse-redirect index"}
                                        style={d.source === "guessed" ? { background: "var(--warm-soft)", color: "var(--warm)" } : undefined}
                                      >
                                        {d.source === "guessed" ? "guessed" : "host.io"}
                                      </span>
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
                                        <td>
                                          <b className="sm">{p.name || "—"}</b>
                                          {p.source === "gtm-lead" ? <span className="tag-pers" title="From our own hot/warm engagers, not Prospeo">our lead</span> : null}
                                        </td>
                                        <td className="sm muted">{p.job_title || "—"}</td>
                                        <td className="sm muted">{p.department || ""}</td>
                                        <td className="sm">{p.email
                                          ? <span className="mono" style={{ color: p.email_status === "VERIFIED" ? "var(--good)" : "var(--ink)" }}>{p.email}</span>
                                          : r.emailsRevealed ? <span className="muted">—</span> : <span className="muted">hidden</span>}</td>
                                        <td>{p.linkedin_url ? <a href={p.linkedin_url} target="_blank" rel="noopener" className="sm">in ↗</a> : null}</td>
                                        <td>{p.email && campaign?.sendkitCampaignId ? (
                                          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); showPreview(p.email); }} title="See the exact personalized email (nothing is sent)">
                                            <Icon name="mail" />preview
                                          </button>
                                        ) : null}</td>
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
          <Pager count={resCount} page={resPage} setPage={setResPage} size={resSize} setSize={setResSize} />
        </>
      ) : campaign && !running ? (
        <div className="tablewrap"><div className="empty"><Icon name="search" /><b>{debouncedResQ ? "No seed matches that search" : "No qualifying prospects"}</b>{debouncedResQ ? "Try a different domain." : "No company passed both gates. Try lowering the thresholds."}</div></div>
      ) : null}

      {preview ? (
        <>
          <div className="drawer-scrim" onClick={() => setPreview(null)} />
          <div className="drawer open">
            <span className="x" onClick={() => setPreview(null)}><Icon name="x" style={{ width: 20, height: 20, stroke: "var(--dim)" }} /></span>
            <h3>Email preview</h3>
            <div className="muted mono" style={{ fontSize: 11 }}>{preview.email} · nothing is sent</div>
            {preview.loading ? <div className="loading"><span className="spin" />Rendering…</div>
              : preview.error ? <div className="note bad" style={{ marginTop: 14 }}><Icon name="warn" /><div>{preview.error}</div></div>
              : (
                <div style={{ marginTop: "var(--s4)" }}>
                  <div className="resn" style={{ marginBottom: 6 }}><b>Subject:</b> {preview.subject}</div>
                  <div className="card" style={{ padding: "var(--s4)", fontSize: 13, lineHeight: 1.55 }}
                    dangerouslySetInnerHTML={{ __html: preview.body || "" }} />
                </div>
              )}
          </div>
        </>
      ) : null}
    </>
  );
}
