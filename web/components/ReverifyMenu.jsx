"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { post } from "@/lib/api";

// Popover from the "Verified" chip. `menu` = { url, x, y } | null.
export default function ReverifyMenu({ menu, onClose, onDone }) {
  const [res, setRes] = useState(null);
  useEffect(() => { setRes(null); }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    const click = (e) => { if (!e.target.closest(".menu")) onClose(); };
    window.addEventListener("scroll", close, true);
    document.addEventListener("click", click);
    return () => { window.removeEventListener("scroll", close, true); document.removeEventListener("click", click); };
  }, [menu, onClose]);
  if (!menu) return null;

  const run = async (provider) => {
    setRes({ ok: null, text: "running…" });
    const r = await post(`/api/leads/${encodeURIComponent(menu.url)}/reverify`, { provider });
    setRes({ ok: r.ok, text: r.ok ? `✓ ${r.provider || r.action}: ${r.result || r.email || "ok"}` : `✗ ${r.result || r.message || "not found"}` });
    onDone();
  };
  return (
    <div className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      <div className="mh">Re-verify this email</div>
      <button onClick={() => run("prospeo")}><Icon name="check" />Verify with Prospeo</button>
      <button onClick={() => run("enrich")}><Icon name="check" />Verify with Enrich</button>
      <button onClick={() => run("refind")}><Icon name="refresh" />Re-find email</button>
      {res && <div className="res" style={{ color: res.ok == null ? "var(--dim)" : res.ok ? "var(--good)" : "var(--hot)" }}>{res.text}</div>}
    </div>
  );
}
