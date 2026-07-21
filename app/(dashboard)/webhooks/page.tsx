"use client";

/**
 * Webhook Activity — last 3 days of Bison webhook deliveries per instance,
 * with cursor pagination and one-click retry of failed attempts.
 *
 * Data: GET /api/webhooks/activity (flattened from Bison /api/events).
 * Retry: POST /api/webhooks/retry → Bison /api/webhook-attempts/{id}/retry.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Webhook, RefreshCw, CheckCircle2, XCircle, Clock, HelpCircle,
  ChevronDown, RotateCw, ArrowUpRight, Activity, Loader2,
} from "lucide-react";
import { BISON_INSTANCES } from "@/lib/bison-instances-shared";
import { cn } from "@/lib/utils";

type DeliveryStatus = "succeeded" | "failed" | "pending" | "unknown";
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Pending" },
  { value: "unknown", label: "Unknown" },
];
interface Attempt { id: number; status: DeliveryStatus; responseCode: number | null; at: string | null }
interface Delivery {
  instance: string; deliveryId: number; eventId: number; eventType: string; eventName: string;
  webhookUrl: string; status: DeliveryStatus; attemptCount: number; latestResponseCode: number | null;
  latestAttemptId: number | null; attempts: Attempt[]; at: string | null; contact: string | null; subject: string | null;
}
const STATUS_META: Record<DeliveryStatus, { label: string; dot: string; chip: string; Icon: typeof CheckCircle2 }> = {
  succeeded: { label: "Succeeded", dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: CheckCircle2 },
  failed:    { label: "Failed",    dot: "bg-rose-500",    chip: "bg-rose-50 text-rose-700 border-rose-200",       Icon: XCircle },
  pending:   { label: "Pending",   dot: "bg-amber-500",   chip: "bg-amber-50 text-amber-700 border-amber-200",     Icon: Clock },
  unknown:   { label: "Unknown",   dot: "bg-slate-400",   chip: "bg-slate-50 text-slate-600 border-slate-200",     Icon: HelpCircle },
};

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function codeChip(code: number | null): string {
  if (code == null) return "bg-slate-100 text-slate-500 border-slate-200";
  if (code >= 200 && code < 300) return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (code >= 300 && code < 400) return "bg-sky-50 text-sky-700 border-sky-200";
  return "bg-rose-50 text-rose-700 border-rose-200";
}

// Bison event types (from /api/events `type` enum) — filtered server-side so
// pagination stays correct.
const EVENT_TYPES: { value: string; label: string }[] = [
  { value: "", label: "All events" },
  { value: "lead_replied", label: "Contact Replied" },
  { value: "untracked_reply_received", label: "Untracked Reply Received" },
  { value: "lead_interested", label: "Contact Interested" },
  { value: "lead_first_contacted", label: "Contact First Emailed" },
  { value: "lead_unsubscribed", label: "Contact Unsubscribed" },
  { value: "email_sent", label: "Email Sent" },
  { value: "email_send_failed", label: "Email Send Failed" },
  { value: "manual_email_sent", label: "Manual Email Sent" },
  { value: "manual_email_send_failed", label: "Manual Email Send Failed" },
  { value: "email_opened", label: "Email Opened" },
  { value: "email_bounced", label: "Email Bounced" },
  { value: "email_account_added", label: "Email Account Added" },
  { value: "email_account_removed", label: "Email Account Removed" },
  { value: "email_account_disconnected", label: "Email Account Disconnected" },
  { value: "email_account_reconnected", label: "Email Account Reconnected" },
  { value: "tag_attached", label: "Tag Attached" },
  { value: "tag_removed", label: "Tag Removed" },
  { value: "warmup_disabled_causing_bounces", label: "Warmup Disabled (Causing Bounces)" },
  { value: "warmup_disabled_receiving_bounces", label: "Warmup Disabled (Receiving Bounces)" },
  { value: "blacklisted_email_added", label: "Blacklisted Email Added" },
  { value: "blacklisted_email_removed", label: "Blacklisted Email Removed" },
  { value: "blacklisted_domain_added", label: "Blacklisted Domain Added" },
  { value: "blacklisted_domain_removed", label: "Blacklisted Domain Removed" },
];

// Minimum-attempts thresholds — applied client-side to the loaded rows (Bison
// has no attempt-count filter). Higher thresholds surface the problem
// deliveries that got retried repeatedly.
const ATTEMPT_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Any attempts" },
  { value: 1, label: "1+ attempts" },
  { value: 2, label: "2+ attempts" },
  { value: 3, label: "3+ attempts" },
  { value: 5, label: "5+ attempts" },
];

export default function WebhooksPage() {
  const [instance, setInstance] = useState<string>(BISON_INSTANCES[0].key);
  const [status, setStatus] = useState<string>("all");
  const [eventType, setEventType] = useState<string>("");
  const [minAttempts, setMinAttempts] = useState<number>(0);
  const [items, setItems] = useState<Delivery[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [retrying, setRetrying] = useState<Set<number>>(new Set());
  const [retried, setRetried] = useState<Set<number>>(new Set());
  const reqId = useRef(0);

  const load = useCallback(async (opts: { append: boolean; cur: string | null }) => {
    const mine = ++reqId.current;
    opts.append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ instance });
      if (status !== "all") qs.set("status", status);
      if (eventType) qs.set("type", eventType);
      if (opts.cur) qs.set("cursor", opts.cur);
      const res = await fetch(`/api/webhooks/activity?${qs.toString()}`);
      const data = await res.json();
      if (mine !== reqId.current) return; // a newer request superseded this one
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      setCursor(data.nextCursor ?? null);
      setItems((prev) => {
        const base = opts.append ? prev : [];
        const seen = new Set(base.map((d) => d.deliveryId));
        const merged = [...base];
        for (const d of data.items as Delivery[]) if (!seen.has(d.deliveryId)) { seen.add(d.deliveryId); merged.push(d); }
        return merged;
      });
    } catch (e) {
      if (mine === reqId.current) setError((e as Error).message);
    } finally {
      if (mine === reqId.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [instance, status, eventType]);

  // Reset + reload whenever the instance / status / event-type filter changes.
  useEffect(() => { setItems([]); setCursor(null); setExpanded(new Set()); load({ append: false, cur: null }); }, [load]);

  // Client-side min-attempts filter over what's loaded (Bison has no such filter).
  const visibleItems = useMemo(
    () => (minAttempts <= 0 ? items : items.filter((d) => d.attemptCount >= minAttempts)),
    [items, minAttempts]
  );

  const stats = useMemo(() => {
    const total = visibleItems.length;
    const ok = visibleItems.filter((d) => d.status === "succeeded").length;
    const fail = visibleItems.filter((d) => d.status === "failed").length;
    const rate = total ? Math.round((ok / total) * 100) : null;
    return { total, ok, fail, rate };
  }, [visibleItems]);

  async function retry(d: Delivery) {
    if (d.latestAttemptId == null) { toast.error("No attempt id to retry for this delivery."); return; }
    setRetrying((s) => new Set(s).add(d.deliveryId));
    try {
      const res = await fetch("/api/webhooks/retry", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance, attemptId: d.latestAttemptId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Retry failed (${res.status})`);
      setRetried((s) => new Set(s).add(d.deliveryId));
      toast.success(data.message || "Retry queued.", {
        description: data.webhookDeliveryId ? `New delivery #${data.webhookDeliveryId} — refresh in a moment to see its status.` : undefined,
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRetrying((s) => { const n = new Set(s); n.delete(d.deliveryId); return n; });
    }
  }

  function toggle(id: number) {
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
            <Webhook className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Webhook Activity</h1>
            <p className="text-sm text-muted-foreground">
              Bison webhook deliveries from the last 3 days · retry any failed delivery in one click.
            </p>
          </div>
        </div>
        <button
          onClick={() => load({ append: false, cur: null })}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border bg-white px-3 h-9 text-sm font-medium shadow-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {/* Instance selector */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">Workspace</span>
        <div className="inline-flex flex-wrap rounded-lg border bg-muted/40 p-0.5">
          {BISON_INSTANCES.map((inst) => (
            <button
              key={inst.key}
              onClick={() => setInstance(inst.key)}
              className={cn(
                "px-3.5 h-8 text-sm font-medium rounded-md transition-colors",
                instance === inst.key ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {inst.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Activity}     tint="from-slate-50 to-white text-slate-700"    label="Deliveries (in view)" value={stats.total} />
        <StatCard icon={CheckCircle2} tint="from-emerald-50 to-white text-emerald-700" label="Succeeded"            value={stats.ok} />
        <StatCard icon={XCircle}      tint="from-rose-50 to-white text-rose-700"       label="Failed"               value={stats.fail} />
        <StatCard icon={ArrowUpRight} tint="from-indigo-50 to-white text-indigo-700"   label="Success rate"         value={stats.rate == null ? "—" : `${stats.rate}%`} />
      </div>

      {/* Toolbar — status / event / attempts filters */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect label="Status" value={status} onChange={setStatus}>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </FilterSelect>
          <FilterSelect label="Event" value={eventType} onChange={setEventType}>
            {EVENT_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </FilterSelect>
          <FilterSelect label="Attempts" value={String(minAttempts)} onChange={(v) => setMinAttempts(Number(v))}>
            {ATTEMPT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </FilterSelect>
        </div>
        <span className="text-xs text-muted-foreground pb-2">
          {minAttempts > 0 ? `${visibleItems.length} shown · ` : ""}{items.length} loaded
        </span>
      </div>

      {/* List */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="divide-y">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5 animate-pulse">
                <div className="h-2.5 w-2.5 rounded-full bg-muted" />
                <div className="h-3.5 w-40 rounded bg-muted" />
                <div className="h-3.5 w-56 rounded bg-muted ml-auto" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="px-4 py-12 text-center">
            <XCircle className="mx-auto h-8 w-8 text-rose-400" />
            <p className="mt-2 text-sm font-medium text-foreground">Couldn&apos;t load webhook activity</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-md mx-auto break-words">{error}</p>
            <button onClick={() => load({ append: false, cur: null })} className="mt-4 inline-flex items-center gap-2 rounded-lg border bg-white px-3 h-9 text-sm font-medium shadow-sm hover:bg-muted/50">
              <RefreshCw className="h-4 w-4" /> Try again
            </button>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="px-4 py-16 text-center">
            <Webhook className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-2 text-sm font-medium">
              {items.length > 0 && minAttempts > 0
                ? `No deliveries with ${minAttempts}+ attempts in view`
                : `No ${status !== "all" ? status + " " : ""}deliveries in the last 3 days`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {items.length > 0 && minAttempts > 0
                ? "Try a lower attempts threshold or load more."
                : `for ${BISON_INSTANCES.find((i) => i.key === instance)?.label}.`}
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {visibleItems.map((d) => {
              const meta = STATUS_META[d.status];
              const isOpen = expanded.has(d.deliveryId);
              const isRetrying = retrying.has(d.deliveryId);
              const wasRetried = retried.has(d.deliveryId);
              return (
                <div key={`${d.instance}-${d.deliveryId}`} className="group">
                  <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                    {/* status */}
                    <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", meta.dot)} title={meta.label} />
                    {/* event + context */}
                    <button onClick={() => toggle(d.deliveryId)} className="flex-1 min-w-0 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{d.eventName}</span>
                        <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px] font-medium", meta.chip)}>{meta.label}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground truncate">
                        {d.contact && <span className="truncate">{d.contact}</span>}
                        {d.contact && d.subject && <span>·</span>}
                        {d.subject && <span className="truncate">{d.subject}</span>}
                        {!d.contact && !d.subject && <span className="font-mono truncate">{d.webhookUrl || "—"}</span>}
                      </div>
                    </button>
                    {/* code + attempts + time */}
                    <div className="hidden sm:flex items-center gap-2 shrink-0">
                      <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-mono", codeChip(d.latestResponseCode))}>
                        {d.latestResponseCode ?? "—"}
                      </span>
                      <span className="text-[11px] text-muted-foreground tabular-nums" title="Attempts">
                        {d.attemptCount}×
                      </span>
                      <span className="w-16 text-right text-[11px] text-muted-foreground tabular-nums">{relTime(d.at)}</span>
                    </div>
                    {/* retry */}
                    <button
                      onClick={() => retry(d)}
                      disabled={isRetrying || d.latestAttemptId == null}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 h-8 text-xs font-medium shadow-sm transition-colors shrink-0 disabled:opacity-40",
                        wasRetried ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-white hover:bg-muted/50"
                      )}
                      title={d.latestAttemptId == null ? "No attempt to retry" : "Resend this webhook"}
                    >
                      {isRetrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
                      {wasRetried ? "Retried" : "Retry"}
                    </button>
                    <ChevronDown className={cn("h-4 w-4 text-muted-foreground/60 transition-transform shrink-0", isOpen && "rotate-180")} onClick={() => toggle(d.deliveryId)} role="button" />
                  </div>

                  {/* attempts timeline */}
                  {isOpen && (
                    <div className="bg-muted/20 px-4 py-3 border-t">
                      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Destination</span>
                        <span className="font-mono truncate">{d.webhookUrl || "—"}</span>
                      </div>
                      <div className="space-y-1.5">
                        {d.attempts.length === 0 && <p className="text-xs text-muted-foreground">No attempt records.</p>}
                        {d.attempts.map((a, i) => {
                          const am = STATUS_META[a.status];
                          return (
                            <div key={a.id || i} className="flex items-center gap-2.5 text-xs">
                              <span className={cn("h-1.5 w-1.5 rounded-full", am.dot)} />
                              <span className="w-16 font-medium">{am.label}</span>
                              <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px]", codeChip(a.responseCode))}>{a.responseCode ?? "—"}</span>
                              <span className="text-muted-foreground">attempt #{a.id}</span>
                              <span className="ml-auto text-muted-foreground tabular-nums">{relTime(a.at)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Load more */}
      {!loading && !error && cursor && (
        <div className="flex justify-center">
          <button
            onClick={() => load({ append: true, cur: cursor })}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 rounded-lg border bg-white px-4 h-9 text-sm font-medium shadow-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
          >
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-lg border bg-white px-2.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 hover:bg-muted/30 transition-colors"
      >
        {children}
      </select>
    </label>
  );
}

function StatCard({ icon: Icon, tint, label, value }: { icon: typeof Activity; tint: string; label: string; value: number | string }) {
  return (
    <div className={cn("rounded-xl border bg-gradient-to-b p-4 shadow-sm", tint)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 opacity-70" />
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
