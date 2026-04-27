"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

type Source = "soft_negative" | "out_of_office" | "sequence_finished" | "other";
type View = "actionable" | "eligible" | "waiting" | "added";

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
  other: "Other",
};

// Subtle accent stripe per source — replaces the noisy badge
const SOURCE_ACCENT: Record<Source, string> = {
  soft_negative: "border-l-blue-400",
  out_of_office: "border-l-amber-400",
  sequence_finished: "border-l-purple-400",
  other: "border-l-zinc-300",
};

function viewToFilters(view: View): { status: string; safety: string } {
  switch (view) {
    case "actionable": return { status: "eligible", safety: "safe" };
    case "eligible":   return { status: "eligible", safety: "all" };
    case "waiting":    return { status: "waiting", safety: "all" };
    case "added":      return { status: "added", safety: "all" };
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
      if (!res.ok) return;
      const data = await res.json();
      setCounts(data);
    } catch {}
  }, [clientFilter]);

  // Reload page when view or filters change
  useEffect(() => {
    loadPage(true, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, clientFilter, sourceFilter]);

  // Load counts on mount + on client filter change
  useEffect(() => { loadCounts(); }, [loadCounts]);

  // Load nurture campaigns once
  useEffect(() => {
    fetch("/api/nurture/campaigns")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.campaigns) setCampaigns(d.campaigns); })
      .catch(() => {});
  }, []);

  // Distinct client tags from current page items (for the filter dropdown)
  const clientTags = useMemo(
    () => Array.from(new Set(items.map((i) => i.client_tag).filter(Boolean))).sort() as string[],
    [items]
  );

  const campaignsForClient = useMemo(
    () => (clientFilter ? campaigns.filter((c) => c.client_tag === clientFilter) : campaigns),
    [campaigns, clientFilter]
  );

  // Tick every 60s so days-left labels stay accurate without a refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Recompute days_until_eligible / is_eligible from eligible_at + current time
  // so the list stays accurate even hours after the initial fetch.
  function withFreshDays(it: NurtureItem): NurtureItem {
    const eligibleMs = new Date(it.eligible_at).getTime();
    const daysLeft = Math.floor((eligibleMs - now) / (1000 * 60 * 60 * 24));
    return { ...it, days_until_eligible: daysLeft, is_eligible: daysLeft <= 0 };
  }

  // Search-filter + sort the visible items client-side (only paginated 50 at a time)
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
    // Sort by time-until-eligible ascending so the most-due items surface first.
    // Eligible items (negative days) end up at the top, oldest-eligible first.
    return list.sort((a, b) => a.days_until_eligible - b.days_until_eligible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, now]);

  function isPushable(it: NurtureItem): boolean {
    if (!it.is_eligible) return false;
    if (it.added_at) return false;
    if (it.skipped) return false;
    if (it.source !== "sequence_finished" && it.nurture_safety !== "safe") return false;
    return true;
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const selectable = visibleItems.filter(isPushable);
    if (selectable.every((i) => selected.has(i.id))) {
      const next = new Set(selected);
      selectable.forEach((i) => next.delete(i.id));
      setSelected(next);
    } else {
      const next = new Set(selected);
      selectable.forEach((i) => next.add(i.id));
      setSelected(next);
    }
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

  const selectableInView = visibleItems.filter(isPushable);
  const allInViewSelected = selectableInView.length > 0 && selectableInView.every((i) => selected.has(i.id));

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Nurture</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Re-engage leads after a 45-day cooldown. The classifier hard-blocks any reply with "no", "remove me", "unsubscribe", or wrong-person signals.
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
            {reclassifying ? "Re-classifying…" : "Re-classify Safe (apply new rules)"}
          </Button>
        </div>
      </div>

      {/* ── Stat tiles (also act as view tabs) ── */}
      <div className="grid grid-cols-4 gap-3">
        <StatTile
          label="Ready to nurture"
          sublabel="eligible & safe"
          value={counts?.eligibleSafe}
          accent="text-emerald-700"
          active={view === "actionable"}
          activeBorder="border-emerald-500"
          onClick={() => setView("actionable")}
        />
        <StatTile
          label="All eligible"
          sublabel="incl. unclassified"
          value={counts?.eligible}
          accent="text-sky-700"
          active={view === "eligible"}
          activeBorder="border-sky-500"
          onClick={() => setView("eligible")}
        />
        <StatTile
          label="Waiting"
          sublabel="< 45 days old"
          value={counts?.waiting}
          accent="text-amber-700"
          active={view === "waiting"}
          activeBorder="border-amber-500"
          onClick={() => setView("waiting")}
        />
        <StatTile
          label="Added"
          sublabel="pushed to a campaign"
          value={counts?.added}
          accent="text-violet-700"
          active={view === "added"}
          activeBorder="border-violet-500"
          onClick={() => setView("added")}
        />
      </div>

      {/* ── Filter bar ── */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search email, name, or company"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 max-w-sm"
        />
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
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => loadPage(true, false)} disabled={loading} className="h-9 ml-auto">
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {/* ── Sticky bulk action bar ── */}
      <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-background/90 backdrop-blur border-b">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleSelectAll}
            disabled={selectableInView.length === 0}
            className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <span className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={allInViewSelected}
                onChange={toggleSelectAll}
                disabled={selectableInView.length === 0}
              />
              <span>
                {selected.size > 0 ? `${selected.size} selected` : `${selectableInView.length} selectable on this page`}
              </span>
            </span>
          </button>
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
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* ── Lead list ── */}
      <div className="rounded-lg border bg-card">
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
          <div className="divide-y">
            {visibleItems.map((it) => {
              const pushable = isPushable(it);
              const isSelected = selected.has(it.id);
              return (
                <div
                  key={it.id}
                  className={`group flex items-center gap-3 px-4 py-3.5 border-l-4 ${SOURCE_ACCENT[it.source]} ${isSelected ? "bg-emerald-50/40" : "hover:bg-muted/40"} transition-colors`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(it.id)}
                    disabled={!pushable}
                    className="shrink-0"
                    title={pushable ? "" : "Not selectable (not eligible/safe or already added)"}
                  />
                  <button
                    onClick={() => setDetailItem(it)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate">{it.email}</span>
                      {(it.first_name || it.last_name) && (
                        <span className="text-sm text-muted-foreground truncate">
                          {it.first_name} {it.last_name}
                        </span>
                      )}
                      {it.company && (
                        <span className="text-sm text-muted-foreground truncate">· {it.company}</span>
                      )}
                      {it.client_tag && (
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                          {it.client_tag}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1 italic">
                      {it.reply_text?.trim() || (it.source === "sequence_finished" ? "Sequence finished — no reply, no bounce" : "—")}
                    </p>
                  </button>
                  <div className="shrink-0 flex items-center gap-2">
                    <SafetyPill safety={it.nurture_safety} source={it.source} />
                    <EligibilityPill it={it} />
                  </div>
                </div>
              );
            })}
            {hasMore && (
              <div className="p-3 text-center">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => loadPage(false, true)}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Detail side panel (centered modal — Sheet not installed) ── */}
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
                  {new Date(detailItem.trigger_at).toLocaleString()} ·
                  {" "}
                  Eligible {new Date(detailItem.eligible_at).toLocaleDateString()}
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
      className={`text-left rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-muted/30 ${active ? `border-b-2 ${activeBorder}` : ""}`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums mt-0.5 ${accent}`}>
        {value === undefined ? "—" : value.toLocaleString()}
      </p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{sublabel}</p>
    </button>
  );
}

function SafetyPill({ safety, source }: { safety: string | null | undefined; source: Source }) {
  if (source === "sequence_finished") {
    return <span className="text-[11px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 whitespace-nowrap">No reply</span>;
  }
  if (!safety) return <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-50 text-zinc-600 border border-zinc-200 whitespace-nowrap">Unclassified</span>;
  if (safety === "safe") return <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 whitespace-nowrap">Safe</span>;
  if (safety === "unsafe") return <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 whitespace-nowrap">Unsafe</span>;
  return <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">Unknown</span>;
}

function EligibilityPill({ it }: { it: NurtureItem }) {
  if (it.added_at) {
    return <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 whitespace-nowrap">Added</span>;
  }
  if (it.skipped) {
    return <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 border border-zinc-200 whitespace-nowrap">Skipped</span>;
  }
  if (it.is_eligible) {
    const ago = Math.abs(it.days_until_eligible);
    return (
      <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 whitespace-nowrap" title={`Eligible since ${new Date(it.eligible_at).toLocaleDateString()}`}>
        {ago === 0 ? "Eligible today" : `Eligible ${ago}d ago`}
      </span>
    );
  }
  return (
    <span className="text-[11px] text-muted-foreground whitespace-nowrap" title={`Eligible on ${new Date(it.eligible_at).toLocaleDateString()}`}>
      In {it.days_until_eligible}d
    </span>
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
