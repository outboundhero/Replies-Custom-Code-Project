"use client";

/**
 * Sheet Pushes — reliability dashboard for lead-tracking-sheet delivery.
 *
 * Every positive lead (Meeting-Ready / Follow Up / Interested / Referral Given)
 * is pushed to the client's tracking sheet. If a push fails, it lands here so
 * the team can retry until it succeeds (a successful retry auto-clears it) or
 * dismiss it manually. A cron also auto-retries every 15 min in the background.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface Failure {
  reply_id: number;
  client_tag: string | null;
  lead_email: string | null;
  lead_name: string | null;
  category: string | null;
  error: string | null;
  attempts: number;
  first_failed_at: string | null;
  last_attempt_at: string | null;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "—";
}

export default function SheetPushesPage() {
  const [rows, setRows] = useState<Failure[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | "all" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sheet-pushes");
      if (res.status === 401) { window.location.href = "/login"; return; }
      const d = await res.json();
      setRows(d.pending || []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Light auto-refresh so cron-healed rows disappear on their own.
  useEffect(() => {
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function retry(replyId: number) {
    setBusy(replyId);
    const res = await fetch("/api/sheet-pushes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry", replyId }) });
    const d = await res.json();
    setBusy(null);
    if (d.ok) { toast.success(d.alreadyInSheet ? "Already in the sheet — not pushed again" : "Pushed to sheet ✓"); setRows((r) => r.filter((x) => x.reply_id !== replyId)); }
    else toast.error(d.error || "Still failing — will keep retrying");
    load();
  }
  async function dismiss(replyId: number) {
    setBusy(replyId);
    await fetch("/api/sheet-pushes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss", replyId }) });
    setBusy(null);
    setRows((r) => r.filter((x) => x.reply_id !== replyId));
    toast.success("Dismissed");
  }
  async function retryAll() {
    setBusy("all");
    const res = await fetch("/api/sheet-pushes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry-all" }) });
    const d = await res.json();
    setBusy(null);
    toast[d.failed ? "warning" : "success"](`Retried ${d.retried} — ${d.succeeded} pushed${d.failed ? `, ${d.failed} still failing` : ""}`);
    load();
  }

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Sheet Pushes</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Positive leads that failed to reach the client&apos;s lead-tracking sheet. Retry until resolved, or dismiss.
            The system also auto-retries these every 15 minutes.
          </p>
        </div>
        {rows.length > 0 && (
          <Button onClick={retryAll} disabled={busy === "all"} className="shrink-0">{busy === "all" ? "Retrying…" : `Retry all (${rows.length})`}</Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-20 rounded-lg bg-muted/40 animate-pulse" />)}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-green-200 bg-green-50 px-5 py-8 text-center">
          <div className="text-3xl mb-2">✓</div>
          <p className="text-sm font-medium text-green-800">All leads delivered</p>
          <p className="text-xs text-green-700 mt-1">No pending sheet-push failures. Every positive lead is reaching its client sheet.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {rows.map((f) => (
            <div key={f.reply_id} className="rounded-xl border border-amber-200 bg-amber-50/40 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-bold bg-primary/10 text-primary px-2 py-0.5 rounded">{f.client_tag || "N/A"}</span>
                    <span className="text-sm font-medium">{f.lead_name || f.lead_email || `Reply #${f.reply_id}`}</span>
                    {f.category && <span className="text-[11px] text-muted-foreground">→ {f.category}</span>}
                    <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">attempt {f.attempts}</span>
                  </div>
                  {f.lead_email && f.lead_name && <p className="text-[11px] text-muted-foreground mt-0.5">{f.lead_email}</p>}
                  <p className="mt-1.5 text-xs text-amber-800 bg-white/70 border border-amber-200 rounded px-2 py-1 break-words">{f.error || "Unknown error"}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">First failed {fmt(f.first_failed_at)} · last tried {fmt(f.last_attempt_at)}</p>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <Button size="sm" className="h-8 text-xs" onClick={() => retry(f.reply_id)} disabled={busy === f.reply_id}>{busy === f.reply_id ? "…" : "Retry"}</Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => dismiss(f.reply_id)} disabled={busy === f.reply_id}>Dismiss</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
