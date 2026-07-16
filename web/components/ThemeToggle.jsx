"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icon";

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(document.documentElement.getAttribute("data-theme") === "dark"); }, []);
  const toggle = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch {}
    setDark(!dark);
  };
  return (
    <button className="themebtn" title={dark ? "Switch to light" : "Switch to dark"} onClick={toggle}>
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}
