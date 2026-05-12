"use client";

/**
 * Nurture hub.
 *
 * Top: 4 dataset-wide count tiles (Ready / Eligible / Waiting / Added).
 * Below: searchable grid of client cards — each shows the same 4 counts
 * for that single client + a stacked mini-bar visualising the breakdown.
 * Click a card → /nurture/c/{clientTag} for the per-client detail page.
 *
 * Sorted by Ready descending by default so the most actionable clients
 * surface at the top. Hub queries are cheap (HEAD counts via
 * /api/nurture/clients-summary) so the page loads in 2–4 s even with
 * 50+ clients.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowRight, Search, RefreshCw } from "lucide-react";

interface OverallCounts {
  total: number;
  eligible: number;
  eligibleSafe: number;
  waiting: number;
  added: number;
}

interface ClientSummary {
  clientTag: string;
  ready: number;
  eligible: number;
  waiting: number;
  added: number;
  total: number;
}

type SortKey = "ready" | "eligible" | "waiting" | "added" | "tag";

export default function NurtureHub() {
  const [counts, setCounts] = useState<OverallCounts | null>(null);
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("ready");

  async function load() {
    setRefreshing(true);
    try {
      const [countsRes, clientsRes] = await Promise.all([
        fetch("/api/nurture/counts"),
        fetch("/api/nurture/clients-summary"),
      ]);
      if (countsRes.redirected || countsRes.status === 401) { window.location.href = "/login"; return; }
      if (countsRes.ok) setCounts(await countsRes.json());
      if (clientsRes.ok) {
        const d = await clientsRes.json();
        setClients(d.clients || []);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!clients) return [];
    const q = search.trim().toLowerCase();
    const rows = q
      ? clients.filter((c) => c.clientTag.toLowerCase().includes(q))
      : clients.slice();
    rows.sort((a, b) => {
      if (sortKey === "tag") return a.clientTag.localeCompare(b.clientTag);
      return (b[sortKey] || 0) - (a[sortKey] || 0);
    });
    return rows;
  }, [clients, search, sortKey]);

  return (
    <div className="space-y-6 max-w-[1500px]">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Nurture</h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Re-engage soft-negative, out-of-office, and sequence-finished leads after the 45-day cooldown. Pick a client below to drill into their lead list, ESP routing, and nurture campaign options.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 h-9 text-sm rounded-md border bg-white hover:bg-muted/50 disabled:opacity-50"
          title="Reload counts"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Overall tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Ready to nurture" sublabel="Eligible & safe — push these" value={counts?.eligibleSafe} accent="text-emerald-700" loading={loading} />
        <Tile label="All eligible" sublabel="Past 45-day cooldown" value={counts?.eligible} accent="text-sky-700" loading={loading} />
        <Tile label="Waiting" sublabel="Cooldown still ticking" value={counts?.waiting} accent="text-amber-700" loading={loading} />
        <Tile label="Added" sublabel="Already pushed to a campaign" value={counts?.added} accent="text-violet-700" loading={loading} />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="size-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            placeholder="Search client tag…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
          <SelectTrigger className="h-9 w-44 text-sm">
            <SelectValue placeholder="Sort by…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ready">Sort: Ready (high → low)</SelectItem>
            <SelectItem value="eligible">Sort: Eligible</SelectItem>
            <SelectItem value="waiting">Sort: Waiting</SelectItem>
            <SelectItem value="added">Sort: Added</SelectItem>
            <SelectItem value="tag">Sort: Tag (A → Z)</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} client{filtered.length === 1 ? "" : "s"}
          {search && clients ? ` (of ${clients.length})` : ""}
        </span>
      </div>

      {/* Client grid */}
      {loading || !clients ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-white p-4 h-[140px] animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          {search ? `No clients match "${search}"` : "No clients found"}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <ClientCard key={c.clientTag} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({
  label, sublabel, value, accent, loading,
}: {
  label: string; sublabel: string; value: number | undefined; accent: string; loading: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums mt-1.5 ${accent}`}>
        {loading ? <span className="inline-block w-16 h-7 bg-muted/50 rounded animate-pulse align-middle" /> : (value ?? 0).toLocaleString()}
      </p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{sublabel}</p>
    </div>
  );
}

function ClientCard({ c }: { c: ClientSummary }) {
  // Mini-bar segments — proportions of (Ready / Eligible-minus-ready / Waiting / Added)
  const eligibleNotReady = Math.max(0, c.eligible - c.ready);
  const total = c.ready + eligibleNotReady + c.waiting + c.added;
  const seg = (n: number) => (total === 0 ? 0 : (n / total) * 100);

  return (
    <Link
      href={`/nurture/c/${encodeURIComponent(c.clientTag)}`}
      className="rounded-lg border bg-card hover:bg-muted/20 hover:border-emerald-300 hover:shadow-sm transition-all p-4 group"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <span className="font-mono font-semibold text-base">{c.clientTag}</span>
        <ArrowRight className="size-4 text-muted-foreground group-hover:text-emerald-700 group-hover:translate-x-0.5 transition-transform" />
      </div>

      <div className="grid grid-cols-4 gap-2 mb-3">
        <Mini label="Ready" value={c.ready} accent="text-emerald-700" />
        <Mini label="Eligible" value={c.eligible} accent="text-sky-700" />
        <Mini label="Waiting" value={c.waiting} accent="text-amber-700" />
        <Mini label="Added" value={c.added} accent="text-violet-700" />
      </div>

      {/* Stacked breakdown bar */}
      <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden flex">
        <div className="bg-emerald-500"   style={{ width: `${seg(c.ready)}%` }} />
        <div className="bg-sky-400"       style={{ width: `${seg(eligibleNotReady)}%` }} />
        <div className="bg-amber-400"     style={{ width: `${seg(c.waiting)}%` }} />
        <div className="bg-violet-400"    style={{ width: `${seg(c.added)}%` }} />
      </div>
    </Link>
  );
}

function Mini({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${accent}`}>{value.toLocaleString()}</p>
    </div>
  );
}
