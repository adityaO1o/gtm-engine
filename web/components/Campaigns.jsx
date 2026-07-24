"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { num } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useDash } from "@/lib/ctx";
import { useToast } from "@/lib/toast";
import { useLeadList } from "@/hooks/useLeadList";
import { useKeywordRun, KeywordRunBox } from "./KeywordRun";
import LeadToolbar from "./LeadToolbar";
import LeadTable from "./LeadTable";
import Pager from "./Pager";
import JobBox from "./JobBox";

const METRICS = { total: "Leads", verified: "Verified", hot: "Hot", warm: "Warm", cold: "Cold", noEmail: "No-email", recovered: "Recovered", review: "Review", competitor: "Competitors", unverified: "Unverified", verifyRate: "Verify rate %" };

// Keyword sweep — lives on the Campaigns tab because it is a CAMPAIGN-wide job: it walks every
// (unpaused) campaign's keywords and feeds each campaign from its own keywords. Pausing a campaign
// below removes it from this sweep, so the two controls sit together.
// (A one-off run of a single keyword you type — with routing you choose — is the "Manual keyword
// scrape" box on the Sources tab.)
function KeywordSweep() {
  const toast = useToast();
  const { status: sweep, start, pause: doPause } = useKeywordRun("/api/keywords/sweep");

  const run = async () => {
    if (!window.confirm("Search this week's posts for every campaign keyword and scrape their engagers?\n\nPosts already scraped are skipped unless they've grown — that check is free. Small posts are skipped too.")) return;
    const r = await start({});
    // The server now reports a rejected start honestly (shared lock with the manual run, or a
    // single-post scrape in progress) instead of it looking like success.
    if (r?.alreadyRunning) {
      toast(r.busyWith === "scrape-post" ? "A post scrape is running — pause it first" : "A keyword run is already going", "bad");
      return;
    }
    if (r?.error) return toast(r.error, "bad");
    toast("Keyword sweep started", "info");
  };
  const pause = async () => { await doPause(); toast("Pausing after the current post…", "info"); };

  return (
    <div className="chartbox" style={{ marginBottom: "var(--s3)", borderTop: "2px solid var(--primary)" }}>
      <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}><Icon name="search" />Keyword sweep</h4><div className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>replaces the Trigify workflows</span></div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Finds this week&rsquo;s posts for every campaign keyword and scrapes their engagers into that campaign.
        Posts already done are skipped unless they&rsquo;ve <b>grown</b> — and that check costs nothing, because the search
        returns each post&rsquo;s engagement counts. Only the new engagers get enriched. Paused campaigns are skipped.
      </div>
      <div className="toolbar">
        {sweep?.running
          ? <button className="btn btn-ghost btn-sm" onClick={pause}><Icon name="pause" />Pause sweep</button>
          : <button className="btn btn-sm" onClick={run}><Icon name="bolt" />Run keyword sweep</button>}
        {sweep?.running ? <span className="muted" style={{ fontSize: 12 }}>{sweep.phase === "scraping" ? "scraping" : "searching"} &middot; <b>{sweep.keyword}</b> &rarr; {sweep.campaign}</span> : null}
      </div>
      <KeywordRunBox s={sweep} done={sweep?.keywordsDone} total={sweep?.totalKeywords} runningLabel="Sweeping" />
    </div>
  );
}

function CampaignList({ campaigns, onOpen }) {
  if (!campaigns.length) return <div className="tablewrap"><div className="empty"><Icon name="mega" /><b>No campaigns yet</b>Leads will appear here as posts flow in.</div></div>;
  return (
    <div className="tablewrap"><table><thead><tr>
      <th>Campaign</th><th>Leads</th><th>Hot</th><th>Warm</th>
      <th title="Verified lead records (one per LinkedIn profile)">Verified</th>
      <th title="Distinct email addresses — this is what SendKit holds.">In SendKit</th>
      <th>No-email</th><th title="Emails rescued by a hand-off retry">Recovered</th><th>Competitors</th>
      <th title="On SendKit's Do-Not-Contact list">DNC</th><th>Trigify</th><th>Prospeo</th></tr></thead>
      <tbody>{campaigns.map((c) => (
        <tr key={c.campaign} className="click" onClick={() => onOpen(c.campaign)}>
          <td className="nm">{c.label}</td><td className="score">{num(c.total)}</td><td>{num(c.hot)}</td><td>{num(c.warm)}</td>
          <td className="num-c" style={{ color: "var(--good)" }}>{num(c.verified)}</td>
          <td className="num-c" style={{ color: "var(--primary-2)", fontWeight: 600 }}>{num(c.verifiedEmails ?? c.verified)}</td>
          <td>{num(c.noEmail)}</td><td className="num-c" style={{ color: "var(--good)" }}>{num(c.recovered || 0)}</td><td>{num(c.competitor)}</td>
          <td className="num-c" style={{ color: "var(--hot)", fontWeight: 600 }}>{num(c.dnc || 0)}</td>
          <td className="num-c">{num(c.credits.trigify)}</td><td className="num-c">{num(c.credits.prospeo)}</td>
        </tr>
      ))}</tbody></table></div>
  );
}

function CampaignDetail({ campaign, label, onBack }) {
  const { openLead, openReverify, jobs, pollJobs, campaigns, refreshTop } = useDash();
  const toast = useToast();
  const [s, setS] = useState({});
  const [cardMetrics, setCardMetrics] = useState(["total", "verified", "hot", "noEmail"]);
  const [msg, setMsg] = useState("");
  const L = useLeadList({ campaign });

  useEffect(() => {
    j("/api/stats?campaign=" + encodeURIComponent(campaign)).then((d) => {
      d.verifyRate = d.total ? Math.round((d.verified / d.total) * 100) : 0;
      setS(d);
    });
  }, [campaign]);

  const setCard = (i, v) => setCardMetrics((m) => m.map((x, idx) => (idx === i ? v : x)));
  const exportFiltered = () => { const p = L.query(); p.delete("limit"); p.delete("skip"); window.location = "/api/export?" + p.toString(); };
  const exportSelected = () => { if (!L.selected.size) return; window.location = "/api/export?urls=" + [...L.selected].map(encodeURIComponent).join(","); };

  // Pause/resume lead GENERATION for this campaign — the keyword sweep skips it while paused.
  // It does not stop SendKit sending to people already in the campaign; that lives in SendKit.
  const isPaused = !!campaigns.find((c) => c.campaign === campaign)?.paused;
  async function togglePause() {
    const next = !isPaused;
    const r = await post(`/api/campaigns/${encodeURIComponent(campaign)}/pause`, { paused: next });
    if (r.ok) {
      setMsg(next ? "✓ Paused — the keyword sweep will skip this campaign. SendKit sending is unchanged." : "✓ Resumed — the keyword sweep will search for it again.");
      toast(next ? "Campaign paused" : "Campaign resumed", "good");
      refreshTop();
    } else {
      setMsg("Failed: " + (r.error || ""));
      toast("Failed", "bad");
    }
  }
  async function sync() { await post("/api/sync", { campaign }); toast("SendKit sync started", "info"); pollJobs(); }

  return (
    <>
      <div className="toolbar">
        <button className="btn btn-ghost btn-sm" onClick={onBack}><Icon name="back" />All campaigns</button>
        <div className="grow" />
        <button className="btn btn-ghost btn-sm" onClick={sync}><Icon name="sync" />Sync SendKit</button>
        <button className="btn btn-ghost btn-sm" onClick={togglePause}
          title={isPaused ? "Resume finding new leads for this campaign" : "Stop the keyword sweep finding new leads for this campaign (SendKit sending is unaffected)"}>
          <Icon name={isPaused ? "bolt" : "pause"} />{isPaused ? "Resume" : "Pause"}</button>
      </div>
      <div className="muted" style={{ fontSize: 12, margin: "-4px 0 0" }}>{msg}</div>
      <div style={{ margin: "0 0 var(--s3)" }}><JobBox kind="sync" s={jobs.sync} /></div>
      <div className="grid g-cred">
        {cardMetrics.map((mk, i) => (
          <div key={i} className="card pri">
            <div className="kh"><select value={mk} onChange={(e) => setCard(i, e.target.value)}>{Object.entries(METRICS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div className="v">{num(s[mk])}</div>
          </div>
        ))}
      </div>
      <LeadToolbar filters={L.filters} setFilter={L.setFilter} count={L.data.count} campaigns={[]} withCampaign={false}
        selectedSize={L.selected.size} onSelectPage={L.selectPage} onExportFiltered={exportFiltered} onExportSelected={exportSelected} />
      <LeadTable rows={L.data.rows} loading={L.loading} selected={L.selected} toggle={L.toggle} toggleAll={L.toggleAll} onRowClick={openLead} onReverify={openReverify} sort={L.filters.sort} onSort={(f) => L.setFilter("sort", f)} />
      <Pager count={L.data.count} page={L.page} setPage={L.setPage} size={L.size} setSize={L.setSize} />
    </>
  );
}

export default function Campaigns() {
  const { campaigns, pendingCampaign, clearPending } = useDash();
  const [active, setActive] = useState(null);
  useEffect(() => { if (pendingCampaign) { setActive(pendingCampaign); clearPending(); } }, [pendingCampaign, clearPending]);
  if (active) {
    const c = campaigns.find((x) => x.campaign === active);
    return <CampaignDetail campaign={active} label={c?.label || active} onBack={() => setActive(null)} />;
  }
  return (
    <>
      <KeywordSweep />
      <CampaignList campaigns={campaigns} onOpen={setActive} />
    </>
  );
}
