"use client";
import { createContext, useContext } from "react";

// Shared dashboard state: campaigns/stats/jobs + actions (open lead drawer, open reverify menu,
// refresh topbar, poll jobs). Provided by app/page.jsx.
export const DashContext = createContext(null);
export const useDash = () => useContext(DashContext);
