"use client";

/**
 * Same Instance tab — move a client's leads between campaigns WITHIN one Bison
 * instance. Pick a client (returning/churned included via the toggle) + an
 * instance, load its campaigns, bulk-select SOURCE + DESTINATION campaigns, and
 * move leads ESP-matched (Google→Google, etc.). Reuses POST /api/leads/move
 * (same instance for source+target = attach-only, idempotent), serviceAreaFilter off.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Search, Loader2, Zap, MapPin, AlertTriangle, ArrowRight, UserX } from "lucide-react";
import { BISON_INSTANCES, getInstanceLabel } from "@/lib/bison-instances-shared";
import SameInstancePanel, { type SameInstanceState, type SameSourceRow } from "./SameInstancePanel";

type Esp = "google" | "outlook" | "segs";
type ClientStatus = "active" | "returning" | "all";
interface ClientRow { tag: string; churned: boolean; churnDate: string | null; group: number | null; b2b: string | null; b2c: string | null }
interface PlanCampaign { id: number; name: string; status: string; esp: Esp; total_leads: number; isNurture: boolean }

const ESP_LABEL: Record<Esp, string> = { google: "Google", outlook: "Outlook", segs: "SEGs" };
const ESPS: Esp[] = ["google", "outlook", "segs"];
const CAMPAIGN_CONCURRENCY = 3;
const INSTANCE_ACCENT: Record<string, string> = {
  outboundhero: "data-[on=true]:bg-emerald-600", facilityreach: "data-[on=true]:bg-sky-600",
  cleaningoutbound: "data-[on=true]:bg-amber-600", outboundclean: "data-[on=true]:bg-violet-600",
};

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx]); } catch { /* row-level */ } }
  }));
}

interface Job { campaignId: number; name: string; esp: Esp; totalLeads: number; targetCampaignId: number; destName: string }

export default function SameInstanceTab() {
  const [allClients, setAllClients] = useState<ClientRow[]>([]);
  const [clientStatus, setClientStatus] = useState<ClientStatus>("active");
  const [clientSearch, setClientSearch] = useState("");
  const [client, setClient] = useState<ClientRow | null>(null);
  const [instance, setInstance] = useState<string>("");
  const [campaigns, setCampaigns] = useState<PlanCampaign[] | null>(null);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [sources, setSources] = useState<Set<number>>(new Set());
  const [destinations, setDestinations] = useState<Set<number>>(new Set());
  const [migration, setMigration] = useState<SameInstanceState | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef(false);
  const abortCtlRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
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

  function pickClient(c: ClientRow) {
    setClient(c);
    setInstance(c.b2b || BISON_INSTANCES[0].key); // default to the client's group B2B instance
    setCampaigns(null);
    setSources(new Set());
    setDestinations(new Set());
  }

  async function loadCampaigns() {
    if (!client || !instance) return;
    setLoadingCampaigns(true);
    setCampaigns(null);
    setSources(new Set());
    setDestinations(new Set());
    try {
      const res = await fetch("/api/leads/move/same-instance/plan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTag: client.tag, instance }),
      });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "Failed to load campaigns"); return; }
      setCampaigns((d.campaigns as PlanCampaign[]) || []);
      if (!d.campaigns?.length) toast.info(`No ${client.tag} campaigns found in ${getInstanceLabel(instance)}.`);
    } catch (e) { toast.error((e as Error).message); } finally { setLoadingCampaigns(false); }
  }

  const campMap = useMemo(() => new Map((campaigns || []).map((c) => [c.id, c])), [campaigns]);
  const byEsp = useMemo(() => {
    const m = new Map<Esp, PlanCampaign[]>();
    for (const c of campaigns || []) { if (!m.has(c.esp)) m.set(c.esp, []); m.get(c.esp)!.push(c); }
    return m;
  }, [campaigns]);

  const toggleSource = (id: number) => setSources((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleDest = (id: number) => setDestinations((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Resolve one destination per ESP + build the movable jobs / skipped / errors.
  const plan = useMemo(() => {
    const errors: string[] = [];
    const both = [...sources].filter((id) => destinations.has(id));
    for (const id of both) errors.push(`"${campMap.get(id)?.name}" is picked as both source and destination.`);

    const destByEsp = new Map<Esp, PlanCampaign>();
    const destGroups = new Map<Esp, PlanCampaign[]>();
    for (const id of destinations) { const c = campMap.get(id); if (!c) continue; if (!destGroups.has(c.esp)) destGroups.set(c.esp, []); destGroups.get(c.esp)!.push(c); }
    for (const [esp, cs] of destGroups) {
      if (cs.length > 1) errors.push(`Pick only one ${ESP_LABEL[esp]} destination (you selected ${cs.length}).`);
      else destByEsp.set(esp, cs[0]);
    }

    const jobs: Job[] = [];
    const skipped: Array<{ c: PlanCampaign; reason: string }> = [];
    let leadsToMove = 0;
    for (const id of sources) {
      const c = campMap.get(id); if (!c) continue;
      const dest = destByEsp.get(c.esp);
      if (!dest) { skipped.push({ c, reason: `no ${ESP_LABEL[c.esp]} destination selected` }); continue; }
      jobs.push({ campaignId: c.id, name: c.name, esp: c.esp, totalLeads: c.total_leads, targetCampaignId: dest.id, destName: dest.name });
      leadsToMove += c.total_leads;
    }
    return { errors, jobs, skipped, destByEsp, leadsToMove };
  }, [sources, destinations, campMap]);

  // ── Driver ──
  const patchRow = useCallback((campaignId: number, patch: Partial<SameSourceRow> | ((r: SameSourceRow) => Partial<SameSourceRow>)) => {
    setMigration((m) => m && { ...m, rows: m.rows.map((r) => (r.campaignId === campaignId ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r)) });
  }, []);

  async function postMoveWithRetry(campaignId: number, body: object): Promise<{ ok: boolean; data?: { moved: number; done: boolean; nextCursor: string | null }; error?: string }> {
    const MAX = 5;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      if (abortRef.current) return { ok: false, error: "stopped" };
      try {
        const res = await fetch("/api/leads/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abortCtlRef.current?.signal });
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
    patchRow(job.campaignId, { state: "moving", moved: 0, error: undefined });
    let moved = 0;
    let cursor: string | null = null;
    for (;;) {
      if (abortRef.current) { patchRow(job.campaignId, { state: "error", error: "stopped", moved }); return; }
      const r = await postMoveWithRetry(job.campaignId, {
        clientTag: client!.tag, sourceInstance: instance, sourceCampaignId: job.campaignId, sourceCampaignName: job.name,
        targetInstance: instance, targetCampaignId: job.targetCampaignId, cursor, serviceAreaFilter: false, runId: runIdRef.current,
      });
      if (!r.ok) { patchRow(job.campaignId, { state: "error", error: r.error, moved }); return; }
      moved += r.data!.moved || 0;
      patchRow(job.campaignId, { moved, state: "moving" });
      if (r.data!.done || !r.data!.nextCursor) break;
      cursor = r.data!.nextCursor;
    }
    patchRow(job.campaignId, { state: "done", moved });
  }

  async function runMove() {
    if (running || !client) return;
    if (plan.errors.length) { toast.error(plan.errors[0]); return; }
    if (!plan.jobs.length) { toast.error("Select at least one source campaign that has a matching-ESP destination."); return; }

    jobsRef.current = new Map(plan.jobs.map((j) => [j.campaignId, j]));
    const rows: SameSourceRow[] = [
      ...plan.jobs.map((j) => ({ campaignId: j.campaignId, name: j.name, esp: j.esp, destName: j.destName, totalLeads: j.totalLeads, moved: 0, state: "queued" as const, retries: 0 })),
      ...plan.skipped.map((s) => ({ campaignId: s.c.id, name: s.c.name, esp: s.c.esp, destName: null, totalLeads: s.c.total_leads, moved: 0, state: "skipped" as const, retries: 0, skipReason: s.reason })),
    ];
    setMigration({ status: "running", clientTag: client.tag, instanceLabel: getInstanceLabel(instance), rows });
    setRunning(true);
    abortRef.current = false;
    abortCtlRef.current = new AbortController();
    runIdRef.current = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `run-${Date.now()}`;
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
    patchRow(campaignId, { state: "queued", moved: 0, error: undefined, retryAttempt: null });
    await moveOne(job);
    setRunning(false);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl">
        Move a client&apos;s leads between campaigns <span className="font-medium text-foreground">inside one instance</span>, matched by ESP (Google→Google, etc.). Copy-only — the source campaigns aren&apos;t emptied.
      </p>

      {/* Client + instance */}
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

        {/* Client list */}
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
          <div className="flex flex-wrap items-end gap-3 pt-1">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">Instance <span className="text-muted-foreground/60 normal-case">· move within</span></p>
              <div className="flex flex-wrap gap-1.5">
                {BISON_INSTANCES.map((inst) => {
                  const on = instance === inst.key;
                  const native = client.b2b === inst.key || client.b2c === inst.key;
                  return (
                    <button key={inst.key} data-on={on} onClick={() => { setInstance(inst.key); setCampaigns(null); setSources(new Set()); setDestinations(new Set()); }}
                      className={`px-2.5 h-8 text-xs rounded-md border transition-colors ${on ? `text-white ${INSTANCE_ACCENT[inst.key] || "data-[on=true]:bg-foreground"}` : "hover:bg-muted/50"}`}>
                      {inst.label}{native ? " ★" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
            <button onClick={loadCampaigns} disabled={loadingCampaigns || !instance} className="inline-flex items-center gap-2 px-3 h-9 text-sm font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
              {loadingCampaigns ? <Loader2 className="size-3.5 animate-spin" /> : <MapPin className="size-3.5" />} Load campaigns
            </button>
            <span className="text-[11px] text-muted-foreground">★ = this client&apos;s group instance</span>
          </div>
        )}
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
            <span>· {campaigns.length} in {getInstanceLabel(instance)} · leads flow to the same-ESP destination</span>
          </div>
          <div className="max-h-[44vh] overflow-auto p-3 space-y-3">
            {ESPS.filter((esp) => byEsp.has(esp)).map((esp) => (
              <div key={esp}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{ESP_LABEL[esp]}</span>
                  <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 flex-1 text-[10px] text-muted-foreground/70 pr-2 text-right">
                    <span />
                    <span className="w-12 text-center">Source</span>
                    <span className="w-12 text-center">Dest</span>
                  </div>
                </div>
                <div className="rounded-md border divide-y">
                  {(byEsp.get(esp) || []).map((c) => (
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

          {/* Preview + Move */}
          <div className="border-t p-3 space-y-2">
            {plan.errors.length > 0 && (
              <div className="space-y-1">
                {plan.errors.map((e, i) => <p key={i} className="text-xs text-rose-700 flex items-start gap-1.5"><AlertTriangle className="size-3.5 shrink-0 mt-px" /> {e}</p>)}
              </div>
            )}
            {(plan.jobs.length > 0 || plan.skipped.length > 0) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                {ESPS.map((esp) => {
                  const srcCount = plan.jobs.filter((j) => j.esp === esp).length;
                  const dest = plan.destByEsp.get(esp);
                  if (!srcCount && !dest) return null;
                  return (
                    <span key={esp} className="inline-flex items-center gap-1.5">
                      <span className="font-medium">{ESP_LABEL[esp]}:</span>
                      <span className="text-muted-foreground">{srcCount} source{srcCount === 1 ? "" : "s"}</span>
                      <ArrowRight className="size-3 text-muted-foreground" />
                      {dest ? <span className="text-emerald-700 truncate max-w-[220px]" title={dest.name}>{dest.name}</span> : <span className="text-amber-600">no destination</span>}
                    </span>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">
                {plan.jobs.length} campaign{plan.jobs.length === 1 ? "" : "s"} · <span className="text-foreground font-semibold">{plan.leadsToMove.toLocaleString()}</span> leads
                {plan.skipped.length > 0 && <span className="text-amber-600"> · {plan.skipped.length} skipped</span>}
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
