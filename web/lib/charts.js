// SVG chart builders — ported verbatim from the vanilla dashboard (proven geometry). They return
// an SVG string; components render them via dangerouslySetInnerHTML (static, self-contained SVG).
import { num } from "./format";

export function donut(segs) {
  const total = segs.reduce((a, s) => a + s.value, 0) || 1;
  let a0 = -Math.PI / 2;
  const cx = 60, cy = 60, r = 46, w = 18;
  let paths = "";
  for (const s of segs) {
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    if (s.value > 0) {
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      paths += `<path d="M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}" stroke="${s.color}" stroke-width="${w}" fill="none"/>`;
    }
    a0 = a1;
  }
  return `<svg viewBox="0 0 120 120" width="120" height="120">${paths}<text x="60" y="65" text-anchor="middle" font-size="20" font-weight="600" fill="#15151C" font-family="PlexNum, Suisse">${num(total)}</text></svg>`;
}

export function area(series) {
  if (!series || !series.length) return '<div class="muted" style="padding:40px 0;text-align:center">Not enough data yet</div>';
  const W = 600, H = 150, pad = 6, max = Math.max(1, ...series.map((s) => s.total));
  const X = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, series.length - 1);
  const Y = (v) => H - pad - (v / max) * (H - 2 * pad);
  const line = (key, color, fill) => {
    const pts = series.map((s, i) => `${X(i)},${Y(s[key])}`).join(" ");
    return (fill ? `<polygon points="${X(0)},${H - pad} ${pts} ${X(series.length - 1)},${H - pad}" fill="${color}" opacity="0.09"/>` : "") + `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`;
  };
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${line("total", "#6C47FF", true)}${line("verified", "#0C8A45", false)}</svg>`;
}

export function funnel(f) {
  const steps = [["Scraped", f.scraped], ["Email found", f.emailFound], ["Verified", f.verified], ["Pushed", f.verified]];
  const max = Math.max(1, f.scraped);
  return steps.map(([l, v]) => `<div class="funnel-row"><span class="lbl">${l}</span><span class="track"><i style="width:${(v / max) * 100}%"></i></span><span class="num">${num(v)}</span></div>`).join("");
}
