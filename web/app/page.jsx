"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import Topbar from "@/components/Topbar";
import Overview from "@/components/Overview";
import { num } from "@/lib/format";
import { j } from "@/lib/api";

// Sidebar tabs. Ported tabs render their component; the rest show a placeholder until migrated.
const TABS = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "leads", label: "Leads", icon: "users", cnt: (s) => s.total },
  { id: "handoff", label: "Hand-off", icon: "inbox", cnt: (s) => s.noEmail },
  { id: "review", label: "Review", icon: "warn", cnt: (s) => s.review },
  { id: "competitors", label: "Competitors", icon: "flag", cnt: (s) => s.competitor },
  { id: "campaigns", label: "Campaigns", icon: "mega", cnt: () => null },
  { id: "sources", label: "Sources", icon: "radio" },
];

function Placeholder({ label }) {
  return (
    <div className="tablewrap">
      <div className="empty">
        <Icon name="spark" />
        <b>{label} — coming soon</b>
        This tab is being migrated to the new dashboard. Use the current dashboard meanwhile.
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [view, setView] = useState("overview");
  const [stats, setStats] = useState({});
  const [campaigns, setCampaigns] = useState([]);
  const [prospeo, setProspeo] = useState(null);

  async function loadTop() {
    const [d, s] = await Promise.all([j("/api/campaigns"), j("/api/stats")]);
    setCampaigns(d.campaigns || []);
    setProspeo(d.prospeo || null);
    setStats(s);
  }
  useEffect(() => { loadTop(); }, []);

  const title = TABS.find((t) => t.id === view)?.label || "Overview";
  const cntFor = (t) => {
    if (t.id === "campaigns") return campaigns.length;
    return t.cnt ? t.cnt(stats) : null;
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="mk"><Icon name="spark" /></div>
          <div><b>InboxKit</b><span>GTM Engine</span></div>
        </div>
        <nav>
          {TABS.map((t) => {
            const c = cntFor(t);
            return (
              <div key={t.id} className={`nav-i${view === t.id ? " on" : ""}`} onClick={() => setView(t.id)}>
                <Icon name={t.icon} />{t.label}
                {c != null && <span className="cnt">{num(c)}</span>}
              </div>
            );
          })}
        </nav>
      </aside>

      <main className="main">
        <Topbar title={title} stats={stats} prospeo={prospeo} />
        <div className="content">
          {view === "overview" ? <Overview /> : <Placeholder label={title} />}
        </div>
      </main>
    </div>
  );
}
