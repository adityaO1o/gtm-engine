import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { num } from "@/lib/format";

const CATS = ["infra-competitor", "deliverability", "infra", "sequencer", "gtm-eng", "data-tools", "cold-email"];

// The leads filter toolbar. `q` is debounced locally so typing doesn't refetch every keystroke.
export default function LeadToolbar({ filters, setFilter, count, campaigns, withCampaign, selectedSize, onSelectAll, selectingAll, onSelectPage, onExportFiltered, onExportSelected }) {
  const [q, setQ] = useState(filters.q || "");
  useEffect(() => { setQ(filters.q || ""); }, [filters.q]);
  useEffect(() => {
    const t = setTimeout(() => { if (q !== filters.q) setFilter("q", q); }, 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line

  const Sel = ({ k, children }) => (
    <select value={filters[k]} onChange={(e) => setFilter(k, e.target.value)}>{children}</select>
  );

  // Status is multi-select: click Hot and Warm to see (and export) both together. Empty = all.
  const statuses = String(filters.status || "").split(",").filter(Boolean);
  const toggleStatus = (s) => {
    const next = statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s];
    setFilter("status", next.join(","));
  };
  const StatusChip = ({ s, label }) => (
    <span className={`chip${statuses.includes(s) ? " on" : ""}`} onClick={() => toggleStatus(s)}>{label}</span>
  );

  return (
    <div className="toolbar">
      {withCampaign && (
        <Sel k="campaign"><option value="">All campaigns</option>{campaigns.map((c) => <option key={c.campaign} value={c.campaign}>{c.label}</option>)}</Sel>
      )}
      <span className="chips" title="Click more than one to combine (e.g. Hot + Warm)">
        <StatusChip s="hot" label="Hot" />
        <StatusChip s="warm" label="Warm" />
        <StatusChip s="cold" label="Cold" />
        {statuses.length ? <span className="chip x" onClick={() => setFilter("status", "")}>clear</span> : null}
      </span>
      <Sel k="email"><option value="">All emails</option><option value="verified">Verified</option><option value="no-email">No email</option><option value="review">Review</option><option value="unverified">Unverified</option><option value="competitor">Competitor</option><option value="discarded">Discarded</option></Sel>
      <Sel k="cat"><option value="">All categories</option>{CATS.map((c) => <option key={c} value={c}>{c}</option>)}</Sel>
      <Sel k="source"><option value="">All sources</option><option value="keyword">Keyword</option><option value="influencer">Influencer/CSV</option><option value="hub">Hub</option><option value="manual-post">Manual post</option></Sel>
      <Sel k="recovered"><option value="">All</option><option value="1">Recovered</option></Sel>
      <Sel k="dnc"><option value="">All (DNC)</option><option value="1">DNC only</option></Sel>
      <Sel k="sort"><option value="score">Sort · score</option><option value="recent">Sort · recent</option></Sel>
      <input className="search" placeholder="Search name, email, company" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="grow" />
      <span className="resn"><b>{num(count)}</b> result{count === 1 ? "" : "s"}</span>
      {/* "Select all" means EVERY row matching the current filter (asks the server for all ids), not
          just the visible page. The old button quietly selected only the page — 50 of N. */}
      <button className="btn btn-ghost btn-sm" disabled={selectingAll || !count} onClick={onSelectAll}
        title={count ? `Selects all ${num(count)} matching this filter, not just this page` : ""}>
        <Icon name={selectingAll ? "refresh" : "check"} />{selectingAll ? "Selecting…" : `Select all${count ? ` (${num(count)})` : ""}`}
      </button>
      <button className="btn btn-ghost btn-sm" onClick={onSelectPage} title="Select only the rows on this page">Page</button>
      <button className="btn btn-ghost btn-sm" onClick={onExportFiltered}><Icon name="download" />Export</button>
      <button className="btn btn-sm" onClick={onExportSelected}><Icon name="download" />Selected · {selectedSize}</button>
    </div>
  );
}
