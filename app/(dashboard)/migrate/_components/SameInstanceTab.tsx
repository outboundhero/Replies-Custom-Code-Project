"use client";

/**
 * Same Instance tab (lane + per-lead-ESP). Pick a client → auto-load campaigns
 * from BOTH group instances (B2B1 + B2C1). Bulk-select SOURCE + DESTINATION
 * campaigns. On move, each source campaign's leads are split by email type
 * (business→B2B, personal→B2C) AND by each lead's ESP (from its Bison tag for
 * Google catch-all sources — so SEGs/Outlook leads hidden inside a "Google +
 * Custom" campaign route correctly) into the chosen destinations.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Search, Loader2, Zap, AlertTriangle, UserX, MapPin, RefreshCw } from "lucide-react";
import { getInstanceLabel } from "@/lib/bison-instances-shared";
import SameInstancePanel, { type SameInstanceState, type SameSourceRow } from "./SameInstancePanel";
import { SkippedViewer } from "./SkippedViewer";

type Esp = "google" | "outlook" | "segs";
type Lane = "b2b" | "b2c";
type ClientStatus = "active" | "returning" | "all";
interface ClientRow { tag: string; churned: boolean; churnDate: string | null; group: number | null; b2b: string | null; b2c: string | null }
interface PlanCampaign { id: number; name: string; status: string; esp: Esp; total_leads: number; isNurture: boolean; instance: string; lane: Lane }
interface Job { campaignId: number; name: string; esp: Esp; sourceInstance: string; sourceSlot: string; totalLeads: number }
type DestMap = { b2b: Partial<Record<Esp, number>>; b2c: Partial<Record<Esp, number>> };

// One client move in the serial queue. Its run params (dest/names/jobs/instances/
// serviceAreaFilter/runId) are FROZEN at enqueue time so nothing mixes between
// clients, and `state` drives its own progress panel.
type MoveStatus = "queued" | "running" | "done";
interface MoveEntry {
  runId: string;
  status: MoveStatus;
  clientTag: string;
  b2bInstance: string;
  b2cInstance: string;
  dest: DestMap;
  names: Map<string, string>;
  jobs: Job[];
  serviceAreaFilter: boolean;
  state: SameInstanceState;
}

const ESP_LABEL: Record<Esp, string> = { google: "Google", outlook: "Outlook", segs: "SEGs" };
const ESPS: Esp[] = ["google", "outlook", "segs"];
const CAMPAIGN_CONCURRENCY = 3;
const INSTANCE_SLOT: Record<string, string> = {
  outboundhero: "B2B 1", facilityreach: "B2B 2", cleaningoutbound: "B2C 1", outboundclean: "B2C 2",
};
const slot = (instance: string) => INSTANCE_SLOT[instance] || instance;
// A Google (catch-all) source can contain leads of ANY ESP → resolved per-lead.
// Outlook/SEGs sources are trusted from the name → only that ESP.
const reachableEsps = (sourceEsp: Esp): Esp[] => (sourceEsp === "google" ? ESPS : [sourceEsp]);

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx]); } catch { /* row-level */ } }
  }));
}

export default function SameInstanceTab() {
  const [allClients, setAllClients] = useState<ClientRow[]>([]);
  const [clientStatus, setClientStatus] = useState<ClientStatus>("active");
  const [clientSearch, setClientSearch] = useState("");
  const [client, setClient] = useState<ClientRow | null>(null);

  const [campaigns, setCampaigns] = useState<PlanCampaign[] | null>(null);
  const [b2bInstance, setB2bInstance] = useState<string>("");
  const [b2cInstance, setB2cInstance] = useState<string>("");
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [sources, setSources] = useState<Set<number>>(new Set());
  const [destinations, setDestinations] = useState<Set<number>>(new Set());
  const [moves, setMoves] = useState<MoveEntry[]>([]);
  const [serviceAreaFilter, setServiceAreaFilter] = useState(true);
  const movesRef = useRef<MoveEntry[]>([]);                    // authoritative queue (state mirrors it)
  const chainRef = useRef<Promise<void>>(Promise.resolve());   // serial executor — ONE move at a time
  const abortRef = useRef(false);                              // aborts the currently-executing move
  const abortCtlRef = useRef<AbortController | null>(null);

  // Update the queue state + ref together so the serial executor always reads fresh data.
  const setMovesSynced = useCallback((updater: (prev: MoveEntry[]) => MoveEntry[]) => {
    movesRef.current = updater(movesRef.current);
    setMoves(movesRef.current);
  }, []);

  // Stop a RUNNING move (abort in-flight requests) or cancel a QUEUED one (remove it).
  const stopMove = useCallback((runId: string) => {
    const entry = movesRef.current.find((m) => m.runId === runId);
    if (!entry) return;
    if (entry.status === "running") { abortRef.current = true; abortCtlRef.current?.abort(); }
    else if (entry.status === "queued") setMovesSynced((prev) => prev.filter((m) => m.runId !== runId));
  }, [setMovesSynced]);

  const closeMove = useCallback((runId: string) => {
    setMovesSynced((prev) => prev.filter((m) => m.runId !== runId));
  }, [setMovesSynced]);
  const abortableSleep = useCallback((ms: number) => new Promise<void>((resolve) => {
    if (abortRef.current) return resolve();
    const t = setTimeout(resolve, ms);
    abortCtlRef.current?.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  }), []);

  useEffect(() => {
    fetch("/api/config/clients").then((r) => (r.ok ? r.json() : [])).then((rows) => {
      if (!Array.isArray(rows)) return;
      const seen = new Set<string>();
      const list: ClientRow[] = [];
      for (const r of rows as Array<Record<string, unknown>>) {
        const tag = String(r.tag || "");
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        list.push({ tag, churned: !!r.churned, churnDate: (r.churnDate as string) ?? null, group: (r.group as number) ?? null, b2b: (r.b2b as string) ?? null, b2c: (r.b2c as string) ?? null });
      }
      list.sort((a, b) => a.tag.localeCompare(b.tag));
      setAllClients(list);
    }).catch(() => {});
  }, []);

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    return allClients.filter((c) =>
      (!q || c.tag.toLowerCase().includes(q)) &&
      (clientStatus === "all" || (clientStatus === "returning" ? c.churned : !c.churned)),
    );
  }, [allClients, clientSearch, clientStatus]);
  const churnedCount = useMemo(() => allClients.filter((c) => c.churned).length, [allClients]);

  const loadCampaigns = useCallback(async (tag: string, opts?: { fresh?: boolean }) => {
    const fresh = opts?.fresh ?? false;
    setLoadingCampaigns(true); setPlanError(null);
    if (!fresh) setCampaigns(null); // on refresh keep the current list visible while re-pulling
    try {
      const res = await fetch("/api/leads/move/same-instance/plan", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientTag: tag, fresh }),
      });
      const d = await res.json();
      if (!res.ok) { setPlanError(d.error || "Failed to load campaigns"); return; }
      setCampaigns((d.campaigns as PlanCampaign[]) || []);
      setB2bInstance(d.b2bInstance); setB2cInstance(d.b2cInstance);
      if (!d.campaigns?.length) setPlanError(`No ${tag} campaigns found in ${getInstanceLabel(d.b2bInstance)} or ${getInstanceLabel(d.b2cInstance)}.`);
    } catch (e) { setPlanError((e as Error).message); } finally { setLoadingCampaigns(false); }
  }, []);

  function pickClient(c: ClientRow) { setClient(c); setSources(new Set()); setDestinations(new Set()); loadCampaigns(c.tag); }
  // Re-pull the client's campaigns from Bison, bypassing the 60s cache (for
  // just-created / still-processing campaigns). Keeps current selections.
  function refreshCampaigns() { if (client) loadCampaigns(client.tag, { fresh: true }); }

  const campMap = useMemo(() => new Map((campaigns || []).map((c) => [c.id, c])), [campaigns]);
  const toggleSource = (id: number) => setSources((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleDest = (id: number) => setDestinations((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Resolve destinations per (lane × ESP); build jobs / skipped / errors / warnings.
  const plan = useMemo(() => {
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const id of sources) if (destinations.has(id)) errors.push(`"${campMap.get(id)?.name}" is both source and destination.`);

    const destByKey = new Map<string, PlanCampaign>();
    const groups = new Map<string, PlanCampaign[]>();
    for (const id of destinations) { const c = campMap.get(id); if (!c) continue; const k = `${c.lane}:${c.esp}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(c); }
    for (const [k, cs] of groups) {
      if (cs.length > 1) { const [lane, esp] = k.split(":"); errors.push(`Pick only one ${lane === "b2c" ? "B2C" : "B2B"} ${ESP_LABEL[esp as Esp]} destination (you selected ${cs.length}).`); }
      else destByKey.set(k, cs[0]);
    }

    // Which (lane, ESP) destinations CAN be fed by the selected sources? A Google
    // source can feed any ESP; an Outlook/SEGs source only its own.
    const feedableEsps = new Set<Esp>();
    for (const id of sources) { const c = campMap.get(id); if (c) for (const e of reachableEsps(c.esp)) feedableEsps.add(e); }
    for (const [k] of destByKey) { const [lane, esp] = k.split(":"); if (!feedableEsps.has(esp as Esp)) warnings.push(`${lane === "b2c" ? "B2C" : "B2B"} ${ESP_LABEL[esp as Esp]} destination selected, but no selected source can produce ${ESP_LABEL[esp as Esp]} leads — it will receive 0.`); }

    const jobs: Job[] = [];
    const skipped: PlanCampaign[] = [];
    let leadsToMove = 0;
    for (const id of sources) {
      const c = campMap.get(id); if (!c) continue;
      // Movable if at least one reachable-ESP destination exists (either lane).
      const hasDest = reachableEsps(c.esp).some((e) => destByKey.has(`b2b:${e}`) || destByKey.has(`b2c:${e}`));
      if (!hasDest) { skipped.push(c); continue; }
      jobs.push({ campaignId: c.id, name: c.name, esp: c.esp, sourceInstance: c.instance, sourceSlot: slot(c.instance), totalLeads: c.total_leads });
      leadsToMove += c.total_leads;
    }
    return { errors, warnings, jobs, skipped, destByKey, leadsToMove };
  }, [sources, destinations, campMap]);

  // ── Driver (serial queue: exactly one move executes at a time) ──
  const patchRow = useCallback((runId: string, campaignId: number, patch: Partial<SameSourceRow> | ((r: SameSourceRow) => Partial<SameSourceRow>)) => {
    setMovesSynced((prev) => prev.map((m) => (m.runId !== runId ? m : {
      ...m,
      state: { ...m.state, rows: m.state.rows.map((r) => (r.campaignId === campaignId ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r)) },
    })));
  }, [setMovesSynced]);

  const setEntryStatus = useCallback((runId: string, status: MoveStatus) => {
    setMovesSynced((prev) => prev.map((m) => (m.runId !== runId ? m : { ...m, status, state: { ...m.state, status } })));
  }, [setMovesSynced]);

  async function postMoveWithRetry(runId: string, campaignId: number, body: object): Promise<{ ok: boolean; data?: { movedByKey: Record<string, number>; skipped: number; skippedArea: number; done: boolean; nextCursor: string | null }; error?: string }> {
    const MAX = 5;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      if (abortRef.current) return { ok: false, error: "stopped" };
      try {
        const res = await fetch("/api/leads/move/same-instance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abortCtlRef.current?.signal });
        if (res.ok) { patchRow(runId, campaignId, { retryAttempt: null }); return { ok: true, data: await res.json() }; }
        const err = await res.json().catch(() => ({}));
        if (res.status !== 429 && res.status < 500) return { ok: false, error: err.error || `HTTP ${res.status}` };
      } catch { if (abortRef.current) return { ok: false, error: "stopped" }; }
      if (attempt < MAX) {
        const wait = Math.min(20000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
        patchRow(runId, campaignId, (r) => ({ state: "retrying", retryAttempt: attempt, retries: r.retries + 1 }));
        await abortableSleep(wait);
      }
    }
    return { ok: false, error: "failed after 5 retries" };
  }

  async function moveOne(entry: MoveEntry, job: Job) {
    if (abortRef.current) return;
    patchRow(entry.runId, job.campaignId, { state: "moving", moved: 0, skipped: 0, skippedArea: 0, buckets: [], error: undefined });
    const acc: Record<string, number> = {};
    let sk = 0, ska = 0;
    let cursor: string | null = null;
    for (;;) {
      if (abortRef.current) { patchRow(entry.runId, job.campaignId, { state: "error", error: "stopped" }); return; }
      const r = await postMoveWithRetry(entry.runId, job.campaignId, {
        clientTag: entry.clientTag, sourceInstance: job.sourceInstance, sourceCampaignId: job.campaignId, sourceCampaignName: job.name,
        b2bInstance: entry.b2bInstance, b2cInstance: entry.b2cInstance, dest: entry.dest, cursor,
        serviceAreaFilter: entry.serviceAreaFilter, runId: entry.runId,
      });
      if (!r.ok) { patchRow(entry.runId, job.campaignId, { state: "error", error: r.error }); return; }
      for (const [k, n] of Object.entries(r.data!.movedByKey || {})) acc[k] = (acc[k] || 0) + n;
      sk += r.data!.skipped || 0;
      ska += r.data!.skippedArea || 0;
      const buckets = Object.entries(acc).map(([key, moved]) => { const [lane, esp] = key.split(":"); return { key, lane: lane as Lane, esp, destName: entry.names.get(key) || "", moved }; });
      const moved = Object.values(acc).reduce((a, b) => a + b, 0);
      patchRow(entry.runId, job.campaignId, { moved, skipped: sk, skippedArea: ska, buckets, state: "moving" });
      if (r.data!.done || !r.data!.nextCursor) break;
      cursor = r.data!.nextCursor;
    }
    patchRow(entry.runId, job.campaignId, { state: "done" });
  }

  // Run ONE whole client move to completion. Called only from the serial chain,
  // so exactly one runs at a time — no cross-client mixing.
  async function executeMove(runId: string) {
    const entry = movesRef.current.find((m) => m.runId === runId);
    if (!entry) return; // cancelled while queued
    abortRef.current = false;
    abortCtlRef.current = new AbortController();
    setEntryStatus(runId, "running");
    try {
      await pool(entry.jobs, CAMPAIGN_CONCURRENCY, (job) => moveOne(entry, job));
    } finally {
      setEntryStatus(runId, "done");
    }
    if (!abortRef.current) toast.success(`${entry.clientTag}: move finished — sources unchanged (copy-only).`);
  }

  // Append a unit of work to the serial chain — guarantees one-at-a-time ordering.
  function runExclusive(fn: () => Promise<void>) {
    chainRef.current = chainRef.current.then(fn, fn).catch(() => {});
  }

  function enqueueMove() {
    if (!client) return;
    if (plan.errors.length) { toast.error(plan.errors[0]); return; }
    if (!plan.jobs.length) { toast.error("Select at least one source campaign that has a matching-ESP destination."); return; }

    // Freeze EVERY run parameter now, so later client selections can't leak in.
    const runId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const dest: DestMap = { b2b: {}, b2c: {} };
    const names = new Map<string, string>();
    for (const [key, c] of plan.destByKey) { const [lane, esp] = key.split(":") as [Lane, Esp]; dest[lane][esp] = c.id; names.set(key, c.name); }

    const rows: SameSourceRow[] = [
      ...plan.jobs.map((j) => ({ campaignId: j.campaignId, name: j.name, esp: j.esp, sourceSlot: j.sourceSlot, totalLeads: j.totalLeads, moved: 0, skipped: 0, skippedArea: 0, buckets: [], state: "queued" as const, retries: 0 })),
      ...plan.skipped.map((c) => ({ campaignId: c.id, name: c.name, esp: c.esp, sourceSlot: slot(c.instance), totalLeads: c.total_leads, moved: 0, skipped: c.total_leads, skippedArea: 0, buckets: [], state: "skipped" as const, retries: 0 })),
    ];
    const entry: MoveEntry = {
      runId, status: "queued", clientTag: client.tag, b2bInstance, b2cInstance,
      dest, names, jobs: plan.jobs.slice(), serviceAreaFilter,
      state: { status: "queued", clientTag: client.tag, b2bLabel: slot(b2bInstance), b2cLabel: slot(b2cInstance), rows },
    };
    setMovesSynced((prev) => [...prev, entry]);
    runExclusive(() => executeMove(runId));
    const active = movesRef.current.filter((m) => m.status === "queued" || m.status === "running").length;
    toast.success(active > 1 ? `${client.tag} queued — position ${active}.` : `${client.tag} started.`);
  }

  // Retry one failed source campaign — also serialized through the chain so it
  // never runs alongside another client's move.
  function retryCampaign(runId: string, campaignId: number) {
    runExclusive(async () => {
      const entry = movesRef.current.find((m) => m.runId === runId);
      if (!entry) return;
      const job = entry.jobs.find((j) => j.campaignId === campaignId);
      if (!job) return;
      abortRef.current = false;
      abortCtlRef.current = new AbortController();
      setEntryStatus(runId, "running");
      patchRow(runId, campaignId, { state: "queued", moved: 0, skipped: 0, skippedArea: 0, buckets: [], error: undefined, retryAttempt: null });
      try { await moveOne(entry, job); } finally { setEntryStatus(runId, "done"); }
    });
  }

  const exportSkipped = useCallback((runId: string) => {
    if (!runId) return;
    window.open(`/api/leads/move/skipped/export?runId=${encodeURIComponent(runId)}`, "_blank");
  }, []);

  const lanes: Array<{ lane: Lane; instance: string; label: string }> = [];
  if (b2bInstance) lanes.push({ lane: "b2b", instance: b2bInstance, label: `${slot(b2bInstance)} · ${getInstanceLabel(b2bInstance)}` });
  if (b2cInstance) lanes.push({ lane: "b2c", instance: b2cInstance, label: `${slot(b2cInstance)} · ${getInstanceLabel(b2cInstance)}` });

  // A move is queued or running → the button label flips to "Queue".
  const anyActive = moves.some((m) => m.status === "running" || m.status === "queued");

  // Show running first, then queued (in order), then done — active work stays on
  // top. Stable sort keeps enqueue order within each group; keyed by runId so
  // reordering never remounts a panel.
  const orderedMoves = useMemo(() => {
    const rank = (s: MoveStatus) => (s === "running" ? 0 : s === "queued" ? 1 : 2);
    return [...moves].sort((a, b) => rank(a.status) - rank(b.status));
  }, [moves]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl">
        Move a client&apos;s leads between its own campaigns. Each lead is routed by <span className="font-medium text-foreground">email type (business→B2B, personal→B2C)</span> and by its <span className="font-medium text-foreground">ESP</span> — Google catch-all sources are split per-lead so Outlook/SEGs leads reach the right campaign. Copy-only.
      </p>

      {/* Client picker */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="size-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <input placeholder="Search client tag…" value={clientSearch} onChange={(e) => setClientSearch(e.target.value)} className="w-full pl-9 pr-3 h-9 text-sm rounded-md border bg-background" />
          </div>
          <div className="flex items-center rounded-md border p-0.5 text-xs bg-white">
            {(["active", "returning", "all"] as ClientStatus[]).map((f) => (
              <button key={f} onClick={() => setClientStatus(f)} className={`px-2.5 h-7 rounded capitalize transition-colors ${clientStatus === f ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted/60"}`}>
                {f}{f === "returning" && churnedCount > 0 ? ` (${churnedCount})` : ""}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-40 overflow-auto rounded-md border divide-y">
          {filteredClients.map((c) => (
            <button key={c.tag} onClick={() => pickClient(c)} className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/40 ${client?.tag === c.tag ? "bg-emerald-50" : ""}`}>
              <span className="font-mono font-semibold w-24 shrink-0">{c.tag}</span>
              {c.group && <span className="text-[9px] font-medium rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">G{c.group}</span>}
              {c.churned && <span className="inline-flex items-center gap-0.5 text-[9px] font-medium rounded bg-rose-100 px-1.5 py-0.5 text-rose-700" title={c.churnDate ? `Churned on ${c.churnDate}` : "Churned"}><UserX className="size-2.5" /> returning{c.churnDate ? ` · ${c.churnDate}` : ""}</span>}
              {client?.tag === c.tag && <span className="ml-auto text-[10px] text-emerald-700 font-medium">selected</span>}
            </button>
          ))}
          {filteredClients.length === 0 && <div className="px-3 py-4 text-center text-xs text-muted-foreground">No clients match.</div>}
        </div>
        {client && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={refreshCampaigns} disabled={loadingCampaigns} className="inline-flex items-center gap-1.5 px-2.5 h-7 text-xs rounded-md border hover:bg-muted/50 disabled:opacity-50">
              <RefreshCw className={`size-3 ${loadingCampaigns ? "animate-spin" : ""}`} /> Refresh campaigns
            </button>
            <span className="text-[11px] text-muted-foreground">Pulls the latest from Bison — use if a just-created campaign isn&apos;t showing yet.</span>
          </div>
        )}
        {loadingCampaigns && <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" /> Loading {client?.tag} campaigns from both instances…</p>}
        {planError && <p className="text-xs text-amber-700 flex items-start gap-1.5"><AlertTriangle className="size-3.5 shrink-0 mt-px" /> {planError}</p>}
      </div>

      {/* Move queue — one panel per client. ONE runs at a time; the rest show
          "queued" and auto-start in order (no cross-client mixing). */}
      {orderedMoves.length > 0 && (
        <div className="space-y-3">
          {orderedMoves.map((m) => (
            <div key={m.runId} className="space-y-2">
              <SameInstancePanel
                state={m.state}
                running={m.status === "running"}
                onStop={() => stopMove(m.runId)}
                onClose={() => closeMove(m.runId)}
                onRetry={(cid) => retryCampaign(m.runId, cid)}
              />
              {m.status !== "queued" && <SkippedViewer runId={m.runId} onExport={() => exportSkipped(m.runId)} />}
            </div>
          ))}
        </div>
      )}

      {/* Campaign selection */}
      {campaigns && campaigns.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Pick source &amp; destination campaigns</span>
            <span>· business → B2B, personal → B2C · per-lead ESP for Google sources</span>
          </div>
          <div className="max-h-[44vh] overflow-auto p-3 space-y-4">
            {lanes.map(({ lane, instance, label }) => {
              const laneCamps = campaigns.filter((c) => c.instance === instance);
              if (!laneCamps.length) return null;
              return (
                <div key={instance}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${lane === "b2b" ? "bg-indigo-50 text-indigo-700 border-indigo-200" : "bg-amber-50 text-amber-700 border-amber-200"}`}>{label}</span>
                  </div>
                  {ESPS.filter((esp) => laneCamps.some((c) => c.esp === esp)).map((esp) => (
                    <div key={esp} className="mb-2">
                      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 mb-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{ESP_LABEL[esp]}</span>
                        <span className="w-12 text-center text-[10px] text-muted-foreground/70">Source</span>
                        <span className="w-12 text-center text-[10px] text-muted-foreground/70">Dest</span>
                      </div>
                      <div className="rounded-md border divide-y">
                        {laneCamps.filter((c) => c.esp === esp).map((c) => (
                          <div key={c.id} className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center px-3 py-1.5 text-sm hover:bg-muted/30">
                            <div className="min-w-0 flex items-center gap-2">
                              <span className="truncate" title={c.name}>{c.name}</span>
                              {c.isNurture && <span className="text-[9px] rounded bg-violet-100 text-violet-700 px-1 py-0.5 shrink-0">nurture</span>}
                              <span className={`text-[10px] shrink-0 ${c.status === "active" ? "text-emerald-600" : "text-muted-foreground"}`}>{c.status}</span>
                              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{c.total_leads.toLocaleString()} leads</span>
                            </div>
                            <label className="w-12 flex justify-center"><input type="checkbox" checked={sources.has(c.id)} disabled={destinations.has(c.id)} onChange={() => toggleSource(c.id)} className="size-3.5 rounded border-muted-foreground/40" /></label>
                            <label className="w-12 flex justify-center"><input type="checkbox" checked={destinations.has(c.id)} disabled={sources.has(c.id)} onChange={() => toggleDest(c.id)} className="size-3.5 rounded border-muted-foreground/40" /></label>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {/* Preview + Move */}
          <div className="border-t p-3 space-y-2">
            {plan.errors.map((e, i) => <p key={`e${i}`} className="text-xs text-rose-700 flex items-start gap-1.5"><AlertTriangle className="size-3.5 shrink-0 mt-px" /> {e}</p>)}
            {plan.warnings.map((e, i) => <p key={`w${i}`} className="text-xs text-amber-700 flex items-start gap-1.5"><AlertTriangle className="size-3.5 shrink-0 mt-px" /> {e}</p>)}
            {plan.jobs.length > 0 && (
              <div className="text-xs text-muted-foreground">
                Destinations by lane × ESP:{" "}
                {[...plan.destByKey.entries()].map(([k, c]) => { const [lane, esp] = k.split(":"); return <span key={k} className="inline-flex items-center gap-1 mr-3"><span className={`font-medium ${lane === "b2c" ? "text-amber-700" : "text-indigo-700"}`}>{lane === "b2c" ? "B2C" : "B2B"} {ESP_LABEL[esp as Esp]}</span> → <span className="truncate max-w-[160px] align-bottom" title={c.name}>{c.name}</span></span>; })}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={serviceAreaFilter} onChange={(e) => setServiceAreaFilter(e.target.checked)} className="size-4 rounded border-muted-foreground/40" />
              <MapPin className="size-3.5 text-muted-foreground" />
              <span className="font-medium">Service-area filter</span>
              <span className="text-xs text-muted-foreground font-normal">
                {serviceAreaFilter
                  ? "Leads whose city isn't in the client's service area are skipped (and exportable). No city, or client with no area set → still move."
                  : "Off — every lead moves regardless of location."}
              </span>
            </label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">
                {plan.jobs.length} source{plan.jobs.length === 1 ? "" : "s"} · <span className="text-foreground font-semibold">{plan.leadsToMove.toLocaleString()}</span> leads
                {plan.skipped.length > 0 && <span className="text-amber-600"> · {plan.skipped.length} skipped (no ESP dest)</span>}
              </span>
              <button onClick={enqueueMove} disabled={plan.errors.length > 0 || plan.jobs.length === 0} className="ml-auto inline-flex items-center gap-2 px-3 h-9 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                <Zap className="size-3.5" /> {anyActive ? "Queue" : "Move"} {plan.leadsToMove > 0 ? plan.leadsToMove.toLocaleString() : ""} leads
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
