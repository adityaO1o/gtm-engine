"use client";
import { useDash } from "@/lib/ctx";
import { useLeadList } from "@/hooks/useLeadList";
import LeadToolbar from "./LeadToolbar";
import LeadTable from "./LeadTable";
import Pager from "./Pager";

export default function Leads() {
  const { campaigns, openLead, openReverify, refreshTop } = useDash();
  const L = useLeadList();
  const exportFiltered = () => { const p = L.query(); p.delete("limit"); p.delete("skip"); window.location = "/api/export?" + p.toString(); };
  const exportSelected = () => { if (!L.selected.size) return; window.location = "/api/export?urls=" + [...L.selected].map(encodeURIComponent).join(","); };
  const setFilter = (k, v) => { L.setFilter(k, v); if (k === "campaign" || k === "email") refreshTop(); };
  return (
    <>
      <LeadToolbar filters={L.filters} setFilter={setFilter} count={L.data.count} campaigns={campaigns} withCampaign
        selectedSize={L.selected.size} onSelectPage={L.selectPage} onExportFiltered={exportFiltered} onExportSelected={exportSelected} />
      <LeadTable rows={L.data.rows} loading={L.loading} selected={L.selected} toggle={L.toggle} toggleAll={L.toggleAll} onRowClick={openLead} onReverify={openReverify} />
      <Pager count={L.data.count} page={L.page} setPage={L.setPage} size={L.size} setSize={L.setSize} />
    </>
  );
}
