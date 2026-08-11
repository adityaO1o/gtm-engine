"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import Topbar from "@/components/Topbar";
import Overview from "@/components/Overview";
import Leads from "@/components/Leads";
import Handoff from "@/components/Handoff";
import Review from "@/components/Review";
import Competitors from "@/components/Competitors";
import Campaigns from "@/components/Campaigns";
import Sources from "@/components/Sources";
import Campaign from "@/components/Campaign";
import Reports from "@/components/Reports";
import Agencies from "@/components/Agencies";
import LeadDrawer from "@/components/LeadDrawer";
import ReverifyMenu from "@/components/ReverifyMenu";
import CommandPalette from "@/components/CommandPalette";
import { num } from "@/lib/format";
import { j } from "@/lib/api";
import { DashContext } from "@/lib/ctx";
import { ToastProvider } from "@/lib/toast";

const TABS = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "leads", label: "Leads", icon: "users", cnt: (s) => s.total },
  { id: "handoff", label: "Hand-off", icon: "inbox", cnt: (s) => s.noEmail },
  { id: "review", label: "Review", icon: "warn", cnt: (s) => s.review },
  { id: "competitors", label: "Competitors", icon: "flag", cnt: (s) => s.competitor },
  { id: "campaigns", label: "Campaigns", icon: "mega" },
  { id: "sources", label: "Sources", icon: "radio" },
  { id: "campaign", label: "Blacklist Campaign", icon: "spark" },
  { id: "reports", label: "Reports", icon: "shield" },
  { id: "agencies", label: "Agencies", icon: "flag" },
];
const TITLES = { overview: "Overview", leads: "Leads", handoff: "Hand-off · No email", review: "Review · Decide these emails", competitors: "Competitors", campaigns: "Campaigns", sources: "Sources", campaign: "Blacklist Campaign · seed domains → blacklisted infra → contacts", reports: "Reports · shareable blacklist proof for prospects", agencies: "Agencies · their case studies → their clients → blacklisted infra" };
const BODIES = { overview: Overview, leads: Leads, handoff: Handoff, review: Review, competitors: Competitors, campaigns: Campaigns, sources: Sources, campaign: Campaign, reports: Reports, agencies: Agencies };

export default function Dashboard() {
  const [view, setView] = useState("overview");
  // Remember the last tab across refreshes. Restore on mount (not via a lazy initializer, so the
  // prerendered "overview" and first client render match — no hydration mismatch), then persist.
  useEffect(() => { try { const s = localStorage.getItem("gtm.view"); if (s && TABS.some((t) => t.id === s)) setView(s); } catch { /* ignore */ } }, []);
  useEffect(() => { try { localStorage.setItem("gtm.view", view); } catch { /* ignore */ } }, [view]);
  const [stats, setStats] = useState({});
  const [campaigns, setCampaigns] = useState([]);
  const [prospeo, setProspeo] = useState(null);
  const [jobs, setJobs] = useState({ retry: {}, sync: {}, sources: {} });
  const [drawer, setDrawer] = useState(null);
  const [menu, setMenu] = useState(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [cmdk, setCmdk] = useState(false);
  const [pendingCampaign, setPendingCampaign] = useState(null);
  // Which teammate's SendKit workspace campaign leads get pushed into. Purely a push target — the
  // LinkedIn-engagement pipeline always uses the server's default workspace regardless of this.
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState("");
  useEffect(() => {
    j("/api/sendkit/workspaces").then((d) => {
      const items = d.items || [];
      setWorkspaces(items);
      let saved = "";
      try { saved = localStorage.getItem("gtm.workspace") || ""; } catch { /* ignore */ }
      setWorkspaceId(items.some((w) => w.id === saved) ? saved : (items[0]?.id ?? ""));
    }).catch(() => {});
  }, []);
  const chooseWorkspace = useCallback((id) => {
    setWorkspaceId(id);
    try { localStorage.setItem("gtm.workspace", id); } catch { /* ignore */ }
  }, []);
  const jobTimer = useRef(null);
  const prevRunning = useRef(false);

  // Fetch stats and campaigns INDEPENDENTLY — Overview + the sidebar counts depend on stats, so
  // don't make them wait on the heavier /api/campaigns (they used to be Promise.all'd together).
  const refreshTop = useCallback(() => {
    j("/api/stats").then(setStats).catch(() => {});
    j("/api/campaigns").then((d) => { setCampaigns(d.campaigns || []); setProspeo(d.prospeo || null); }).catch(() => {});
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
    if (prevRunning.current && !now) { refreshTop(); setDataVersion((v) => v + 1); }
    prevRunning.current = now;
    jobTimer.current = setTimeout(poll, now ? 1500 : 10000);
  }, [refreshTop]);

  useEffect(() => { refreshTop(); pollJobs(); return () => clearTimeout(jobTimer.current); }, [refreshTop, pollJobs]);
  useEffect(() => { const t = setInterval(refreshTop, 25000); return () => clearInterval(t); }, [refreshTop]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdk((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openLead = useCallback((url, name) => setDrawer({ url, name }), []);
  const openReverify = useCallback((url, el) => {
    const r = el.getBoundingClientRect();
    setMenu({ url, x: Math.min(r.left, window.innerWidth - 210), y: r.bottom + 5 });
  }, []);
  const refreshData = useCallback(() => setDataVersion((v) => v + 1), []);
  const openCampaign = useCallback((key) => { setPendingCampaign(key); setView("campaigns"); }, []);
  const clearPending = useCallback(() => setPendingCampaign(null), []);

  const ctx = useMemo(() => ({
    campaigns, stats, prospeo, jobs, dataVersion, pendingCampaign, workspaces, workspaceId,
    refreshTop, pollJobs, openLead, openReverify, refreshData, openCampaign, clearPending,
  }), [campaigns, stats, prospeo, jobs, dataVersion, pendingCampaign, workspaces, workspaceId, refreshTop, pollJobs, openLead, openReverify, refreshData, openCampaign, clearPending]);

  const Body = BODIES[view];

  return (
    <ToastProvider>
      <DashContext.Provider value={ctx}>
        <div className="app">
          <aside className="sidebar">
            <div className="brand"><div className="mk"><Icon name="spark" /></div><div><b>InboxKit</b><span>GTM Engine</span></div></div>
            {workspaces.length > 1 ? (
              <div className="wsw">
                <div className="wsw-k">Send leads to</div>
                {workspaces.map((w) => (
                  <div key={w.id} className={`wsw-i${workspaceId === w.id ? " on" : ""}`} onClick={() => chooseWorkspace(w.id)}>
                    <Icon name={workspaceId === w.id ? "check" : "mega"} />{w.label}
                  </div>
                ))}
              </div>
            ) : null}
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
            <Topbar title={TITLES[view]} stats={stats} prospeo={prospeo} onCmdK={() => setCmdk(true)} onRefreshBalances={refreshTop} />
            <div className="content" key={view}><Body /></div>
          </main>
        </div>
        <LeadDrawer lead={drawer} onClose={() => setDrawer(null)} />
        <ReverifyMenu menu={menu} onClose={() => setMenu(null)} onDone={() => { refreshTop(); refreshData(); }} />
        <CommandPalette open={cmdk} onClose={() => setCmdk(false)} tabs={TABS} campaigns={campaigns}
          onTab={(id) => setView(id)} onCampaign={openCampaign} />
      </DashContext.Provider>
    </ToastProvider>
  );
}
