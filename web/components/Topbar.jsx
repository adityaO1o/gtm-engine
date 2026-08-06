import { useState } from "react";
import { num } from "@/lib/format";
import Icon from "@/components/Icon";
import ThemeToggle from "@/components/ThemeToggle";
import { j } from "@/lib/api";

// Effective remaining = whichever cap (credits OR requests) is closest to 0 — RapidAPI blocks on either.
function effLeft(b) {
  if (!b) return null;
  const vals = [b.creditsRemaining, b.requestsRemaining].filter((v) => v !== null && v !== undefined);
  return vals.length ? Math.max(0, Math.min(...vals)) : null;
}

function BalChip({ label, b, note }) {
  if (!b) return null;
  const left = effLeft(b);
  const lim = b.creditsLimit || b.requestsLimit || 500;
  const tip = `${note} · REAL RapidAPI balance — credits ${num(Math.max(0, b.creditsRemaining))}/${num(b.creditsLimit || 0)}, requests ${num(Math.max(0, b.requestsRemaining))}/${num(b.requestsLimit || 0)}.`;
  return (
    <div className={`balc${left <= lim * 0.1 ? " warn" : ""}`} title={tip}>
      {label} · <b>{num(left)}</b> {`left / ${num(lim)}`}
    </div>
  );
}

// Only LIVE balances are shown. RapidAPI plans only reveal their remaining in a response header, so
// a provider we haven't called simply doesn't appear (better than a stale hand-entered number).
export default function Topbar({ title, stats, prospeo, onCmdK, onRefreshBalances }) {
  const [busy, setBusy] = useState(false);
  // The balances are cached server-side for 5 minutes, so right after a big run they read stale.
  // This forces a live re-read of every provider.
  async function refresh() {
    if (busy) return;
    setBusy(true);
    try { await j("/api/balances/refresh"); onRefreshBalances?.(); } catch { /* leave the old numbers */ }
    setBusy(false);
  }

  const bal = stats?.apiBalance || {};
  const bb = stats?.bounceban;
  return (
    <div className="topbar">
      <div className="crumb">
        <h2>{title}</h2>
      </div>
      <div className="grow" />
      <div className="bals" id="bals">
        {bb?.remaining != null && (
          <div className="balc" title="BounceBan — primary email verifier (live balance).">
            BounceBan · <b>{num(bb.remaining)}</b> left
          </div>
        )}
        <BalChip label="PND" b={bal.pnd} note="professional-network-data — scrape + profile + exact domain" />
        {prospeo && (
          <div className="balc" title="Prospeo email-finder credits (live).">
            Prospeo · <b>{num(prospeo.remaining)}</b> left
          </div>
        )}
        {/* Fresh only appears if a REAL response header ever populated it */}
        <BalChip label="Fresh" b={bal.fresh} note="Fresh scraper — legacy" />
        <button className="themebtn" title="Refresh credit balances (bypasses the 5-min cache)"
          onClick={refresh} disabled={busy}>
          {busy ? <span className="spin" style={{ width: 14, height: 14 }} /> : <Icon name="refresh" />}
        </button>
      </div>
      <button className="themebtn" title="Search — ⌘K / Ctrl-K" onClick={onCmdK}><Icon name="search" /></button>
      <ThemeToggle />
    </div>
  );
}
