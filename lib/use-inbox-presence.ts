"use client";

/**
 * Real-time "who's viewing which lead" presence for the inbox.
 *
 * Rides the inbox's existing Supabase Realtime WebSocket via the built-in
 * Presence feature (ephemeral, in-memory, sub-second join/leave — no polling).
 * Each client tracks { email, name, color, leadId, at }; the moment someone
 * opens/switches a lead we push a fresh track(), and every other inbox sees it
 * near-instantly. Returns a Map<leadId, Viewer[]> the UI renders as split color
 * bars, ordered left-to-right by who opened the lead first (`at` ascending).
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

const CHANNEL = "inbox-presence";

export function useInboxPresence(
  client: SupabaseClient,
  { email, name, color, currentLeadId }: Identity,
): Map<number, Viewer[]> {
  const [byLead, setByLead] = useState<Map<number, Viewer[]>>(new Map());

  // Latest identity + current lead held in refs so the channel never has to
  // re-subscribe on a lead switch — we just push a new track() payload.
  const idRef = useRef({ email, name, color });
  idRef.current = { email, name, color };
  const leadRef = useRef<number | null>(currentLeadId);
  const openedAtRef = useRef<number>(Date.now());
  const channelRef = useRef<RealtimeChannel | null>(null);

  function payload() {
    const { email: e, name: n, color: c } = idRef.current;
    return { email: e || "", name: n, color: c, leadId: leadRef.current, at: openedAtRef.current };
  }

  function pushTrack() {
    const ch = channelRef.current;
    if (ch) void ch.track(payload());
  }

  // ── Subscribe once (per signed-in email). Rebuild the map on every presence
  //    event; do the initial track() the instant we're SUBSCRIBED. ──
  useEffect(() => {
    if (!email) return; // not signed in → no presence
    const channel = client.channel(CHANNEL, { config: { presence: { key: email } } });
    channelRef.current = channel;

    const rebuild = () => {
      const state = channel.presenceState() as Record<string, Array<Record<string, unknown>>>;
      const map = new Map<number, Viewer[]>();
      for (const entries of Object.values(state)) {
        for (const p of entries) {
          const leadId = p.leadId;
          if (typeof leadId !== "number") continue; // present but not on a lead
          const v: Viewer = {
            email: String(p.email || ""),
            name: String(p.name || "Someone"),
            color: String(p.color || "#6b7280"),
            at: typeof p.at === "number" ? p.at : 0,
          };
          const arr = map.get(leadId);
          if (arr) arr.push(v);
          else map.set(leadId, [v]);
        }
      }
      // Left-to-right = who opened the lead first.
      for (const arr of map.values()) arr.sort((a, b) => a.at - b.at);
      setByLead(map);
    };

    channel
      .on("presence", { event: "sync" }, rebuild)
      .on("presence", { event: "join" }, rebuild)
      .on("presence", { event: "leave" }, rebuild)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") pushTrack();
      });

    // Graceful tab close → drop our presence immediately (don't wait for the
    // socket-timeout reaper). Passive backstop for hard crashes remains.
    const onUnload = () => { void channel.untrack(); };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      window.removeEventListener("beforeunload", onUnload);
      channelRef.current = null;
      client.removeChannel(channel);
    };
    // Re-subscribe only if the signed-in identity's key (email) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, email]);

  // ── Lead switch → re-track with a fresh open timestamp (near-instant). ──
  useEffect(() => {
    leadRef.current = currentLeadId;
    openedAtRef.current = Date.now();
    pushTrack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLeadId]);

  return byLead;
}
