"use client";

/**
 * Lead Mover — self-serve batch migration of a client tag's leads between Bison
 * instances/campaigns. Pick From → To, select clients, Plan (auto-match by ESP),
 * then Migrate. A sticky top MigrationPanel shows the whole run live with
 * per-client progress + retry state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Search, ArrowRight, Loader2, Sparkles, Zap, Check, AlertTriangle } from "lucide-react";
import { BISON_INSTANCES } from "@/lib/bison-instances-shared";
import MigrationPanel, { type MigrationState, type MoveClientRow } from "./_components/MigrationPanel";

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
}
const ESP_LABEL: Record<string, string> = { google: "Google", outlook: "Outlook", segs: "SEGs" };
const INSTANCE_ACCENT: Record<string, string> = {
  outboundhero: "data-[on=true]:bg-emerald-600", facilityreach: "data-[on=true]:bg-sky-600",
  cleaningoutbound: "data-[on=true]:bg-amber-600", outboundclean: "data-[on=true]:bg-violet-600",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx]); } catch { /* row-level */ } }
  }));
}

export default function MigratePage() {
  const [allTags, setAllTags] = useState<string[]>([]);
  const [from, setFrom] = useState<string>("outboundhero");
  const [to, setTo] = useState<string>("facilityreach");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<Map<string, ClientPlan>>(new Map());
  const [planning, setPlanning] = useState(false);
  const [migration, setMigration] = useState<MigrationState | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef(false);

  useEffect(() => {
    fetch("/api/config/clients").then((r) => (r.ok ? r.json() : [])).then((rows) => {
      if (!Array.isArray(rows)) return;
      const tags = [...new Set((rows as Array<{ tag?: string; churned?: boolean }>).filter((r) => !r.churned).map((r) => r.tag).filter(Boolean))].sort() as string[];
      setAllTags(tags);
    }).catch(() => {});
  }, []);

  // Changing instances invalidates any loaded plan.
  useEffect(() => { setPlan(new Map()); }, [from, to]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? allTags.filter((t) => t.toLowerCase().includes(q)) : allTags;
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

  // ── Migration driver ──
  const patchRow = useCallback((tag: string, patch: Partial<MoveClientRow> | ((r: MoveClientRow) => Partial<MoveClientRow>)) => {
    setMigration((m) => m && { ...m, rows: m.rows.map((r) => (r.tag === tag ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r)) });
  }, []);

  async function postMoveWithRetry(tag: string, body: object): Promise<{ ok: boolean; data?: { moved: number; done: boolean; nextPage: number; truncated?: boolean }; error?: string }> {
    const MAX = 5;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      if (abortRef.current) return { ok: false, error: "stopped" };
      try {
        const res = await fetch("/api/leads/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (res.ok) { patchRow(tag, { state: "moving", retryAttempt: null }); return { ok: true, data: await res.json() }; }
        const err = await res.json().catch(() => ({}));
        if (res.status !== 429 && res.status < 500) return { ok: false, error: err.error || `HTTP ${res.status}` }; // hard 4xx → don't retry
      } catch { /* network → retry */ }
      if (attempt < MAX) {
        const wait = Math.min(20000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
        patchRow(tag, (r) => ({ state: "retrying", retryAttempt: attempt, retries: r.retries + 1 }));
        await sleep(wait);
      }
    }
    return { ok: false, error: "failed after 5 retries" };
  }

  async function migrateClient(p: ClientPlan) {
    const tag = p.tag;
    if (abortRef.current) { patchRow(tag, { state: "error", error: "stopped" }); return; }
    const campaigns = p.sourceCampaigns.filter((c) => p.match[c.esp]);
    if (!campaigns.length) {
      patchRow(tag, { state: "skipped", skipReason: p.totalLeads === 0 ? "no leads in source" : `no ${p.unmatchedEsps.map((e) => ESP_LABEL[e]).join("/")} campaign in ${toLabel}` });
      return;
    }
    patchRow(tag, { state: "moving", campaignsTotal: campaigns.length, campaignsDone: 0, moved: 0 });
    let moved = 0, campaignsDone = 0;
    for (const c of campaigns) {
      if (abortRef.current) break;
      patchRow(tag, { currentEsp: c.esp });
      const targetCampaignId = p.match[c.esp]!.campaignId;
      let page = 1;
      for (;;) {
        if (abortRef.current) break;
        const r = await postMoveWithRetry(tag, {
          clientTag: tag, sourceInstance: from, sourceCampaignId: c.id, sourceCampaignName: c.name,
          targetInstance: to, targetCampaignId, page,
        });
        if (!r.ok) { patchRow(tag, { state: "error", error: r.error, moved }); return; }
        moved += r.data!.moved || 0;
        patchRow(tag, { moved });
        if (r.data!.done) break;
        page = r.data!.nextPage;
      }
      campaignsDone++;
      patchRow(tag, { campaignsDone });
    }
    patchRow(tag, abortRef.current ? { state: "error", error: "stopped", moved } : { state: "done", moved });
  }

  async function runMigration(tags: string[]) {
    if (running) return;
    const planned = tags.map((t) => plan.get(t)).filter(Boolean) as ClientPlan[];
    if (!planned.length) { toast.error("Nothing planned — run Plan first."); return; }
    const rows: MoveClientRow[] = planned.map((p) => ({
      tag: p.tag, state: "queued", totalLeads: p.totalLeads, moved: 0,
      campaignsTotal: p.sourceCampaigns.filter((c) => p.match[c.esp]).length, campaignsDone: 0,
      retries: 0, unmatchedEsps: p.unmatchedEsps,
    }));
    setMigration({ status: "running", from, to, rows });
    setRunning(true);
    abortRef.current = false;
    await pool(planned, 2, migrateClient);
    setMigration((m) => m && { ...m, status: "done" });
    setRunning(false);
    const total = rows.length;
    toast.success(`Migration finished (${total} client${total === 1 ? "" : "s"}). Remember to pause/archive the source campaigns.`);
  }

  async function retryClient(tag: string) {
    const p = plan.get(tag); if (!p) return;
    abortRef.current = false;
    setRunning(true);
    patchRow(tag, { state: "queued", moved: 0, campaignsDone: 0, error: undefined, retryAttempt: null });
    await migrateClient(p);
    setRunning(false);
  }

  const plannedSelected = useMemo(() => [...selected].filter((t) => plan.get(t) && plan.get(t)!.totalLeads > 0), [selected, plan]);
  const toLabel = useMemo(() => BISON_INSTANCES.find((i) => i.key === to)?.label || to, [to]);

  // Batch preview: ready to migrate vs flagged (missing campaigns), computed over selected+planned clients.
  const summary = useMemo(() => {
    const rows = [...selected].map((t) => plan.get(t)).filter(Boolean) as ClientPlan[];
    const ready = rows.filter((r) => r.status === "ready");
    const partial = rows.filter((r) => r.status === "partial");
    const blocked = rows.filter((r) => r.status === "blocked");
    const empty = rows.filter((r) => r.status === "empty");
    const readyLeads = [...ready, ...partial].reduce((s, r) => s + (r.status === "partial"
      ? r.sourceCampaigns.filter((c) => r.match[c.esp]).reduce((a, c) => a + c.total_leads, 0)
      : r.totalLeads), 0);
    return { total: rows.length, ready, partial, blocked, empty, readyLeads };
  }, [selected, plan]);

  return (
    <div className="space-y-4 pb-16">
      <div>
        <h1 className="text-[26px] font-semibold tracking-tight">Move Leads</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Migrate a client tag&apos;s leads from one Bison instance into the matching campaigns (by ESP) on another — no CSV. Copy-only: pause/archive the source campaigns afterward.
        </p>
      </div>

      {/* From → To */}
      <div className="flex flex-wrap items-end gap-4 rounded-xl border bg-card p-4">
        <InstancePick label="From instance" value={from} onChange={setFrom} disabledKey={to} />
        <ArrowRight className="size-5 text-muted-foreground mb-2 shrink-0" />
        <InstancePick label="To instance" value={to} onChange={setTo} disabledKey={from} />
        <div className="ml-auto flex items-center gap-2">
          <button onClick={loadPlan} disabled={planning || !selected.size} className="inline-flex items-center gap-2 px-3 h-9 text-sm font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
            {planning ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Plan {selected.size || ""} client{selected.size === 1 ? "" : "s"}
          </button>
          <button onClick={() => runMigration([...selected])} disabled={running || !plannedSelected.length} className="inline-flex items-center gap-2 px-3 h-9 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />} Migrate {plannedSelected.length || ""}
          </button>
        </div>
      </div>

      {/* Batch preview summary — shows what's ready vs flagged before you migrate */}
      {summary.total > 0 && (
        <div className="rounded-xl border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span className="font-medium">Plan preview</span>
            <SummaryPill tone="emerald" n={summary.ready.length} label="ready" />
            {summary.partial.length > 0 && <SummaryPill tone="amber" n={summary.partial.length} label="partial" />}
            {summary.blocked.length > 0 && <SummaryPill tone="rose" n={summary.blocked.length} label="blocked" />}
            {summary.empty.length > 0 && <SummaryPill tone="slate" n={summary.empty.length} label="no leads" />}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              <span className="text-foreground font-semibold">{summary.readyLeads.toLocaleString()}</span> leads will move
            </span>
          </div>
          {(summary.blocked.length > 0 || summary.partial.length > 0) && (
            <div className="mt-2.5 pt-2.5 border-t space-y-1 text-xs">
              {summary.blocked.length > 0 && (
                <p className="flex items-start gap-1.5 text-rose-700">
                  <AlertTriangle className="size-3.5 shrink-0 mt-px" />
                  <span><span className="font-semibold">No campaigns in {toLabel}</span> for {summary.blocked.map((r) => r.tag).join(", ")} — these will be skipped. Create the matching nurture campaigns in {toLabel} first.</span>
                </p>
              )}
              {summary.partial.length > 0 && (
                <p className="flex items-start gap-1.5 text-amber-700">
                  <AlertTriangle className="size-3.5 shrink-0 mt-px" />
                  <span><span className="font-semibold">Missing some ESPs:</span> {summary.partial.map((r) => `${r.tag} (${r.unmatchedEsps.map((e) => ESP_LABEL[e]).join(", ")})`).join("; ")} — matched ESPs move, the rest are skipped.</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Sticky live panel */}
      {migration && (
        <div className="sticky top-2 z-20">
          <MigrationPanel state={migration} running={running} onStop={() => { abortRef.current = true; }} onClose={() => setMigration(null)} onRetry={retryClient} />
        </div>
      )}

      {/* Client picker */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-2.5 border-b">
          <div className="relative flex-1 max-w-sm">
            <Search className="size-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <Input placeholder="Search client tag…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-8" />
          </div>
          <span className="text-xs text-muted-foreground">{selected.size} selected · {filtered.length} shown</span>
          <label className="ml-auto flex items-center gap-1.5 text-xs cursor-pointer select-none">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="size-3.5 rounded border-muted-foreground/40" /> Select all
          </label>
        </div>
        <div className="max-h-[46vh] overflow-auto divide-y">
          {filtered.map((tag) => {
            const p = plan.get(tag);
            const matchedEsps = p ? (Object.keys(p.match) as Esp[]) : [];
            return (
              <div key={tag} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
                <input type="checkbox" checked={selected.has(tag)} onChange={() => toggleOne(tag)} className="size-3.5 rounded border-muted-foreground/40" />
                <span className="font-mono text-sm font-semibold w-24 shrink-0">{tag}</span>
                {p ? (
                  <div className="flex items-center gap-2.5 text-xs text-muted-foreground flex-wrap">
                    <StatusBadge status={p.status} />
                    <span className="tabular-nums"><span className="text-foreground font-medium">{p.totalLeads.toLocaleString()}</span> leads · {p.sourceCampaigns.length} campaigns</span>
                    {p.status === "blocked" && <span className="text-rose-700">no <span className="font-medium">{tag}</span> campaigns in {toLabel}</span>}
                    {p.status !== "blocked" && matchedEsps.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-emerald-700"><Check className="size-3" /> {matchedEsps.map((e) => ESP_LABEL[e]).join(", ")} → {toLabel}</span>
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
