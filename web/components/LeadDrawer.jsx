"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { j } from "@/lib/api";

// Always mounted (for the slide transition); `lead` null = closed.
export default function LeadDrawer({ lead, onClose }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!lead) return;
    setRows([]);
    j("/api/leads/" + encodeURIComponent(lead.url) + "/timeline").then((d) => setRows(d.rows || [])).catch(() => setRows([]));
  }, [lead]);
  return (
    <div className={`drawer${lead ? " open" : ""}`}>
      <span className="x" onClick={onClose}><Icon name="x" style={{ width: 20, height: 20, stroke: "var(--dim)" }} /></span>
      <h3>{lead?.name || "—"}</h3>
      <div className="muted mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{lead?.url}</div>
      <div style={{ marginTop: "var(--s4)" }}>
        {rows.length ? rows.map((e, i) => (
          <div key={i} className="tl">
            <div><strong>{e.category}</strong> · {e.engagement}</div>
            <div className="c">{e.campaign || ""} · {new Date(e.created_at).toLocaleString()}</div>
            {e.comment_text ? <div className="c">“{e.comment_text}”</div> : null}
            <div className="c"><a href={e.post_url} target="_blank" rel="noopener">post ↗</a></div>
          </div>
        )) : <div className="muted">{lead ? "…" : "no timeline"}</div>}
      </div>
    </div>
  );
}
