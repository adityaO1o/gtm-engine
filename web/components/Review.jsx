"use client";
import { useState } from "react";
import Icon from "@/components/Icon";
import { num } from "@/lib/format";
import { post } from "@/lib/api";
import { useDash } from "@/lib/ctx";
import { useLeadList } from "@/hooks/useLeadList";
import { MethodLabel } from "@/lib/cells";
import Pager from "./Pager";

export default function Review() {
  const { refreshTop } = useDash();
  const L = useLeadList({ email: "review" });
  const [msg, setMsg] = useState("");
  const rows = L.data.rows, count = L.data.count;

  async function decide(action, url) {
    const urls = url ? [url] : [...L.selected];
    if (!urls.length) { setMsg("Pick at least one lead first."); return; }
    setMsg(action === "approve" ? "Approving…" : "Discarding…");
    const r = await post("/api/leads/decision", { urls, action });
    if (!url) L.clearSel();
    await refreshTop();
    await L.refresh();
    setMsg(r.ok
      ? (action === "approve"
        ? `✓ Approved ${num(r.approved)} · pushed ${num(r.pushed)} into their campaigns`
        : `✓ Discarded ${num(r.discarded)}${r.dnc ? ` · ${num(r.dnc)} DNC'd (already in SendKit)` : ""}`)
      : `✗ ${r.error || "failed"}`);
  }

  const allChecked = rows.length > 0 && rows.every((x) => L.selected.has(x.linkedin_url));
  return (
    <>
      <div className="note"><Icon name="warn" /><div>Emails our <b>name-match guard</b> held back — the address doesn’t obviously belong to this person (email finders sometimes return the <b>wrong person’s</b> address). You decide.<br />
        <b>Approve</b> → marked verified and pushed into every campaign the lead is in. <b>Discard</b> → never sent (and DNC’d if it already reached SendKit).</div></div>
      <div className="toolbar">
        <span className="resn"><b>{num(count)}</b> to review · <b>{L.selected.size}</b> selected</span>
        <button className="btn btn-ghost btn-sm" onClick={L.selectPage}><Icon name="check" />Select all</button>
        <div className="grow" />
        <button className="btn btn-sm btn-ok" onClick={() => decide("approve")}><Icon name="check" />Approve selected</button>
        <button className="btn btn-sm btn-no" onClick={() => decide("discard")}><Icon name="x" />Discard selected</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{msg}</div>
      {rows.length ? (
        <>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="chkcol"><input type="checkbox" className="chk" checked={allChecked} onChange={(e) => L.toggleAll(e.target.checked)} /></th>
                  <th>Person / email</th><th>Company</th><th>Found by</th><th></th><th>Categories</th><th>Score</th><th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.linkedin_url}>
                    <td className="chkcol"><input type="checkbox" className="chk" checked={L.selected.has(x.linkedin_url)} onChange={() => L.toggle(x.linkedin_url)} /></td>
                    <td>
                      <span className="nm trunc" title={x.name}>{x.name || "—"}</span>
                      <span className="em trunc mono" title={x.email || ""}>{x.email || ""}</span>
                    </td>
                    <td><span className="trunc sm muted" title={x.company || ""}>{x.company || "—"}</span></td>
                    <td><MethodLabel m={x.email_method} /></td>
                    <td>{x.personal_email ? <span className="tag-pers">personal</span> : null}{x.dnc ? <span className="tag-dnc">DNC</span> : null}</td>
                    <td><div className="cats">{(x.categories || []).map((c) => <span key={c} className="cat">{c}</span>)}</div></td>
                    <td className="score">{x.score ?? 0}</td>
                    <td><div className="rowact">
                      <button className="btn btn-sm btn-ok" onClick={() => decide("approve", x.linkedin_url)}><Icon name="check" />Approve</button>
                      <button className="btn btn-sm btn-no" onClick={() => decide("discard", x.linkedin_url)}><Icon name="x" />Discard</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager count={count} page={L.page} setPage={L.setPage} size={L.size} setSize={L.setSize} />
        </>
      ) : (
        <div className="tablewrap"><div className="empty"><Icon name="check" /><b>Nothing to review</b>Every held-back email has been decided.</div></div>
      )}
    </>
  );
}
