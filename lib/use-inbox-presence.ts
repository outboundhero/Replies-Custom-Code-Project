"use client";

/**
 * Real-time "who's viewing which lead" presence for the inbox.
 *
 * Uses Supabase Realtime **Broadcast** (not Presence) for the current-lead
 * signal. Presence meta-updates (repeated track()) proved unreliable here — the
 * first state stuck and switches didn't propagate. Broadcast is a direct pub/sub
 * message delivered to every subscriber instantly (the same mechanism live
 * cursors use), so a lead switch shows up on everyone else's screen right away.
 *
 * Online/offline is handled ourselves:
 *   - every client re-broadcasts its state on a heartbeat; a viewer whose
 *     heartbeats stop (closed tab / crash) is pruned after TTL_MS.
 *   - a graceful tab close broadcasts an explicit "leaving" so the color clears
 *     immediately instead of waiting for the TTL.
 *   - on join we broadcast "hello"; everyone replies with their state, so a
 *     freshly-opened inbox learns every current position within a fraction of a
 *     second (Broadcast has no built-in state sync like Presence does).
 *
 * Returns Map<leadId, Viewer[]> the UI renders as split color bars + dots,
 * ordered left-to-right by who opened the lead first (`at` ascending).
 */

import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

export interface Viewer {
  email: string;
  name: string;
  color: string;
  at: number; // ms epoch when this user opened their current lead (open-order)
}

interface Identity {
  email: string | null | undefined;
  name: string;
  color: string;
  currentLeadId: number | null;
}

interface Entry {
  leadId: number | null;
  name: string;
  color: string;
  at: number;
  lastSeen: number;
}

const CHANNEL = "inbox-presence";
const HEARTBEAT_MS = 4000; // re-announce so others keep us alive
const TTL_MS = 11000;      // drop a viewer we haven't heard from in this long
const PRUNE_MS = 3000;     // sweep for expired viewers

export function useInboxPresence(
  client: SupabaseClient,
  { email, name, color, currentLeadId }: Identity,
): Map<number, Viewer[]> {
  const [byLead, setByLead] = useState<Map<number, Viewer[]>>(new Map());

  // Latest identity + current lead in refs so channel wiring never needs to
  // re-subscribe on a lead switch — we just broadcast a new state.
  const idRef = useRef({ email, name, color });
  idRef.current = { email, name, color };
  const leadRef = useRef<number | null>(currentLeadId);
  const openedAtRef = useRef<number>(Date.now());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const subscribedRef = useRef<boolean>(false);
  // email → latest known state (includes ourselves, upserted locally).
  const viewersRef = useRef<Map<string, Entry>>(new Map());
  const lastSigRef = useRef<string>("");
  const trackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debug = typeof window !== "undefined" && window.location.search.includes("presenceDebug");

  // Rebuild byLead from viewersRef, pruning expired entries. Only re-renders
  // (repaints the whole inbox) when the meaningful signature actually changes —
  // heartbeats that only bump lastSeen never trigger a render.
  function recompute() {
    const now = Date.now();
    const map = new Map<number, Viewer[]>();
    const sig: string[] = [];
    for (const [em, e] of viewersRef.current) {
      if (now - e.lastSeen > TTL_MS) { viewersRef.current.delete(em); continue; }
      if (typeof e.leadId !== "number") continue; // online but not on a lead
      sig.push(`${e.leadId}:${em}:${e.at}`);
      const v: Viewer = { email: em, name: e.name, color: e.color, at: e.at };
      const arr = map.get(e.leadId);
      if (arr) arr.push(v);
      else map.set(e.leadId, [v]);
    }
    const signature = sig.sort().join("|");
    if (signature === lastSigRef.current) return;
    lastSigRef.current = signature;
    for (const arr of map.values()) arr.sort((a, b) => a.at - b.at);
    if (debug) console.debug("[presence] recompute →", [...map.entries()]);
    setByLead(map);
  }

  function upsertSelf() {
    const { email: e, name: n, color: c } = idRef.current;
    if (!e) return;
    viewersRef.current.set(e, {
      leadId: leadRef.current, name: n, color: c, at: openedAtRef.current, lastSeen: Date.now(),
    });
  }

  function sendState() {
    const ch = channelRef.current;
    if (!ch || !subscribedRef.current) return;
    const { email: e, name: n, color: c } = idRef.current;
    upsertSelf();  // reflect our own state locally (broadcast self:false)
    recompute();
    if (debug) console.debug("[presence] sendState leadId=", leadRef.current);
    void ch.send({ type: "broadcast", event: "viewing",
      payload: { email: e || "", name: n, color: c, leadId: leadRef.current, at: openedAtRef.current } });
  }

  function sendHello() {
    const ch = channelRef.current;
    if (!ch || !subscribedRef.current) return;
    void ch.send({ type: "broadcast", event: "hello", payload: {} });
  }

  function sendLeave() {
    const ch = channelRef.current;
    const { email: e } = idRef.current;
    if (e) viewersRef.current.delete(e);
    if (ch) void ch.send({ type: "broadcast", event: "viewing", payload: { email: e || "", leaving: true } });
  }

  // ── Wire the channel once per signed-in email. ──
  useEffect(() => {
    if (!email) return;
    lastSigRef.current = "";
    viewersRef.current.clear();
    const channel = client.channel(CHANNEL, { config: { broadcast: { self: false } } });
    channelRef.current = channel;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onViewing = (payload: any) => {
      const p = payload || {};
      if (!p.email) return;
      if (p.leaving) { viewersRef.current.delete(p.email); recompute(); return; }
      viewersRef.current.set(p.email, {
        leadId: typeof p.leadId === "number" ? p.leadId : null,
        name: String(p.name || "Someone"),
        color: String(p.color || "#6b7280"),
        at: typeof p.at === "number" ? p.at : 0,
        lastSeen: Date.now(),
      });
      recompute();
    };

    channel
      .on("broadcast", { event: "viewing" }, ({ payload }) => onViewing(payload))
      .on("broadcast", { event: "hello" }, () => sendState()) // newcomer asked — announce ourselves
      .subscribe((status) => {
        if (debug) console.debug("[presence] status:", status);
        if (status === "SUBSCRIBED") {
          subscribedRef.current = true;
          sendState();  // announce our current lead
          sendHello();  // ask everyone else to announce theirs
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          subscribedRef.current = false;
        }
      });

    const hb = setInterval(() => { sendState(); }, HEARTBEAT_MS);
    const pruneTimer = setInterval(() => { recompute(); }, PRUNE_MS);

    const onUnload = () => { sendLeave(); };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);

    // Regaining focus (from a throttled background tab) → re-announce + re-sync.
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      sendState();
      sendHello();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      clearInterval(hb);
      clearInterval(pruneTimer);
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      sendLeave();
      subscribedRef.current = false;
      channelRef.current = null;
      client.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, email]);

  // ── Lead switch → broadcast new state. Coalesce rapid switches (clicking
  //    through leads) with a short trailing debounce so the settled lead wins. ──
  useEffect(() => {
    leadRef.current = currentLeadId;
    openedAtRef.current = Date.now();
    if (trackTimerRef.current) clearTimeout(trackTimerRef.current);
    trackTimerRef.current = setTimeout(() => { sendState(); }, 120);
    return () => { if (trackTimerRef.current) clearTimeout(trackTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLeadId]);

  return byLead;
}
