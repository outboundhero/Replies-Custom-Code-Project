"use client";

/**
 * Lead Mover — self-serve batch migration of a client tag's leads between Bison
 * instances/campaigns. Pick From → To, select clients, Plan (auto-match by ESP),
 * then Migrate. The move runs entirely SERVER-SIDE (a durable background job): it
 * completes on its own whether or not this tab is open, survives Wi-Fi drops, and
 * this page just enqueues it and polls progress. Cross Instance moves are LANE-
 * AWARE + PER-LEAD-ESP (the To instance's lane decides which leads move; each is
 * routed by its own ESP). Copy-only — sources are never modified.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Search, ArrowRight, Loader2, Sparkles, Zap, Check, AlertTriangle, MapPin, Download, ChevronDown, UserX, Plus, RefreshCw } from "lucide-react";
import { BISON_INSTANCES, getInstanceLane } from "@/lib/bison-instances-shared";
import MigrationPanel from "./_components/MigrationPanel";
import SameInstanceTab from "./_components/SameInstanceTab";
import { useMoveJobs } from "./_components/useMoveJobs";

type Esp = "google" | "outlook" | "segs";
type PlanStatus = "ready" | "partial" | "blocked" | "empty";
interface ClientPlan {
  tag: string;
  status: PlanStatus;
  sourceCampaigns: Array<{ id: number; name: string; status: string; esp: Esp; total_leads: number }>;
  match: Partial<Record<Esp, { campaignId: number; name: string; status: string }>>;
  sourceEsps: Esp[];
  unmatchedEsps: Esp[];
  totalLeads: number;
  targetTagCampaigns: number;
  hasServiceArea: boolean;
  serviceAreaCount: number;
}
const ESP_LABEL: Record<string, string> = { google: "Google", outlook: "Outlook", segs: "SEGs" };
const ESPS: Esp[] = ["google", "outlook", "segs"];
const INSTANCE_ACCENT: Record<string, string> = {
  outboundhero: "data-[on=true]:bg-emerald-600", facilityreach: "data-[on=true]:bg-sky-600",
  cleaningoutbound: "data-[on=true]:bg-amber-600", outboundclean: "data-[on=true]:bg-violet-600",
};

type ClientRow = { tag: string; churned: boolean; churnDate: string | null };
type MoveTab = "cross" | "same";

export default function MigratePage() {
  const [tab, setTab] = useState<MoveTab>("cross");
  const [allClientRows, setAllClientRows] = useState<ClientRow[]>([]);
  const [clientStatus, setClientStatus] = useState<"active" | "returning" | "all">("active");
  const [from, setFrom] = useState<string>("outboundhero");
  const [to, setTo] = useState<string>("facilityreach");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<Map<string, ClientPlan>>(new Map());
  const [planning, setPlanning] = useState(false);
  const [serviceAreaFilter, setServiceAreaFilter] = useState(true);
  const [syncingSheet, setSyncingSheet] = useState(false);
  const [enqueuing, setEnqueuing] = useState(false);

  // The move now runs server-side; this hook just polls status + drives controls.
  const { entries, cancel, retry, dismiss, refresh } = useMoveJobs();

  const exportSkipped = useCallback((runId: string) => {
    if (!runId) return;
    window.open(`/api/leads/move/skipped/export?runId=${encodeURIComponent(runId)}`, "_blank");
  }, []);

  const loadClients = useCallback(() => {
    return fetch("/api/config/clients").then((r) => (r.ok ? r.json() : [])).then((rows) => {
      if (!Array.isArray(rows)) return;
      const seen = new Set<string>();
      const list: ClientRow[] = [];
      for (const r of rows as Array<{ tag?: string; churned?: boolean; churnDate?: string | null }>) {
        const tag = r.tag; if (!tag || seen.has(tag)) continue; seen.add(tag);
        list.push({ tag, churned: !!r.churned, churnDate: r.churnDate ?? null });
      }
      list.sort((a, b) => a.tag.localeCompare(b.tag));
      setAllClientRows(list);
    }).catch(() => {});
  }, []);
  useEffect(() => { loadClients(); }, [loadClients]);

  async function syncFromSheet() {
    if (syncingSheet) return;
    setSyncingSheet(true);
    const tid = toast.loading("Syncing client directory from the Groups sheet…");
    try {
      const res = await fetch("/api/groups/sync", { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || "Sync failed", { id: tid }); return; }
      await loadClients();
      const g = d.groups || {}; const c = d.churn || {};
      toast.success(`Synced — ${g.count ?? 0} clients (G1 ${g.g1 ?? 0} · G2 ${g.g2 ?? 0}), ${c.count ?? 0} churned.`, { id: tid });
    } catch (e) {
      toast.error((e as Error).message, { id: tid });
    } finally {
      setSyncingSheet(false);
    }
  }

  const allTags = useMemo(() => allClientRows
    .filter((c) => clientStatus === "all" || (clientStatus === "returning" ? c.churned : !c.churned))
    .map((c) => c.tag), [allClientRows, clientStatus]);
  const clientRowByTag = useMemo(() => new Map(allClientRows.map((c) => [c.tag, c])), [allClientRows]);
  const churnedCount = useMemo(() => allClientRows.filter((c) => c.churned).length, [allClientRows]);

  useEffect(() => { setPlan(new Map()); }, [from, to]);

  const filtered = useMemo(() => {
    const tokens = search.toLowerCase().split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!tokens.length) return allTags;
    if (tokens.length === 1) return allTags.filter((t) => t.toLowerCase().includes(tokens[0]));
    const exact = new Set(tokens);
    return allTags.filter((t) => exact.has(t.toLowerCase()));
  }, [allTags, search]);
  const unknownTokens = useMemo(() => {
    const tokens = [...new Set(search.toUpperCase().split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    if (tokens.length < 2) return [] as string[];
    const upper = new Set(allTags.map((t) => t.toUpperCase()));
    return tokens.filter((tok) => !upper.has(tok));
  }, [allTags, search]);

  const allSelected = filtered.length > 0 && filtered.every((t) => selected.has(t));
  const toggleAll = () => setSelected((prev) => {
    if (allSelected) { const n = new Set(prev); filtered.forEach((t) => n.delete(t)); return n; }
    return new Set([...prev, ...filtered]);
  });
  const toggleOne = (t: string) => setSelected((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });

  // ── Plan ──
  async function loadPlan() {
    const tags = [...selected];
    if (from === to) { toast.error("Pick different From and To instances."); return; }
    if (!tags.length) { toast.error("Select at least one client."); return; }
    setPlanning(true);
    try {
      const res = await fetch("/api/leads/move/plan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceInstance: from, targetInstance: to, clientTags: tags }),
      });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "Plan failed"); return; }
      const m = new Map<string, ClientPlan>();
      for (const c of d.clients || []) m.set(c.tag, c);
      setPlan(m);
      const cs: ClientPlan[] = d.clients || [];
      const blocked = cs.filter((c) => c.status === "blocked").length;
      const partial = cs.filter((c) => c.status === "partial").length;
      if (blocked || partial) {
        toast.warning(`${cs.filter((c) => c.status === "ready").length} ready · ${partial} partial · ${blocked} blocked — see the flagged clients below.`);
      } else {
        toast.success(`Planned ${cs.length} client${cs.length === 1 ? "" : "s"} — all campaigns matched.`);
      }
    } catch (e) { toast.error((e as Error).message); } finally { setPlanning(false); }
  }

  // ── Enqueue (server-side background job) ──
  async function enqueueMigration(tags: string[]) {
    if (from === to) { toast.error("Pick different From and To instances."); return; }
    const planned = tags.map((t) => plan.get(t)).filter((p): p is ClientPlan => !!p && p.totalLeads > 0);
    if (!planned.length) { toast.error("Nothing planned — run Plan first."); return; }
    const toLbl = BISON_INSTANCES.find((i) => i.key === to)?.label || to;
    const clients = planned.map((p) => ({
      tag: p.tag,
      dest: Object.fromEntries(ESPS.flatMap((e) => { const m = p.match[e]; return m ? [[e, m.campaignId]] : []; })),
      sourceCampaigns: p.sourceCampaigns.map((c) => ({ id: c.id, name: c.name, totalLeads: c.total_leads })),
    }));
    const runId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    setEnqueuing(true);
    try {
      const res = await fetch("/api/leads/move/enqueue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "cross", from, to, toLabel: toLbl, serviceAreaFilter, runId, clients }),
      });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "Couldn't start the migration"); return; }
      toast.success(`${toLbl} migration started in the background — it'll finish on its own, even if you close this tab.`);
      refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setEnqueuing(false); }
  }

  const plannedSelected = useMemo(() => [...selected].filter((t) => plan.get(t) && plan.get(t)!.totalLeads > 0), [selected, plan]);
  const toLabel = useMemo(() => BISON_INSTANCES.find((i) => i.key === to)?.label || to, [to]);
  const targetLane = useMemo(() => getInstanceLane(to), [to]);
  const laneLabel = targetLane === "b2b" ? "B2B" : "B2C";
  const anyActive = entries.some((m) => m.status === "running" || m.status === "queued");

  // Running first, then queued, then done — active work stays on top.
  const orderedMoves = useMemo(() => {
    const rank = (s: string) => (s === "running" ? 0 : s === "queued" ? 1 : 2);
    return [...entries].sort((a, b) => rank(a.status) - rank(b.status));
  }, [entries]);

  const summary = useMemo(() => {
    const rows = [...selected].map((t) => plan.get(t)).filter(Boolean) as ClientPlan[];
    const ready = rows.filter((r) => r.status === "ready");
    const partial = rows.filter((r) => r.status === "partial");
    const blocked = rows.filter((r) => r.status === "blocked");
    const empty = rows.filter((r) => r.status === "empty");
    const readyLeads = [...ready, ...partial].reduce((s, r) => s + r.totalLeads, 0);
    return { total: rows.length, ready, partial, blocked, empty, readyLeads };
  }, [selected, plan]);

  return (
    <div className="space-y-4 pb-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Move Leads</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Move a client&apos;s leads between Bison instances (Cross Instance) or between campaigns within one instance (Same Instance). Runs in the background — start it and it finishes on its own, even if you close the tab. Each lead is routed by its lane (business→B2B, personal→B2C) and its ESP. Copy-only.
          </p>
        </div>
        <button
          onClick={syncFromSheet}
          disabled={syncingSheet}
          title="Rebuild group allocation, churned status and service areas from the Groups sheet now (instead of waiting for the scheduled sync)"
          className="shrink-0 inline-flex items-center gap-1.5 px-3 h-9 text-sm font-medium rounded-md border hover:bg-muted/50 disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${syncingSheet ? "animate-spin" : ""}`} /> {syncingSheet ? "Syncing…" : "Sync from sheet"}
        </button>
      </div>

      {/* Persistent progress panels — server-driven, so they show every active/
          recent move (cross or same) regardless of which tab is open, and rehydrate
          after a tab close. */}
      {orderedMoves.map((m) => (
        <div key={m.jobId} className="space-y-2">
          <MigrationPanel
            state={m.state}
            running={m.status === "running"}
            onStop={() => cancel(m.jobId)}
            onClose={() => dismiss(m.jobId)}
            onRetry={() => retry(m.jobId)}
            onExportSkipped={() => exportSkipped(m.runId)}
          />
          {m.status !== "queued" && <SkippedViewer runId={m.runId} onExport={() => exportSkipped(m.runId)} />}
        </div>
      ))}

      {/* Tabs */}
      <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
        <button type="button" onClick={() => setTab("cross")} className={`px-3.5 h-8 text-sm font-medium rounded-md transition-colors ${tab === "cross" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Cross Instance</button>
        <button type="button" onClick={() => setTab("same")} className={`px-3.5 h-8 text-sm font-medium rounded-md transition-colors ${tab === "same" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Same Instance</button>
      </div>

      <div className={tab === "same" ? "" : "hidden"}>
        <SameInstanceTab onEnqueued={refresh} />
      </div>

      <div className={tab === "cross" ? "space-y-4" : "hidden"}>
      {/* From → To */}
      <div className="flex flex-wrap items-end gap-4 rounded-xl border bg-card p-4">
        <InstancePick label="From instance" value={from} onChange={setFrom} disabledKey={to} />
        <ArrowRight className="size-5 text-muted-foreground mb-2 shrink-0" />
        <InstancePick label="To instance" value={to} onChange={setTo} disabledKey={from} />
        <div className="ml-auto flex items-center gap-2">
          <button onClick={loadPlan} disabled={planning || !selected.size} className="inline-flex items-center gap-2 px-3 h-9 text-sm font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
            {planning ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Plan {selected.size || ""} client{selected.size === 1 ? "" : "s"}
          </button>
          <button onClick={() => enqueueMigration([...selected])} disabled={!plannedSelected.length || enqueuing} title={anyActive ? "A migration is already running — this queues another (they run one at a time)" : undefined} className="inline-flex items-center gap-2 px-3 h-9 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
            {enqueuing ? <Loader2 className="size-3.5 animate-spin" /> : anyActive ? <Plus className="size-3.5" /> : <Zap className="size-3.5" />} {anyActive ? "Queue" : "Migrate"} {plannedSelected.length || ""}
          </button>
        </div>
        {/* Lane note — the To instance decides which leads move */}
        <div className="w-full flex items-center gap-2 pt-3 mt-1 border-t text-xs text-muted-foreground">
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${targetLane === "b2b" ? "bg-indigo-50 text-indigo-700 border-indigo-200" : "bg-amber-50 text-amber-700 border-amber-200"}`}>{laneLabel}</span>
          <span>{toLabel} is a <span className="font-medium text-foreground">{laneLabel}</span> instance — only <span className="font-medium text-foreground">{targetLane === "b2b" ? "business" : "personal"}-email</span> leads move here, each routed by its own ESP (Google/Outlook/SEGs). {targetLane === "b2b" ? "Personal" : "Business"} leads are skipped — move them in a separate run to the {targetLane === "b2b" ? "B2C" : "B2B"} instance.</span>
        </div>
        {/* Service-area gate */}
        <div className="w-full flex items-center gap-2 pt-3 mt-1 border-t">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={serviceAreaFilter} onChange={(e) => setServiceAreaFilter(e.target.checked)} className="size-4 rounded border-muted-foreground/40" />
            <MapPin className="size-3.5 text-muted-foreground" />
            <span className="font-medium">Service-area filter</span>
          </label>
          <span className="text-xs text-muted-foreground">
            {serviceAreaFilter
              ? "Leads whose city isn't in the client's service area are skipped (and exportable). Leads with no city, or clients with no area set, still move."
              : "Off — every lead moves regardless of location."}
          </span>
        </div>
      </div>

      {/* Batch preview summary */}
      {summary.total > 0 && (
        <div className="rounded-xl border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span className="font-medium">Plan preview</span>
            <SummaryPill tone="emerald" n={summary.ready.length} label="ready" />
            {summary.partial.length > 0 && <SummaryPill tone="amber" n={summary.partial.length} label="partial" />}
            {summary.blocked.length > 0 && <SummaryPill tone="rose" n={summary.blocked.length} label="blocked" />}
            {summary.empty.length > 0 && <SummaryPill tone="slate" n={summary.empty.length} label="no leads" />}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              up to <span className="text-foreground font-semibold">{summary.readyLeads.toLocaleString()}</span> leads · only {laneLabel} leads move
            </span>
          </div>
          {(summary.blocked.length > 0 || summary.partial.length > 0) && (
            <div className="mt-2.5 pt-2.5 border-t space-y-1 text-xs">
              {summary.blocked.length > 0 && (
                <p className="flex items-start gap-1.5 text-rose-700">
                  <AlertTriangle className="size-3.5 shrink-0 mt-px" />
                  <span><span className="font-semibold">No campaigns in {toLabel}</span> for {summary.blocked.map((r) => r.tag).join(", ")} — these will be skipped. Create the matching campaigns in {toLabel} first.</span>
                </p>
              )}
              {summary.partial.length > 0 && (
                <p className="flex items-start gap-1.5 text-amber-700">
                  <AlertTriangle className="size-3.5 shrink-0 mt-px" />
                  <span><span className="font-semibold">Missing some ESPs:</span> {summary.partial.map((r) => `${r.tag} (${r.unmatchedEsps.map((e) => ESP_LABEL[e]).join(", ")})`).join("; ")} — leads of a missing ESP are skipped (create that ESP&apos;s campaign in {toLabel}).</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Client picker */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-2.5 border-b space-y-2">
          <div className="flex items-start gap-3">
            <div className="relative flex-1">
              <Search className="size-4 text-muted-foreground absolute left-3 top-2.5" />
              <textarea
                placeholder="Search a tag, or paste a list (one per line, comma, or space) then Select all…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                rows={Math.min(8, Math.max(1, search.split(/\n/).length))}
                className="w-full pl-9 pr-3 py-1.5 text-sm rounded-md border bg-background resize-y leading-6 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
              />
            </div>
            <div className="flex items-center gap-3 shrink-0 pt-1.5">
              <div className="flex items-center rounded-md border p-0.5 text-xs bg-white">
                {(["active", "returning", "all"] as const).map((f) => (
                  <button key={f} onClick={() => setClientStatus(f)} className={`px-2 h-6 rounded capitalize transition-colors ${clientStatus === f ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted/60"}`}>
                    {f}{f === "returning" && churnedCount > 0 ? ` (${churnedCount})` : ""}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">{selected.size} selected · {filtered.length} shown</span>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none whitespace-nowrap">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="size-3.5 rounded border-muted-foreground/40" /> Select all
              </label>
            </div>
          </div>
          {unknownTokens.length > 0 && (
            <p className="text-[11px] text-amber-700 flex items-start gap-1.5">
              <AlertTriangle className="size-3 shrink-0 mt-0.5" />
              <span>Not in the list (churned or misspelled): <span className="font-mono">{unknownTokens.join(", ")}</span></span>
            </p>
          )}
        </div>
        <div className="max-h-[46vh] overflow-auto divide-y">
          {filtered.map((tag) => {
            const p = plan.get(tag);
            const matchedEsps = p ? (Object.keys(p.match) as Esp[]) : [];
            return (
              <div key={tag} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
                <input type="checkbox" checked={selected.has(tag)} onChange={() => toggleOne(tag)} className="size-3.5 rounded border-muted-foreground/40" />
                <span className="font-mono text-sm font-semibold w-24 shrink-0">{tag}</span>
                {clientRowByTag.get(tag)?.churned && (
                  <span className="inline-flex items-center gap-0.5 text-[9px] font-medium rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 shrink-0" title={clientRowByTag.get(tag)?.churnDate ? `Churned on ${clientRowByTag.get(tag)?.churnDate}` : "Returning/churned"}><UserX className="size-2.5" /> returning</span>
                )}
                {p ? (
                  <div className="flex items-center gap-2.5 text-xs text-muted-foreground flex-wrap">
                    <StatusBadge status={p.status} />
                    <span className="tabular-nums"><span className="text-foreground font-medium">{p.totalLeads.toLocaleString()}</span> leads · {p.sourceCampaigns.length} campaigns</span>
                    {p.status === "blocked" && <span className="text-rose-700">no <span className="font-medium">{tag}</span> campaigns in {toLabel}</span>}
                    {p.status !== "blocked" && matchedEsps.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-emerald-700"><Check className="size-3" /> {matchedEsps.map((e) => ESP_LABEL[e]).join(", ")} → {toLabel} ({laneLabel})</span>
                    )}
                    {p.status === "partial" && p.unmatchedEsps.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="size-3" /> no {p.unmatchedEsps.map((e) => ESP_LABEL[e]).join(", ")} campaign in {toLabel}</span>
                    )}
                    {p.status === "empty" && <span className="text-muted-foreground/60 italic">no leads in {from}</span>}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground/50 italic">select + Plan to preview</span>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && <div className="px-4 py-10 text-center text-sm text-muted-foreground">No clients match.</div>}
        </div>
      </div>
      </div>
    </div>
  );
}

const PILL_TONE: Record<string, string> = {
  emerald: "bg-emerald-100 text-emerald-700", amber: "bg-amber-100 text-amber-700",
  rose: "bg-rose-100 text-rose-700", slate: "bg-slate-100 text-slate-600",
};
function SummaryPill({ tone, n, label }: { tone: "emerald" | "amber" | "rose" | "slate"; n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`grid place-items-center min-w-5 h-5 px-1 rounded text-xs font-semibold tabular-nums ${PILL_TONE[tone]}`}>{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

const STATUS_BADGE: Record<PlanStatus, { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "bg-emerald-100 text-emerald-700" },
  partial: { label: "Partial", cls: "bg-amber-100 text-amber-700" },
  blocked: { label: "Blocked", cls: "bg-rose-100 text-rose-700" },
  empty: { label: "No leads", cls: "bg-slate-100 text-slate-500" },
};
function StatusBadge({ status }: { status: PlanStatus }) {
  const b = STATUS_BADGE[status];
  return <span className={`px-1.5 h-5 grid place-items-center rounded text-[10px] font-semibold uppercase tracking-wide shrink-0 ${b.cls}`}>{b.label}</span>;
}

interface SkippedRow { client_tag: string; email: string; city: string | null; state: string | null; source_campaign_name: string; reason: string }
function SkippedViewer({ runId, onExport }: { runId: string | null; onExport: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SkippedRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/leads/move/skipped?runId=${encodeURIComponent(runId)}&limit=500`);
      const d = await res.json();
      if (res.ok) { setRows((d.rows as SkippedRow[]) || []); setTotal(d.total ?? 0); }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [runId]);

  useEffect(() => { if (open) load(); }, [open, load]);
  if (!runId) return null;

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-muted/30">
        <MapPin className="size-4 text-amber-600" />
        <span className="font-medium">Skipped — out of service area</span>
        {total != null && <span className="text-xs text-muted-foreground tabular-nums">{total.toLocaleString()} lead{total === 1 ? "" : "s"}</span>}
        <span className="ml-auto flex items-center gap-2">
          {!!total && (
            <span onClick={(e) => { e.stopPropagation(); onExport(); }} className="inline-flex items-center gap-1 px-2 h-7 text-xs rounded border hover:bg-muted/50"><Download className="size-3" /> Export CSV</span>
          )}
          <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <div className="border-t">
          <div className="flex items-center justify-between px-4 py-1.5 text-xs text-muted-foreground">
            <span>{loading ? "Loading…" : `Showing ${rows.length}${total != null && total > rows.length ? ` of ${total.toLocaleString()}` : ""}`}</span>
            <button onClick={load} className="hover:text-foreground">Refresh</button>
          </div>
          <div className="max-h-[40vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card border-y text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-1.5 font-medium">Client</th>
                  <th className="px-3 py-1.5 font-medium">Email</th>
                  <th className="px-3 py-1.5 font-medium">City</th>
                  <th className="px-3 py-1.5 font-medium">State</th>
                  <th className="px-3 py-1.5 font-medium">Campaign</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r, i) => (
                  <tr key={i} className="hover:bg-muted/30">
                    <td className="px-3 py-1 font-mono">{r.client_tag}</td>
                    <td className="px-3 py-1">{r.email}</td>
                    <td className="px-3 py-1">{r.city || <span className="text-muted-foreground/50">—</span>}</td>
                    <td className="px-3 py-1">{r.state || <span className="text-muted-foreground/50">—</span>}</td>
                    <td className="px-3 py-1 text-muted-foreground truncate max-w-[240px]" title={r.source_campaign_name}>{r.source_campaign_name}</td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No leads skipped by the service-area filter yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function InstancePick({ label, value, onChange, disabledKey }: { label: string; value: string; onChange: (v: string) => void; disabledKey?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {BISON_INSTANCES.map((inst) => {
          const on = value === inst.key;
          const disabled = disabledKey === inst.key;
          return (
            <button
              key={inst.key}
              data-on={on}
              disabled={disabled}
              onClick={() => onChange(inst.key)}
              className={`px-2.5 h-8 text-xs rounded-md border transition-colors disabled:opacity-30 ${on ? `text-white ${INSTANCE_ACCENT[inst.key] || "data-[on=true]:bg-foreground"}` : "hover:bg-muted/50"}`}
            >
              {inst.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
