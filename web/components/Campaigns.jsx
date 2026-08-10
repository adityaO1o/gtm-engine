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
  const [showLogs, setShowLogs] = useState(false);
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
      <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}><Icon name="search" />Keyword sweep</h4><div className="grow" /></div>
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
        <div className="grow" />
        <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs((v) => !v)}><Icon name="radio" />{showLogs ? "Hide logs" : "Logs"}</button>
      </div>
      <KeywordRunBox s={sweep} done={sweep?.keywordsDone} total={sweep?.totalKeywords} runningLabel="Sweeping" />
      {showLogs ? <PndDailyLog /> : null}
    </div>
  );
}

// PND credit "days log" — how many credits every scraping surface spent, per calendar day.
// Sits under the sweep because the sweep is the biggest daily spender, but the totals here cover
// every path (keyword, manual, hub, influencer, imported-list).
const KIND_LABEL = { keyword: "sweep", manual: "manual", hub: "hubs", influencer: "influencers", post: "single-post" };
function PndDailyLog() {
  const [days, setDays] = useState([]);
  useEffect(() => { j("/api/pnd/daily?days=14").then((r) => setDays(r?.days || [])).catch(() => {}); }, []);
  if (!days.length) return null;
  return (
    <div style={{ marginTop: "var(--s3)" }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}><b>PND credits per day</b> — every scrape path, newest first. “Saved” = engager lookups served free from cache.</div>
      <div className="tablewrap" style={{ border: "none" }}><table><thead><tr>
        <th>Day</th><th title="Engager-list pages (likers/commenters)">Scrape</th><th title="Paid profile lookups">Profile</th>
        <th title="Paid company lookups">Company</th><th>Total</th><th title="Cache hits — credits NOT spent">Saved</th><th>By surface</th></tr></thead>
        <tbody>{days.map((d) => (
          <tr key={d.day}>
            <td className="nm">{d.day}</td>
            <td className="num-c">{num(d.scrape)}</td><td className="num-c">{num(d.profile)}</td><td className="num-c">{num(d.company)}</td>
            <td className="num-c" style={{ color: "var(--primary-2)", fontWeight: 600 }}>{num(d.total)}</td>
            <td className="num-c" style={{ color: "var(--good)" }}>{d.cacheSaved ? num(d.cacheSaved) : "—"}</td>
            <td><span className="muted" style={{ fontSize: 11 }}>{Object.entries(d.kinds || {}).filter(([, v]) => v).map(([k, v]) => `${KIND_LABEL[k] || k} ${num(v)}`).join(" · ") || "—"}</span></td>
          </tr>
        ))}</tbody></table></div>
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
      <th title="On SendKit's Do-Not-Contact list">DNC</th><th>Prospeo</th>
      <th title="PND credits spent scraping engagers into this campaign">PND cr</th></tr></thead>
      <tbody>{campaigns.map((c) => (
        <tr key={c.campaign} className="click" onClick={() => onOpen(c.campaign)}>
          <td className="nm">{c.label}</td><td className="score">{num(c.total)}</td><td>{num(c.hot)}</td><td>{num(c.warm)}</td>
          <td className="num-c" style={{ color: "var(--good)" }}>{num(c.verified)}</td>
          <td className="num-c" style={{ color: "var(--primary-2)", fontWeight: 600 }}>{num(c.verifiedEmails ?? c.verified)}</td>
          <td>{num(c.noEmail)}</td><td className="num-c" style={{ color: "var(--good)" }}>{num(c.recovered || 0)}</td><td>{num(c.competitor)}</td>
          <td className="num-c" style={{ color: "var(--hot)", fontWeight: 600 }}>{num(c.dnc || 0)}</td>
          <td className="num-c">{num(c.credits.prospeo)}</td>
          <td className="num-c" style={{ color: "var(--primary-2)" }} title={`${num(c.pndPosts || 0)} posts`}>{num(c.pndCredits || 0)}</td>
        </tr>
      ))}</tbody></table></div>
  );
}

function CampaignDetail({ campaign, bucket, label, onBack }) {
  const { openLead, openReverify, jobs, pollJobs, campaigns, refreshTop } = useDash();
  const toast = useToast();
  const [s, setS] = useState({});
  const [cardMetrics, setCardMetrics] = useState(["total", "verified", "hot", "noEmail"]);
  const [msg, setMsg] = useState("");
  const L = useLeadList({ campaign, bucket: bucket || "" });

  useEffect(() => {
    j("/api/stats?campaign=" + encodeURIComponent(campaign) + (bucket ? "&bucket=" + bucket : "")).then((d) => {
      d.verifyRate = d.total ? Math.round((d.verified / d.total) * 100) : 0;
      setS(d);
    });
  }, [campaign, bucket]);

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
        selectedSize={L.selected.size} onSelectAll={() => L.toggleAll(true)} selectingAll={L.selectingAll}
        onSelectPage={L.selectPage} onExportFiltered={exportFiltered} onExportSelected={exportSelected} />
      <LeadTable rows={L.data.rows} loading={L.loading} selected={L.selected} toggle={L.toggle} toggleAll={L.toggleAll} onRowClick={openLead} onReverify={openReverify} sort={L.filters.sort} onSort={(f) => L.setFilter("sort", f)} />
      <Pager count={L.data.count} page={L.page} setPage={L.setPage} size={L.size} setSize={L.setSize} />
    </>
  );
}

// Top level: pick a bucket (1.0 old / 2.0 new). Each drills into the same topic-campaign table,
// scoped to that bucket; a topic then drills into its leads (bucket + topic).
// Two numbers, deliberately shown side by side so they never confuse:
//  • "In SendKit" = the campaign's ACTUAL membership (the real sending list, source of truth).
//  • "Verified (new-era)" = verified emails whose lead was FIRST SEEN in this date window.
// They differ because 2.0 also holds recovered leads first-seen before 27 Jul + any manual SendKit
// adds — so SendKit membership can exceed the date-bucket verified count. Tooltips explain each.
function BucketPicker({ onPick }) {
  const [sum, setSum] = useState(null);
  useEffect(() => { j("/api/campaigns/summary").then((d) => setSum(d.campaigns || [])).catch(() => {}); }, []);
  const byBucket = Object.fromEntries((sum || []).map((c) => [c.bucket, c]));
  const Stat = ({ k, v, title, good, txt }) => (
    <div className="card pri" title={title}><div className="kh">{k}</div>
      <div className="v" style={{ ...(good ? { color: "var(--good)" } : {}), ...(txt ? { fontSize: 14 } : {}) }}>{txt != null ? txt : v != null ? num(v) : "—"}</div></div>
  );
  const Card = ({ b, title, sub }) => {
    const c = byBucket[b] || {}; const sk = c.sendkit || {}; const have = c.have || {};
    return (
      <div className="chartbox click" style={{ cursor: "pointer" }} onClick={() => onPick(b)}>
        <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}><Icon name="mega" />{title}</h4>
          {c.status ? <span className={c.status === "active" ? "tag-harv" : "tag-man"} style={{ marginLeft: 8 }}>{c.status}</span> : null}
          <div className="grow" /><Icon name="external" /></div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{sub}</div>
        <div className="grid g-cred">
          <Stat k="In SendKit" v={sk.inCampaign} title="Actual members in the SendKit campaign — the real sending list (source of truth). Includes recovered leads first-seen before 27 Jul and any manual adds, so it can exceed 'Verified (new-era)'." />
          {b === "2.0"
            ? <Stat k="Sent" v={sk.sent} good title="Emails SendKit has actually sent so far." />
            : <Stat k="Sending" txt="draft" title="This campaign is a draft — not sending yet." />}
          <Stat k="Replied" v={sk.replied} good title="Replies recorded in SendKit." />
        </div>
        <div className="grid g-cred" style={{ marginTop: 8 }}>
          <Stat k="Verified (new-era)" v={have.verified} title="Verified emails the engine collected whose lead was FIRST SEEN in this era (2.0 = 27 Jul onwards, 1.0 = before). A DATE bucket, NOT SendKit membership — which is why it differs from 'In SendKit'." />
          <Stat k="No-email" v={have.noEmail} title="Leads first-seen in this era we couldn't find an email for." />
          <Stat k="Recovered" v={have.recovered} title="No-email leads later rescued by a retry." />
        </div>
      </div>
    );
  };
  return (
    <>
      <div className="note"><Icon name="inbox" /><div><b>In SendKit</b> = real members in the campaign (what actually sends). <b>Verified (new-era)</b> = verified emails first-seen in this date window. They differ because 2.0 also holds recovered leads first-seen before 27 Jul + manual adds — hover any number for its exact meaning.</div></div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "var(--s3)", alignItems: "start" }}>
        <Card b="2.0" title="Cold Email 2.0 — new leads" sub="The current intake — everything routed to 2.0. Click to see it by keyword topic." />
        <Card b="1.0" title="Cold Email 1.0 — old leads" sub="The earlier base (contacted separately). Click to see it by keyword topic." />
      </div>
    </>
  );
}

export default function Campaigns() {
  const { pendingCampaign, clearPending } = useDash();
  const [bucket, setBucket] = useState(null);   // null | "1.0" | "2.0"
  const [active, setActive] = useState(null);    // topic campaign key
  const [rows, setRows] = useState(null);        // topic rows for the picked bucket
  useEffect(() => { if (pendingCampaign) { setActive(pendingCampaign); clearPending(); } }, [pendingCampaign, clearPending]);
  useEffect(() => {
    if (bucket && !active) { setRows(null); j("/api/campaigns?bucket=" + bucket).then((d) => setRows(d.campaigns || [])); }
  }, [bucket, active]);

  if (active) {
    const c = (rows || []).find((x) => x.campaign === active);
    return <CampaignDetail campaign={active} bucket={bucket} label={c?.label || active} onBack={() => setActive(null)} />;
  }
  if (bucket) {
    return (
      <>
        <div className="toolbar"><button className="btn btn-ghost btn-sm" onClick={() => setBucket(null)}><Icon name="back" />1.0 / 2.0</button>
          <div className="grow" /><span className="resn">{bucket === "2.0" ? "Cold Email 2.0 · new leads · by keyword topic" : "Cold Email 1.0 · old leads · by keyword topic"}</span></div>
        {rows === null ? <div className="muted" style={{ padding: 16 }}>Loading…</div> : <CampaignList campaigns={rows} onOpen={setActive} />}
      </>
    );
  }
  return (<><KeywordSweep /><BucketPicker onPick={setBucket} /></>);
}
