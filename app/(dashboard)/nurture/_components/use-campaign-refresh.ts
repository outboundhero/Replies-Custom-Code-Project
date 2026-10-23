"use client";

/**
 * The Nurture pages' "Refresh campaigns" button (classic and new views): pulls every campaign
 * from all 4 Email Bison instances now instead of waiting for the 10-minute refresh
 * (/api/nurture/refresh-campaigns). Each page draws its own button; this holds the request,
 * the busy state and when it last ran.
 */
import { useCallback, useEffect, useState } from "react";
import { getInstanceLabel } from "@/lib/bison-instances-shared";

export interface CampaignRefresh {
  at: string; ms: number; cached: number; mains: number; failures?: string[];
  by?: string | null; manual?: boolean;
}

/** "Campaigns refreshed from all 4 Email Bison instances — …" for a finished refresh. */
export function refreshedText(d: CampaignRefresh): string {
  const failed = (d.failures ?? []).map((f) => getInstanceLabel(f.split(":")[0]));
  const read = failed.length ? `${4 - failed.length} of 4 Email Bison instances` : "all 4 Email Bison instances";
  return `Campaigns refreshed from ${read} — ${d.cached.toLocaleString()} nurture + ${d.mains.toLocaleString()} other campaigns (${Math.max(1, Math.round(d.ms / 1000))}s)`
    + (failed.length ? `. ${failed.join(" and ")} didn't answer — its campaigns are as of the last refresh; try again in a minute.` : "");
}

export function useCampaignRefresh() {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<CampaignRefresh | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/nurture/refresh-campaigns", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d?.ok) setLast(d.last ?? null); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  /** Refresh now. Resolves with the message to show and whether it worked. */
  const run = useCallback(async (): Promise<{ ok: boolean; text: string }> => {
    setBusy(true);
    try {
      const r = await fetch("/api/nurture/refresh-campaigns", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, text: `Couldn't refresh campaigns: ${d.error || `HTTP ${r.status}`}` };
      if (d.busy) return { ok: true, text: "A campaign refresh is already running (the automatic one, or someone else's) — reload in a minute to see it." };
      setLast(d as CampaignRefresh);
      return { ok: true, text: refreshedText(d as CampaignRefresh) };
    } catch (e) {
      return { ok: false, text: `Couldn't refresh campaigns: ${(e as Error).message}` };
    } finally {
      setBusy(false);
    }
  }, []);

  const lastAt = last?.at ? new Date(last.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  const title = `Pull every campaign from all 4 Email Bison instances now (it also refreshes on its own every 10 minutes).${lastAt ? ` Last refresh: ${lastAt}${last?.manual && last.by ? ` by ${last.by}` : " (automatic)"}.` : ""}`;
  return { busy, last, run, title };
}
