"use client";

/**
 * Same Instance tab (lane + per-lead-ESP). Pick a client → auto-load campaigns
 * from BOTH group instances (B2B1 + B2C1). Bulk-select SOURCE + DESTINATION
 * campaigns, then Move. Each source campaign's leads are split by email type
 * (business→B2B, personal→B2C) AND by each lead's ESP into the chosen
 * destinations. The move runs as a durable SERVER-SIDE background job (finishes
 * on its own even if you close the tab); this tab just enqueues it — progress
 * shows in the shared panels at the top of the page.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Search, Loader2, Zap, AlertTriangle, UserX, MapPin, RefreshCw } from "lucide-react";
import { getInstanceLabel } from "@/lib/bison-instances-shared";

type Esp = "google" | "outlook" | "segs";
type Lane = "b2b" | "b2c";
type ClientStatus = "active" | "returning" | "all";
interface ClientRow { tag: string; churned: boolean; churnDate: string | null; group: number | null; b2b: string | null; b2c: string | null }
interface PlanCampaign { id: number; name: string; status: string; esp: Esp; total_leads: number; isNurture: boolean; instance: string; lane: Lane }
interface Job { campaignId: number; name: string; esp: Esp; sourceInstance: string; sourceSlot: string; totalLeads: number }

const ESP_LABEL: Record<Esp, string> = { google: "Google", outlook: "Outlook", segs: "SEGs" };
const ESPS: Esp[] = ["google", "outlook", "segs"];
const INSTANCE_SLOT: Record<string, string> = {
  outboundhero: "B2B 1", facilityreach: "B2B 2", cleaningoutbound: "B2C 1", outboundclean: "B2C 2",
};
const slot = (instance: string) => INSTANCE_SLOT[instance] || instance;
const reachableEsps = (sourceEsp: Esp): Esp[] => (sourceEsp === "google" ? ESPS : [sourceEsp]);

export default function SameInstanceTab({ onEnqueued }: { onEnqueued?: () => void }) {
  const [allClients, setAllClients] = useState<ClientRow[]>([]);
  const [clientStatus, setClientStatus] = useState<ClientStatus>("active");
  const [clientSearch, setClientSearch] = useState("");
  const [client, setClient] = useState<ClientRow | null>(null);

  const [campaigns, setCampaigns] = useState<PlanCampaign[] | null>(null);
  const [b2bInstance, setB2bInstance] = useState<string>("");
  const [b2cInstance, setB2cInstance] = useState<string>("");
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [serviceArea, setServiceArea] = useState<{ raw: string; cities: string[] } | null>(null);
  const [syncingArea, setSyncingArea] = useState(false);

  const [sources, setSources] = useState<Set<number>>(new Set());
  const [destinations, setDestinations] = useState<Set<number>>(new Set());
  const [serviceAreaFilter, setServiceAreaFilter] = useState(true);
  const [enqueuing, setEnqueuing] = useState(false);

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
    if (!fresh) setCampaigns(null);
    try {
      const res = await fetch("/api/leads/move/same-instance/plan", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientTag: tag, fresh }),
      });
      const d = await res.json();
      if (!res.ok) { setPlanError(d.error || "Failed to load campaigns"); return; }
      setCampaigns((d.campaigns as PlanCampaign[]) || []);
      setB2bInstance(d.b2bInstance); setB2cInstance(d.b2cInstance);
      setServiceArea((d.serviceArea as { raw: string; cities: string[] }) ?? null);
      if (!d.campaigns?.length) setPlanError(`No ${tag} campaigns found in ${getInstanceLabel(d.b2bInstance)} or ${getInstanceLabel(d.b2cInstance)}.`);
    } catch (e) { setPlanError((e as Error).message); } finally { setLoadingCampaigns(false); }
  }, []);

  function pickClient(c: ClientRow) { setClient(c); setSources(new Set()); setDestinations(new Set()); loadCampaigns(c.tag); }
  function refreshCampaigns() { if (client) loadCampaigns(client.tag, { fresh: true }); }

  async function syncServiceArea() {
    if (!client || syncingArea) return;
    setSyncingArea(true);
    try {
      const res = await fetch("/api/service-area/sync", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientTag: client.tag }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || "Service-area sync failed"); return; }
      const area = (d.serviceArea as { raw: string; cities: string[] }) ?? null;
      setServiceArea(area);
      toast.success(area
        ? `${client.tag}: service area synced — ${area.cities.length} ${area.cities.length === 1 ? "city" : "cities"}.`
        : `${client.tag}: no service area found in the onboarding form.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncingArea(false);
    }
  }

  const campMap = useMemo(() => new Map((campaigns || []).map((c) => [c.id, c])), [campaigns]);
  const toggleSource = (id: number) => setSources((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleDest = (id: number) => setDestinations((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

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

    const feedableEsps = new Set<Esp>();
    for (const id of sources) { const c = campMap.get(id); if (c) for (const e of reachableEsps(c.esp)) feedableEsps.add(e); }
    for (const [k] of destByKey) { const [lane, esp] = k.split(":"); if (!feedableEsps.has(esp as Esp)) warnings.push(`${lane === "b2c" ? "B2C" : "B2B"} ${ESP_LABEL[esp as Esp]} destination selected, but no selected source can produce ${ESP_LABEL[esp as Esp]} leads — it will receive 0.`); }

    const jobs: Job[] = [];
    const skipped: PlanCampaign[] = [];
    let leadsToMove = 0;
    for (const id of sources) {
      const c = campMap.get(id); if (!c) continue;
      const hasDest = reachableEsps(c.esp).some((e) => destByKey.has(`b2b:${e}`) || destByKey.has(`b2c:${e}`));
      if (!hasDest) { skipped.push(c); continue; }
      jobs.push({ campaignId: c.id, name: c.name, esp: c.esp, sourceInstance: c.instance, sourceSlot: slot(c.instance), totalLeads: c.total_leads });
      leadsToMove += c.total_leads;
    }
    return { errors, warnings, jobs, skipped, destByKey, leadsToMove };
  }, [sources, destinations, campMap]);

  // ── Enqueue (server-side background job) ──
  async function enqueueMove() {
    if (!client) return;
    if (plan.errors.length) { toast.error(plan.errors[0]); return; }
    if (!plan.jobs.length) { toast.error("Select at least one source campaign that has a matching-ESP destination."); return; }

    const dest = { b2b: {} as Partial<Record<Esp, number>>, b2c: {} as Partial<Record<Esp, number>> };
    for (const [key, c] of plan.destByKey) { const [lane, esp] = key.split(":") as [Lane, Esp]; dest[lane][esp] = c.id; }
    const jobs = plan.jobs.map((j) => ({ sourceInstance: j.sourceInstance, sourceCampaignId: j.campaignId, sourceCampaignName: j.name, totalLeads: j.totalLeads, dest }));
    const skipped = plan.skipped.map((c) => ({ sourceCampaignName: c.name, reason: "no matching-ESP destination" }));
    const runId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    setEnqueuing(true);
    try {
      const res = await fetch("/api/leads/move/enqueue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "same", clientTag: client.tag, b2bInstance, b2cInstance, serviceAreaFilter, runId, jobs, skipped }),
      });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "Couldn't start the move"); return; }
      toast.success(`${client.tag} move started in the background — it'll finish on its own, even if you close this tab.`);
      onEnqueued?.();
    } catch (e) { toast.error((e as Error).message); } finally { setEnqueuing(false); }
  }

  const lanes: Array<{ lane: Lane; instance: string; label: string }> = [];
  if (b2bInstance) lanes.push({ lane: "b2b", instance: b2bInstance, label: `${slot(b2bInstance)} · ${getInstanceLabel(b2bInstance)}` });
  if (b2cInstance) lanes.push({ lane: "b2c", instance: b2cInstance, label: `${slot(b2cInstance)} · ${getInstanceLabel(b2cInstance)}` });

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
            {client && (
              <button
                onClick={syncServiceArea}
                disabled={syncingArea}
                title={`Pull ${client.tag}'s inclusion locations from the onboarding sheet now (don't wait for the 12h sync)`}
                className="inline-flex items-center gap-1.5 px-2.5 h-7 w-fit text-xs rounded-md border hover:bg-muted/50 disabled:opacity-50"
              >
                <RefreshCw className={`size-3 ${syncingArea ? "animate-spin" : ""}`} /> {syncingArea ? "Syncing…" : `Sync ${client.tag} service area`}
              </button>
            )}
            {serviceAreaFilter && client && (
              <div className="rounded-md border bg-amber-50/40 px-3 py-2 text-xs">
                {serviceArea ? (
                  <>
                    <p className="font-medium text-muted-foreground mb-1 flex flex-wrap items-center gap-1">
                      <MapPin className="size-3 text-amber-600" /> {client.tag} inclusion locations — leads outside this area are skipped
                      <span className="text-[10px] text-muted-foreground/70">· {serviceArea.cities.length} {serviceArea.cities.length === 1 ? "city" : "cities"} matched</span>
                    </p>
                    <p className="text-foreground max-h-24 overflow-auto leading-relaxed">{(serviceArea.raw || serviceArea.cities.join(", ")).split(/\n+/).map((s) => s.trim()).filter(Boolean).join(", ")}</p>
                  </>
                ) : (
                  <p className="text-amber-700 flex items-center gap-1"><AlertTriangle className="size-3 shrink-0" /> No service area set for {client.tag} — all leads will move (nothing skipped).</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">
                {plan.jobs.length} source{plan.jobs.length === 1 ? "" : "s"} · <span className="text-foreground font-semibold">{plan.leadsToMove.toLocaleString()}</span> leads
                {plan.skipped.length > 0 && <span className="text-amber-600"> · {plan.skipped.length} skipped (no ESP dest)</span>}
              </span>
              <button onClick={enqueueMove} disabled={plan.errors.length > 0 || plan.jobs.length === 0 || enqueuing} className="ml-auto inline-flex items-center gap-2 px-3 h-9 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                {enqueuing ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />} Move {plan.leadsToMove > 0 ? plan.leadsToMove.toLocaleString() : ""} leads
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
