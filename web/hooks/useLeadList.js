"use client";
import { useCallback, useEffect, useState } from "react";
import { j } from "@/lib/api";
import { useDash } from "@/lib/ctx";

// Centralises the lead-list logic (filters → query → fetch, pagination, selection) used by
// Leads / Review / Competitors / Campaign-detail. `fixed` locks filters a tab always applies.
export function useLeadList(fixed = {}) {
  const [filters, setFilters] = useState({
    status: "", email: "", cat: "", campaign: "", q: "", sort: "score", recovered: "", dnc: "", source: "", list: "", bucket: "", ...fixed,
  });
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);
  const [data, setData] = useState({ rows: [], count: 0 });
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const { dataVersion } = useDash() || {}; // bumped after reverify/decision/job-finish → refetch

  const query = useCallback(() => {
    const p = new URLSearchParams();
    let f = { ...filters };
    if (f.source === "manual-post") f = { ...f, source: "", list: "manual-post" };
    ["status", "campaign", "cat", "sort", "q", "recovered", "dnc", "source", "list", "bucket"].forEach((k) => {
      if (f[k]) p.set(k === "cat" ? "category" : k, f[k]);
    });
    if (f.email) p.set("email_status", f.email);
    p.set("limit", size);
    p.set("skip", page * size);
    return p;
  }, [filters, page, size]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await j("/api/leads?" + query().toString());
      setData({ rows: d.rows || [], count: d.count || 0 });
    } finally { setLoading(false); }
  }, [query]);

  useEffect(() => { refresh(); }, [refresh, dataVersion]);

  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(0); };
  const toggle = (url) => setSelected((s) => { const n = new Set(s); n.has(url) ? n.delete(url) : n.add(url); return n; });
  // The header checkbox used to select only the rows on screen, which quietly meant "select 100"
  // when the filter matched 800 — and every bulk action then applied to the wrong set. It now asks
  // the server for every id matching the CURRENT filter.
  const [selectingAll, setSelectingAll] = useState(false);
  const toggleAll = async (checked) => {
    if (!checked) return setSelected(new Set());
    setSelectingAll(true);
    try {
      const p = query();
      p.delete("limit"); p.delete("skip");
      const d = await j("/api/leads/ids?" + p.toString());
      setSelected(new Set(d.ids || []));
    } catch {
      setSelected(new Set(data.rows.map((r) => r.linkedin_url))); // fall back to the page
    }
    setSelectingAll(false);
  };
  const selectPage = () => setSelected(new Set(data.rows.map((r) => r.linkedin_url)));
  const clearSel = () => setSelected(new Set());
  // Optimistic: drop rows immediately (e.g. after approve/discard) before the server confirms.
  const removeRows = (urls) => setData((d) => ({ rows: d.rows.filter((r) => !urls.includes(r.linkedin_url)), count: Math.max(0, d.count - urls.length) }));

  return { filters, setFilter, page, setPage, size, setSize, data, loading, refresh, selected, toggle, toggleAll, selectPage, clearSel, removeRows, query, selectingAll };
}
