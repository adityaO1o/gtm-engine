import Icon from "@/components/Icon";
import { num, pctOf } from "@/lib/format";

// Server-owned job progress (retry / sync / sources). Returns null when idle.
export default function JobBox({ kind, s }) {
  if (!s || (!s.running && !s.finishedAt)) return null;
  const C = {
    retry: { done: s.processed, total: s.total, verb: "Retrying", extra: <><b className="ok">{num(s.newlyFound || 0)}</b> emails recovered</> },
    sync: { done: s.processed, total: s.total, verb: "Syncing", extra: <><b className="ok">{num(s.pushed || 0)}</b> added · {num(s.alreadyIn || 0)} already in · <b>{num(s.dnc || 0)}</b> DNC’d · {num(s.failed || 0)} failed</> },
    sources: { done: s.postsProcessed, total: s.totalPosts, verb: "Scraping posts", extra: <><b>{num(s.uniqueEngagers || 0)}</b> unique people · <b className="ok">{num(s.newlyFound || 0)}</b> sent</> },
  }[kind];
  const done = C.done || 0, total = C.total || 0, pct = pctOf(done, total);
  const head = s.running
    ? <>{C.verb} <b>{num(done)}</b> / <b>{num(total)}</b> · {pct}% · {C.extra}{kind === "sources" && s.phase ? <span className="muted"> ({s.phase})</span> : null}</>
    : <>Done · {num(done)} processed · {C.extra}</>;
  const w = Math.max(s.running ? pct : 100, s.running ? 3 : 0);
  return (
    <div className={`jobbox${s.running ? " on" : ""}`}>
      <div className="jobh"><Icon name={s.running ? "refresh" : "check"} /><span>{head}</span></div>
      <div className={`prog${s.running ? " on" : ""}`}><i style={{ width: `${w}%` }} /></div>
    </div>
  );
}
