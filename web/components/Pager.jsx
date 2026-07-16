import { num } from "@/lib/format";

export default function Pager({ count, page, setPage, size, setSize }) {
  const from = count ? page * size + 1 : 0;
  const to = Math.min(count, (page + 1) * size);
  const last = Math.max(0, Math.ceil(count / size) - 1);
  return (
    <div className="pager">
      <span>Rows</span>
      <select value={size} onChange={(e) => { setSize(+e.target.value); setPage(0); }}>
        {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <span>{num(from)}–{num(to)} of {num(count)}</span>
      <button className="btn btn-ghost btn-sm" disabled={page <= 0} onClick={() => setPage(Math.max(0, page - 1))}>Prev</button>
      <button className="btn btn-ghost btn-sm" disabled={page >= last} onClick={() => setPage(page + 1)}>Next</button>
    </div>
  );
}
