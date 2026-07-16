// Shared table-cell renderers — ported from the vanilla helpers, as JSX.
import Icon from "@/components/Icon";
import { cap } from "./format";

const STATUS_ICON = { hot: "bolt", warm: "warn", cold: "" };
const EMAIL_ICON = { verified: "check", "no-email": "x", review: "warn", competitor: "flag", unverified: "warn", "role-based": "x" };

export function StatusBadge({ s }) {
  s = s || "cold";
  return <span className={`badge b-${s}`}>{STATUS_ICON[s] ? <Icon name={STATUS_ICON[s]} /> : null}{s}</span>;
}
export function EmailPill({ s }) {
  s = s || "no-email";
  return <span className={`pill p-${s}`}><Icon name={EMAIL_ICON[s] || "x"} />{s}</span>;
}
export function MethodLabel({ m }) {
  if (!m) return <span className="muted">—</span>;
  const [p, how] = m.split(":");
  return <span className="src"><b>{p === "enrich" ? "Enrich" : "Prospeo"}</b> · {how === "name+domain" ? "name+domain" : how === "url" ? "URL" : how}</span>;
}
export function SourceCell({ x }) {
  if (x.source === "influencer") return <span className="srcpill src-inf" title={`Influencer post${x.source_list ? " · " + x.source_list : ""}`}>{x.source_list || "Influencer"}</span>;
  if (x.source === "hub") return <span className="srcpill src-hub" title={`Hub: ${x.source_list || ""}`}>{`Hub${x.source_list ? " · " + x.source_list : ""}`}</span>;
  return <span className="srcpill src-kw">Keyword</span>;
}
export function VerifiedCell({ r, onReverify }) {
  if (!r.email) return <span className="muted">—</span>;
  return (
    <span className="prov-chip" onClick={(e) => { e.stopPropagation(); onReverify(r.linkedin_url, e.currentTarget); }}>
      <Icon name="check" />{r.verified_by ? cap(r.verified_by) : "verify"}<Icon name="chev" />
    </span>
  );
}
