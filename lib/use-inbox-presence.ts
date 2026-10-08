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
 *   - a client re-broadcasts its state on a heartbeat — only while its tab is
 *     visible AND it has a lead open (nothing else is ever rendered); a viewer
 *     whose heartbeats stop (closed / hidden tab, crash) is pruned after TTL_MS.
 *     Kept deliberately slow: every message fans out to every open inbox, and
 *     Supabase bills Realtime per delivered message (the old 4s beat from every
 *     tab, hidden ones included, blew through the monthly quota).
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
const HEARTBEAT_MS = 20000; // re-announce so others keep us alive (visible + on a lead only)
const TTL_MS = 50000;       // drop a viewer we haven't heard from in this long
const PRUNE_MS = 5000;      // sweep for expired viewers (local only — no messages)
const HELLO_MIN_GAP_MS = 30000; // at most one "who's here?" per this long

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

  // "Who's here?" makes EVERY viewer answer — throttle it.
  const lastHelloRef = useRef<number>(0);
  function sendHello() {
    const ch = channelRef.current;
    if (!ch || !subscribedRef.current) return;
    if (Date.now() - lastHelloRef.current < HELLO_MIN_GAP_MS) return;
    lastHelloRef.current = Date.now();
    void ch.send({ type: "broadcast", event: "hello", payload: {} });
  }
  const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

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
      // Newcomer asked — announce ourselves, but only if there's something to
      // show (we're on a lead in a visible tab); others are never rendered.
      .on("broadcast", { event: "hello" }, () => { if (isVisible() && typeof leadRef.current === "number") sendState(); })
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

    const hb = setInterval(() => { if (isVisible() && typeof leadRef.current === "number") sendState(); }, HEARTBEAT_MS);
    const pruneTimer = setInterval(() => { recompute(); }, PRUNE_MS);

    const onUnload = () => { sendLeave(); };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);

    // Tab shown again → re-announce + re-sync (hello is throttled). Window
    // focus alone doesn't re-sync — it fires on every alt-tab.
    const onVisible = () => {
      if (!isVisible()) return;
      sendState();
      sendHello();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(hb);
      clearInterval(pruneTimer);
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
      document.removeEventListener("visibilitychange", onVisible);
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
