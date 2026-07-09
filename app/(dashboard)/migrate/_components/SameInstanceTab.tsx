"use client";

/**
 * Same Instance tab (lane-aware). Pick a client → auto-load its campaigns from
 * BOTH group instances (B2B1 + B2C1). Bulk-select SOURCE + DESTINATION campaigns.
 * On move, each source campaign's leads are split by email type — business →
 * the B2B destination, personal → the B2C destination — matched by ESP. Reuses
 * POST /api/leads/move/same-instance (routeCandidates: attach or create+attach).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Search, Loader2, Zap, AlertTriangle, ArrowRight, UserX } from "lucide-react";
import { getInstanceLabel } from "@/lib/bison-instances-shared";
import SameInstancePanel, { type SameInstanceState, type SameSourceRow } from "./SameInstancePanel";

type Esp = "google" | "outlook" | "segs";
type Lane = "b2b" | "b2c";
type ClientStatus = "active" | "returning" | "all";
interface ClientRow { tag: string; churned: boolean; churnDate: string | null; group: number | null; b2b: string | null; b2c: string | null }
interface PlanCampaign { id: number; name: string; status: string; esp: Esp; total_leads: number; isNurture: boolean; instance: string; lane: Lane }
interface Job { campaignId: number; name: string; esp: Esp; sourceInstance: string; sourceSlot: string; totalLeads: number; b2bTargetCampaignId: number | null; b2cTargetCampaignId: number | null; b2bDest: string | null; b2cDest: string | null }

const ESP_LABEL: Record<Esp, string> = { google: "Google", outlook: "Outlook", segs: "SEGs" };
const ESPS: Esp[] = ["google", "outlook", "segs"];
const CAMPAIGN_CONCURRENCY = 3;
const INSTANCE_SLOT: Record<string, string> = {
  outboundhero: "B2B 1", facilityreach: "B2B 2", cleaningoutbound: "B2C 1", outboundclean: "B2C 2",
};
const slot = (instance: string) => INSTANCE_SLOT[instance] || instance;

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
  const [migration, setMigration] = useState<SameInstanceState | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef(false);
  const abortCtlRef = useRef<AbortController | null>(null);
  const jobsRef = useRef<Map<number, Job>>(new Map());

  const stopMove = useCallback(() => { abortRef.current = true; abortCtlRef.current?.abort(); }, []);
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

  const loadCampaigns = useCallback(async (tag: string) => {
    setLoadingCampaigns(true); setCampaigns(null); setPlanError(null);
    setSources(new Set()); setDestinations(new Set());
    try {
      const res = await fetch("/api/leads/move/same-instance/plan", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientTag: tag }),
      });
      const d = await res.json();
      if (!res.ok) { setPlanError(d.error || "Failed to load campaigns"); return; }
      setCampaigns((d.campaigns as PlanCampaign[]) || []);
      setB2bInstance(d.b2bInstance); setB2cInstance(d.b2cInstance);
      if (!d.campaigns?.length) setPlanError(`No ${tag} campaigns found in ${getInstanceLabel(d.b2bInstance)} or ${getInstanceLabel(d.b2cInstance)}.`);
    } catch (e) { setPlanError((e as Error).message); } finally { setLoadingCampaigns(false); }
  }, []);

  function pickClient(c: ClientRow) { setClient(c); loadCampaigns(c.tag); }

  const campMap = useMemo(() => new Map((campaigns || []).map((c) => [c.id, c])), [campaigns]);
  const toggleSource = (id: number) => setSources((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleDest = (id: number) => setDestinations((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Resolve one destination per (lane × ESP); build movable jobs / skipped / errors.
  const plan = useMemo(() => {
    const errors: string[] = [];
    for (const id of sources) if (destinations.has(id)) errors.push(`"${campMap.get(id)?.name}" is both source and destination.`);

    const destByKey = new Map<string, PlanCampaign>();
    const groups = new Map<string, PlanCampaign[]>();
    for (const id of destinations) { const c = campMap.get(id); if (!c) continue; const k = `${c.lane}:${c.esp}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(c); }
    for (const [k, cs] of groups) {
      if (cs.length > 1) { const [lane, esp] = k.split(":"); errors.push(`Pick only one ${lane === "b2c" ? "B2C" : "B2B"} ${ESP_LABEL[esp as Esp]} destination (you selected ${cs.length}).`); }
      else destByKey.set(k, cs[0]);
    }

    const jobs: Job[] = [];
    const skipped: PlanCampaign[] = [];
    let leadsToMove = 0;
    for (const id of sources) {
      const c = campMap.get(id); if (!c) continue;
      const b2bDest = destByKey.get(`b2b:${c.esp}`) || null;
      const b2cDest = destByKey.get(`b2c:${c.esp}`) || null;
      if (!b2bDest && !b2cDest) { skipped.push(c); continue; } // no destination for this ESP at all
      jobs.push({ campaignId: c.id, name: c.name, esp: c.esp, sourceInstance: c.instance, sourceSlot: slot(c.instance), totalLeads: c.total_leads, b2bTargetCampaignId: b2bDest?.id ?? null, b2cTargetCampaignId: b2cDest?.id ?? null, b2bDest: b2bDest?.name ?? null, b2cDest: b2cDest?.name ?? null });
      leadsToMove += c.total_leads;
    }
    return { errors, jobs, skipped, destByKey, leadsToMove };
  }, [sources, destinations, campMap]);

  // ── Driver ──
  const patchRow = useCallback((campaignId: number, patch: Partial<SameSourceRow> | ((r: SameSourceRow) => Partial<SameSourceRow>)) => {
    setMigration((m) => m && { ...m, rows: m.rows.map((r) => (r.campaignId === campaignId ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r)) });
  }, []);

  async function postMoveWithRetry(campaignId: number, body: object): Promise<{ ok: boolean; data?: { movedB2b: number; movedB2c: number; skipped: number; done: boolean; nextCursor: string | null }; error?: string }> {
    const MAX = 5;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      if (abortRef.current) return { ok: false, error: "stopped" };
      try {
        const res = await fetch("/api/leads/move/same-instance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abortCtlRef.current?.signal });
        if (res.ok) { patchRow(campaignId, { retryAttempt: null }); return { ok: true, data: await res.json() }; }
        const err = await res.json().catch(() => ({}));
        if (res.status !== 429 && res.status < 500) return { ok: false, error: err.error || `HTTP ${res.status}` };
      } catch { if (abortRef.current) return { ok: false, error: "stopped" }; }
      if (attempt < MAX) {
        const wait = Math.min(20000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
        patchRow(campaignId, (r) => ({ state: "retrying", retryAttempt: attempt, retries: r.retries + 1 }));
        await abortableSleep(wait);
      }
    }
    return { ok: false, error: "failed after 5 retries" };
  }

  async function moveOne(job: Job) {
    if (abortRef.current) return;
    patchRow(job.campaignId, { state: "moving", movedB2b: 0, movedB2c: 0, skipped: 0, error: undefined });
    let b2b = 0, b2c = 0, sk = 0;
    let cursor: string | null = null;
    for (;;) {
      if (abortRef.current) { patchRow(job.campaignId, { state: "error", error: "stopped" }); return; }
      const r = await postMoveWithRetry(job.campaignId, {
        clientTag: client!.tag, sourceInstance: job.sourceInstance, sourceCampaignId: job.campaignId, sourceCampaignName: job.name,
        b2bInstance, b2cInstance, b2bCampaignId: job.b2bTargetCampaignId, b2cCampaignId: job.b2cTargetCampaignId, cursor,
      });
      if (!r.ok) { patchRow(job.campaignId, { state: "error", error: r.error }); return; }
      b2b += r.data!.movedB2b || 0; b2c += r.data!.movedB2c || 0; sk += r.data!.skipped || 0;
      patchRow(job.campaignId, { movedB2b: b2b, movedB2c: b2c, skipped: sk, state: "moving" });
      if (r.data!.done || !r.data!.nextCursor) break;
      cursor = r.data!.nextCursor;
    }
    patchRow(job.campaignId, { state: "done" });
  }

  async function runMove() {
    if (running || !client) return;
    if (plan.errors.length) { toast.error(plan.errors[0]); return; }
    if (!plan.jobs.length) { toast.error("Select at least one source campaign that has a matching-ESP destination."); return; }
    jobsRef.current = new Map(plan.jobs.map((j) => [j.campaignId, j]));
    const rows: SameSourceRow[] = [
      ...plan.jobs.map((j) => ({ campaignId: j.campaignId, name: j.name, esp: j.esp, sourceSlot: j.sourceSlot, totalLeads: j.totalLeads, movedB2b: 0, movedB2c: 0, b2bDest: j.b2bDest, b2cDest: j.b2cDest, skipped: 0, state: "queued" as const, retries: 0 })),
      ...plan.skipped.map((c) => ({ campaignId: c.id, name: c.name, esp: c.esp, sourceSlot: slot(c.instance), totalLeads: c.total_leads, movedB2b: 0, movedB2c: 0, b2bDest: null, b2cDest: null, skipped: c.total_leads, state: "skipped" as const, retries: 0 })),
    ];
    setMigration({ status: "running", clientTag: client.tag, b2bLabel: slot(b2bInstance), b2cLabel: slot(b2cInstance), rows });
    setRunning(true);
    abortRef.current = false;
    abortCtlRef.current = new AbortController();
    await pool(plan.jobs, CAMPAIGN_CONCURRENCY, moveOne);
    setMigration((m) => m && { ...m, status: "done" });
    setRunning(false);
    toast.success("Move finished — source campaigns are unchanged (copy-only).");
  }

  async function retryCampaign(campaignId: number) {
    const job = jobsRef.current.get(campaignId); if (!job) return;
    abortRef.current = false;
    abortCtlRef.current = new AbortController();
    setRunning(true);
    patchRow(campaignId, { state: "queued", movedB2b: 0, movedB2c: 0, skipped: 0, error: undefined, retryAttempt: null });
    await moveOne(job);
    setRunning(false);
  }

  const lanes: Array<{ lane: Lane; instance: string; label: string }> = [];
  if (b2bInstance) lanes.push({ lane: "b2b", instance: b2bInstance, label: `${slot(b2bInstance)} · ${getInstanceLabel(b2bInstance)}` });
  if (b2cInstance) lanes.push({ lane: "b2c", instance: b2cInstance, label: `${slot(b2cInstance)} · ${getInstanceLabel(b2cInstance)}` });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl">
        Move a client&apos;s leads between its own campaigns. Each source campaign&apos;s leads are split by email — <span className="font-medium text-foreground">business → B2B, personal → B2C</span> — and matched by ESP. Copy-only.
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
        {loadingCampaigns && <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" /> Loading {client?.tag} campaigns from both instances…</p>}
        {planError && <p className="text-xs text-amber-700 flex items-start gap-1.5"><AlertTriangle className="size-3.5 shrink-0 mt-px" /> {planError}</p>}
      </div>

      {/* Live panel */}
      {migration && (
        <div className="sticky top-2 z-20">
          <SameInstancePanel state={migration} running={running} onStop={stopMove} onClose={() => setMigration(null)} onRetry={retryCampaign} />
        </div>
      )}

      {/* Campaign selection */}
      {campaigns && campaigns.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Pick source &amp; destination campaigns</span>
            <span>· business leads → B2B destination, personal leads → B2C destination (same ESP)</span>
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
            {plan.errors.length > 0 && plan.errors.map((e, i) => <p key={i} className="text-xs text-rose-700 flex items-start gap-1.5"><AlertTriangle className="size-3.5 shrink-0 mt-px" /> {e}</p>)}
            {plan.jobs.length > 0 && (
              <div className="space-y-1 text-xs">
                {ESPS.filter((esp) => plan.jobs.some((j) => j.esp === esp)).map((esp) => {
                  const b2bDest = plan.destByKey.get(`b2b:${esp}`);
                  const b2cDest = plan.destByKey.get(`b2c:${esp}`);
                  const n = plan.jobs.filter((j) => j.esp === esp).length;
                  return (
                    <div key={esp} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className="font-medium">{ESP_LABEL[esp]}</span>
                      <span className="text-muted-foreground">{n} source{n === 1 ? "" : "s"}</span>
                      <span className="inline-flex items-center gap-1 text-indigo-700"><ArrowRight className="size-3" /> business → {b2bDest ? <span className="truncate max-w-[200px]" title={b2bDest.name}>{b2bDest.name}</span> : <span className="text-amber-600">none (skipped)</span>}</span>
                      <span className="inline-flex items-center gap-1 text-amber-700"><ArrowRight className="size-3" /> personal → {b2cDest ? <span className="truncate max-w-[200px]" title={b2cDest.name}>{b2cDest.name}</span> : <span className="text-amber-600">none (skipped)</span>}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">
                {plan.jobs.length} source{plan.jobs.length === 1 ? "" : "s"} · <span className="text-foreground font-semibold">{plan.leadsToMove.toLocaleString()}</span> leads
                {plan.skipped.length > 0 && <span className="text-amber-600"> · {plan.skipped.length} skipped (no ESP dest)</span>}
              </span>
              <button onClick={runMove} disabled={running || plan.errors.length > 0 || plan.jobs.length === 0} className="ml-auto inline-flex items-center gap-2 px-3 h-9 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                {running ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />} Move {plan.leadsToMove > 0 ? plan.leadsToMove.toLocaleString() : ""} leads
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
