"use client";

import { useEffect } from "react";

/**
 * Keeps an active user's login session from lapsing. The inbox is a long-open
 * SPA that rarely navigates, and the 7-day cookie is otherwise never renewed —
 * so a tab left open past the expiry starts 401-ing mid-action (e.g. on Send).
 *
 * Pings /api/auth/refresh (re-issues the cookie if still valid) on mount, when
 * the tab regains focus / becomes visible, and every 30 minutes. Purely a
 * keep-alive: it never forces a login and quietly no-ops if the session is
 * already gone (the next real request handles that).
 */
export function SessionKeepAlive() {
  useEffect(() => {
    let stopped = false;
    const ping = () => {
      if (stopped || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      fetch("/api/auth/refresh", { method: "POST", cache: "no-store" }).catch(() => {});
    };

    ping(); // on load
    const interval = setInterval(ping, 30 * 60 * 1000); // every 30 min
    const onFocus = () => ping();
    const onVisible = () => { if (document.visibilityState === "visible") ping(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
