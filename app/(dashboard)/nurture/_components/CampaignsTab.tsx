"use client";

/**
 * Campaigns monitoring tab — watch nurture campaigns fill up and auto-expand.
 * Per routing (client × workspace) shows the trio's completion-% bars, a
 * combined-leads-vs-5,000 meter, and a status (Building / Ready to expand /
 * Batch N). Reads the cached /api/nurture/expansion-status (Turso-only, fast).
 * "Check now" runs a dry-run evaluation on demand to verify it live.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { InstanceBadge } from "@/components/instance-badge";
import { Input } from "@/components/ui/input";
import { Search, RefreshCw, Zap, TrendingUp, Loader2 } from "lucide-react";

type Esp = "google" | "outlook" | "segs";
type Cell = { campaignId: number | null; name: string | null; completion: number; total: number; status: string };
interface Routing {
  clientTag: string; group: number | null; instance: string; lane: "b2b" | "b2c" | null;
  esps: Record<Esp, Cell | null>; combinedLeads: number; allAbove50: boolean; readyToExpand: boolean;
  batch: number; checkedAt: string | null;
}
interface Expansion { clientTag: string; instance: string; esp: string; batch: number; createdAt: string }
interface Data {
  routings: Routing[]; recentExpansions: Expansion[];
  stats: { routingsWatched: number; readyToExpand: number; totalClones: number; largestCombined: number };
  thresholds: { completion: number; combinedLeads: number };
}

const ESPS: Esp[] = ["google", "outlook", "segs"];
const ESP_SHORT: Record<Esp, string> = { google: "G", outlook: "O", segs: "S" };
const LANE_LABEL: Record<string, string> = { b2b: "B2B", b2c: "B2C" };

function rel(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso.includes("Z") || iso.includes("+") ? iso : iso.replace(" ", "T") + "Z").getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function CampaignsTab() {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [checking, setChecking] = useState<string | null>(null);

  const load = useCallback((fresh = false) => {
    setLoading(true);
    fetch(`/api/nurture/expansion-status${fresh ? "?fresh=1" : ""}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(false); }, [load]);

  const routings = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return q ? data.routings.filter((r) => r.clientTag.toLowerCase().includes(q)) : data.routings;
  }, [data, search]);

  const combinedMin = data?.thresholds.combinedLeads ?? 5000;
  const compMin = data?.thresholds.completion ?? 50;

  async function checkNow(tag: string) {
    setChecking(tag);
    try {
      const res = await fetch("/api/nurture/expand-now", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientTag: tag, dryRun: true }) });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "Check failed"); return; }
      const would = (d.instances || []).filter((i: { reason?: string }) => i.reason?.includes("would expand"));
      if (would.length) toast.success(`${tag}: ${would.length} routing(s) ready to expand now.`);
      else toast.info(`${tag}: nothing to expand yet — health refreshed.`);
      load(true);
    } finally { setChecking(null); }
  }

  if (loading && !data) return <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-16 rounded-lg border bg-card animate-pulse" />)}</div>;
  if (error) return <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">Couldn&apos;t load campaign status: {error}</div>;
  const stats = data!.stats;

  return (
    <div className="space-y-4">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Routings watched" value={stats.routingsWatched.toLocaleString()} accent="text-foreground" />
        <Tile label="Ready to expand" value={stats.readyToExpand.toLocaleString()} accent="text-violet-700" />
        <Tile label="Clones created" value={stats.totalClones.toLocaleString()} accent="text-emerald-700" />
        <Tile label="Largest routing" value={`${stats.largestCombined.toLocaleString()} leads`} accent="text-foreground" />
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
        <span className="text-xs text-muted-foreground ml-auto">auto-expands when all 3 are ≥ {compMin}% contacted &amp; &gt; {combinedMin.toLocaleString()} leads combined</span>
      </div>

      {/* Routing list */}
      <div className="rounded-lg border bg-card overflow-hidden">
        {routings.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No routing health yet. It populates after the daily expansion check (or click <strong>Check now</strong> on a confirmed client).
          </div>
        ) : (
          <div className="divide-y">
            {routings.map((r) => (
              <RoutingRow key={`${r.clientTag}:${r.instance}`} r={r} combinedMin={combinedMin} compMin={compMin}
                onOpen={() => router.push(`/nurture/c/${encodeURIComponent(r.clientTag)}`)}
                onCheck={() => checkNow(r.clientTag)} checking={checking === r.clientTag} />
            ))}
          </div>
        )}
      </div>

      {/* Recent expansions */}
      {data!.recentExpansions.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="px-4 py-2.5 border-b flex items-center gap-2"><TrendingUp className="size-4 text-emerald-600" /><span className="text-sm font-semibold">Recent expansions</span></div>
          <div className="divide-y max-h-72 overflow-auto">
            {data!.recentExpansions.map((e, i) => (
              <div key={i} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                <span className="font-mono font-semibold">{e.clientTag}</span>
                <InstanceBadge instance={e.instance} size="xs" />
                <span className="text-muted-foreground uppercase text-[11px]">{e.esp}</span>
                <span className="text-muted-foreground">→</span>
                <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><Zap className="size-3" /> Batch {e.batch}</span>
                <span className="ml-auto text-xs text-muted-foreground">{rel(e.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums mt-1 ${accent}`}>{value}</p>
    </div>
  );
}

function RoutingRow({ r, combinedMin, compMin, onOpen, onCheck, checking }: {
  r: Routing; combinedMin: number; compMin: number; onOpen: () => void; onCheck: () => void; checking: boolean;
}) {
  const combinedPct = Math.min(100, (r.combinedLeads / combinedMin) * 100);
  const status = r.readyToExpand
    ? { label: "Ready to expand", cls: "bg-violet-100 text-violet-700" }
    : r.batch > 1
      ? { label: `Batch ${r.batch}`, cls: "bg-emerald-100 text-emerald-700" }
      : { label: "Building", cls: "bg-amber-100 text-amber-700" };

  return (
    <div onClick={onOpen} className="group flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-muted/40 transition-colors">
      {/* Identity */}
      <div className="w-36 shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold text-sm">{r.clientTag}</span>
          {r.group && <span className="text-[9px] font-medium rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">G{r.group}</span>}
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="text-[10px] font-semibold text-muted-foreground">{r.lane ? LANE_LABEL[r.lane] : "—"}</span>
          <InstanceBadge instance={r.instance} size="xs" />
        </div>
      </div>

      {/* Trio completion bars */}
      <div className="flex-1 grid grid-cols-3 gap-3 min-w-0">
        {ESPS.map((esp) => {
          const c = r.esps[esp];
          const pct = c?.completion ?? 0;
          const ok = pct >= compMin;
          return (
            <div key={esp} className="min-w-0">
              <div className="flex items-center justify-between text-[11px] mb-1">
                <span className="font-semibold text-muted-foreground">{ESP_SHORT[esp]}</span>
                <span className={`tabular-nums ${ok ? "text-emerald-700" : "text-amber-700"}`}>{c ? `${Math.round(pct)}%` : "—"}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className={`h-full rounded-full ${ok ? "bg-emerald-500" : "bg-amber-400"}`} style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{(c?.total ?? 0).toLocaleString()} leads</p>
            </div>
          );
        })}
      </div>

      {/* Combined meter */}
      <div className="w-28 shrink-0">
        <div className="flex items-center justify-between text-[11px] mb-1">
          <span className="text-muted-foreground">combined</span>
          <span className="tabular-nums font-medium">{r.combinedLeads.toLocaleString()}</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div className={`h-full rounded-full ${r.combinedLeads > combinedMin ? "bg-violet-500" : "bg-slate-400"}`} style={{ width: `${combinedPct}%` }} />
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5">of {combinedMin.toLocaleString()}</p>
      </div>

      {/* Status + actions */}
      <div className="w-32 shrink-0 flex flex-col items-end gap-1">
        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2.5 h-6 ${status.cls}`}>{status.label}</span>
        <span className="text-[10px] text-muted-foreground">checked {rel(r.checkedAt)}</span>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onCheck(); }}
        disabled={checking}
        title="Run a dry-run evaluation now (refreshes health, reports if it would expand)"
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md border text-[11px] font-medium hover:bg-muted/50 disabled:opacity-50"
      >
        {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Check now
      </button>
    </div>
  );
}
