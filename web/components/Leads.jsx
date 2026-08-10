"use client";
import { useState } from "react";
import { useDash } from "@/lib/ctx";
import { useLeadList } from "@/hooks/useLeadList";
import { j, post } from "@/lib/api";
import { useToast } from "@/lib/toast";
import LeadToolbar from "./LeadToolbar";
import LeadTable from "./LeadTable";
import Pager from "./Pager";

export default function Leads() {
  const { campaigns, openLead, openReverify, refreshTop } = useDash();
  const toast = useToast();
  const L = useLeadList();
  const [backfillingDomains, setBackfillingDomains] = useState(false);
  const [purgingIcp, setPurgingIcp] = useState(false);
  const exportFiltered = () => { const p = L.query(); p.delete("limit"); p.delete("skip"); window.location = "/api/export?" + p.toString(); };
  const exportSelected = () => { if (!L.selected.size) return; window.location = "/api/export?urls=" + [...L.selected].map(encodeURIComponent).join(","); };
  const setFilter = (k, v) => { L.setFilter(k, v); if (k === "campaign" || k === "email") refreshTop(); };

  // Fill company_domain on leads that don't have one (email @-domain, then Clearbit on name). Runs in
  // the background on the server; poll its status and refetch the table when it finishes.
  const backfillDomains = async () => {
    if (backfillingDomains) return;
    setBackfillingDomains(true);
    try {
      const r = await post("/api/leads/backfill-domains", {});
      if (!r.ok) { toast(r.error || "Backfill failed", "bad"); setBackfillingDomains(false); return; }
      toast("Filling company domains… running in the background", "info");
      const poll = async () => {
        const s = await j("/api/leads/backfill-domains/status").catch(() => null);
        if (s && !s.running) {
          setBackfillingDomains(false);
          if (s.last) toast(`Domains filled — ${s.last.fromEmail} from email, ${s.last.fromName} from name`, "good");
          L.refresh();
          return;
        }
        setTimeout(poll, 2500);
      };
      setTimeout(poll, 2500);
    } catch { toast("Backfill failed", "bad"); setBackfillingDomains(false); }
  };

  // Sweep existing leads: move anyone now out-of-ICP out of hot/warm (and DNC any already in a
  // campaign). Runs in the background on the server; poll and refetch the table when it finishes.
  const purgeIcp = async () => {
    if (purgingIcp) return;
    if (!window.confirm(
      "Sweep all existing leads and move anyone now out-of-ICP (big tech, banks, …) out of hot/warm?\n\n" +
      "They're kept but marked out-of-icp and never sent; any already in a SendKit campaign get DNC'd. This can't be auto-undone."
    )) return;
    setPurgingIcp(true);
    try {
      const r = await post("/api/leads/reclassify-icp", {});
      if (!r.ok) { toast(r.error || "Purge failed", "bad"); setPurgingIcp(false); return; }
      toast("Scanning leads for non-ICP… running in the background", "info");
      const poll = async () => {
        const s = await j("/api/leads/reclassify-icp/status").catch(() => null);
        if (s && !s.running) {
          setPurgingIcp(false);
          if (s.last) toast(`Purged ${s.last.flagged} non-ICP leads (${s.last.dnc} DNC'd)`, "good");
          refreshTop(); L.refresh();
          return;
        }
        setTimeout(poll, 3000);
      };
      setTimeout(poll, 3000);
    } catch { toast("Purge failed", "bad"); setPurgingIcp(false); }
  };

  return (
    <>
      <LeadToolbar filters={L.filters} setFilter={setFilter} count={L.data.count} campaigns={campaigns} withCampaign
        selectedSize={L.selected.size} onSelectAll={() => L.toggleAll(true)} selectingAll={L.selectingAll}
        onSelectPage={L.selectPage} onExportFiltered={exportFiltered} onExportSelected={exportSelected}
        onBackfillDomains={backfillDomains} backfillingDomains={backfillingDomains}
        onPurgeIcp={purgeIcp} purgingIcp={purgingIcp} />
      <LeadTable rows={L.data.rows} loading={L.loading} selected={L.selected} toggle={L.toggle} toggleAll={L.toggleAll} onRowClick={openLead} onReverify={openReverify} sort={L.filters.sort} onSort={(f) => L.setFilter("sort", f)} selectingAll={L.selectingAll} count={L.data.count} />
      <Pager count={L.data.count} page={L.page} setPage={L.setPage} size={L.size} setSize={L.setSize} />
    </>
  );
}
