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

function ScrapedPosts({ posts, onResume, busy }) {
  if (!posts.length) return null;
  return (
    <div className="chartbox" style={{ marginBottom: "var(--s3)" }}>
      <h4><Icon name="check" />Scraped posts <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>· live counts</span></h4>
      <div className="tablewrap" style={{ border: "none" }}>
        <table><thead><tr><th>Post</th><th>Campaign</th><th>Engagers</th><th>Verified</th><th>No-email</th><th>Unverified</th><th title="verified ÷ engagers">Hit</th><th>When</th><th></th></tr></thead>
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
                  {p.commentsSkipped ? <span className="tag-man" title={p.commentsSkipReason || "Commenters were not scraped for this post"}>likers only</span> : null}
                </td>
                <td>{p.campaign ? <b>{p.campaign}</b> : <span className="muted">—</span>}</td>
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
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Counts are live — as retries recover no-email leads, Verified climbs here automatically.</div>
    </div>
  );
}

export default function Sources() {
  const { refreshTop, jobs, pollJobs, campaigns } = useDash();
  const toast = useToast();
  const [data, setData] = useState({ sources: [], lists: [], status: {} });
  const [posts, setPosts] = useState([]);
  const [scrape, setScrape] = useState(null);
  const [list, setList] = useState(null);
  const [listPage, setListPage] = useState(0);
  const [listRows, setListRows] = useState({ rows: [], count: 0 });
  const [inPost, setInPost] = useState("");
  const [inCamp, setInCamp] = useState(""); // "" = auto-route by the post's topic
  const [sweep, setSweep] = useState(null);
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

  // Declared BEFORE the effect that lists it as a dependency: a `const` referenced above its own
  // declaration throws "Cannot access 'pollSweep' before initialization" while the dependency array
  // is being evaluated, which crashed the whole Sources tab on render.
  const pollSweep = useCallback(async function p() {
    const s = await j("/api/keywords/sweep/status").catch(() => null);
    setSweep(s);
    if (s?.running) setTimeout(p, 4000);
    else { refreshTop(); load(); }
  }, [refreshTop, load]);

  useEffect(() => { load(); pollScrape(); pollSweep(); return () => clearTimeout(scrapeTimer.current); }, [load, pollScrape, pollSweep]);
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
  const runSweep = async () => {
    if (!window.confirm("Search this week's posts for every campaign keyword and scrape their engagers?\n\nPosts already scraped are skipped unless they've grown — that check is free. Small posts are skipped too.")) return;
    await post("/api/keywords/sweep", {});
    toast("Keyword sweep started", "info");
    pollSweep();
  };
  const pauseSweep = async () => { await post("/api/keywords/sweep/pause", {}); toast("Pausing after the current post…", "info"); pollSweep(); };

  const scrapePost = async () => {
    if (!inPost.trim()) return;
    await post("/api/sources/scrape-post", { postUrl: inPost.trim(), campaign: inCamp });
    toast(inCamp ? `Scrape started → ${inCamp}` : "Scrape started — routing by the post's topic", "info");
    pollScrape();
  };
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
        <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}><Icon name="search" />Keyword sweep <span className="tag-harv">new</span></h4><div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>replaces the Trigify workflows</span></div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Finds this week&rsquo;s posts for every campaign keyword and scrapes their engagers into that campaign.
          Posts already done are skipped unless they&rsquo;ve <b>grown</b> — and that check costs nothing, because the search
          returns each post&rsquo;s engagement counts. Only the new engagers get enriched.
        </div>
        <div className="toolbar">
          {sweep?.running
            ? <button className="btn btn-ghost btn-sm" onClick={pauseSweep}><Icon name="pause" />Pause sweep</button>
            : <button className="btn btn-sm" onClick={runSweep}><Icon name="bolt" />Run keyword sweep</button>}
          {sweep?.running ? <span className="muted" style={{ fontSize: 12 }}>{sweep.phase === "scraping" ? "scraping" : "searching"} &middot; <b>{sweep.keyword}</b> &rarr; {sweep.campaign}</span> : null}
        </div>
        {(sweep?.running || sweep?.finishedAt) ? (
          <div className={`jobbox${sweep.running ? " on" : ""}`} style={{ marginTop: 10 }}>
            <div className="jobh"><Icon name={sweep.running ? "refresh" : "check"} />
              <span><b>{sweep.running ? "Sweeping" : sweep.phase === "paused" ? "Paused" : "Done"}</b> &middot; {num(sweep.keywordsDone)}/{num(sweep.totalKeywords)} keywords &middot;{" "}
                <b>{num(sweep.postsScraped)}</b> posts scraped &middot; <b className="ok">{num(sweep.newEngagers)}</b> new engagers
                {sweep.skippedUnchanged ? <span className="muted"> &middot; {num(sweep.skippedUnchanged)} unchanged</span> : null}
                {sweep.skippedSmall ? <span className="muted"> &middot; {num(sweep.skippedSmall)} too small</span> : null}
                {sweep.creditsUsed != null ? <> &middot; <b>{num(sweep.creditsUsed)}</b> credits</> : null}</span>
            </div>
            <div className={`prog${sweep.running ? " on" : ""}`}><i style={{ width: `${sweep.totalKeywords ? Math.round((sweep.keywordsDone / sweep.totalKeywords) * 100) : 3}%` }} /></div>
          </div>
        ) : null}
      </div>

      <div className="chartbox" style={{ marginBottom: "var(--s3)" }}>
        <div className="toolbar" style={{ marginBottom: "var(--s3)" }}><h4 style={{ margin: 0 }}><Icon name="radio" />Scrape via post <span className="tag-harv">new</span></h4><div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>{scrape?.rapid ? `Fresh scraper: ${num((scrape.rapid.reactionPages || 0) + (scrape.rapid.commentPages || 0))} pages used${scrape.rapid.outOfCredits ? " · out of credits" : ""}` : ""}</span></div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>Paste a LinkedIn post URL — we scrape ALL its reactors + commenters (interleaved: leads flow as it runs) and route them by topic. Pausable + resumable.</div>
        <div className="toolbar"><input className="search" placeholder="https://www.linkedin.com/feed/update/urn:li:activity:..." style={{ flex: 1, minWidth: 0 }} value={inPost} onChange={(e) => setInPost(e.target.value)} />
          <select value={inCamp} onChange={(e) => setInCamp(e.target.value)}
            title="Where these engagers should go. Auto reads the post and picks the matching campaign; choose one to override — e.g. send an Instantly post's engagers to Cold Email.">
            <option value="">Auto — route by topic</option>
            {campaigns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <button className="btn btn-sm" onClick={scrapePost}><Icon name="bolt" />Scrape post</button></div>
        <div style={{ marginTop: 10 }}><ScrapeBox s={scrape} onPause={pauseScrape} onResume={resumeScrape} /></div>
      </div>

      <ScrapedPosts posts={posts} onResume={resumeScrape} busy={!!scrape?.running} />
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
