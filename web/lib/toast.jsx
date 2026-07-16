"use client";
import { createContext, useCallback, useContext, useState } from "react";
import Icon from "@/components/Icon";

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

let idc = 0;
const ICON = { good: "check", bad: "x", info: "spark" };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((msg, type = "info") => {
    const id = ++idc;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <Icon name={ICON[t.type] || "spark"} /><span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
