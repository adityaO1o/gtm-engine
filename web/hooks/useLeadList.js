"use client";
import { useCallback, useEffect, useState } from "react";
import { j } from "@/lib/api";
import { useDash } from "@/lib/ctx";

// Centralises the lead-list logic (filters → query → fetch, pagination, selection) used by
// Leads / Review / Competitors / Campaign-detail. `fixed` locks filters a tab always applies.
export function useLeadList(fixed = {}) {
  const [filters, setFilters] = useState({
    status: "", email: "", cat: "", campaign: "", q: "", sort: "score", recovered: "", dnc: "", source: "", list: "", ...fixed,
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
    ["status", "campaign", "cat", "sort", "q", "recovered", "dnc", "source", "list"].forEach((k) => {
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
  const toggleAll = (checked) => setSelected(() => (checked ? new Set(data.rows.map((r) => r.linkedin_url)) : new Set()));
  const selectPage = () => setSelected(new Set(data.rows.map((r) => r.linkedin_url)));
  const clearSel = () => setSelected(new Set());

  return { filters, setFilter, page, setPage, size, setSize, data, loading, refresh, selected, toggle, toggleAll, selectPage, clearSel, query };
}
