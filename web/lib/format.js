export const num = (n) => (n ?? 0).toLocaleString();
export const ts = (d) => (d ? new Date(d).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : "");
export const pctOf = (done, total) => (total ? Math.min(100, Math.round((done / total) * 100)) : 0);
