"use client";

import { useEffect, useState, useCallback, useMemo, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

type Source = "soft_negative" | "out_of_office" | "sequence_finished" | "legacy_airtable" | "other";
type View = "actionable" | "eligible" | "waiting" | "added";
type SortKey = "email" | "company" | "client" | "source" | "safety" | "eligibility";
type SortDir = "asc" | "desc";

interface NurtureItem {
  id: string;
  source: Source;
  client_tag: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  trigger_at: string;
  eligible_at: string;
  days_until_eligible: number;
  is_eligible: boolean;
  added_at: string | null;
  skipped: boolean;
  reply_id?: number;
  ai_category?: string | null;
  reply_text?: string | null;
  nurture_safety?: string | null;
  nurture_bucket?: string | null;
  nurture_safety_reason?: string | null;
  nurture_classified_at?: string | null;
  ob_lead_id?: number;
  ob_campaign_id?: number;
  campaign_name?: string;
}

interface NurtureCampaign {
  id: number;
  name: string;
  status: string;
  client_tag: string | null;
}

interface Counts {
  total: number;
  eligible: number;
  eligibleSafe: number;
  waiting: number;
  added: number;
}

const PAGE_SIZE = 50;

const SOURCE_LABEL: Record<Source, string> = {
  soft_negative: "Soft Negative",
  out_of_office: "Out of Office",
  sequence_finished: "Sequence Finished",
  legacy_airtable: "Legacy (Airtable)",
  other: "Other",
};

const SOURCE_DOT: Record<Source, string> = {
  soft_negative: "bg-blue-400",
  out_of_office: "bg-amber-400",
  sequence_finished: "bg-violet-400",
  legacy_airtable: "bg-rose-400",
  other: "bg-zinc-300",
};

const SAFETY_RANK: Record<string, number> = { safe: 0, unknown: 1, unsafe: 2 };

function viewToFilters(view: View): { status: string; safety: string } {
  switch (view) {
    case "actionable": return { status: "eligible", safety: "safe" };
    case "eligible":   return { status: "eligible", safety: "all" };
    case "waiting":    return { status: "waiting", safety: "all" };
    case "added":      return { status: "added", safety: "all" };
  }
}

function getSortValue(it: NurtureItem, key: SortKey): string | number {
  switch (key) {
    case "email":       return it.email?.toLowerCase() || "";
    case "company":     return it.company?.toLowerCase() || "~"; // empty sorts last
    case "client":      return it.client_tag?.toLowerCase() || "~";
    case "source":      return it.source;
    case "safety":      return it.source === "sequence_finished" ? 0 : SAFETY_RANK[it.nurture_safety || ""] ?? 3;
    case "eligibility": return it.days_until_eligible;
  }
}

export default function NurturePage() {
  const [view, setView] = useState<View>("actionable");
  const [items, setItems] = useState<NurtureItem[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [campaigns, setCampaigns] = useState<NurtureCampaign[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const [sortKey, setSortKey] = useState<SortKey>("eligibility");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [groupByClient, setGroupByClient] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pushTargetCampaignId, setPushTargetCampaignId] = useState<string>("");
  const [pushing, setPushing] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [detailItem, setDetailItem] = useState<NurtureItem | null>(null);

  const loadPage = useCallback(
    async (resetOffset: boolean, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const { status, safety } = viewToFilters(view);
        const nextOffset = resetOffset ? 0 : offset;
        const p = new URLSearchParams();
        p.set("status", status);
        p.set("safety", safety);
        p.set("limit", String(PAGE_SIZE));
        p.set("offset", String(nextOffset));
        if (clientFilter) p.set("client_tag", clientFilter);
        if (sourceFilter !== "all") p.set("source", sourceFilter);

        const res = await fetch(`/api/nurture?${p}`);
        if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setFetchError(data.error || `HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        const newItems: NurtureItem[] = data.items || [];
        if (append) setItems((prev) => [...prev, ...newItems]);
        else { setItems(newItems); setSelected(new Set()); }
        setHasMore(!!data.page?.hasMore);
        setOffset(nextOffset + newItems.length);
        setFetchError(null);
      } catch (e) {
        setFetchError((e as Error).message);
      }
      setLoading(false);
      setLoadingMore(false);
    },
    [view, clientFilter, sourceFilter, offset]
  );

  const loadCounts = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (clientFilter) p.set("client_tag", clientFilter);
      const res = await fetch(`/api/nurture/counts?${p}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[nurture] /api/nurture/counts ${res.status}: ${body.slice(0, 200)}`);
        return;
      }
      const data = await res.json();
      setCounts(data);
    } catch (e) {
      console.error("[nurture] counts fetch failed:", e);
    }
  }, [clientFilter]);

  useEffect(() => {
    loadPage(true, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, clientFilter, sourceFilter]);

  useEffect(() => { loadCounts(); }, [loadCounts]);

  useEffect(() => {
    fetch("/api/nurture/campaigns")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.campaigns) setCampaigns(d.campaigns); })
      .catch(() => {});
  }, []);

  // Tick every 60s so days-left labels stay accurate without a refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Recompute days_until_eligible / is_eligible from eligible_at + current time
  function withFreshDays(it: NurtureItem): NurtureItem {
    const eligibleMs = new Date(it.eligible_at).getTime();
    const daysLeft = Math.floor((eligibleMs - now) / (1000 * 60 * 60 * 24));
    return { ...it, days_until_eligible: daysLeft, is_eligible: daysLeft <= 0 };
  }

  // Distinct client tags from current page items (for the filter dropdown)
  const clientTags = useMemo(
    () => Array.from(new Set(items.map((i) => i.client_tag).filter(Boolean))).sort() as string[],
    [items]
  );

  const campaignsForClient = useMemo(
    () => (clientFilter ? campaigns.filter((c) => c.client_tag === clientFilter) : campaigns),
    [campaigns, clientFilter]
  );

  // Search + sort visible items
  const visibleItems = useMemo(() => {
    let list = items.map(withFreshDays);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (i) =>
          i.email?.toLowerCase().includes(q) ||
          i.company?.toLowerCase().includes(q) ||
          `${i.first_name || ""} ${i.last_name || ""}`.toLowerCase().includes(q)
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const av = getSortValue(a, sortKey);
      const bv = getSortValue(b, sortKey);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Tiebreak by eligibility ascending so most-due always wins.
      return a.days_until_eligible - b.days_until_eligible;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, sortKey, sortDir, now]);

  // Group items by client when groupByClient is enabled
  const groupedItems = useMemo(() => {
    if (!groupByClient) return null;
    const groups = new Map<string, NurtureItem[]>();
    for (const it of visibleItems) {
      const key = it.client_tag || "(no client)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(it);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [visibleItems, groupByClient]);

  function isPushable(it: NurtureItem): boolean {
    if (!it.is_eligible) return false;
    if (it.added_at) return false;
    if (it.skipped) return false;
    if (it.source !== "sequence_finished" && it.nurture_safety !== "safe") return false;
    return true;
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "eligibility" ? "asc" : "asc");
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAllInGroup(groupItems: NurtureItem[]) {
    const pushables = groupItems.filter(isPushable);
    if (pushables.length === 0) return;
    const allSelected = pushables.every((i) => selected.has(i.id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) pushables.forEach((i) => next.delete(i.id));
      else pushables.forEach((i) => next.add(i.id));
      return next;
    });
  }

  function toggleSelectAllVisible() {
    toggleSelectAllInGroup(visibleItems);
  }

  function toggleGroupCollapse(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function classifyAllUnclassified() {
    setClassifying(true);
    try {
      const res = await fetch("/api/nurture/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "classify-all-unclassified" }),
      });
      const data = await res.json();
      if (res.ok) toast.success(`Classified ${data.classified} replies`);
      else toast.error(data.error || "Classify failed");
      await Promise.all([loadPage(true, false), loadCounts()]);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setClassifying(false);
  }

  async function reclassifySafe() {
    setReclassifying(true);
    try {
      const res = await fetch("/api/nurture/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "classify-reset-safe" }),
      });
      const data = await res.json();
      if (res.ok) toast.success(`Re-classified ${data.reclassified} • ${data.flippedToUnsafe} flipped to unsafe`);
      else toast.error(data.error || "Re-classify failed");
      await Promise.all([loadPage(true, false), loadCounts()]);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setReclassifying(false);
  }

  async function syncSequenceFinished() {
    setSyncing(true);
    try {
      const res = await fetch("/api/nurture/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Synced ${data.upserted} leads from ${data.campaignsScanned} campaigns`);
        if (data.errors?.length) console.warn("Sync errors:", data.errors);
      } else {
        toast.error(data.error || "Sync failed");
      }
      await Promise.all([loadPage(true, false), loadCounts()]);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSyncing(false);
  }

  async function pushSelected() {
    if (!pushTargetCampaignId || selected.size === 0) return;
    setPushing(true);
    try {
      const itemRefs = items
        .filter((i) => selected.has(i.id))
        .map((i) => ({ id: i.id, ob_lead_id: i.ob_lead_id }));
      const res = await fetch("/api/nurture/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push-to-nurture",
          nurtureCampaignId: Number(pushTargetCampaignId),
          items: itemRefs,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Added ${data.attached} leads to nurture campaign`);
        if (data.failures?.length) console.warn("Push failures:", data.failures);
      } else {
        toast.error(data.error || "Push failed");
        if (data.failures?.length) console.warn("Push failures:", data.failures);
      }
      await Promise.all([loadPage(true, false), loadCounts()]);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setPushing(false);
  }

  async function skipSelected() {
    if (selected.size === 0) return;
    const res = await fetch("/api/nurture/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "skip", itemIds: Array.from(selected) }),
    });
    const data = await res.json();
    if (res.ok) {
      toast.success(`Skipped ${data.updated} leads`);
      await Promise.all([loadPage(true, false), loadCounts()]);
    } else toast.error(data.error);
  }

  const pushableInView = visibleItems.filter(isPushable);
  const allInViewSelected = pushableInView.length > 0 && pushableInView.every((i) => selected.has(i.id));

  return (
    <div className="space-y-6 max-w-[1500px]">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Nurture</h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Re-engage soft-negative and out-of-office leads after a 45-day cooldown. The classifier hard-blocks any reply with "no", "remove me", "unsubscribe", "wrong person", or remote-only signals — and any lead the AI categorizer flagged as Do Not Contact / Wrong Person / Not Interested.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={syncSequenceFinished} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync Sequence-Finished"}
          </Button>
          <Button size="sm" variant="outline" onClick={classifyAllUnclassified} disabled={classifying}>
            {classifying ? "Classifying…" : "Classify Unclassified"}
          </Button>
          <Button size="sm" variant="outline" onClick={reclassifySafe} disabled={reclassifying}>
            {reclassifying ? "Re-classifying…" : "Re-classify Safe"}
          </Button>
        </div>
      </div>

      {/* ── Stat tiles (also act as view tabs) ── */}
      <div className="grid grid-cols-4 gap-3">
        <StatTile
          label="Ready to nurture"
          sublabel="Eligible & safe — push these"
          value={counts?.eligibleSafe}
          accent="text-emerald-700"
          active={view === "actionable"}
          activeBorder="border-emerald-500"
          onClick={() => setView("actionable")}
        />
        <StatTile
          label="All eligible"
          sublabel="Past 45-day cooldown"
          value={counts?.eligible}
          accent="text-sky-700"
          active={view === "eligible"}
          activeBorder="border-sky-500"
          onClick={() => setView("eligible")}
        />
        <StatTile
          label="Waiting"
          sublabel="Cooldown still ticking"
          value={counts?.waiting}
          accent="text-amber-700"
          active={view === "waiting"}
          activeBorder="border-amber-500"
          onClick={() => setView("waiting")}
        />
        <StatTile
          label="Added"
          sublabel="Already pushed to a campaign"
          value={counts?.added}
          accent="text-violet-700"
          active={view === "added"}
          activeBorder="border-violet-500"
          onClick={() => setView("added")}
        />
      </div>

      {/* ── Filter bar ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            placeholder="Search email, name, or company"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-72 pl-8"
          />
        </div>
        <Select value={clientFilter || "all"} onValueChange={(v) => setClientFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="h-9 w-44 text-sm"><SelectValue placeholder="All clients" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clients</SelectItem>
            {clientTags.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="h-9 w-44 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="soft_negative">Soft negative</SelectItem>
            <SelectItem value="out_of_office">Out of office</SelectItem>
            <SelectItem value="sequence_finished">Sequence finished</SelectItem>
            <SelectItem value="legacy_airtable">Legacy (Airtable)</SelectItem>
          </SelectContent>
        </Select>
        <button
          onClick={() => setGroupByClient((g) => !g)}
          className={`h-9 px-3 rounded-md border text-sm transition-colors ${
            groupByClient
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background hover:bg-muted/50 text-foreground"
          }`}
        >
          Group by client
        </button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => loadPage(true, false)}
          disabled={loading}
          className="h-9 ml-auto"
          title="Refresh"
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* ── Sticky bulk action bar ── */}
      <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur border-b">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allInViewSelected}
              onChange={toggleSelectAllVisible}
              disabled={pushableInView.length === 0}
              className="size-4"
            />
            <span className="text-sm text-muted-foreground">
              {selected.size > 0 ? (
                <span className="text-foreground font-medium">{selected.size} selected</span>
              ) : (
                <>
                  <span className="text-foreground font-medium">{visibleItems.length}</span> shown
                  {pushableInView.length > 0 && (
                    <span> · <span className="text-emerald-700">{pushableInView.length} ready to push</span></span>
                  )}
                </>
              )}
            </span>
          </div>
          <Select value={pushTargetCampaignId} onValueChange={setPushTargetCampaignId}>
            <SelectTrigger className="h-9 w-72 text-sm" disabled={selected.size === 0}>
              <SelectValue placeholder="Choose a nurture campaign…" />
            </SelectTrigger>
            <SelectContent>
              {campaignsForClient.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {clientFilter ? `No nurture campaigns for ${clientFilter}` : "No nurture campaigns found"}
                </div>
              )}
              {campaignsForClient.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={pushSelected}
            disabled={pushing || !pushTargetCampaignId || selected.size === 0}
            className="h-9"
          >
            {pushing ? "Pushing…" : `Add to nurture${selected.size > 0 ? ` (${selected.size})` : ""}`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={skipSelected}
            disabled={selected.size === 0}
            className="h-9"
          >
            Skip
          </Button>
          {selected.size > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} className="h-9 ml-auto">
              Clear selection
            </Button>
          )}
        </div>
      </div>

      {/* ── Lead table ── */}
      <div className="rounded-lg border bg-card overflow-hidden">
        {fetchError && (
          <div className="m-3 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {fetchError}
          </div>
        )}

        {loading && items.length === 0 ? (
          <SkeletonRows count={6} />
        ) : visibleItems.length === 0 ? (
          <EmptyState view={view} />
        ) : (
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="w-10 px-3"></TableHead>
                <SortableHead label="Lead" k="email" current={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableHead label="Company" k="company" current={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableHead label="Client" k="client" current={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableHead label="Source" k="source" current={sortKey} dir={sortDir} onClick={toggleSort} />
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Reply
                </TableHead>
                <SortableHead label="Safety" k="safety" current={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableHead label="Eligibility" k="eligibility" current={sortKey} dir={sortDir} onClick={toggleSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupedItems
                ? groupedItems.map(([group, gItems]) => {
                    const collapsed = collapsedGroups.has(group);
                    const groupPushable = gItems.filter(isPushable);
                    const groupAllSelected = groupPushable.length > 0 && groupPushable.every((i) => selected.has(i.id));
                    return (
                      <Fragment key={`group-${group}`}>
                        <TableRow
                          className="bg-muted/30 hover:bg-muted/50 cursor-pointer"
                          onClick={() => toggleGroupCollapse(group)}
                        >
                          <TableCell className="px-3">
                            <input
                              type="checkbox"
                              checked={groupAllSelected}
                              onChange={(e) => { e.stopPropagation(); toggleSelectAllInGroup(gItems); }}
                              onClick={(e) => e.stopPropagation()}
                              disabled={groupPushable.length === 0}
                              className="size-4"
                            />
                          </TableCell>
                          <TableCell colSpan={7} className="font-medium">
                            <span className="inline-flex items-center gap-2">
                              {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                              <span>{group}</span>
                              <span className="text-xs text-muted-foreground">
                                · {gItems.length} lead{gItems.length === 1 ? "" : "s"}
                                {groupPushable.length > 0 && <> · <span className="text-emerald-700">{groupPushable.length} ready</span></>}
                              </span>
                            </span>
                          </TableCell>
                        </TableRow>
                        {!collapsed && gItems.map((it) => (
                          <LeadRow
                            key={it.id}
                            it={it}
                            selected={selected.has(it.id)}
                            pushable={isPushable(it)}
                            onToggle={() => toggleSelect(it.id)}
                            onClick={() => setDetailItem(it)}
                          />
                        ))}
                      </Fragment>
                    );
                  })
                : visibleItems.map((it) => (
                    <LeadRow
                      key={it.id}
                      it={it}
                      selected={selected.has(it.id)}
                      pushable={isPushable(it)}
                      onToggle={() => toggleSelect(it.id)}
                      onClick={() => setDetailItem(it)}
                    />
                  ))}
            </TableBody>
          </Table>
        )}
        {hasMore && (
          <div className="p-3 text-center border-t bg-muted/20">
            <Button size="sm" variant="outline" onClick={() => loadPage(false, true)} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </div>

      {/* ── Detail dialog ── */}
      <Dialog open={!!detailItem} onOpenChange={(open) => !open && setDetailItem(null)}>
        <DialogContent className="sm:max-w-2xl">
          {detailItem && (
            <>
              <DialogHeader>
                <DialogTitle className="text-base flex items-center gap-2 flex-wrap">
                  <span className="truncate">{detailItem.email}</span>
                  {detailItem.client_tag && (
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {detailItem.client_tag}
                    </span>
                  )}
                  <SafetyPill safety={detailItem.nurture_safety} source={detailItem.source} />
                  <EligibilityPill it={detailItem} />
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <DetailField label="Name">
                  {[detailItem.first_name, detailItem.last_name].filter(Boolean).join(" ") || "—"}
                </DetailField>
                <DetailField label="Company">{detailItem.company || "—"}</DetailField>
                <DetailField label="Source">{SOURCE_LABEL[detailItem.source]}</DetailField>
                {detailItem.ai_category && (
                  <DetailField label="Original AI category">{detailItem.ai_category}</DetailField>
                )}
                {detailItem.campaign_name && (
                  <DetailField label="From campaign">{detailItem.campaign_name}</DetailField>
                )}
                <DetailField label="Triggered">
                  {new Date(detailItem.trigger_at).toLocaleString()} · Eligible {new Date(detailItem.eligible_at).toLocaleDateString()}
                </DetailField>
                {detailItem.nurture_safety_reason && (
                  <DetailField label="Safety reason">
                    <span className="italic text-muted-foreground">{detailItem.nurture_safety_reason}</span>
                  </DetailField>
                )}
                {detailItem.reply_text && (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Reply text</p>
                    <div className="rounded border bg-muted/30 p-3 text-sm whitespace-pre-wrap max-h-72 overflow-auto">
                      {detailItem.reply_text}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex gap-2 justify-end pt-2">
                {isPushable(detailItem) && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setSelected(new Set([detailItem.id]));
                      setDetailItem(null);
                      toast.info("Selected — pick a campaign in the action bar above to push.");
                    }}
                  >
                    Select for push
                  </Button>
                )}
                {!detailItem.added_at && !detailItem.skipped && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const res = await fetch("/api/nurture/mutate", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "skip", itemIds: [detailItem.id] }),
                      });
                      if (res.ok) {
                        toast.success("Skipped");
                        setDetailItem(null);
                        loadPage(true, false);
                        loadCounts();
                      } else {
                        toast.error("Skip failed");
                      }
                    }}
                  >
                    Skip
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatTile({
  label, sublabel, value, accent, active, activeBorder, onClick,
}: {
  label: string;
  sublabel: string;
  value: number | undefined;
  accent: string;
  active: boolean;
  activeBorder: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-lg border bg-card px-5 py-4 transition-all hover:shadow-sm hover:bg-muted/20 ${active ? `border-b-2 ${activeBorder} shadow-sm` : ""}`}
    >
      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
      <p className={`text-3xl font-semibold tabular-nums mt-1 ${accent}`}>
        {value === undefined ? "—" : value.toLocaleString()}
      </p>
      <p className="text-xs text-muted-foreground mt-1">{sublabel}</p>
    </button>
  );
}

function SortableHead({
  label, k, current, dir, onClick,
}: {
  label: string;
  k: SortKey;
  current: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
}) {
  const active = current === k;
  return (
    <TableHead
      className="text-xs uppercase tracking-wide text-muted-foreground font-medium cursor-pointer select-none hover:text-foreground"
      onClick={() => onClick(k)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </span>
    </TableHead>
  );
}

function LeadRow({
  it, selected, pushable, onToggle, onClick,
}: {
  it: NurtureItem;
  selected: boolean;
  pushable: boolean;
  onToggle: () => void;
  onClick: () => void;
}) {
  return (
    <TableRow className={selected ? "bg-emerald-50/50 hover:bg-emerald-50/60" : ""}>
      <TableCell className="px-3" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={!pushable}
          className="size-4"
          title={pushable ? "" : "Not selectable (not eligible/safe or already added)"}
        />
      </TableCell>
      <TableCell className="cursor-pointer max-w-[220px]" onClick={onClick}>
        <div className="font-medium text-sm truncate">{it.email}</div>
        {(it.first_name || it.last_name) && (
          <div className="text-xs text-muted-foreground truncate">
            {it.first_name} {it.last_name}
          </div>
        )}
      </TableCell>
      <TableCell className="cursor-pointer max-w-[180px]" onClick={onClick}>
        <span className="text-sm truncate block">{it.company || "—"}</span>
      </TableCell>
      <TableCell className="cursor-pointer" onClick={onClick}>
        {it.client_tag ? (
          <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {it.client_tag}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="cursor-pointer" onClick={onClick}>
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span className={`size-2 rounded-full ${SOURCE_DOT[it.source]}`} />
          <span className="text-muted-foreground">{SOURCE_LABEL[it.source]}</span>
        </span>
      </TableCell>
      <TableCell className="cursor-pointer max-w-[280px] whitespace-normal" onClick={onClick}>
        <span className="text-xs text-muted-foreground italic line-clamp-1">
          {it.reply_text?.trim() || (it.source === "sequence_finished" ? "Sequence finished — no reply, no bounce" : "—")}
        </span>
      </TableCell>
      <TableCell className="cursor-pointer" onClick={onClick}>
        <SafetyPill safety={it.nurture_safety} source={it.source} />
      </TableCell>
      <TableCell className="cursor-pointer" onClick={onClick}>
        <EligibilityPill it={it} />
      </TableCell>
    </TableRow>
  );
}

function SafetyPill({ safety, source }: { safety: string | null | undefined; source: Source }) {
  const cls = "text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap";
  if (source === "sequence_finished") {
    return <span className={`${cls} bg-violet-50 text-violet-700 border-violet-200`}>No reply</span>;
  }
  if (!safety) return <span className={`${cls} bg-zinc-50 text-zinc-600 border-zinc-200`}>Unclassified</span>;
  if (safety === "safe") return <span className={`${cls} bg-emerald-50 text-emerald-700 border-emerald-200`}>Safe</span>;
  if (safety === "unsafe") return <span className={`${cls} bg-red-50 text-red-700 border-red-200`}>Unsafe</span>;
  return <span className={`${cls} bg-amber-50 text-amber-700 border-amber-200`}>Unknown</span>;
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function EligibilityPill({ it }: { it: NurtureItem }) {
  const cls = "text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap";
  if (it.added_at) {
    return (
      <span className={`${cls} bg-blue-50 text-blue-700 border-blue-200`} title={`Added ${new Date(it.added_at).toLocaleString()}`}>
        Added
      </span>
    );
  }
  if (it.skipped) return <span className={`${cls} bg-zinc-100 text-zinc-600 border-zinc-200`}>Skipped</span>;
  if (it.is_eligible) {
    const ago = Math.abs(it.days_until_eligible);
    return (
      <div className="flex flex-col items-end gap-0.5 leading-tight">
        <span className={`${cls} bg-emerald-50 text-emerald-700 border-emerald-200`}>
          {ago === 0 ? "Eligible today" : `Eligible ${ago}d ago`}
        </span>
        <span className="text-[10px] text-muted-foreground">since {formatShortDate(it.eligible_at)}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-0.5 leading-tight">
      <span className="text-[11px] text-muted-foreground whitespace-nowrap">In {it.days_until_eligible}d</span>
      <span className="text-[10px] text-muted-foreground">on {formatShortDate(it.eligible_at)}</span>
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="divide-y">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="px-4 py-3.5 flex items-center gap-3">
          <div className="size-4 rounded bg-muted animate-pulse" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-2/3 bg-muted rounded animate-pulse" />
            <div className="h-3 w-1/2 bg-muted/70 rounded animate-pulse" />
          </div>
          <div className="h-5 w-16 bg-muted rounded animate-pulse" />
          <div className="h-5 w-20 bg-muted rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ view }: { view: View }) {
  const messages: Record<View, { title: string; sub: string }> = {
    actionable: {
      title: "All caught up",
      sub: "No leads are ready for nurture right now. Check back tomorrow or widen filters.",
    },
    eligible: {
      title: "No eligible candidates",
      sub: "No replies have crossed the 45-day cooldown for the current filters.",
    },
    waiting: {
      title: "Nothing waiting",
      sub: "No replies are within the 45-day cooldown window.",
    },
    added: {
      title: "Nothing pushed yet",
      sub: "Leads you push to a nurture campaign will appear here.",
    },
  };
  const m = messages[view];
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-base font-medium">{m.title}</p>
      <p className="text-sm text-muted-foreground mt-1">{m.sub}</p>
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 items-baseline">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}
