"use client";

/**
 * Nurture hub.
 *
 * Two-phase load so the page is interactive immediately:
 *   1. /api/config/clients (instant Turso fetch) → render every client
 *      card with the tag visible and counts as "—".
 *   2. /api/nurture/clients-summary (slow — ~10–30s cold, ~instant when
 *      warm via server-side cache) → merge real counts into each card.
 *
 * Click any card → /nurture/c/{clientTag} for the per-client detail page.
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

type SortKey = "ready" | "waiting" | "added" | "tag";

export default function NurtureHub() {
  const [counts, setCounts] = useState<OverallCounts | null>(null);
  const [allTags, setAllTags] = useState<string[] | null>(null);
  const [summaryByTag, setSummaryByTag] = useState<Map<string, ClientSummary>>(new Map());
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("ready");

  // Phase 1: fetch overall counts + client tag list in parallel. Both are
  // cheap (counts ~1–2s, tags ~100ms) so the cards render quickly.
  useEffect(() => {
    fetch("/api/nurture/counts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setCounts(d); })
      .catch(() => {});

    fetch("/api/config/clients")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        const tags = Array.from(
          new Set(rows.map((r: { tag?: string }) => r.tag).filter(Boolean))
        ).sort() as string[];
        setAllTags(tags);
      })
      .catch(() => setAllTags([]));
  }, []);

  // Phase 2: kick off the slow summary fetch. Don't block UI.
  function loadSummary(fresh = false) {
    setSummaryLoading(true);
    setSummaryError(null);
    fetch(`/api/nurture/clients-summary${fresh ? "?fresh=1" : ""}`)
      .then((r) => {
        if (r.redirected || r.status === 401) { window.location.href = "/login"; return null; }
        return r.ok ? r.json() : Promise.reject(new Error(`Failed (${r.status})`));
      })
      .then((d) => {
        if (!d) return;
        const m = new Map<string, ClientSummary>();
        for (const c of d.clients || []) m.set(c.clientTag, c);
        setSummaryByTag(m);
      })
      .catch((e) => setSummaryError((e as Error).message))
      .finally(() => setSummaryLoading(false));
  }
  useEffect(() => { loadSummary(false); }, []);

  // Merge: every client tag has a card. Counts come from the map if loaded.
  const cards = useMemo<Array<ClientSummary & { hasCounts: boolean }>>(() => {
    const tags = allTags ?? [];
    return tags.map((tag) => {
      const s = summaryByTag.get(tag);
      return s
        ? { ...s, hasCounts: true }
        : { clientTag: tag, ready: 0, eligible: 0, waiting: 0, added: 0, total: 0, hasCounts: false };
    });
  }, [allTags, summaryByTag]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = q ? cards.filter((c) => c.clientTag.toLowerCase().includes(q)) : cards.slice();
    rows.sort((a, b) => {
      if (sortKey === "tag") return a.clientTag.localeCompare(b.clientTag);
      // Rows that haven't loaded counts yet sort to the bottom
      const aHas = a.hasCounts ? 1 : 0;
      const bHas = b.hasCounts ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      return (b[sortKey] || 0) - (a[sortKey] || 0);
    });
    return rows;
  }, [cards, search, sortKey]);

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
          onClick={() => loadSummary(true)}
          disabled={summaryLoading}
          className="flex items-center gap-2 px-3 h-9 text-sm rounded-md border bg-white hover:bg-muted/50 disabled:opacity-50"
          title="Recompute per-client counts (bypasses 5-min cache)"
        >
          <RefreshCw className={`size-3.5 ${summaryLoading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Overall tiles — Eligible bucket dropped per workflow update;
          every safe + eligible lead lives under "Ready". */}
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Ready to nurture" sublabel="Eligible & safe — push these" value={counts?.eligibleSafe} accent="text-emerald-700" loading={!counts} />
        <Tile label="Waiting" sublabel="Cooldown still ticking" value={counts?.waiting} accent="text-amber-700" loading={!counts} />
        <Tile label="Added" sublabel="Already pushed to a campaign" value={counts?.added} accent="text-violet-700" loading={!counts} />
      </div>

      {/* Loading / error banner for the slow summary fetch */}
      {summaryLoading && allTags && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-800 flex items-center gap-2">
          <RefreshCw className="size-3 animate-spin" />
          Loading per-client counts… cards below will fill in as numbers arrive (~10–30 s on cold start, instant once cached).
        </div>
      )}
      {summaryError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          Couldn't load counts: {summaryError}. Cards still show tags — click into a client to see their detail page.
        </div>
      )}

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
            <SelectItem value="waiting">Sort: Waiting</SelectItem>
            <SelectItem value="added">Sort: Added</SelectItem>
            <SelectItem value="tag">Sort: Tag (A → Z)</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-auto">
          {allTags
            ? `${filtered.length} client${filtered.length === 1 ? "" : "s"}${search && cards.length ? ` (of ${cards.length})` : ""}`
            : "Loading clients…"}
        </span>
      </div>

      {/* Client grid */}
      {!allTags ? (
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

function ClientCard({ c }: { c: ClientSummary & { hasCounts: boolean } }) {
  const total = c.ready + c.waiting + c.added;
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

      <div className="grid grid-cols-3 gap-2 mb-3">
        <Mini label="Ready"   value={c.hasCounts ? c.ready   : null} accent="text-emerald-700" />
        <Mini label="Waiting" value={c.hasCounts ? c.waiting : null} accent="text-amber-700" />
        <Mini label="Added"   value={c.hasCounts ? c.added   : null} accent="text-violet-700" />
      </div>

      {/* Stacked breakdown bar — shows skeleton-grey until counts arrive */}
      {c.hasCounts ? (
        <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden flex">
          <div className="bg-emerald-500" style={{ width: `${seg(c.ready)}%` }} />
          <div className="bg-amber-400"   style={{ width: `${seg(c.waiting)}%` }} />
          <div className="bg-violet-400"  style={{ width: `${seg(c.added)}%` }} />
        </div>
      ) : (
        <div className="h-1.5 w-full rounded-full bg-muted/30 animate-pulse" />
      )}
    </Link>
  );
}

function Mini({ label, value, accent }: { label: string; value: number | null; accent: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${value === null ? "text-muted-foreground/40" : accent}`}>
        {value === null ? "—" : value.toLocaleString()}
      </p>
    </div>
  );
}
