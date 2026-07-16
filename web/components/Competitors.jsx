"use client";
import Icon from "@/components/Icon";
import { num } from "@/lib/format";
import { useDash } from "@/lib/ctx";
import { useLeadList } from "@/hooks/useLeadList";
import LeadTable from "./LeadTable";
import Pager from "./Pager";

export default function Competitors() {
  const { openLead, openReverify } = useDash();
  const L = useLeadList({ email: "competitor" });
  const count = L.data.count;
  const exportComp = () => { const p = L.query(); p.delete("limit"); p.delete("skip"); window.location = "/api/export?" + p.toString(); };
  return (
    <>
      <div className="note"><Icon name="flag" /><div>Engagers who work at a competitor (matched by company or email domain). Saved for your review — <b>never sent to SendKit</b>.</div></div>
      <div className="toolbar">
        <div className="grow" />
        <span className="resn"><b>{num(count)}</b> result{count === 1 ? "" : "s"}</span>
        <button className="btn btn-ghost btn-sm" onClick={L.selectPage}><Icon name="check" />Select all</button>
        <button className="btn btn-ghost btn-sm" onClick={exportComp}><Icon name="download" />Export</button>
      </div>
      <LeadTable rows={L.data.rows} selected={L.selected} toggle={L.toggle} toggleAll={L.toggleAll} onRowClick={openLead} onReverify={openReverify} />
      <Pager count={count} page={L.page} setPage={L.setPage} size={L.size} setSize={L.setSize} />
    </>
  );
}
