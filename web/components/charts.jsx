"use client";
import { useRef, useState } from "react";
import { num } from "@/lib/format";

// Donut with hover — a segment lifts + dims the rest, and the centre shows that slice's value/label.
export function Donut({ segs }) {
  const [hi, setHi] = useState(-1);
  const total = segs.reduce((a, s) => a + s.value, 0) || 1;
  const cx = 60, cy = 60, r = 46, w = 18;
  let a0 = -Math.PI / 2;
  const arcs = [];
  segs.forEach((s, i) => {
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    if (s.value > 0) {
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      arcs.push({ i, color: s.color, d: `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}` });
    }
    a0 = a1;
  });
  const shown = hi >= 0 ? segs[hi] : null;
  return (
    <svg viewBox="0 0 120 120" width="120" height="120">
      {arcs.map((a) => (
        <path key={a.i} d={a.d} stroke={a.color} strokeWidth={hi === a.i ? w + 3 : w} fill="none"
          opacity={hi < 0 || hi === a.i ? 1 : 0.32} style={{ transition: "stroke-width .12s,opacity .12s", cursor: "pointer" }}
          onMouseEnter={() => setHi(a.i)} onMouseLeave={() => setHi(-1)} />
      ))}
      <text x="60" y={shown ? 57 : 65} textAnchor="middle" fontSize="20" fontWeight="600" fill="currentColor" fontFamily="PlexNum, Suisse">{num(shown ? shown.value : total)}</text>
      {shown && <text x="60" y="72" textAnchor="middle" fontSize="9" style={{ fill: "var(--dim)" }} fontFamily="Suisse">{shown.label}</text>}
    </svg>
  );
}

// Area chart with a hover guide-line + tooltip (Total / Verified at that point).
export function Area({ series }) {
  const [hi, setHi] = useState(-1);
  const ref = useRef(null);
  if (!series?.length) return <div className="muted" style={{ padding: "40px 0", textAlign: "center" }}>Not enough data yet</div>;
  const W = 600, H = 150, pad = 6, max = Math.max(1, ...series.map((s) => s.total));
  const X = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, series.length - 1);
  const Y = (v) => H - pad - (v / max) * (H - 2 * pad);
  const poly = (key) => series.map((s, i) => `${X(i)},${Y(s[key])}`).join(" ");
  const onMove = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const step = (W - 2 * pad) / Math.max(1, series.length - 1);
    setHi(Math.max(0, Math.min(series.length - 1, Math.round((x - pad) / step))));
  };
  const p = hi >= 0 ? series[hi] : null;
  return (
    <div style={{ position: "relative" }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHi(-1)} style={{ display: "block" }}>
        <polygon points={`${X(0)},${H - pad} ${poly("total")} ${X(series.length - 1)},${H - pad}`} fill="#6C47FF" opacity="0.09" />
        <polyline points={poly("total")} fill="none" stroke="#6C47FF" strokeWidth="2" />
        <polyline points={poly("verified")} fill="none" stroke="#0C8A45" strokeWidth="2" />
        {p && (
          <g>
            <line x1={X(hi)} y1={pad} x2={X(hi)} y2={H - pad} style={{ stroke: "var(--line)" }} strokeWidth="1" />
            <circle cx={X(hi)} cy={Y(p.total)} r="3.5" fill="#6C47FF" />
            <circle cx={X(hi)} cy={Y(p.verified)} r="3.5" fill="#0C8A45" />
          </g>
        )}
      </svg>
      {p && (
        <div className="charttip" style={{ left: `${(X(hi) / W) * 100}%` }}>
          <div className="tt-d">{p.date || p.day || p.label || `Point ${hi + 1}`}</div>
          <div><i style={{ background: "#6C47FF" }} />Total <b>{num(p.total)}</b></div>
          <div><i style={{ background: "#0C8A45" }} />Verified <b>{num(p.verified)}</b></div>
        </div>
      )}
    </div>
  );
}
