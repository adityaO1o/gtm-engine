"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { num, ts } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useDash } from "@/lib/ctx";
import { useToast } from "@/lib/toast";
import { useKeywordRun, KeywordRunBox } from "./KeywordRun";
import JobBox from "./JobBox";

const SCR_PHASE = { working: "Scraping + finding emails", done: "Done", paused: "Paused", stopped: "Stopped", error: "Error" };
// Which job scraped a post — shown as a badge so auto-scraped posts aren't mistaken for manual ones.
const SRC_KIND = { keyword: "sweep", "keyword-manual": "manual", manual: "manual", influencer: "influencer", hub: "hub", post: "single" };

// Every topic (Smartlead, GTM, …) now routes into the ONE intake campaign — Cold Email 2.0. The
// `campaign` value stored on a scrape/post is just the keyword bucket used for reporting, NOT the
// destination. So show the real destination (2.0, or 1.0 when explicitly chosen) and surface the
// matched keyword as a chip, instead of making it look like leads go into a per-topic campaign.
function RouteTag({ campaign }) {
  if (!campaign) return <span className="muted">—</span>;
  const c = String(campaign);
  if (c.includes("2.0")) return <b>Cold Email 2.0</b>;
  if (c.includes("1.0")) return <b>Cold Email 1.0</b>;
  return <><b>Cold Email 2.0</b> <span className="tag-harv" title="Keyword/topic that matched this post — the leads route into Cold Email 2.0">kw: {c}</span></>;
}

function ScrapeBox({ s, onPause, onResume }) {
  if (!s || !s.postUrl || !s.phase || s.phase === "idle") return null;
  const id = (String(s.postUrl).match(/activity[:-](\d+)/) || [])[1] || s.postUrl.slice(-24);
  const icon = s.running ? "refresh" : s.phase === "paused" ? "pause" : s.phase === "done" ? "check" : "warn";
  const denom = s.expected || s.total || 0;
  const pct = denom ? Math.min(100, Math.round((s.enriched / denom) * 100)) : 0;
  const Stat = ({ l, v, cls }) => <span className="scstat"><b className={cls || ""}>{num(v)}</b>{l}</span>;
  return (
    <div className={`jobbox${s.running ? " on" : ""}`}>
      <div className="jobh"><Icon name={icon} /><span><b>{SCR_PHASE[s.phase] || s.phase}</b> <span className="mono muted">activity:{id}</span>{s.campaign ? <> → <RouteTag campaign={s.campaign} /></> : null}</span></div>
      <div className="scrow">
        <Stat l="engagers scraped" v={s.total} />
        <Stat l="processed" v={s.enriched} />
        <Stat l="verified & sent" v={s.sent} cls="ok" />
        <span className="scstat"><b>{pct}%</b>done{s.expected ? ` of ~${num(s.expected)}` : ""}</span>
        {s.outOfCredits ? <span className="scstat"><b style={{ color: "var(--hot)" }}>Fresh</b>out of credits</span> : null}
      </div>
      <div className={`prog${s.running ? " on" : ""}`}><i style={{ width: `${Math.max(pct, s.running ? 3 : 0)}%` }} /></div>
      {s.running ? <div className="toolbar" style={{ marginTop: 8 }}><button className="btn btn-ghost btn-sm" onClick={onPause}><Icon name="pause" />Pause</button></div>
        : s.phase !== "done" ? <div className="toolbar" style={{ marginTop: 8 }}><button className="btn btn-sm" onClick={() => onResume(s.postUrl)}><Icon name="bolt" />Resume</button></div> : null}
    </div>
  );
}

// A post URL's own slug is human-readable — "penn-frank_quite-a-few-people-have-asked-how-we-handle"
// beats falling back to "activity:—", which is what a row showed whenever the title lookup hadn't
// landed. Free, offline, and always available, so the title fetch is a bonus rather than the only
// thing standing between you and knowing which post this is.
function labelFromUrl(u = "") {
  const m = String(u).match(/\/posts\/([^/?]+)/);
  if (!m) return null;
  const raw = decodeURIComponent(m[1]).replace(/-(?:activity|share|ugcPost)-\d{15,25}.*$/, "");
  const [who, ...rest] = raw.split("_");
  const text = rest.join(" ").replace(/-/g, " ").trim();
  const name = who.replace(/-\w{6,}$/, "").replace(/-/g, " ").trim();
  return text ? `${name} — ${text}` : name || null;
}

function ScrapedPosts({ onResume, busy }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(25);
  const [data, setData] = useState({ posts: [], total: 0 });
  useEffect(() => {
    if (!open) return;
    j(`/api/sources/scraped-posts?skip=${page * size}&limit=${size}`).then((d) => setData({ posts: d.posts || [], total: d.total || 0 })).catch(() => {});
  }, [open, page, size]);
  const { posts, total } = data;
  const from = total ? page * size + 1 : 0, to = Math.min(total, (page + 1) * size), last = Math.max(0, Math.ceil(total / size) - 1);
  return (
    <div className="chartbox" style={{ marginBottom: "var(--s3)" }}>
      <div className="toolbar" style={{ marginBottom: open ? "var(--s3)" : 0 }}>
        <h4 style={{ margin: 0 }}><Icon name="check" />Scraped posts <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>· live counts</span></h4>
        <div className="grow" />
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Expand"}</button>
      </div>
      {open ? (<>
      <div className="tablewrap" style={{ border: "none" }}>
        <table><thead><tr><th>Post</th><th>Campaign</th><th>Engagers</th><th>Verified</th><th>No-email</th><th>Unverified</th><th title="verified ÷ engagers">Hit</th><th title="PND credits this post cost: scrape pages + paid profile/company lookups">PND cr</th><th>When</th><th></th></tr></thead>
          <tbody>{posts.map((p) => {
            const hit = p.engagers ? Math.round((p.verified / p.engagers) * 100) : 0;
            const label = p.title || labelFromUrl(p.postUrl) || p.posterName || ("activity:" + (p.activityId || "—"));
            // The target is what's REACHABLE, not what LinkedIn's counter says. LinkedIn counts
            // replies-to-comments in its comment total but the API only returns top-level
            // commenters, so a post reading "11 reactions, 6 comments" has 14 people to scrape, not
            // 17 — and using 17 made a complete scrape look like it lost 3.
            const reachable = (p.expectedReactions || 0) + (p.commentsAvailable ?? p.expectedComments ?? 0);
            const inflated = p.commentsAvailable != null && p.expectedComments != null && p.expectedComments > p.commentsAvailable;
            return (
              <tr key={p.postUrl}>
                <td>
                  <a href={p.postUrl} target="_blank" rel="noopener" className="postlink" title={p.postUrl}>{label}<Icon name="external" /></a>
                  {p.sourceKind ? <span className="tag-harv" title="Which job scraped this post">{SRC_KIND[p.sourceKind] || p.sourceKind}</span> : null}
                  {p.partial ? <span className="tag-man" style={{ color: "var(--hot)" }} title={p.partialReason || "This scrape is incomplete — re-scrape with the post's /feed/update/urn:li:activity:… URL"}>partial</span> : null}
                  {p.commentsSkipped ? <span className="tag-man" title={p.commentsSkipReason || "Commenters were not scraped for this post"}>likers only</span> : null}
                </td>
                <td><RouteTag campaign={p.campaign} /></td>
                <td className="num-c">
                  {num(p.engagers)}
                  {reachable ? (
                    <span className="muted" style={{ fontSize: 11 }} title={
                      `${p.expectedReactions ?? "?"} likers + ${p.commentsAvailable ?? p.expectedComments ?? "?"} commenters = ${reachable} people to scrape`
                      + (inflated ? `\nLinkedIn says ${p.expectedComments} comments, but ${p.expectedComments - p.commentsAvailable} of those are replies to comments — the API only returns top-level commenters.` : "")
                      + (p.skippedCompany ? `\n${p.skippedCompany} scraped engager${p.skippedCompany === 1 ? " was a" : "s were"} company page${p.skippedCompany === 1 ? "" : "s"}, not people — queued then dropped, which is why this is ${p.engagers} and not ${p.scraped}.` : "")
                    }> of {num(reachable)}</span>
                  ) : null}
                  {p.skippedCompany ? <span className="tag-man" title={`${p.skippedCompany} company page${p.skippedCompany === 1 ? "" : "s"} skipped — not people`}>−{p.skippedCompany}</span> : null}
                </td>
                <td className="num-c" style={{ color: "var(--good)", fontWeight: 600 }}>{num(p.verified)}</td>
                <td className="num-c muted">{num(p.noEmail)}</td>
                <td className="num-c muted">{num(p.unverified)}</td>
                <td className="num-c">{hit}%</td>
                <td className="num-c" title={p.pndCredits
                  ? `${p.pndCredits.scrape} scrape + ${p.pndCredits.profile} profile + ${p.pndCredits.company} company = ${p.pndCredits.total} credits\n${p.pndCredits.paidLeads} leads needed the paid tier · ${p.pndCredits.cacheSaved} lookups served free from cache`
                  : "No PND ledger for this post yet (scraped before per-post accounting, or no PND calls)"}>
                  {p.pndCredits ? <b>{num(p.pndCredits.total)}</b> : <span className="muted">—</span>}
                </td>
                <td className="tstamp">{p.running ? <span style={{ color: "var(--primary)" }}>scraping…</span> : ts(p.at)}</td>
                <td>
                  {!p.running && !p.scrapeDone ? (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onResume(p.postUrl)} title={
                      p.cp?.legacy
                        ? "This post's checkpoint predates the current scraper, whose pages mean something different — resuming from it would skip everything before it, so paging restarts from page 1. Only the scrape pages are re-read (~1 credit per 50 engagers); nobody already enriched is charged for again."
                        : `Resumes from page ${p.cp?.page ?? 1}. Engagers already scraped are deduped and nobody already enriched is charged for again.`
                    }><Icon name="bolt" />Resume</button>
                  ) : null}
                </td>
              </tr>
            );
          })}</tbody></table>
      </div>
      <div className="pager"><span>Rows</span>
        <select value={size} onChange={(e) => { setSize(+e.target.value); setPage(0); }}>{[25, 50, 100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        <span>{num(from)}–{num(to)} of {num(total)}</span>
        <button className="btn btn-ghost btn-sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</button>
        <button className="btn btn-ghost btn-sm" disabled={page >= last} onClick={() => setPage((p) => p + 1)}>Next</button></div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Counts are live — as retries recover no-email leads, Verified climbs here automatically.</div>
      </>) : null}
    </div>
  );
}

// The one automatic engine: scheduled keyword sweep + hub pass + daily influencer/list rotation.
// Its enable switch is persisted server-side (survives deploys), unlike the old in-memory flag.
function AutoEngineBox({ onRotate }) {
  const toast = useToast();
  const [a, setA] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => j("/api/auto/status").then((d) => alive && setA(d)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const toggle = async () => {
    const next = !(a?.enabled);
    const r = await post("/api/auto/toggle", { enabled: next });
    setA((s) => ({ ...(s || {}), enabled: r.enabled }));
    toast(r.enabled ? "Auto engine ON" : "Auto engine paused", r.enabled ? "good" : "info");
  };
  const hrs = (iso) => { if (!iso) return "—"; const d = (new Date(iso) - Date.now()) / 3600000; return d <= 0 ? "due now" : `in ${d < 1 ? Math.round(d * 60) + "m" : d.toFixed(1) + "h"}`; };
  const on = a?.enabled;
  return (
    <div className="chartbox" style={{ marginBottom: "var(--s3)", borderTop: `2px solid ${on ? "var(--good)" : "var(--muted)"}` }}>
      <div className="toolbar" style={{ marginBottom: "var(--s3)" }}>
        <h4 style={{ margin: 0 }}><Icon name="bolt" />Auto engine <span className={on ? "tag-harv" : "tag-man"}>{on ? "on" : "paused"}</span></h4>
        <div className="grow" />
        <button className="btn btn-ghost btn-sm" onClick={onRotate} title="Run the daily influencer/list rotation right now"><Icon name="refresh" />Run rotation now</button>
        <button className={`btn btn-sm ${on ? "btn-no" : "btn-ok"}`} onClick={toggle}><Icon name={on ? "pause" : "bolt"} />{on ? "Pause" : "Enable"}</button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Keyword sweep every <b>{a?.sweepEveryHours ?? 12}h</b> ({hrs(a?.nextSweepAt)}) · daily rotation picks <b>{a?.perList ?? 5}</b> per list + {a?.perList ?? 5} standalone,
        scraping their last-3-months on-topic posts, then marking them done. Off-topic posts and already-scraped engagers cost nothing.
        {a ? <> <br />Imported-list members: <b>{num(a.listMembers?.done || 0)}</b>/{num(a.listMembers?.total || 0)} done ·
          PND credits: <b>{a.creditsRemaining != null ? num(a.creditsRemaining) : "?"}</b>
          {a.idleLowCredits ? <span style={{ color: "var(--hot)" }}> — below floor ({num(a.minCredits)}), engine idle</span> : null}
          {a.busyWith ? <span className="muted"> · a scrape is running</span> : null}</> : null}
      </div>
    </div>
  );
}

// Standalone influencer/hub table. Defined at MODULE level (not inside Sources) — an inline component
// is a new type on every render, which makes React remount the whole table and reset its scroll to
// the top-left on every state change (e.g. a pause/resume toggle). Props keep it pure + stable.
function SrcTable({ rows, cols, onToggle, onDelete }) {
  return (
    <div className="tablewrap" style={{ border: "none" }}><table><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}<th></th></tr></thead>
      <tbody>{rows.length ? rows.map((s) => (
        <tr key={s._id}>
          <td className="nm">{s.label || "—"}{s.harvestedFrom ? <span className="tag-harv" title="Auto-discovered from a hub page">harvested</span> : <span className="tag-man" title="Added by you">manual</span>}
            {s.active === false ? <span className="tag-man" title="Paused — skipped by the auto engine">paused</span> : null}
            {s.scrape_done ? <span className="tag-harv" title={`3-month backlog scraped${s.posts_scraped != null ? ` — ${s.posts_scraped} posts` : ""}. Auto engine won't revisit (done forever).`}>done</span> : null}</td>
          <td><span className="trunc mono muted" title={s.url}>{s.url}</span></td>
          <td className="num-c">{(s.posts_scraped ?? s.lastPosts) != null ? num(s.posts_scraped ?? s.lastPosts) : <span className="muted">—</span>}</td>
          <td className="num-c" style={{ color: "var(--primary-2)" }}>{s.pnd_credits ? num(s.pnd_credits) : <span className="muted">—</span>}</td>
          <td className="tstamp">{s.last_picked_at || s.lastRun ? ts(s.last_picked_at || s.lastRun) : "never"}</td>
          <td><div className="rowact">
            {s.active !== false
              ? <button className="btn btn-no btn-sm" title="Skip this source on the daily run" onClick={() => onToggle(s._id, false)}><Icon name="pause" /></button>
              : <button className="btn btn-ok btn-sm" title="Resume scraping this source — uses API credits" onClick={() => onToggle(s._id, true)}><Icon name="bolt" /></button>}
            <button className="btn btn-ghost btn-sm" onClick={() => onDelete(s._id)}><Icon name="trash" /></button>
          </div></td>
        </tr>
      )) : <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>None yet</td></tr>}</tbody></table></div>
  );
}

export default function Sources() {
  const { refreshTop, jobs, pollJobs } = useDash();
  const toast = useToast();
  const [data, setData] = useState({ sources: [], lists: [], status: {} });
  const [posts, setPosts] = useState([]);
  const [scrape, setScrape] = useState(null);
  const [list, setList] = useState(null);
  const [listPage, setListPage] = useState(0);
  const [listRows, setListRows] = useState({ rows: [], count: 0 });
  const [sel, setSel] = useState(() => new Set()); // multi-selected member ids in the list drill-in
  const [listQ, setListQ] = useState("");
  const [listSize, setListSize] = useState(100);
  const [inflOpen, setInflOpen] = useState(true);
  const [hubsOpen, setHubsOpen] = useState(true);
  const [inPost, setInPost] = useState("");
  const [inCamp, setInCamp] = useState(""); // "" = auto-route by the post's topic
  const [kwIn, setKwIn] = useState("");        // the keyword you type
  const [kwCamp, setKwCamp] = useState("");     // which campaign its engagers are routed into
  // Manual keyword run — same polling/box as the Campaigns-tab sweep, shared so the two can't drift.
  const { status: manual, start: startManual, pause: pauseManual } = useKeywordRun("/api/keywords/manual");
  // EVERY campaign, including ones with no leads yet. The dashboard-wide `campaigns` from context is
  // aggregated from the leads collection, so empty campaigns are absent from it — and its rows carry
  // `campaign`, not `key`, which is why the routing dropdowns here used to send an empty value.
  const [allCamps, setAllCamps] = useState([]);
  const [inInfl, setInInfl] = useState("");
  const [inHub, setInHub] = useState("");
  const [listMsg, setListMsg] = useState("");
  const scrapeTimer = useRef(null);

  const load = useCallback(async () => {
    const [d, sp] = await Promise.all([j("/api/sources").catch(() => null), j("/api/sources/scraped-posts").catch(() => ({ posts: [] }))]);
    // Right after a deploy the container can answer before Mongo is ready and return empty arrays (or the
    // call can transiently fail). Never let that blank an already-populated view — keep what we have.
    if (d) setData((prev) => {
      const sources = d.sources || [], lists = d.lists || [];
      if (!sources.length && !lists.length && (prev.sources.length || prev.lists.length)) return prev;
      return { sources, lists, status: d.status || {} };
    });
    setPosts(sp.posts || []);
  }, []);

  const pollScrape = useCallback(async () => {
    const d = await j("/api/sources/scrape-post/status").catch(() => null);
    if (!d) return;
    setScrape(d);
    clearTimeout(scrapeTimer.current);
    if (d.running) scrapeTimer.current = setTimeout(pollScrape, 2500);
    else { refreshTop(); load(); }
  }, [refreshTop, load]);

  useEffect(() => { load(); pollScrape(); return () => clearTimeout(scrapeTimer.current); }, [load, pollScrape]);
  useEffect(() => { j("/api/campaigns/list").then((d) => setAllCamps(d.campaigns || [])).catch(() => {}); }, []);
  const loadListRows = useCallback(() => {
    if (list) j(`/api/sources/list/${encodeURIComponent(list)}?skip=${listPage * listSize}&limit=${listSize}${listQ ? `&q=${encodeURIComponent(listQ)}` : ""}`).then((d) => setListRows({ rows: d.rows || [], count: d.count || 0 })).catch(() => {});
  }, [list, listPage, listSize, listQ]);
  useEffect(() => { loadListRows(); }, [loadListRows]);
  // Clear the multi-select whenever we navigate the drill-in (different list / page / search).
  useEffect(() => { setSel(new Set()); }, [list, listPage, listQ]);

  // handlers
  const addSrc = async (type, url, clear) => { if (!url.trim()) return; await post("/api/sources", { type, url: url.trim() }); clear(); load(); toast(`${type === "hub" ? "Hub" : "Influencer"} added`, "good"); };
  const delSrc = async (id) => {
    // optimistic — drop the row instantly from both the main lists and any open drill-in
    setData((d) => ({ ...d, sources: d.sources.filter((s) => s._id !== id) }));
    setListRows((r) => ({ rows: r.rows.filter((s) => s._id !== id), count: Math.max(0, r.count - 1) }));
    await fetch("/api/sources/" + id, { method: "DELETE" });
    toast("Removed", "good");
  };
  const runNow = async () => {
    const r = await post("/api/sources/run", {});
    if (r?.ok === false) return toast(r.error || "Could not start", "bad");
    toast("Rotation started — scraping the next batch of sources", "info");
  };

  // Manual keyword scrape: search ONE keyword and send everyone it finds to the campaign you picked.
  // Routing is required and explicit — unlike the post scraper there is no "auto by topic", because a
  // keyword has no post body to classify.
  const runManualKw = async () => {
    const k = kwIn.trim();
    if (!k) return toast("Type a keyword first", "bad");
    if (!kwCamp) return toast("Pick the campaign to route these leads into", "bad");
    const label = allCamps.find((c) => c.key === kwCamp)?.label || kwCamp;
    if (!window.confirm(`Search this week's posts for “${k}” and scrape their engagers into ${label}?\n\nPosts already scraped are skipped unless they've grown, and small posts are skipped — so re-running is cheap.`)) return;
    const r = await startManual({ keyword: k, campaign: kwCamp });
    if (r?.alreadyRunning) {
      return toast(r.busyWith === "scrape-post" ? "A post scrape is running — pause it first" : "A keyword run is already going — pause it first", "bad");
    }
    if (r?.error) return toast(r.error, "bad");
    toast(`Scraping “${k}” → ${label}`, "info");
  };
  const pauseManualKw = async () => { await pauseManual(); toast("Pausing after the current post…", "info"); };

  // Pause/resume ONE influencer, without touching the rest of its imported list.
  // The row is flipped optimistically, but a failed write is rolled BACK and reported — reporting
  // success blindly left a profile that is still `active` looking paused, so the daily run kept
  // scraping it (and burning credits) while the UI insisted it was off.
  const setSrcActive = async (id, on) => {
    const flip = (v) => {
      setData((d) => ({ ...d, sources: d.sources.map((s) => (s._id === id ? { ...s, active: v } : s)) }));
      setListRows((r) => ({ ...r, rows: r.rows.map((s) => (s._id === id ? { ...s, active: v } : s)) }));
    };
    flip(on);
    const r = await post(`/api/sources/${id}/active`, { active: on }).catch(() => null);
    if (!r?.ok) {
      flip(!on); // roll back — nothing was written
      return toast(r?.error ? `Failed: ${r.error}` : "Failed to change this source", "bad");
    }
    toast(on ? "Influencer resumed" : "Influencer paused", "good");
  };

  // Pause/resume MANY selected influencers at once. Optimistic (rows update in place, no refetch) so
  // the table doesn't jump back to the top — on failure we resync from the server.
  const bulkSetActive = async (on) => {
    const ids = [...sel];
    if (!ids.length) return;
    const inSel = new Set(ids);
    setListRows((r) => ({ ...r, rows: r.rows.map((s) => (inSel.has(s._id) ? { ...s, active: on } : s)) }));
    setData((d) => ({ ...d, sources: d.sources.map((s) => (inSel.has(s._id) ? { ...s, active: on } : s)) }));
    setSel(new Set());
    const r = await post("/api/sources/bulk-active", { ids, active: on }).catch(() => null);
    if (!r?.ok) { toast(r?.error ? `Failed: ${r.error}` : "Bulk update failed", "bad"); loadListRows(); return; }
    toast(`${on ? "Resumed" : "Paused"} ${num(r.modified ?? ids.length)} influencer${ids.length === 1 ? "" : "s"}`, "good");
  };

  // Both start paths go through the same route, which can now legitimately refuse (a keyword run is
  // in progress, or another post is already being scraped). Report that instead of claiming success.
  const startScrape = async (body, okMsg) => {
    const r = await post("/api/sources/scrape-post", body).catch(() => null);
    if (!r?.ok) { toast(r?.error ? `Not started: ${r.error}` : "Could not start the scrape", "bad"); return; }
    toast(okMsg, "info");
    // Show the box immediately (optimistic) and keep polling until the backend registers the run.
    // The status endpoint can still read "idle" for a beat after start; the plain pollScrape() would
    // see running:false, stop, and the box only appeared on the next manual refresh.
    setScrape({ postUrl: body.postUrl, phase: "working", running: true, total: 0, enriched: 0, sent: 0 });
    let tries = 0;
    const kick = async () => {
      const d = await j("/api/sources/scrape-post/status").catch(() => null);
      if (d && d.phase && d.phase !== "idle") {
        setScrape(d);
        clearTimeout(scrapeTimer.current);
        if (d.running) scrapeTimer.current = setTimeout(pollScrape, 2500);
        return;
      }
      if (++tries < 8) scrapeTimer.current = setTimeout(kick, 1500);
    };
    clearTimeout(scrapeTimer.current);
    kick();
  };
  const scrapePost = async () => {
    if (!inPost.trim()) return;
    await startScrape({ postUrl: inPost.trim(), campaign: inCamp },
      inCamp ? `Scrape started → ${allCamps.find((c) => c.key === inCamp)?.label || inCamp}` : "Scrape started — routing by the post's topic");
  };
  const pauseScrape = async () => { await post("/api/sources/scrape-post/pause", {}); toast("Scrape paused — resume anytime", "info"); pollScrape(); };
  const resumeScrape = async (url) => { await startScrape({ postUrl: url }, "Scrape resumed"); };
  const setListActive = async (l, on) => { setListMsg(on ? "Enabling…" : "Pausing…"); const r = await post(`/api/sources/list/${encodeURIComponent(l)}/active`, { active: on }); if (!r?.ok) { setListMsg(`✗ Couldn't ${on ? "enable" : "pause"} “${l}” — try again`); return; } setListMsg(`✓ ${on ? "Enabled" : "Paused"} “${l}” · ${num(r.matched)} influencers${on ? " — will scrape on the next run" : ""}`); load(); };
  const delList = async (l) => { if (!window.confirm(`Delete the whole list “${l}”? This removes those influencers from Sources (leads already collected stay).`)) return; await fetch(`/api/sources/list/${encodeURIComponent(l)}`, { method: "DELETE" }); setList(null); load(); };

  // Imported-list drill-in view
  if (list) {
    const { rows, count } = listRows;
    const from = count ? listPage * listSize + 1 : 0, to = Math.min(count, (listPage + 1) * listSize), last = Math.max(0, Math.ceil(count / listSize) - 1);
    return (
      <>
        <div className="toolbar"><button className="btn btn-ghost btn-sm" onClick={() => setList(null)}><Icon name="back" />All sources</button>
          <input className="search" placeholder="Search name / profile / title…" style={{ minWidth: 220 }}
            value={listQ} onChange={(e) => { setListQ(e.target.value); setListPage(0); }} />
          <div className="grow" />
          {sel.size ? (
            <>
              <span className="resn"><b>{num(sel.size)}</b> selected</span>
              <button className="btn btn-ok btn-sm" onClick={() => bulkSetActive(true)}><Icon name="bolt" />Resume</button>
              <button className="btn btn-no btn-sm" onClick={() => bulkSetActive(false)}><Icon name="pause" />Pause</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setSel(new Set())}>Clear</button>
            </>
          ) : null}
          <span className="resn"><b>{num(count)}</b> influencers in “{list}”</span></div>
        <div className="tablewrap"><table><thead><tr>
          <th className="chkcol"><input type="checkbox" className="chk" title="Select all on this page"
            checked={rows.length > 0 && rows.every((s) => sel.has(s._id))}
            onChange={(e) => { const on = e.target.checked; setSel((prev) => { const n = new Set(prev); rows.forEach((s) => on ? n.add(s._id) : n.delete(s._id)); return n; }); }} /></th>
          <th>Name</th><th>Title</th><th>Profile</th><th>Posts</th><th title="PND credits spent scraping this person's engagers">PND cr</th><th>Last run</th><th></th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s._id}>
              <td className="chkcol"><input type="checkbox" className="chk" checked={sel.has(s._id)}
                onChange={() => setSel((prev) => { const n = new Set(prev); n.has(s._id) ? n.delete(s._id) : n.add(s._id); return n; })} /></td>
              <td className="nm">{s.label || "—"}{s.active !== false ? <span className="tag-harv">on</span> : <span className="tag-man">paused</span>}
                {s.scrape_done ? <span className="tag-harv" title={`3-month backlog scraped${s.posts_scraped != null ? ` — ${s.posts_scraped} posts` : ""}. Done forever.`}>done</span> : null}</td>
              <td><span className="trunc sm muted" title={s.title || ""}>{s.title || ""}</span></td>
              <td><span className="trunc mono muted" title={s.url}>{s.url}</span></td>
              <td className="num-c">{(s.posts_scraped ?? s.lastPosts) != null ? num(s.posts_scraped ?? s.lastPosts) : <span className="muted">—</span>}</td>
              <td className="num-c" style={{ color: "var(--primary-2)" }}>{s.pnd_credits ? num(s.pnd_credits) : <span className="muted">—</span>}</td>
              <td className="tstamp">{s.last_picked_at || s.lastRun ? ts(s.last_picked_at || s.lastRun) : "never"}</td>
              <td><div className="rowact">
                {s.active !== false
                  ? <button className="btn btn-no btn-sm" title="Stop scraping just this person — the rest of the list keeps running" onClick={() => setSrcActive(s._id, false)}><Icon name="pause" />Pause</button>
                  : <button className="btn btn-ok btn-sm" title="Resume scraping this person — uses API credits" onClick={() => setSrcActive(s._id, true)}><Icon name="bolt" />Resume</button>}
                <button className="btn btn-ghost btn-sm" onClick={() => delSrc(s._id)}><Icon name="trash" /></button>
              </div></td>
            </tr>
          ))}</tbody></table></div>
        <div className="pager"><span>Rows</span>
          <select value={listSize} onChange={(e) => { setListSize(+e.target.value); setListPage(0); }}>
            {[100, 200, 500, 1000, 10000].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>{num(from)}–{num(to)} of {num(count)}</span>
          <button className="btn btn-ghost btn-sm" disabled={listPage <= 0} onClick={() => setListPage((p) => Math.max(0, p - 1))}>Prev</button>
          <button className="btn btn-ghost btn-sm" disabled={listPage >= last} onClick={() => setListPage((p) => p + 1)}>Next</button></div>
      </>
    );
  }

  const infl = data.sources.filter((s) => s.type === "influencer");
  const hubs = data.sources.filter((s) => s.type === "hub");

  return (
    <>
      <AutoEngineBox onRotate={runNow} />
      <div className="note"><Icon name="radio" /><div>Scrape big cold-email <b>influencers’</b> posts and LinkedIn <b>top-content hubs</b>. Each post is auto-classified and its engagers routed by topic. The auto engine above walks each source’s last-3-months on-topic posts once, then marks it <b>done</b>.<br />
        <span className="tag-harv">harvested</span> = we auto-found this person · <span className="tag-man">manual</span> = you added them · <span className="tag-harv">done</span> = 3-month backlog scraped.</div></div>
      <div className="toolbar">
        <span className="resn"><b>{infl.length}</b> influencers · <b>{hubs.length}</b> hubs</span>
      </div>

      <div className="chartbox" style={{ marginBottom: "var(--s3)", borderTop: "2px solid var(--primary)" }}>
        <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}><Icon name="search" />Manual keyword scrape <span className="tag-harv">new</span></h4><div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>the automatic sweep lives on the Campaigns tab</span></div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Search <b>any</b> keyword — it doesn&rsquo;t have to belong to a campaign — and send everyone who engaged with this
          week&rsquo;s posts for it into the campaign <b>you</b> pick. One-off: the keyword isn&rsquo;t added to that campaign&rsquo;s
          list, so the automatic sweep won&rsquo;t start using it. Posts already scraped are skipped unless they&rsquo;ve grown,
          and thin posts are skipped, so re-running a keyword is cheap.
        </div>
        <div className="toolbar">
          <input className="search" placeholder="e.g. cold email deliverability" style={{ flex: 1, minWidth: 0 }}
            value={kwIn} onChange={(e) => setKwIn(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runManualKw(); }} />
          <select value={kwCamp} onChange={(e) => setKwCamp(e.target.value)}
            title="Where these engagers go. Required — a keyword has no post body to classify, so there is no auto-routing here.">
            <option value="">Route to campaign…</option>
            {allCamps.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          {manual?.running
            ? <button className="btn btn-ghost btn-sm" onClick={pauseManualKw}><Icon name="pause" />Pause</button>
            : <button className="btn btn-sm" onClick={runManualKw}><Icon name="bolt" />Scrape keyword</button>}
        </div>
        {/* Progress is posts-processed over postsTotal (fixed once the search returns), NOT over
            postsFound — that counter grows as the run walks the results, so the bar ran backwards. */}
        <KeywordRunBox
          s={manual}
          done={(manual?.postsScraped || 0) + (manual?.skippedSmall || 0) + (manual?.skippedUnchanged || 0)}
          total={manual?.postsTotal}
          runningLabel={manual?.phase === "scraping" ? "Scraping" : "Searching"} />
      </div>

      <div className="chartbox" style={{ marginBottom: "var(--s3)" }}>
        <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}><Icon name="radio" />Scrape via post <span className="tag-harv">new</span></h4><div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>{scrape?.rapid ? `Fresh scraper: ${num((scrape.rapid.reactionPages || 0) + (scrape.rapid.commentPages || 0))} pages used${scrape.rapid.outOfCredits ? " · out of credits" : ""}` : ""}</span></div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>Paste a LinkedIn post URL — we scrape ALL its reactors + commenters (interleaved: leads flow as it runs) and route them by topic. Pausable + resumable.</div>
        <div className="toolbar"><input className="search" placeholder="https://www.linkedin.com/feed/update/urn:li:activity:..." style={{ flex: 1, minWidth: 0 }} value={inPost} onChange={(e) => setInPost(e.target.value)} />
          <select value={inCamp} onChange={(e) => setInCamp(e.target.value)}
            title="Where these engagers should go. Auto reads the post and picks the matching campaign; choose one to override — e.g. send an Instantly post's engagers to Cold Email.">
            <option value="">Auto — route by topic</option>
            {allCamps.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <button className="btn btn-sm" onClick={scrapePost}><Icon name="bolt" />Scrape post</button></div>
        <div style={{ marginTop: 10 }}><ScrapeBox s={scrape} onPause={pauseScrape} onResume={resumeScrape} /></div>
      </div>

      <ScrapedPosts onResume={resumeScrape} busy={!!scrape?.running} />
      <JobBox kind="sources" s={jobs.sources} />

      <div className="chartbox" style={{ marginBottom: "var(--s3)" }}>
        <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}>Imported lists</h4><div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>Imported from CSV · <b>paused</b> until you enable them (enabling spends scraping credits)</span></div>
        {data.lists.length ? (
          <div className="tablewrap" style={{ border: "none" }}><table><thead><tr><th>List</th><th>Influencers</th><th>Status</th><th>Progress</th><th title="PND credits spent scraping this list's members">PND cr</th><th></th></tr></thead>
            <tbody>{data.lists.map((l) => (
              <tr key={l.list} className="click" onClick={() => { setList(l.list); setListPage(0); }}>
                <td className="nm">{l.list}</td><td className="score">{num(l.count)}</td>
                <td>{l.active ? <span className="tag-harv">{num(l.active)} on</span> : <span className="tag-man">paused</span>}{l.done ? <span className="tag-harv" title="Members whose 3-month backlog is fully scraped">{num(l.done)} done</span> : null}</td>
                <td className="muted">{l.ran ? num(l.ran) + " scraped" : "—"}</td>
                <td className="num-c" style={{ color: "var(--primary-2)" }}>{l.pndCredits ? num(l.pndCredits) : <span className="muted">—</span>}</td>
                <td onClick={(e) => e.stopPropagation()}><div className="rowact">
                  {l.active
                    ? <button className="btn btn-no btn-sm" title="Pause every influencer in this CSV" onClick={() => setListActive(l.list, false)}><Icon name="pause" />Pause</button>
                    : <button className="btn btn-ok btn-sm" title="Resume every influencer in this CSV — uses API credits" onClick={() => setListActive(l.list, true)}><Icon name="bolt" />Resume</button>}
                  <button className="btn btn-ghost btn-sm" onClick={() => delList(l.list)}><Icon name="trash" /></button>
                </div></td>
              </tr>
            ))}</tbody></table></div>
        ) : <div className="muted" style={{ padding: 14 }}>No imported lists yet.</div>}
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{listMsg}</div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "var(--s3)", alignItems: "start" }}>
        <div className="chartbox" style={{ minWidth: 0, overflow: "hidden" }}>
          <div className="toolbar"><h4 style={{ margin: 0 }}>Influencers <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>({infl.length})</span></h4><div className="grow" />
            <button className="btn btn-ghost btn-sm" onClick={() => setInflOpen((v) => !v)}>{inflOpen ? "Hide" : "Expand"}</button></div>
          <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><input className="search" placeholder="LinkedIn profile URL or handle" style={{ flex: 1, minWidth: 0 }} value={inInfl} onChange={(e) => setInInfl(e.target.value)} />
            <button className="btn btn-sm" onClick={() => addSrc("influencer", inInfl, () => setInInfl(""))}><Icon name="plus" />Add</button></div>
          {inflOpen ? <SrcTable rows={infl} cols={["Name", "Profile", "Posts", "PND cr", "Last run"]} onToggle={setSrcActive} onDelete={delSrc} /> : null}
        </div>
        <div className="chartbox" style={{ minWidth: 0, overflow: "hidden" }}>
          <div className="toolbar"><h4 style={{ margin: 0 }}>Hubs <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>({hubs.length})</span></h4><div className="grow" />
            <button className="btn btn-ghost btn-sm" onClick={() => setHubsOpen((v) => !v)}>{hubsOpen ? "Hide" : "Expand"}</button></div>
          <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><input className="search" placeholder="linkedin.com/top-content/... URL" style={{ flex: 1, minWidth: 0 }} value={inHub} onChange={(e) => setInHub(e.target.value)} />
            <button className="btn btn-sm" onClick={() => addSrc("hub", inHub, () => setInHub(""))}><Icon name="plus" />Add</button></div>
          {hubsOpen ? <SrcTable rows={hubs} cols={["Hub", "URL", "Posts", "PND cr", "Last run"]} onToggle={setSrcActive} onDelete={delSrc} /> : null}
        </div>
      </div>
    </>
  );
}
