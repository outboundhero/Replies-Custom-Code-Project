"use client";

/**
 * Nurture Automation tab — health dashboard. Per client: auto on/off (opt-out),
 * its group's B2B/B2C instances, and a campaign-existence matrix (instance x ESP)
 * so operators see at a glance which clients are routable and which need
 * campaigns created (and where). Bulk enable/disable by section + multi-select.
 * Reads the fast, cached /api/nurture/automation-status (Turso-only).
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { getInstanceLabel } from "@/lib/bison-instances-shared";
import { Search, Check, AlertTriangle, Zap, ZapOff, RefreshCw, ChevronRight } from "lucide-react";

type Esp = "google" | "outlook" | "segs";
type Cell = { state: "ok" | "missing"; status?: string; draft?: boolean };
interface ClientRow {
  clientTag: string; group: number | null; b2b: string | null; b2c: string | null;
  autoOn: boolean; lastRunAt: string | null; mappingMissing: boolean;
  matrix: Record<string, Record<Esp, Cell>>; configured: boolean;
  missingCells: Array<{ instance: string; esp: Esp }>;
  mapConfirmed: boolean; mapConfirmedAt: string | null;
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
  const [busy, setBusy] = useState(false);
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
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
      .map((s) => ({
        ...s,
        clients: s.clients.filter((c) =>
          (!q || c.clientTag.toLowerCase().includes(q)) &&
          (!onlyUnmapped || !c.mapConfirmed),
        ),
      }))
      .filter((s) => s.clients.length > 0);
  }, [sections, search, onlyUnmapped]);

  const stats = useMemo(() => {
    let total = 0, on = 0, configured = 0, needCampaigns = 0, needMap = 0;
    for (const s of sections || []) for (const c of s.clients) {
      total++;
      // "Auto-route ON" = effectively running: opted-in AND map confirmed
      // (without a confirmed map, sending is gated off no matter the flag).
      if (autoFor(c) && c.mapConfirmed) on++;
      if (c.configured) configured++; if (!c.configured) needCampaigns++;
      if (!c.mapConfirmed) needMap++;
    }
    return { total, on, configured, needCampaigns, needMap };
  }, [sections, autoOverride]);

  // Flat, globally-sorted client list (no section grouping): needs-attention
  // (un-mapped or campaign-gaps) first, then alphabetical.
  const flatClients = useMemo(() => {
    const all = (filtered || []).flatMap((s) => s.clients);
    const attn = (c: ClientRow) => (!c.mapConfirmed || !c.configured) ? 0 : 1;
    return [...all].sort((a, b) => attn(a) - attn(b) || a.clientTag.localeCompare(b.clientTag));
  }, [filtered]);

  const allSelected = flatClients.length > 0 && flatClients.every((c) => selected.has(c.clientTag));
  const toggleSelectAll = () => setSelected((prev) => {
    if (allSelected) { const n = new Set(prev); flatClients.forEach((c) => n.delete(c.clientTag)); return n; }
    return new Set([...prev, ...flatClients.map((c) => c.clientTag)]);
  });

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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Tile label="Clients" value={stats.total} accent="text-foreground" />
        <Tile label="Auto-route ON" value={stats.on} accent="text-emerald-700" />
        <Tile label="Fully configured" value={stats.configured} accent="text-emerald-700" />
        <Tile label="Need campaigns" value={stats.needCampaigns} accent="text-rose-700" />
        <Tile
          label="Need mapping"
          value={stats.needMap}
          accent="text-amber-700"
          active={onlyUnmapped}
          onClick={() => setOnlyUnmapped((v) => !v)}
        />
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

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/70">Campaign per ESP:</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-flex items-center justify-center size-4 rounded bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 text-[9px] font-semibold">G</span> active</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-flex items-center justify-center size-4 rounded bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 text-[9px] font-semibold">O</span> draft</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-flex items-center justify-center size-4 rounded bg-rose-50 text-rose-600 ring-1 ring-inset ring-rose-200 text-[9px] font-semibold">S</span> missing</span>
        <span className="text-muted-foreground/70">· G = Google, O = Outlook, S = SEGs · B2B / B2C = workspace lane</span>
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

      {/* Flat client list (no section grouping) */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2 bg-muted/30 border-b text-xs text-muted-foreground">
          <span>{flatClients.length} client{flatClients.length === 1 ? "" : "s"}{onlyUnmapped ? " · needing a map" : ""}</span>
          <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="size-3.5 rounded border-muted-foreground/40" />
            Select all
          </label>
        </div>
        {flatClients.length === 0
          ? <div className="p-8 text-center text-sm text-muted-foreground">No clients match.</div>
          : <div className="divide-y">
              {flatClients.map((c) => (
                <ClientRowView
                  key={c.clientTag} c={c} autoOn={autoFor(c)} selected={selected.has(c.clientTag)}
                  onSelect={(v) => setSelected((sel) => { const n = new Set(sel); v ? n.add(c.clientTag) : n.delete(c.clientTag); return n; })}
                  onToggle={(v) => toggleOne(c.clientTag, v)}
                />
              ))}
            </div>}
      </div>
    </div>
  );
}

function Tile({ label, value, accent, active, onClick }: { label: string; value: number; accent: string; active?: boolean; onClick?: () => void }) {
  const inner = (
    <>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums mt-1 ${accent}`}>{value.toLocaleString()}</p>
    </>
  );
  if (onClick) {
    return (
      <button onClick={onClick} className={`text-left rounded-lg border px-4 py-3 transition-colors ${active ? "border-amber-400 bg-amber-50/60 ring-1 ring-amber-300" : "bg-card hover:bg-muted/40"}`}>
        {inner}
      </button>
    );
  }
  return <div className="rounded-lg border bg-card px-4 py-3">{inner}</div>;
}

// Within a client's group there is exactly one B2B and one B2C instance, so a
// compact lane label (B2B / B2C) is far cleaner than repeating the full
// workspace name; the full name lives in the tooltip.
function laneFor(inst: string, c: ClientRow): "B2B" | "B2C" | null {
  if (inst === c.b2b) return "B2B";
  if (inst === c.b2c) return "B2C";
  return null;
}

const ESP_FULL: Record<Esp, string> = { google: "Google", outlook: "Outlook", segs: "SEGs" };

function EspPill({ cell, label, title }: { cell: Cell | undefined; label: string; title: string }) {
  const ok = cell?.state === "ok";
  const draft = cell?.draft;
  const cls = !ok
    ? "bg-rose-50 text-rose-600 ring-1 ring-inset ring-rose-200"
    : draft
      ? "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200"
      : "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200";
  return <span title={title} className={`inline-flex items-center justify-center size-5 rounded-md text-[10px] font-semibold ${cls}`}>{label}</span>;
}

function ClientRowView({ c, autoOn, selected, onSelect, onToggle }: {
  c: ClientRow; autoOn: boolean; selected: boolean; onSelect: (v: boolean) => void; onToggle: (v: boolean) => void;
}) {
  const router = useRouter();
  const danger = autoOn && !c.configured;
  // Order instances B2B first, then B2C, so the matrix reads consistently.
  const instances = useMemo(() => {
    const keys = Object.keys(c.matrix);
    return keys.sort((a, b) => (a === c.b2b ? -1 : b === c.b2b ? 1 : 0));
  }, [c.matrix, c.b2b]);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      onClick={() => router.push(`/nurture/c/${encodeURIComponent(c.clientTag)}`)}
      className={`group flex items-center gap-4 px-4 py-3 cursor-pointer transition-colors hover:bg-muted/40 ${danger ? "border-l-2 border-l-amber-400" : "border-l-2 border-l-transparent"}`}
    >
      <input
        type="checkbox" checked={selected} onClick={stop} onChange={(e) => onSelect(e.target.checked)}
        className="size-3.5 rounded border-muted-foreground/40 cursor-pointer"
      />

      {/* Client identity */}
      <div className="w-32 shrink-0 flex items-center gap-2">
        <span className="font-mono font-semibold text-sm truncate group-hover:text-foreground">{c.clientTag}</span>
        {c.group
          ? <span className="text-[9px] font-medium rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">G{c.group}</span>
          : <span className="text-[9px] font-medium rounded bg-amber-100 px-1.5 py-0.5 text-amber-700" title="No group mapping — run the group sheet sync">no group</span>}
      </div>

      {/* Matrix: per instance (lane), 3 ESP pills */}
      <div className="flex-1 flex flex-wrap items-center gap-x-5 gap-y-2">
        {instances.length === 0
          ? <span className="text-xs text-muted-foreground/60 italic">unmapped — sync the group sheet to route this client</span>
          : instances.map((inst) => {
              const lane = laneFor(inst, c);
              return (
                <div key={inst} className="flex items-center gap-1.5">
                  <span title={getInstanceLabel(inst)} className="text-[10px] font-semibold text-muted-foreground tabular-nums w-7">{lane ?? "—"}</span>
                  {ESPS.map((esp) => {
                    const cell = c.matrix[inst]?.[esp];
                    const ok = cell?.state === "ok";
                    const title = !ok
                      ? `Missing: create "${c.clientTag}: ${ESP_FULL[esp]} [Nurture] (Cleaning Client)" in ${getInstanceLabel(inst)}`
                      : cell?.draft ? `${ESP_FULL[esp]} — draft (won't send until activated)` : `${ESP_FULL[esp]} — active`;
                    return <EspPill key={esp} cell={cell} label={ESP_SHORT[esp]} title={title} />;
                  })}
                </div>
              );
            })}
      </div>

      {/* Target-campaign map status */}
      <div className="shrink-0 w-28 flex justify-end">
        {c.mapConfirmed
          ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700" title={c.mapConfirmedAt ? `Confirmed ${new Date(c.mapConfirmedAt).toLocaleString()}` : "Target campaigns confirmed"}><Check className="size-3.5" /> Mapped</span>
          : <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700" title="No target-campaign map confirmed — open the client and pick campaigns to enable sending"><AlertTriangle className="size-3.5" /> No map</span>}
      </div>

      {/* Configured status (campaigns exist?) */}
      <div className="shrink-0 w-24 flex justify-end">
        {c.configured
          ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700"><Check className="size-3.5" /> Ready</span>
          : <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-600" title={c.missingCells.map((m) => `${ESP_FULL[m.esp]} @ ${getInstanceLabel(m.instance)}`).join("\n")}><AlertTriangle className="size-3.5" /> {c.missingCells.length} gap{c.missingCells.length === 1 ? "" : "s"}</span>}
      </div>

      {/* Auto toggle — gated on a confirmed map: without one, auto-routing can't
          run, so the control is disabled and shows the gated state rather than a
          misleading "Auto ON". */}
      {!c.mapConfirmed ? (
        <span
          title="Confirm this client's Target Campaigns to enable auto-routing"
          className="shrink-0 inline-flex items-center gap-1.5 px-3 h-7 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-400 cursor-not-allowed"
        >
          <ZapOff className="size-3" /> Off
        </span>
      ) : (
        <button
          onClick={(e) => { stop(e); onToggle(!autoOn); }}
          className={`shrink-0 inline-flex items-center gap-1.5 px-3 h-7 rounded-full text-[11px] font-semibold transition-colors ${autoOn ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
        >
          {autoOn ? <Zap className="size-3" /> : <ZapOff className="size-3" />} {autoOn ? "Auto" : "Off"}
        </button>
      )}

      <ChevronRight className="size-4 text-muted-foreground/30 shrink-0 group-hover:text-muted-foreground/70 transition-colors" />
    </div>
  );
}
