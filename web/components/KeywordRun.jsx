"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { num } from "@/lib/format";
import { j, post } from "@/lib/api";

// Shared plumbing for the two keyword runners — the automatic sweep (Campaigns tab, /api/keywords/sweep)
// and the manual one-off (Sources tab, /api/keywords/manual). They speak the same status shape and
// render the same job box, so both live here rather than being copy-pasted into each tab.

// Poll a runner's status endpoint. Two things the naive version got wrong:
//   • a single failed fetch must NOT null the status — that both blanked the panel mid-run and
//     ended the poll chain, so a transient 502 during a multi-hour sweep looked like "not running"
//     and re-offered the Run button while the server was still working.
//   • the timer must be ref-tracked and cleared on unmount, or every visit to the tab starts
//     another chain that keeps calling setState on an unmounted component.
export function useKeywordRun(base) {
  const [status, setStatus] = useState(null);
  const timer = useRef(null);
  const fails = useRef(0);
  const alive = useRef(true);

  const poll = useCallback(async function p() {
    const s = await j(`${base}/status`).catch(() => null);
    if (!alive.current) return;
    clearTimeout(timer.current);
    if (!s) {
      // Keep the last known status on screen and retry, but don't retry forever.
      fails.current += 1;
      if (fails.current <= 6) timer.current = setTimeout(p, 8000);
      return;
    }
    fails.current = 0;
    setStatus(s);
    if (s.running) timer.current = setTimeout(p, 4000);
  }, [base]);

  useEffect(() => {
    alive.current = true;
    poll();
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, [poll]);

  // Returns the parsed body so callers can surface {alreadyRunning} / {error} instead of assuming success.
  const start = useCallback(async (body) => {
    const r = await post(base, body || {});
    poll();
    return r;
  }, [base, poll]);

  const pause = useCallback(async () => { await post(`${base}/pause`, {}); poll(); }, [base, poll]);

  return { status, poll, start, pause };
}

// `done` / `total` are supplied by the caller because the two runners measure progress differently:
// the sweep by keywords (known up front), the manual run by posts (known only after its search).
export function KeywordRunBox({ s, done, total, runningLabel = "Running" }) {
  if (!s || (!s.running && !s.finishedAt)) return null;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const head = s.running ? runningLabel : s.phase === "paused" ? "Paused" : s.phase === "error" ? "Error" : "Done";
  return (
    <div className={`jobbox${s.running ? " on" : ""}`} style={{ marginTop: 10 }}>
      <div className="jobh"><Icon name={s.running ? "refresh" : s.phase === "error" ? "warn" : "check"} />
        <span><b>{head}</b>
          {s.keyword ? <> &middot; <b>{s.keyword}</b>{s.campaign ? <> &rarr; {s.campaign}</> : null}</> : null}
          {total ? <> &middot; {num(done)}/{num(total)}</> : null} &middot;{" "}
          <b>{num(s.postsScraped)}</b> posts scraped &middot; <b className="ok">{num(s.newEngagers)}</b> new engagers
          {s.skippedUnchanged ? <span className="muted"> &middot; {num(s.skippedUnchanged)} unchanged</span> : null}
          {s.skippedSmall ? <span className="muted"> &middot; {num(s.skippedSmall)} too small</span> : null}
          {s.creditsUsed != null ? <> &middot; <b>{num(s.creditsUsed)}</b> credits</> : null}
          {s.error ? <span className="muted"> &middot; {s.error}</span> : null}</span>
      </div>
      <div className={`prog${s.running ? " on" : ""}`}><i style={{ width: `${Math.max(pct, s.running ? 3 : 0)}%` }} /></div>
    </div>
  );
}
