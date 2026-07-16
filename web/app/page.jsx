"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import Topbar from "@/components/Topbar";
import Overview from "@/components/Overview";
import Leads from "@/components/Leads";
import Handoff from "@/components/Handoff";
import Review from "@/components/Review";
import Competitors from "@/components/Competitors";
import Campaigns from "@/components/Campaigns";
import Sources from "@/components/Sources";
import LeadDrawer from "@/components/LeadDrawer";
import ReverifyMenu from "@/components/ReverifyMenu";
import { num } from "@/lib/format";
import { j } from "@/lib/api";
import { DashContext } from "@/lib/ctx";

const TABS = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "leads", label: "Leads", icon: "users", cnt: (s) => s.total },
  { id: "handoff", label: "Hand-off", icon: "inbox", cnt: (s) => s.noEmail },
  { id: "review", label: "Review", icon: "warn", cnt: (s) => s.review },
  { id: "competitors", label: "Competitors", icon: "flag", cnt: (s) => s.competitor },
  { id: "campaigns", label: "Campaigns", icon: "mega" },
  { id: "sources", label: "Sources", icon: "radio" },
];
const TITLES = { overview: "Overview", leads: "Leads", handoff: "Hand-off · No email", review: "Review · Decide these emails", competitors: "Competitors", campaigns: "Campaigns", sources: "Sources" };
const BODIES = { overview: Overview, leads: Leads, handoff: Handoff, review: Review, competitors: Competitors, campaigns: Campaigns, sources: Sources };

export default function Dashboard() {
  const [view, setView] = useState("overview");
  const [stats, setStats] = useState({});
  const [campaigns, setCampaigns] = useState([]);
  const [prospeo, setProspeo] = useState(null);
  const [jobs, setJobs] = useState({ retry: {}, sync: {}, sources: {} });
  const [drawer, setDrawer] = useState(null);
  const [menu, setMenu] = useState(null);
  const [dataVersion, setDataVersion] = useState(0);
  const jobTimer = useRef(null);
  const prevRunning = useRef(false);

  const refreshTop = useCallback(async () => {
    const [d, s] = await Promise.all([j("/api/campaigns"), j("/api/stats")]);
    setCampaigns(d.campaigns || []); setProspeo(d.prospeo || null); setStats(s);
  }, []);

  const pollJobs = useCallback(async function poll() {
    clearTimeout(jobTimer.current);
    const [retry, sync, sources] = await Promise.all([
      j("/api/reprocess/status").catch(() => ({})),
      j("/api/sync/status").catch(() => ({})),
      j("/api/sources/status").catch(() => ({})),
    ]);
    setJobs({ retry, sync, sources });
    const now = retry.running || sync.running || sources.running;
    if (prevRunning.current && !now) { refreshTop(); setDataVersion((v) => v + 1); } // a job just finished
    prevRunning.current = now;
    jobTimer.current = setTimeout(poll, now ? 1500 : 10000);
  }, [refreshTop]);

  useEffect(() => { refreshTop(); pollJobs(); return () => clearTimeout(jobTimer.current); }, [refreshTop, pollJobs]);
  useEffect(() => { const t = setInterval(refreshTop, 25000); return () => clearInterval(t); }, [refreshTop]);

  const openLead = useCallback((url, name) => setDrawer({ url, name }), []);
  const openReverify = useCallback((url, el) => {
    const r = el.getBoundingClientRect();
    setMenu({ url, x: Math.min(r.left, window.innerWidth - 210), y: r.bottom + 5 });
  }, []);
  const refreshData = useCallback(() => setDataVersion((v) => v + 1), []);

  const ctx = { campaigns, stats, prospeo, jobs, dataVersion, refreshTop, pollJobs, openLead, openReverify, refreshData };
  const Body = BODIES[view];

  return (
    <DashContext.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand"><div className="mk"><Icon name="spark" /></div><div><b>InboxKit</b><span>GTM Engine</span></div></div>
          <nav>
            {TABS.map((t) => {
              const c = t.id === "campaigns" ? campaigns.length : t.cnt ? t.cnt(stats) : null;
              return (
                <div key={t.id} className={`nav-i${view === t.id ? " on" : ""}`} onClick={() => setView(t.id)}>
                  <Icon name={t.icon} />{t.label}{c != null && <span className="cnt">{num(c)}</span>}
                </div>
              );
            })}
          </nav>
        </aside>
        <main className="main">
          <Topbar title={TITLES[view]} stats={stats} prospeo={prospeo} />
          <div className="content"><Body /></div>
        </main>
      </div>
      <LeadDrawer lead={drawer} onClose={() => setDrawer(null)} />
      <ReverifyMenu menu={menu} onClose={() => setMenu(null)} onDone={() => { refreshTop(); refreshData(); }} />
    </DashContext.Provider>
  );
}
