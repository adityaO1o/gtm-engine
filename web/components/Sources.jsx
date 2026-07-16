"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { num, ts } from "@/lib/format";
import { j, post } from "@/lib/api";
import { useDash } from "@/lib/ctx";
import { useToast } from "@/lib/toast";
import JobBox from "./JobBox";

const SCR_PHASE = { working: "Scraping + finding emails", done: "Done", paused: "Paused", stopped: "Stopped", error: "Error" };

function ScrapeBox({ s, onPause, onResume }) {
  if (!s || !s.postUrl || !s.phase || s.phase === "idle") return null;
  const id = (String(s.postUrl).match(/activity[:-](\d+)/) || [])[1] || s.postUrl.slice(-24);
  const icon = s.running ? "refresh" : s.phase === "paused" ? "pause" : s.phase === "done" ? "check" : "warn";
  const denom = s.expected || s.total || 0;
  const pct = denom ? Math.min(100, Math.round((s.enriched / denom) * 100)) : 0;
  const Stat = ({ l, v, cls }) => <span className="scstat"><b className={cls || ""}>{num(v)}</b>{l}</span>;
  return (
    <div className={`jobbox${s.running ? " on" : ""}`}>
      <div className="jobh"><Icon name={icon} /><span><b>{SCR_PHASE[s.phase] || s.phase}</b> <span className="mono muted">activity:{id}</span>{s.campaign ? <> → <b>{s.campaign}</b></> : null}</span></div>
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

function ScrapedPosts({ posts }) {
  if (!posts.length) return null;
  return (
    <div className="chartbox" style={{ marginBottom: "var(--s3)" }}>
      <h4><Icon name="check" />Scraped posts <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>· live counts</span></h4>
      <div className="tablewrap" style={{ border: "none" }}>
        <table><thead><tr><th>Post</th><th>Campaign</th><th>Engagers</th><th>Verified</th><th>No-email</th><th>Unverified</th><th title="verified ÷ engagers">Hit</th><th>When</th></tr></thead>
          <tbody>{posts.map((p) => {
            const hit = p.engagers ? Math.round((p.verified / p.engagers) * 100) : 0;
            const label = p.title || p.posterName || ("activity:" + (p.activityId || "—"));
            const expected = (p.expectedReactions || 0) + (p.expectedComments || 0);
            return (
              <tr key={p.postUrl}>
                <td><a href={p.postUrl} target="_blank" rel="noopener" className="postlink" title={p.postUrl}>{label}<Icon name="external" /></a></td>
                <td>{p.campaign ? <b>{p.campaign}</b> : <span className="muted">—</span>}</td>
                <td className="num-c">{num(p.engagers)}{expected ? <span className="muted" style={{ fontSize: 11 }}> of ~{num(expected)}</span> : null}</td>
                <td className="num-c" style={{ color: "var(--good)", fontWeight: 600 }}>{num(p.verified)}</td>
                <td className="num-c muted">{num(p.noEmail)}</td>
                <td className="num-c muted">{num(p.unverified)}</td>
                <td className="num-c">{hit}%</td>
                <td className="tstamp">{p.running ? <span style={{ color: "var(--primary)" }}>scraping…</span> : ts(p.at)}</td>
              </tr>
            );
          })}</tbody></table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Counts are live — as retries recover no-email leads, Verified climbs here automatically.</div>
    </div>
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
  const [inPost, setInPost] = useState("");
  const [inInfl, setInInfl] = useState("");
  const [inHub, setInHub] = useState("");
  const [listMsg, setListMsg] = useState("");
  const scrapeTimer = useRef(null);

  const load = useCallback(async () => {
    const [d, sp] = await Promise.all([j("/api/sources"), j("/api/sources/scraped-posts").catch(() => ({ posts: [] }))]);
    setData({ sources: d.sources || [], lists: d.lists || [], status: d.status || {} });
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
  useEffect(() => {
    if (list) j(`/api/sources/list/${encodeURIComponent(list)}?skip=${listPage * 100}&limit=100`).then((d) => setListRows({ rows: d.rows || [], count: d.count || 0 }));
  }, [list, listPage]);

  // handlers
  const addSrc = async (type, url, clear) => { if (!url.trim()) return; await post("/api/sources", { type, url: url.trim() }); clear(); load(); toast(`${type === "hub" ? "Hub" : "Influencer"} added`, "good"); };
  const delSrc = async (id) => {
    // optimistic — drop the row instantly from both the main lists and any open drill-in
    setData((d) => ({ ...d, sources: d.sources.filter((s) => s._id !== id) }));
    setListRows((r) => ({ rows: r.rows.filter((s) => s._id !== id), count: Math.max(0, r.count - 1) }));
    await fetch("/api/sources/" + id, { method: "DELETE" });
    toast("Removed", "good");
  };
  const runNow = async () => { await post("/api/sources/run", {}); toast("Sources sweep started", "info"); pollJobs(); };
  const scrapePost = async () => { if (!inPost.trim()) return; await post("/api/sources/scrape-post", { postUrl: inPost.trim() }); toast("Scrape started — leads will flow in as it runs", "info"); pollScrape(); };
  const pauseScrape = async () => { await post("/api/sources/scrape-post/pause", {}); toast("Scrape paused — resume anytime", "info"); pollScrape(); };
  const resumeScrape = async (url) => { await post("/api/sources/scrape-post", { postUrl: url }); toast("Scrape resumed", "info"); pollScrape(); };
  const setListActive = async (l, on) => { setListMsg(on ? "Enabling…" : "Pausing…"); const r = await post(`/api/sources/list/${encodeURIComponent(l)}/active`, { active: on }); setListMsg(`✓ ${on ? "Enabled" : "Paused"} “${l}” · ${num(r.matched)} influencers${on ? " — will scrape on the next run" : ""}`); load(); };
  const delList = async (l) => { if (!window.confirm(`Delete the whole list “${l}”? This removes those influencers from Sources (leads already collected stay).`)) return; await fetch(`/api/sources/list/${encodeURIComponent(l)}`, { method: "DELETE" }); setList(null); load(); };

  // Imported-list drill-in view
  if (list) {
    const { rows, count } = listRows;
    const from = count ? listPage * 100 + 1 : 0, to = Math.min(count, (listPage + 1) * 100), last = Math.max(0, Math.ceil(count / 100) - 1);
    return (
      <>
        <div className="toolbar"><button className="btn btn-ghost btn-sm" onClick={() => setList(null)}><Icon name="back" />All sources</button>
          <div className="grow" /><span className="resn"><b>{num(count)}</b> influencers in “{list}”</span></div>
        <div className="tablewrap"><table><thead><tr><th>Name</th><th>Title</th><th>Profile</th><th>Posts</th><th>Last run</th><th></th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s._id}>
              <td className="nm">{s.label || "—"}{s.active ? <span className="tag-harv">on</span> : <span className="tag-man">paused</span>}</td>
              <td><span className="trunc sm muted" title={s.title || ""}>{s.title || ""}</span></td>
              <td><span className="trunc mono muted" title={s.url}>{s.url}</span></td>
              <td className="num-c">{s.lastPosts != null ? num(s.lastPosts) : <span className="muted">—</span>}</td>
              <td className="tstamp">{s.lastRun ? ts(s.lastRun) : "never"}</td>
              <td><button className="btn btn-ghost btn-sm" onClick={() => delSrc(s._id)}><Icon name="trash" /></button></td>
            </tr>
          ))}</tbody></table></div>
        <div className="pager"><span>{num(from)}–{num(to)} of {num(count)}</span>
          <button className="btn btn-ghost btn-sm" disabled={listPage <= 0} onClick={() => setListPage((p) => Math.max(0, p - 1))}>Prev</button>
          <button className="btn btn-ghost btn-sm" disabled={listPage >= last} onClick={() => setListPage((p) => p + 1)}>Next</button></div>
      </>
    );
  }

  const infl = data.sources.filter((s) => s.type === "influencer");
  const hubs = data.sources.filter((s) => s.type === "hub");
  const SrcTable = ({ rows, cols }) => (
    <div className="tablewrap" style={{ border: "none" }}><table><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}<th></th></tr></thead>
      <tbody>{rows.length ? rows.map((s) => (
        <tr key={s._id}>
          <td className="nm">{s.label || "—"}{s.harvestedFrom ? <span className="tag-harv" title="Auto-discovered from a hub page">harvested</span> : <span className="tag-man" title="Added by you">manual</span>}</td>
          <td><span className="trunc mono muted" title={s.url}>{s.url}</span></td>
          <td className="num-c">{s.lastPosts != null ? num(s.lastPosts) : <span className="muted">—</span>}</td>
          <td className="tstamp">{s.lastRun ? ts(s.lastRun) : "never"}</td>
          <td><button className="btn btn-ghost btn-sm" onClick={() => delSrc(s._id)}><Icon name="trash" /></button></td>
        </tr>
      )) : <tr><td colSpan={5} className="muted" style={{ padding: 16 }}>None yet</td></tr>}</tbody></table></div>
  );

  return (
    <>
      <div className="note"><Icon name="radio" /><div>Scrape big cold-email <b>influencers’</b> posts and LinkedIn <b>top-content hubs</b>. Each post is auto-classified and its engagers routed to the Influencer/Hub campaigns. Runs daily.<br />
        <span className="tag-harv">harvested</span> = we auto-found this person · <span className="tag-man">manual</span> = you added them.</div></div>
      <div className="toolbar">
        <span className="resn"><b>{infl.length}</b> influencers · <b>{hubs.length}</b> hubs</span>
        <div className="grow" />
        <button className="btn btn-sm" disabled={data.status.running} onClick={runNow}><Icon name="refresh" />{data.status.running ? "Running…" : "Run now"}</button>
      </div>

      <div className="chartbox" style={{ marginBottom: "var(--s3)", borderTop: "2px solid var(--primary)" }}>
        <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}><Icon name="radio" />Scrape via post <span className="tag-harv">new</span></h4><div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>{scrape?.rapid ? `Fresh scraper: ${num((scrape.rapid.reactionPages || 0) + (scrape.rapid.commentPages || 0))} pages used${scrape.rapid.outOfCredits ? " · out of credits" : ""}` : ""}</span></div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>Paste a LinkedIn post URL — we scrape ALL its reactors + commenters (interleaved: leads flow as it runs) and route them by topic. Pausable + resumable.</div>
        <div className="toolbar"><input className="search" placeholder="https://www.linkedin.com/feed/update/urn:li:activity:..." style={{ flex: 1, minWidth: 0 }} value={inPost} onChange={(e) => setInPost(e.target.value)} />
          <button className="btn btn-sm" onClick={scrapePost}><Icon name="bolt" />Scrape post</button></div>
        <div style={{ marginTop: 10 }}><ScrapeBox s={scrape} onPause={pauseScrape} onResume={resumeScrape} /></div>
      </div>

      <ScrapedPosts posts={posts} />
      <JobBox kind="sources" s={jobs.sources} />

      <div className="chartbox" style={{ marginBottom: "var(--s3)" }}>
        <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}>Imported lists</h4><div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>Imported from CSV · <b>paused</b> until you enable them (enabling spends scraping credits)</span></div>
        {data.lists.length ? (
          <div className="tablewrap" style={{ border: "none" }}><table><thead><tr><th>List</th><th>Influencers</th><th>Status</th><th>Progress</th><th></th></tr></thead>
            <tbody>{data.lists.map((l) => (
              <tr key={l.list} className="click" onClick={() => { setList(l.list); setListPage(0); }}>
                <td className="nm">{l.list}</td><td className="score">{num(l.count)}</td>
                <td>{l.active ? <span className="tag-harv">{num(l.active)} on</span> : <span className="tag-man">paused</span>}</td>
                <td className="muted">{l.ran ? num(l.ran) + " scraped" : "—"}</td>
                <td onClick={(e) => e.stopPropagation()}><div className="rowact">
                  {l.active
                    ? <button className="btn btn-no btn-sm" onClick={() => setListActive(l.list, false)}><Icon name="pause" />Pause</button>
                    : <button className="btn btn-ok btn-sm" title="Enable scraping — uses API credits" onClick={() => setListActive(l.list, true)}><Icon name="bolt" />Enable</button>}
                  <button className="btn btn-ghost btn-sm" onClick={() => delList(l.list)}><Icon name="trash" /></button>
                </div></td>
              </tr>
            ))}</tbody></table></div>
        ) : <div className="muted" style={{ padding: 14 }}>No imported lists yet.</div>}
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{listMsg}</div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "var(--s3)", alignItems: "start" }}>
        <div className="chartbox" style={{ minWidth: 0, overflow: "hidden" }}><h4>Influencers</h4>
          <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><input className="search" placeholder="LinkedIn profile URL or handle" style={{ flex: 1, minWidth: 0 }} value={inInfl} onChange={(e) => setInInfl(e.target.value)} />
            <button className="btn btn-sm" onClick={() => addSrc("influencer", inInfl, () => setInInfl(""))}><Icon name="plus" />Add</button></div>
          <SrcTable rows={infl} cols={["Name", "Profile", "Posts", "Last run"]} />
        </div>
        <div className="chartbox" style={{ minWidth: 0, overflow: "hidden" }}><h4>Hubs</h4>
          <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><input className="search" placeholder="linkedin.com/top-content/... URL" style={{ flex: 1, minWidth: 0 }} value={inHub} onChange={(e) => setInHub(e.target.value)} />
            <button className="btn btn-sm" onClick={() => addSrc("hub", inHub, () => setInHub(""))}><Icon name="plus" />Add</button></div>
          <SrcTable rows={hubs} cols={["Hub", "URL", "Posts", "Last run"]} />
        </div>
      </div>
    </>
  );
}
