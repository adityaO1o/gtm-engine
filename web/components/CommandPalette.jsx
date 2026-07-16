"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { num } from "@/lib/format";

// ⌘K / Ctrl-K launcher: jump to a tab or a campaign. Arrow keys + Enter, Esc closes.
export default function CommandPalette({ open, onClose, tabs, onTab, campaigns, onCampaign }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { if (open) { setQ(""); setIdx(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);

  const items = useMemo(() => {
    const list = [];
    tabs.forEach((t) => list.push({ type: "Navigate", label: t.label, icon: t.icon, run: () => onTab(t.id) }));
    campaigns.forEach((c) => list.push({ type: "Campaign", label: c.label, icon: "mega", sub: `${num(c.total)} leads`, run: () => onCampaign(c.campaign) }));
    const ql = q.trim().toLowerCase();
    return ql ? list.filter((x) => x.label.toLowerCase().includes(ql)) : list;
  }, [q, tabs, campaigns, onTab, onCampaign]);

  useEffect(() => { if (idx > items.length - 1) setIdx(0); }, [items.length, idx]);
  if (!open) return null;

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[idx]?.run(); onClose(); }
    else if (e.key === "Escape") onClose();
  };
  let lastType = null;
  return (
    <div className="cmdk-ov" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKey} placeholder="Jump to a tab or campaign…" />
        <div className="cmdk-list">
          {items.length ? items.map((it, i) => {
            const showHead = it.type !== lastType;
            lastType = it.type;
            return (
              <div key={i}>
                {showHead && <div className="cmdk-sec">{it.type}</div>}
                <div className={`cmdk-i${i === idx ? " on" : ""}`} onMouseEnter={() => setIdx(i)} onClick={() => { it.run(); onClose(); }}>
                  <Icon name={it.icon} />{it.label}{it.sub ? <span className="k">{it.sub}</span> : null}
                </div>
              </div>
            );
          }) : <div className="cmdk-i muted">No matches</div>}
        </div>
        <div className="cmdk-hint"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
      </div>
    </div>
  );
}
