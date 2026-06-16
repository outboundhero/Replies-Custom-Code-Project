"use client";

/**
 * Nurture Automation tab — health dashboard. Per client: auto on/off (opt-out),
 * its group's B2B/B2C instances, and a campaign-existence matrix (instance x ESP)
 * so operators see at a glance which clients are routable and which need
 * campaigns created (and where). Bulk enable/disable by section + multi-select.
 * Reads the fast, cached /api/nurture/automation-status (Turso-only).
 */
import { useEffect, useMemo, useState, useCallback, Fragment } from "react";
import { InstanceBadge } from "@/components/instance-badge";
import { Input } from "@/components/ui/input";
import { Search, Check, AlertTriangle, Zap, ZapOff, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";

type Esp = "google" | "outlook" | "segs";
type Cell = { state: "ok" | "missing"; status?: string; draft?: boolean };
interface ClientRow {
  clientTag: string; group: number | null; b2b: string | null; b2c: string | null;
  autoOn: boolean; lastRunAt: string | null; mappingMissing: boolean;
  matrix: Record<string, Record<Esp, Cell>>; configured: boolean;
  missingCells: Array<{ instance: string; esp: Esp }>;
}
interface Section { id: number; name: string; clients: ClientRow[] }

const ESPS: Esp[] = ["google", "outlook", "segs"];
const ESP_SHORT: Record<Esp, string> = { google: "G", outlook: "O", segs: "S" };

export default function AutomationTab() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  // local optimistic overrides: tag -> autoOn
  const [autoOverride, setAutoOverride] = useState<Map<string, boolean>>(new Map());

  const load = useCallback((fresh = false) => {
    setLoading(true);
    fetch(`/api/nurture/automation-status${fresh ? "?fresh=1" : ""}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setSections(d.sections || []); setSyncedAt(d.syncedAt || null); setError(null); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(false); }, [load]);

  const autoFor = (c: ClientRow) => autoOverride.has(c.clientTag) ? autoOverride.get(c.clientTag)! : c.autoOn;

  const filtered = useMemo(() => {
    if (!sections) return null;
    const q = search.trim().toLowerCase();
    return sections
      .map((s) => ({ ...s, clients: q ? s.clients.filter((c) => c.clientTag.toLowerCase().includes(q)) : s.clients }))
      .filter((s) => s.clients.length > 0);
  }, [sections, search]);

  const stats = useMemo(() => {
    let total = 0, on = 0, configured = 0, needCampaigns = 0;
    for (const s of sections || []) for (const c of s.clients) {
      total++; if (autoFor(c)) on++; if (c.configured) configured++; if (!c.configured) needCampaigns++;
    }
    return { total, on, configured, needCampaigns };
  }, [sections, autoOverride]);

  async function toggleOne(tag: string, enabled: boolean) {
    setAutoOverride((m) => new Map(m).set(tag, enabled));
    try {
      await fetch("/api/clients/auto-nurture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientTag: tag, enabled }) });
    } catch { setAutoOverride((m) => new Map(m).set(tag, !enabled)); }
  }

  async function bulk(enabled: boolean, opts: { clientTags?: string[]; sectionIds?: number[] }) {
    setBusy(true);
    const affected = new Set<string>(opts.clientTags?.map((t) => t) || []);
    if (opts.sectionIds && sections) for (const s of sections) if (opts.sectionIds.includes(s.id)) s.clients.forEach((c) => affected.add(c.clientTag));
    setAutoOverride((m) => { const n = new Map(m); affected.forEach((t) => n.set(t, enabled)); return n; });
    try {
      await fetch("/api/clients/auto-nurture/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, ...opts }) });
      setSelected(new Set());
    } finally { setBusy(false); }
  }

  if (loading && !sections) return <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-12 rounded-lg border bg-card animate-pulse" />)}</div>;
  if (error) return <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">Couldn&apos;t load automation status: {error}</div>;

  return (
    <div className="space-y-4">
      {/* Summary tiles */}
      <div className="grid grid-cols-4 gap-3">
        <Tile label="Clients" value={stats.total} accent="text-foreground" />
        <Tile label="Auto-route ON" value={stats.on} accent="text-emerald-700" />
        <Tile label="Fully configured" value={stats.configured} accent="text-emerald-700" />
        <Tile label="Need campaigns" value={stats.needCampaigns} accent="text-rose-700" />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="size-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <Input placeholder="Search client tag…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9" />
        </div>
        <button onClick={() => load(true)} disabled={loading} className="flex items-center gap-2 px-3 h-9 text-sm rounded-md border bg-white hover:bg-muted/50 disabled:opacity-50">
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        {syncedAt && <span className="text-xs text-muted-foreground ml-auto">campaign data as of {new Date(syncedAt).toLocaleString()}</span>}
      </div>

      {/* Sticky bulk bar */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex items-center gap-3 rounded-lg border bg-card shadow-sm px-4 py-2.5">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="ml-auto flex gap-2">
            <button disabled={busy} onClick={() => bulk(true, { clientTags: [...selected] })} className="flex items-center gap-1.5 px-3 h-8 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"><Zap className="size-3" /> Enable</button>
            <button disabled={busy} onClick={() => bulk(false, { clientTags: [...selected] })} className="flex items-center gap-1.5 px-3 h-8 text-xs rounded-md border hover:bg-muted/50 disabled:opacity-50"><ZapOff className="size-3" /> Disable</button>
            <button onClick={() => setSelected(new Set())} className="px-2 h-8 text-xs text-muted-foreground hover:underline">Clear</button>
          </div>
        </div>
      )}

      {/* Sections */}
      <div className="space-y-4">
        {(filtered || []).map((s) => {
          const isCollapsed = collapsed.has(s.id);
          return (
            <div key={s.id} className="rounded-lg border bg-card overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/30 border-b">
                <button onClick={() => setCollapsed((c) => { const n = new Set(c); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })} className="text-muted-foreground hover:text-foreground">
                  {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                </button>
                <span className="font-semibold text-sm">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.clients.length} clients</span>
                <div className="ml-auto flex gap-2">
                  <button disabled={busy} onClick={() => bulk(true, { sectionIds: [s.id] })} className="px-2.5 h-7 text-[11px] rounded-md border hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50">Enable all</button>
                  <button disabled={busy} onClick={() => bulk(false, { sectionIds: [s.id] })} className="px-2.5 h-7 text-[11px] rounded-md border hover:bg-muted/50 disabled:opacity-50">Disable all</button>
                </div>
              </div>
              {!isCollapsed && (
                <div className="divide-y">
                  {s.clients.map((c) => <ClientRowView key={c.clientTag} c={c} autoOn={autoFor(c)} selected={selected.has(c.clientTag)} onSelect={(v) => setSelected((sel) => { const n = new Set(sel); v ? n.add(c.clientTag) : n.delete(c.clientTag); return n; })} onToggle={(v) => toggleOne(c.clientTag, v)} />)}
                </div>
              )}
            </div>
          );
        })}
        {filtered && filtered.length === 0 && <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">No clients match.</div>}
      </div>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums mt-1 ${accent}`}>{value.toLocaleString()}</p>
    </div>
  );
}

function ClientRowView({ c, autoOn, selected, onSelect, onToggle }: {
  c: ClientRow; autoOn: boolean; selected: boolean; onSelect: (v: boolean) => void; onToggle: (v: boolean) => void;
}) {
  const danger = autoOn && !c.configured;
  const instances = useMemo(() => Object.keys(c.matrix), [c.matrix]);
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 ${danger ? "border-l-2 border-l-amber-400" : ""}`}>
      <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="size-3.5 rounded border-muted-foreground/40" />
      <div className="w-40 shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="font-mono font-semibold text-sm">{c.clientTag}</span>
          {c.group && <span className="text-[9px] rounded bg-muted px-1 py-0.5 text-muted-foreground">G{c.group}</span>}
        </div>
        <div className="flex items-center gap-1 mt-1">
          {c.b2b && <InstanceBadge instance={c.b2b} size="xs" />}
          {c.b2c && <InstanceBadge instance={c.b2c} size="xs" />}
          {c.mappingMissing && <span className="text-[9px] rounded bg-amber-100 text-amber-700 px-1 py-0.5">no group</span>}
        </div>
      </div>

      {/* matrix: per instance, 3 ESP chips */}
      <div className="flex-1 flex flex-wrap gap-x-4 gap-y-1.5">
        {instances.length === 0 ? <span className="text-xs text-muted-foreground/60">unmapped — sync group sheet</span> : instances.map((inst) => (
          <div key={inst} className="flex items-center gap-1.5">
            <InstanceBadge instance={inst} size="xs" />
            {ESPS.map((esp) => {
              const cell = c.matrix[inst]?.[esp];
              const ok = cell?.state === "ok";
              const draft = cell?.draft;
              const cls = !ok ? "bg-rose-100 text-rose-600" : draft ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700";
              const title = !ok ? `Missing: create "${c.clientTag}: ${esp[0].toUpperCase() + esp.slice(1)} [Nurture] (Cleaning Client)" in ${inst}` : draft ? `${esp} ready (draft — won't send until active)` : `${esp} active`;
              return <span key={esp} title={title} className={`text-[10px] font-medium rounded px-1 py-0.5 leading-none ${cls}`}>{ESP_SHORT[esp]}</span>;
            })}
          </div>
        ))}
      </div>

      <div className="shrink-0 w-20 text-center">
        {c.configured
          ? <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700"><Check className="size-3" /> Ready</span>
          : <span className="inline-flex items-center gap-1 text-[11px] text-rose-600" title={c.missingCells.map((m) => `${m.esp}@${m.instance}`).join(", ")}><AlertTriangle className="size-3" /> {c.missingCells.length} gap{c.missingCells.length === 1 ? "" : "s"}</span>}
      </div>

      {/* Auto toggle */}
      <button onClick={() => onToggle(!autoOn)} className={`shrink-0 flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[11px] font-medium transition-colors ${autoOn ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}>
        {autoOn ? <Zap className="size-3" /> : <ZapOff className="size-3" />} {autoOn ? "Auto" : "Off"}
      </button>
    </div>
  );
}
