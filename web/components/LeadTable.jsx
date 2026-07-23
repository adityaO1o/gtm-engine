import Icon from "@/components/Icon";
import { num, ts } from "@/lib/format";
import { StatusBadge, EmailPill, MethodLabel, VerifiedCell, SourceCell } from "@/lib/cells";

export default function LeadTable({ rows, selected, toggle, toggleAll, onRowClick, onReverify, loading, sort, onSort, selectingAll, count }) {
  if (loading && !rows.length) {
    return <div className="tablewrap"><div className="loading"><span className="spin" />Loading leads…</div></div>;
  }
  if (!rows.length) {
    return (
      <div className="tablewrap">
        <div className="empty"><Icon name="users" /><b>No leads here</b>Nothing matches this view yet.</div>
      </div>
    );
  }
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.linkedin_url));
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th className="chkcol" title={count ? `Selects all ${count.toLocaleString()} matching this filter, not just this page` : ""}><input type="checkbox" className="chk" disabled={selectingAll} checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} /></th>
            <th>Person</th><th>Company</th><th>Status</th>
            <th className={onSort ? "sortable" : ""} onClick={() => onSort && onSort("score")}>Score{sort === "score" && <span className="sortarrow">▼</span>}</th>
            <th>Email</th><th>Found by</th><th>Verified</th><th>Source</th><th>Categories</th><th>Seen</th>
            <th className={onSort ? "sortable" : ""} onClick={() => onSort && onSort("recent")}>Last seen{sort === "recent" && <span className="sortarrow">▼</span>}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.linkedin_url} className="click" onClick={() => onRowClick(x.linkedin_url, x.name)}>
              <td className="chkcol" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" className="chk" checked={selected.has(x.linkedin_url)} onChange={() => toggle(x.linkedin_url)} />
              </td>
              <td>
                <span className="nm trunc" title={x.name}>{x.name || "—"}</span>
                {x.email ? <span className="em trunc mono" title={x.email}>{x.email}</span> : null}
              </td>
              <td><span className="trunc sm muted" title={x.company || ""}>{x.company || ""}</span></td>
              <td><StatusBadge s={x.status} /></td>
              <td className="score">{x.score ?? 0}</td>
              <td>
                <EmailPill s={x.email_status} />
                {x.recovered ? <span className="tag-rec"><Icon name="check" />rec</span> : null}
                {x.personal_email ? <span className="tag-pers">personal</span> : null}
                {x.dnc ? <span className="tag-dnc" title="On SendKit DNC — will never be emailed">DNC</span> : null}
              </td>
              <td><MethodLabel m={x.email_method} /></td>
              <td onClick={(e) => e.stopPropagation()}><VerifiedCell r={x} onReverify={onReverify} /></td>
              <td><SourceCell x={x} /></td>
              <td><div className="cats">{(x.categories || []).map((c) => <span key={c} className="cat">{c}</span>)}</div></td>
              <td className="tstamp">{x.times_seen || 1}×</td>
              <td className="tstamp">{ts(x.last_engagement_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
