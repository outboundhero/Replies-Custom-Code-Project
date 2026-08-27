"use client";

import { useEffect, useState, useCallback } from "react";

interface Item {
  replyId: number;
  leadEmail: string;
  clientTag: string | null;
  senderEmail: string | null;
  lastError: string | null;
  at: string | null;
}

/**
 * Slim, quiet alert strip at the top of the inbox listing reply/handoff sends
 * that FAILED and could not auto-recover (retry exhausted) — the only case that
 * needs a human. Renders nothing when there's nothing to act on, so it never adds
 * visual weight in the normal case. Each lead is a clickable chip that opens it.
 */
export function NeedsAttentionBanner({
  onOpen,
  reloadSignal = 0,
}: {
  onOpen: (replyId: number) => void;
  /** Bump this (from the parent) to force an immediate reload — e.g. right after
   *  a send failure is dismissed from the lead's detail pane, so the matching
   *  chip disappears without waiting for the 60s poll. */
  reloadSignal?: number;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [dismissing, setDismissing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox/needs-attention");
      if (!res.ok) return;
      const d = await res.json();
      setItems(Array.isArray(d.items) ? d.items : []);
    } catch { /* never disrupt the inbox */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Force a refresh when the parent signals (e.g. a dismiss from the detail pane).
  useEffect(() => { if (reloadSignal) load(); }, [reloadSignal, load]);

  // Dismiss a single lead's failure straight from its chip. Optimistically drop
  // it, then clear the persistent send_error server-side (same action the detail
  // pane's Dismiss uses), and re-sync.
  const dismiss = useCallback(async (replyId: number) => {
    setDismissing(replyId);
    setItems((prev) => prev.filter((it) => it.replyId !== replyId));
    try {
      await fetch("/api/inbox/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss-send-error", id: replyId }),
      });
    } catch { /* already dropped locally; the poll will reconcile */ }
    finally { setDismissing(null); load(); }
  }, [load]);

  if (!items.length) return null;

  const shown = items.slice(0, 6);
  const extra = items.length - shown.length;

  return (
    <div className="shrink-0 border-b border-amber-200 bg-amber-50">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-900">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          {items.length} reply {items.length === 1 ? "send" : "sends"} couldn&apos;t auto-recover — manual resend needed
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {shown.map((it) => (
            <span
              key={it.replyId}
              className="inline-flex items-center rounded-full border border-amber-300 bg-white text-[11px] text-amber-800 transition-colors hover:bg-amber-100"
            >
              <button
                type="button"
                onClick={() => onOpen(it.replyId)}
                title={[
                  it.clientTag ? `Client ${it.clientTag}` : null,
                  it.senderEmail ? `inbox ${it.senderEmail}` : null,
                  it.lastError || null,
                ].filter(Boolean).join(" · ")}
                className="max-w-[220px] truncate rounded-full pl-2.5 pr-1.5 py-0.5"
              >
                {it.leadEmail || `Reply #${it.replyId}`}
              </button>
              <button
                type="button"
                onClick={() => dismiss(it.replyId)}
                disabled={dismissing === it.replyId}
                title="Dismiss — clear this send failure"
                aria-label="Dismiss send failure"
                className="mr-0.5 rounded-full px-1 leading-none text-amber-500 hover:text-amber-900 hover:bg-amber-200/60 disabled:opacity-50"
              >
                ×
              </button>
            </span>
          ))}
          {extra > 0 && <span className="text-[11px] font-medium text-amber-700">+{extra} more</span>}
        </div>
      </div>
    </div>
  );
}
