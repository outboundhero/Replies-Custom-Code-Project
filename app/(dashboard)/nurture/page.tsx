"use client";

import { useEffect, useState, useCallback, useMemo, useRef, Fragment } from "react";
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
  esp_host: string | null;          // raw "Outlook" / "Gmail" / "Office 365" / null when un-backfilled
  esp_bucket: "outlook" | "other";  // routing bucket
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
  /** UUID used in OutboundHero dashboard URLs (different from the numeric id used by the API) */
  uuid: string | null;
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
  // Canonical client list from Turso (client_tags table). Populates the
  // filter dropdown with EVERY client, not just the ones that happen to be
  // on the current page of items.
  const [allClients, setAllClients] = useState<string[]>([]);
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

  // selected = the IDs the user has chosen for bulk actions.
  // selectedMeta = parallel map carrying client_tag + ob_lead_id for every
  // selected ID, including bulk-selected rows that are NOT on the visible
  // page. Needed so the campaign dropdown can filter by the selected
  // leads' client_tag and so push/skip work without refetching.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedMeta, setSelectedMeta] = useState<Map<string, { client_tag: string | null; ob_lead_id?: number }>>(new Map());
  const [bulkSelecting, setBulkSelecting] = useState(false);
  // When non-null, the visible list IS the selection (not the normal
  // filtered view). Set by bulkSelectMatching, cleared by Clear selection.
  const [selectionScope, setSelectionScope] = useState<{
    clientTag: string;
    esp?: "outlook" | "other";
    source?: string;
  } | null>(null);
  const [pushTargetCampaignId, setPushTargetCampaignId] = useState<string>("");
  const [pushing, setPushing] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [detailItem, setDetailItem] = useState<NurtureItem | null>(null);

  // Rich modal shown after every push attempt — success, partial, or fail.
  const [pushResult, setPushResult] = useState<{
    status: "success" | "partial" | "error";
    requested: number;
    attached: number | null;
    campaignId: number | null;
    campaignUuid: string | null;
    campaignName: string | null;
    message?: string;
    obMessage?: string;
    error?: string;
    failures?: Array<{ id: string; reason: string }>;
  } | null>(null);

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
        p.set("sort", sortKey);
        p.set("dir", sortDir);
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
        else { setItems(newItems); setSelected(new Set()); setSelectedMeta(new Map()); }
        setHasMore(!!data.page?.hasMore);
        setOffset(nextOffset + newItems.length);
        setFetchError(null);
      } catch (e) {
        setFetchError((e as Error).message);
      }
      setLoading(false);
      setLoadingMore(false);
    },
    [view, clientFilter, sourceFilter, offset, sortKey, sortDir]
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
  }, [view, clientFilter, sourceFilter, sortKey, sortDir]);

  useEffect(() => { loadCounts(); }, [loadCounts]);

  useEffect(() => {
    fetch("/api/nurture/campaigns")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.campaigns) setCampaigns(d.campaigns); })
      .catch(() => {});
  }, []);

  // Pull the full client list once on mount so the filter dropdown is
  // complete regardless of which leads happen to be on the current page.
  useEffect(() => {
    fetch("/api/config/clients")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        const tags = Array.from(
          new Set(rows.map((r: { tag?: string }) => r.tag).filter(Boolean))
        ).sort() as string[];
        setAllClients(tags);
      })
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

  // Filter dropdown source: prefer the canonical list from Turso (every
  // client the system knows about), and fall back to whatever's on the
  // current page if that fetch hasn't landed / failed.
  const clientTags = useMemo(() => {
    if (allClients.length > 0) return allClients;
    return Array.from(new Set(items.map((i) => i.client_tag).filter(Boolean))).sort() as string[];
  }, [allClients, items]);

  // Distinct client_tags currently in the selection — used to filter the
  // campaign dropdown so the user only sees that client's nurture campaigns.
  const selectedClientTags = useMemo(() => {
    const tags = new Set<string>();
    for (const meta of selectedMeta.values()) {
      if (meta.client_tag) tags.add(meta.client_tag);
    }
    return Array.from(tags);
  }, [selectedMeta]);

  // Campaign dropdown filter:
  //   - If something is selected, show only campaigns matching the selected
  //     leads' client_tag(s).
  //   - Otherwise honour the page's client filter as a fallback.
  //   - Match in this order of confidence:
  //       1. exact c.client_tag match (extracted by /api/nurture/campaigns)
  //       2. name PREFIX match: "TAG - …", "TAG: …", "TAG | …", "TAG/…"
  //       3. tag appears as a whole word ANYWHERE in the campaign name —
  //          covers naming patterns like "[Nurture] AC Cooldown".
  const filteredCampaigns = useMemo(() => {
    const tagsToMatch =
      selectedClientTags.length > 0 ? selectedClientTags
      : clientFilter ? [clientFilter]
      : null;
    if (!tagsToMatch) return campaigns;
    return campaigns.filter((c) => {
      if (c.client_tag && tagsToMatch.includes(c.client_tag)) return true;
      const prefix = c.name.match(/^\s*([A-Za-z0-9&_]+)\s*[-–—:|/]/);
      if (prefix && tagsToMatch.some((t) => t.toLowerCase() === prefix[1].toLowerCase())) return true;
      // Whole-word match anywhere in the name (escapes regex specials in the tag).
      return tagsToMatch.some((t) => {
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`, "i").test(c.name);
      });
    });
  }, [campaigns, selectedClientTags, clientFilter]);

  // Search filter only — server already returns rows in the chosen sort
  // order across the FULL dataset (not just this 50-row page).
  const visibleItems = useMemo(() => {
    const list = items.map(withFreshDays);
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (i) =>
        i.email?.toLowerCase().includes(q) ||
        i.company?.toLowerCase().includes(q) ||
        `${i.first_name || ""} ${i.last_name || ""}`.toLowerCase().includes(q)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, now]);

  // Group items by client + ESP when groupByClient is enabled. Each
  // client header rolls up the totals; under it sit two sub-groups
  // (Outlook / Gmail + Others) so the user can bulk-select per ESP and
  // route to the matching campaign.
  const groupedItems = useMemo(() => {
    if (!groupByClient) return null;
    type Sub = { esp: "outlook" | "other"; items: NurtureItem[] };
    type Group = { client: string; subs: Sub[] };
    const groups = new Map<string, Map<"outlook" | "other", NurtureItem[]>>();
    for (const it of visibleItems) {
      const client = it.client_tag || "(no client)";
      if (!groups.has(client)) groups.set(client, new Map());
      const subMap = groups.get(client)!;
      const esp = it.esp_bucket;
      if (!subMap.has(esp)) subMap.set(esp, []);
      subMap.get(esp)!.push(it);
    }
    const out: Group[] = [];
    for (const [client, subMap] of groups) {
      const subs: Sub[] = [];
      // Outlook first (smaller, distinct), then Gmail+Others
      if (subMap.has("outlook")) subs.push({ esp: "outlook", items: subMap.get("outlook")! });
      if (subMap.has("other"))   subs.push({ esp: "other",   items: subMap.get("other")! });
      out.push({ client, subs });
    }
    return out.sort((a, b) => a.client.localeCompare(b.client));
  }, [visibleItems, groupByClient]);

  function isPushable(it: NurtureItem): boolean {
    if (!it.is_eligible) return false;
    if (it.added_at) return false;
    if (it.skipped) return false;
    if (it.source !== "sequence_finished" && it.nurture_safety !== "safe") return false;
    return true;
  }

  // What a checkbox-tickable row looks like depends on the view:
  //   - Added view  → row must be added (so Rollback is meaningful)
  //   - everything else → same as pushable (eligible + safe + not added/skipped)
  function isSelectable(it: NurtureItem): boolean {
    if (view === "added") return !!it.added_at;
    return isPushable(it);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "eligibility" ? "asc" : "asc");
    }
  }

  function toggleSelect(it: NurtureItem) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(it.id)) next.delete(it.id); else next.add(it.id);
      return next;
    });
    setSelectedMeta((prev) => {
      const next = new Map(prev);
      if (next.has(it.id)) next.delete(it.id);
      else next.set(it.id, { client_tag: it.client_tag, ob_lead_id: it.ob_lead_id });
      return next;
    });
  }

  function toggleSelectAllInGroup(groupItems: NurtureItem[]) {
    const selectables = groupItems.filter(isSelectable);
    if (selectables.length === 0) return;
    const allSelected = selectables.every((i) => selected.has(i.id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) selectables.forEach((i) => next.delete(i.id));
      else selectables.forEach((i) => next.add(i.id));
      return next;
    });
    setSelectedMeta((prev) => {
      const next = new Map(prev);
      if (allSelected) {
        selectables.forEach((i) => next.delete(i.id));
      } else {
        selectables.forEach((i) =>
          next.set(i.id, { client_tag: i.client_tag, ob_lead_id: i.ob_lead_id })
        );
      }
      return next;
    });
  }

  function toggleSelectAllVisible() {
    toggleSelectAllInGroup(visibleItems);
  }

  /**
   * Bulk-select EVERY pushable lead matching the given filters across the
   * full dataset (not just the visible page). Returns IDs from
   * /api/nurture/ids — capped at 1000 per call. Replaces the current
   * selection so the user can grab "everything for this client" in one
   * click.
   *
   * REQUIRES a client_tag — pushing leads from many clients to one
   * nurture campaign doesn't make sense (campaigns are per-client). If
   * called without one, refuse and prompt the user to filter first.
   */
  /**
   * Bulk-select + REPLACE the visible list with the leads we just selected.
   *
   * Old behaviour was lossy: select 328 leads across pages, but only see
   * the 3 that happened to be on the current page. Now bulk-select fires
   * the main /api/nurture endpoint with the same filter (so we get full
   * row data, not just IDs) AND swaps the items array so the user sees
   * exactly what got selected.
   *
   * `selectionScope` tracks the active scope so the action bar can show
   * "AC Outlook · 47 selected" and provide a clean "Clear selection"
   * that reverts to the normal filtered view.
   */
  async function bulkSelectMatching(filters: { client_tag?: string; source?: string; esp?: "outlook" | "other" }) {
    if (!filters.client_tag) {
      toast.error("Pick a Client filter first — nurture campaigns are per-client, so the bulk select needs to be scoped to one client at a time.");
      return;
    }
    setBulkSelecting(true);
    try {
      const p = new URLSearchParams();
      p.set("client_tag", filters.client_tag);
      p.set("status", "eligible");
      p.set("safety", "safe");
      p.set("limit", "1000");
      if (filters.source && filters.source !== "all") p.set("source", filters.source);
      if (filters.esp) p.set("esp", filters.esp);

      const res = await fetch(`/api/nurture?${p}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || `Bulk select failed (${res.status})`);
        return;
      }
      const data = await res.json() as { items: NurtureItem[]; page?: { hasMore?: boolean } };
      const fetched = data.items || [];

      // Replace the visible items with the selected set so the user can
      // SEE what they just selected (not just trust the count).
      setItems(fetched);
      setHasMore(false);
      setOffset(fetched.length);
      setSelectionScope({
        clientTag: filters.client_tag,
        esp: filters.esp,
        source: filters.source && filters.source !== "all" ? filters.source : undefined,
      });
      setSelected(new Set(fetched.map((i) => i.id)));
      setSelectedMeta(new Map(fetched.map((i) => [
        i.id,
        { client_tag: i.client_tag, ob_lead_id: i.ob_lead_id },
      ])));

      // Auto-pick the matching nurture campaign for this (client, ESP).
      if (filters.esp) {
        const espNeedle = filters.esp === "outlook" ? /\boutlook\b/i : /\bgmail\b/i;
        const matches = campaigns.filter((c) => {
          const tagMatches =
            (c.client_tag && c.client_tag === filters.client_tag) ||
            new RegExp(`\\b${filters.client_tag}\\b`, "i").test(c.name);
          return tagMatches && espNeedle.test(c.name);
        });
        if (matches.length === 1) {
          setPushTargetCampaignId(String(matches[0].id));
        }
      }

      const espLabel = filters.esp ? ` ${filters.esp === "outlook" ? "Outlook" : "Gmail+Others"}` : "";
      const noun = `for ${filters.client_tag}${espLabel}`;
      const truncated = fetched.length === 1000;
      toast.success(
        truncated
          ? `Selected ${fetched.length.toLocaleString()} leads ${noun} (capped at 1000 — push these first, then re-run)`
          : `Selected ${fetched.length.toLocaleString()} leads ${noun}`
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBulkSelecting(false);
  }

  function toggleGroupCollapse(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  /**
   * Clears selection AND exits selection-view mode (the items array goes
   * back to the regular paged filter view). Used by both the action bar
   * "Clear" button and the selection-mode banner's "Back to all leads".
   */
  function exitSelectionScope() {
    setSelected(new Set());
    setSelectedMeta(new Map());
    setPushTargetCampaignId("");
    if (selectionScope) {
      setSelectionScope(null);
      // Reload the normal filtered view
      loadPage(true, false);
    }
  }

  /**
   * Drain the entire unclassified backlog by re-firing the classify-batch
   * endpoint until it returns done=true. Each batch is 200 reply + 200
   * legacy rows server-side, ~30–60s per batch.
   *
   * Stop is implemented via AbortController so clicking Stop interrupts
   * the in-flight fetch immediately — not after the current batch
   * finishes. Progress is tracked in classifyProgress state and rendered
   * as a live banner while running.
   */
  const classifyAbortRef = useRef<AbortController | null>(null);
  const [classifyProgress, setClassifyProgress] = useState<{
    status: "idle" | "running" | "stopping" | "done" | "error";
    batches: number;
    classifiedThisRun: number;
    lastBatchClassified: number;
    startedAt: number | null;
    error?: string;
  }>({ status: "idle", batches: 0, classifiedThisRun: 0, lastBatchClassified: 0, startedAt: null });

  async function classifyAllUnclassified() {
    setClassifying(true);
    const ac = new AbortController();
    classifyAbortRef.current = ac;
    setClassifyProgress({
      status: "running",
      batches: 0,
      classifiedThisRun: 0,
      lastBatchClassified: 0,
      startedAt: Date.now(),
    });

    let totalClassified = 0;
    let batches = 0;
    let stopped = false;

    try {
      while (true) {
        if (ac.signal.aborted) { stopped = true; break; }

        let data: { classified?: number; remaining?: number | string; error?: string } | null = null;
        try {
          const res = await fetch("/api/nurture/mutate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "classify-all-unclassified" }),
            signal: ac.signal,
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            setClassifyProgress((p) => ({ ...p, status: "error", error: err.error || `HTTP ${res.status}` }));
            toast.error(err.error || "Classify failed");
            break;
          }
          data = await res.json();
        } catch (e) {
          if ((e as Error).name === "AbortError") { stopped = true; break; }
          throw e;
        }

        batches++;
        const lastBatch = data?.classified || 0;
        totalClassified += lastBatch;
        setClassifyProgress((p) => ({
          ...p,
          batches,
          classifiedThisRun: totalClassified,
          lastBatchClassified: lastBatch,
        }));

        // Refresh tile counts every 3 batches so the dial moves visibly.
        if (batches % 3 === 0) loadCounts();

        // done = server returned 0 unclassified, or this batch classified 0 rows
        if (data?.remaining === 0 || lastBatch === 0) {
          setClassifyProgress((p) => ({ ...p, status: "done" }));
          toast.success(`Done — classified ${totalClassified.toLocaleString()} rows in ${batches} batch${batches === 1 ? "" : "es"}`);
          break;
        }
      }
      if (stopped) {
        setClassifyProgress((p) => ({ ...p, status: "done" }));
        toast.info(`Stopped — classified ${totalClassified.toLocaleString()} rows in ${batches} batch${batches === 1 ? "" : "es"}`);
      }
      await Promise.all([loadPage(true, false), loadCounts()]);
    } catch (e) {
      setClassifyProgress((p) => ({ ...p, status: "error", error: (e as Error).message }));
      toast.error((e as Error).message);
    }

    setClassifying(false);
    classifyAbortRef.current = null;
  }

  function cancelClassify() {
    if (!classifyAbortRef.current) return;
    setClassifyProgress((p) => ({ ...p, status: "stopping" }));
    classifyAbortRef.current.abort();
  }

  function dismissClassifyProgress() {
    setClassifyProgress({ status: "idle", batches: 0, classifiedThisRun: 0, lastBatchClassified: 0, startedAt: null });
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
      // Pull from selectedMeta — covers bulk-selected items that aren't on
      // the current visible page. Falls back to items[] for ob_lead_id when
      // the selection came from a row click.
      const itemMap = new Map(items.map((i) => [i.id, i]));
      const itemRefs = Array.from(selected).map((id) => {
        const meta = selectedMeta.get(id);
        const it = itemMap.get(id);
        return { id, ob_lead_id: meta?.ob_lead_id ?? it?.ob_lead_id };
      });
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
      const campaign = campaigns.find((c) => c.id === Number(pushTargetCampaignId)) || null;

      // Three terminal states:
      //   - success: ok=true, OB confirmed all attached, DB updated
      //   - partial: ok=false + partial=true, OB attached < requested, DB NOT updated
      //   - error:   ok=false otherwise (HTTP error, no leads resolved, etc.)
      if (res.ok && data.ok) {
        toast.success(`Added ${data.attached} leads to ${campaign?.name || "the campaign"}`);
        setPushResult({
          status: "success",
          requested: data.requested ?? data.attached,
          attached: data.attached,
          campaignId: campaign?.id ?? null,
          campaignUuid: campaign?.uuid ?? null,
          campaignName: campaign?.name ?? null,
          message: data.message,
          failures: data.failures || [],
        });
        // Successful push: clear selection + exit selection-view mode
        // (banner clears, items revert to the regular paged view that no
        // longer contains the just-pushed leads).
        setSelected(new Set());
        setSelectedMeta(new Map());
        setPushTargetCampaignId("");
        setSelectionScope(null);
      } else if (data.partial) {
        toast.warning(`Partial: ${data.attached} of ${data.requested} attached — see details`);
        setPushResult({
          status: "partial",
          requested: data.requested,
          attached: data.attached,
          campaignId: campaign?.id ?? null,
          campaignUuid: campaign?.uuid ?? null,
          campaignName: campaign?.name ?? null,
          message: data.message,
          obMessage: data.obMessage,
          failures: data.failures || [],
        });
        // Don't clear selection on partial — user may want to re-push after
        // investigating in OutboundHero.
      } else {
        toast.error(data.error || "Push failed");
        setPushResult({
          status: "error",
          requested: data.requested ?? itemRefs.length,
          attached: 0,
          campaignId: campaign?.id ?? null,
          campaignUuid: campaign?.uuid ?? null,
          campaignName: campaign?.name ?? null,
          error: data.error || "Push failed",
          failures: data.failures || [],
        });
      }
      if (data.failures?.length) console.warn("Push failures:", data.failures);
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
      // Same cleanup as push — skipped rows shouldn't linger in the
      // selection view either.
      setSelected(new Set());
      setSelectedMeta(new Map());
      setPushTargetCampaignId("");
      setSelectionScope(null);
      await Promise.all([loadPage(true, false), loadCounts()]);
    } else toast.error(data.error);
  }

  async function rollbackSelected() {
    if (selected.size === 0) return;
    const n = selected.size;
    const ok = window.confirm(
      `Rollback ${n} lead${n === 1 ? "" : "s"} from "Added" back to "Ready to Nurture"?\n\n` +
      `This only clears the dashboard's added-at timestamp. The lead is NOT removed from the OutboundHero campaign — you must remove it there manually if needed.`
    );
    if (!ok) return;
    try {
      const res = await fetch("/api/nurture/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rollback-from-added", itemIds: Array.from(selected) }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Rolled back ${data.updated} lead${data.updated === 1 ? "" : "s"} to Ready`);
        setSelected(new Set());
        setSelectedMeta(new Map());
        setSelectionScope(null);
        await Promise.all([loadPage(true, false), loadCounts()]);
      } else {
        toast.error(data.error || "Rollback failed");
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const pushableInView = visibleItems.filter(isPushable);
  // selectableInView covers the active view's notion of a tickable row
  // (Added view → already-added rows for Rollback; other views → pushable).
  const selectableInView = visibleItems.filter(isSelectable);
  const allInViewSelected = selectableInView.length > 0 && selectableInView.every((i) => selected.has(i.id));

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
          <Button
            size="sm"
            variant="outline"
            onClick={syncSequenceFinished}
            disabled={syncing}
            title="Pulls leads from EmailBison whose outbound sequence finished with no reply and no bounce — they're added to the queue as a third source ('Sequence Finished'). Run after a sequence wraps."
          >
            {syncing ? "Syncing…" : "Sync Sequence-Finished"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={classifying ? cancelClassify : classifyAllUnclassified}
            title={
              classifying
                ? "Click to stop. The current batch will finish first."
                : "Drains the entire unclassified backlog — keeps firing 200-reply + 200-legacy batches in a loop until done. Tile counts refresh every 5 batches. Click again while running to stop."
            }
          >
            {classifying ? "Classifying — click to stop" : "Classify Unclassified"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={reclassifySafe}
            disabled={reclassifying}
            title="Re-runs the classifier on rows currently marked Safe. Useful after the classifier rules tighten — flips false positives to Unsafe so they stop showing in 'Ready to nurture'."
          >
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

      {/* ── Classify progress banner (visible while classify-loop is active) ── */}
      {classifyProgress.status !== "idle" && (
        <ClassifyProgressBanner
          progress={classifyProgress}
          counts={counts}
          onStop={cancelClassify}
          onDismiss={dismissClassifyProgress}
        />
      )}

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

      {/* ── Selection-mode banner ── */}
      {selectionScope && (
        <div className="rounded-lg border-2 border-primary/40 bg-primary/5 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm">
            <span className="font-semibold">Selection view active:</span>{" "}
            <span className="text-foreground">{selectionScope.clientTag}</span>
            {selectionScope.esp && (
              <span> · <span className={selectionScope.esp === "outlook" ? "text-sky-700" : "text-violet-700"}>
                {selectionScope.esp === "outlook" ? "Outlook" : "Gmail + Others"}
              </span></span>
            )}
            {selectionScope.source && <span> · {selectionScope.source}</span>}
            <span className="text-muted-foreground"> · showing all {items.length.toLocaleString()} matching leads, {selected.size.toLocaleString()} selected</span>
          </div>
          <button
            onClick={exitSelectionScope}
            className="text-xs text-primary hover:underline shrink-0"
          >
            ← Back to all leads
          </button>
        </div>
      )}

      {/* ── Sticky bulk action bar ── */}
      <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur border-b">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allInViewSelected}
              onChange={toggleSelectAllVisible}
              disabled={selectableInView.length === 0}
              className="size-4"
            />
            <span className="text-sm text-muted-foreground">
              {selected.size > 0 ? (
                <span>
                  <span className="text-foreground font-medium">{selected.size.toLocaleString()} selected</span>
                  {selectionScope && (
                    <span className="text-xs ml-1.5">
                      ({selectionScope.clientTag}
                      {selectionScope.esp && ` · ${selectionScope.esp === "outlook" ? "Outlook" : "Gmail+Others"}`})
                    </span>
                  )}
                </span>
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
          <button
            onClick={() => bulkSelectMatching({ client_tag: clientFilter || undefined, source: sourceFilter })}
            disabled={bulkSelecting || !clientFilter}
            className="text-xs text-primary hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
            title={
              clientFilter
                ? `Select every pushable ${clientFilter} lead across the whole dataset (capped at 1000)`
                : "Pick a Client filter (or use Group by Client and click 'Select all <tag>' on a group header) — nurture campaigns are per-client, so bulk select must be scoped to one client at a time."
            }
          >
            {bulkSelecting ? "Selecting…" : clientFilter ? `Select all for ${clientFilter}` : "Select all (pick a client first)"}
          </button>
          {filteredCampaigns.length === 0 ? (
            // Radix Select can fail to open when SelectContent has zero
            // SelectItems. Render a static, non-Select placeholder instead
            // so the user always gets a clear, non-broken UX. The hint is
            // explicit so they know how to fix it.
            <div className="h-9 w-72 px-3 flex items-center text-xs text-muted-foreground border rounded-md bg-muted/40">
              {(() => {
                const target =
                  selectedClientTags.length > 0 ? selectedClientTags.join(", ")
                  : clientFilter || null;
                if (target) {
                  return `No "[Nurture]" campaign tagged ${target} (of ${campaigns.length} total)`;
                }
                return campaigns.length === 0
                  ? "Loading nurture campaigns…"
                  : `${campaigns.length} nurture campaigns — pick a client first`;
              })()}
            </div>
          ) : (
            <Select value={pushTargetCampaignId} onValueChange={setPushTargetCampaignId}>
              <SelectTrigger className="h-9 w-72 text-sm" disabled={selected.size === 0}>
                <SelectValue placeholder="Choose a nurture campaign…" />
              </SelectTrigger>
              <SelectContent>
                {filteredCampaigns.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
          {/* Rollback only makes sense on the Added view — clears
              nurture_added_at + nurture_campaign_id so the row reappears
              under Ready to Nurture. The lead is NOT detached from the
              OutboundHero campaign — confirm modal warns the user. */}
          {view === "added" && (
            <Button
              size="sm"
              variant="outline"
              onClick={rollbackSelected}
              disabled={selected.size === 0}
              className="h-9 text-amber-700 border-amber-300 hover:bg-amber-50 hover:text-amber-800"
              title="Move selected leads from 'Added' back to 'Ready to Nurture'. Does NOT remove them from the OutboundHero campaign."
            >
              Rollback to Ready{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          )}
          {selected.size > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={exitSelectionScope}
              className="h-9 ml-auto"
            >
              {selectionScope ? "Clear & back to all leads" : "Clear selection"}
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
          <EmptyState view={view} counts={counts} onClassify={classifyAllUnclassified} classifying={classifying} />
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
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  ESP
                </TableHead>
                <SortableHead label="Safety" k="safety" current={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableHead label="Eligibility" k="eligibility" current={sortKey} dir={sortDir} onClick={toggleSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupedItems
                ? groupedItems.map(({ client, subs }) => {
                    const collapsed = collapsedGroups.has(client);
                    const allItems = subs.flatMap((s) => s.items);
                    const groupSelectable = allItems.filter(isSelectable);
                    return (
                      <Fragment key={`group-${client}`}>
                        {/* Client header */}
                        <TableRow
                          className="bg-muted/40 hover:bg-muted/60 cursor-pointer"
                          onClick={() => toggleGroupCollapse(client)}
                        >
                          <TableCell className="px-3" />
                          <TableCell colSpan={8} className="font-semibold">
                            <div className="flex items-center justify-between gap-3">
                              <span className="inline-flex items-center gap-2">
                                {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                                <span>{client}</span>
                                <span className="text-xs text-muted-foreground font-normal">
                                  · {allItems.length} on this page
                                  {groupSelectable.length > 0 && (
                                    <> · <span className="text-emerald-700">{groupSelectable.length} {view === "added" ? "added" : "ready"}</span></>
                                  )}
                                </span>
                              </span>
                              {client !== "(no client)" && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    bulkSelectMatching({ client_tag: client, source: sourceFilter });
                                  }}
                                  disabled={bulkSelecting}
                                  className="text-xs text-primary hover:underline disabled:opacity-50 disabled:no-underline shrink-0"
                                  title={`Select EVERY pushable ${client} lead across all pages (capped at 1000)`}
                                >
                                  Select all {client}
                                </button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>

                        {/* ESP sub-groups under each client */}
                        {!collapsed && subs.map((sub) => {
                          const subSelectable = sub.items.filter(isSelectable);
                          const subKey = `${client}__${sub.esp}`;
                          const subCollapsed = collapsedGroups.has(subKey);
                          const espLabel = sub.esp === "outlook" ? "Outlook" : "Gmail + Others";
                          const espDot = sub.esp === "outlook" ? "bg-sky-500" : "bg-violet-500";
                          return (
                            <Fragment key={subKey}>
                              <TableRow
                                className="bg-muted/15 hover:bg-muted/30 cursor-pointer"
                                onClick={() => toggleGroupCollapse(subKey)}
                              >
                                <TableCell className="px-3" />
                                <TableCell colSpan={8}>
                                  <div className="flex items-center justify-between gap-3 pl-4">
                                    <span className="inline-flex items-center gap-2 text-sm">
                                      {subCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                                      <span className={`size-2 rounded-full ${espDot}`} />
                                      <span className="font-medium">{espLabel}</span>
                                      <span className="text-xs text-muted-foreground font-normal">
                                        · {sub.items.length} on this page
                                        {subSelectable.length > 0 && (
                                          <> · <span className="text-emerald-700">{subSelectable.length} {view === "added" ? "added" : "ready"}</span></>
                                        )}
                                      </span>
                                    </span>
                                    {client !== "(no client)" && subSelectable.length > 0 && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          bulkSelectMatching({ client_tag: client, esp: sub.esp, source: sourceFilter });
                                        }}
                                        disabled={bulkSelecting}
                                        className="text-xs text-primary hover:underline disabled:opacity-50 disabled:no-underline shrink-0"
                                        title={`Select all pushable ${client} ${espLabel} leads + auto-pick the matching campaign`}
                                      >
                                        Select all {client} {espLabel}
                                      </button>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                              {!subCollapsed && sub.items.map((it: NurtureItem) => (
                                <LeadRow
                                  key={it.id}
                                  it={it}
                                  selected={selected.has(it.id)}
                                  pushable={isSelectable(it)}
                                  onToggle={() => toggleSelect(it)}
                                  onClick={() => setDetailItem(it)}
                                />
                              ))}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    );
                  })
                : visibleItems.map((it) => (
                    <LeadRow
                      key={it.id}
                      it={it}
                      selected={selected.has(it.id)}
                      pushable={isSelectable(it)}
                      onToggle={() => toggleSelect(it)}
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
                      setSelectedMeta(new Map([[detailItem.id, { client_tag: detailItem.client_tag, ob_lead_id: detailItem.ob_lead_id }]]));
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

      {/* ── Push result modal ── */}
      <PushResultDialog result={pushResult} onClose={() => setPushResult(null)} />
    </div>
  );
}

function ClassifyProgressBanner({
  progress, counts, onStop, onDismiss,
}: {
  progress: {
    status: "idle" | "running" | "stopping" | "done" | "error";
    batches: number;
    classifiedThisRun: number;
    lastBatchClassified: number;
    startedAt: number | null;
    error?: string;
  };
  counts: Counts | null;
  onStop: () => void;
  onDismiss: () => void;
}) {
  // Live elapsed-time tick
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (progress.status !== "running" && progress.status !== "stopping") return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [progress.status]);
  void tick; // keep eslint happy — we use it implicitly via re-render

  const elapsedMs = progress.startedAt ? Date.now() - progress.startedAt : 0;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const mm = Math.floor(elapsedSec / 60).toString().padStart(2, "0");
  const ss = (elapsedSec % 60).toString().padStart(2, "0");

  const rowsPerMin = elapsedSec > 0 ? Math.round((progress.classifiedThisRun / elapsedSec) * 60) : 0;

  // Estimate remaining: counts.eligible is "all eligible" — eligibleSafe is
  // the subset already classified safe. Unscored ≈ eligible − eligibleSafe.
  // Add waiting too since the cron classifies everything regardless of
  // eligibility status.
  const remainingEstimate = counts
    ? Math.max(0, counts.eligible + counts.waiting - counts.eligibleSafe)
    : null;
  const pctDone = remainingEstimate !== null && remainingEstimate > 0
    ? Math.min(99, Math.round((progress.classifiedThisRun / (progress.classifiedThisRun + remainingEstimate)) * 100))
    : null;
  const etaSec = remainingEstimate !== null && rowsPerMin > 0
    ? Math.round((remainingEstimate / rowsPerMin) * 60)
    : null;
  const etaText = etaSec === null ? "—"
    : etaSec < 90 ? `${etaSec}s`
    : etaSec < 3600 ? `${Math.round(etaSec / 60)}m`
    : `${(etaSec / 3600).toFixed(1)}h`;

  const isActive = progress.status === "running" || progress.status === "stopping";
  const isDone = progress.status === "done";
  const isError = progress.status === "error";

  const accent = isError ? "border-red-300 bg-red-50/40"
    : isDone ? "border-emerald-300 bg-emerald-50/40"
    : "border-sky-300 bg-sky-50/40";

  const headline = isError ? `Classify failed: ${progress.error || "unknown"}`
    : progress.status === "stopping" ? "Stopping after current batch…"
    : isDone ? "Classify finished"
    : progress.batches === 0 ? "Starting classifier — first batch is processing (up to 60s)…"
    : `Classifying batch ${progress.batches + 1}…`;

  return (
    <div className={`rounded-lg border ${accent} px-4 py-3`}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isActive && (
            <span className="relative flex size-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
              <span className="relative inline-flex rounded-full size-2.5 bg-sky-500" />
            </span>
          )}
          <p className="text-sm font-medium truncate">{headline}</p>
        </div>
        {isActive ? (
          <Button size="sm" variant="outline" onClick={onStop} disabled={progress.status === "stopping"}>
            {progress.status === "stopping" ? "Stopping…" : "Stop"}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
        )}
      </div>

      {/* Progress bar */}
      {pctDone !== null && (
        <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${isDone ? "bg-emerald-500" : "bg-sky-500"}`}
            style={{ width: `${isDone ? 100 : pctDone}%` }}
          />
        </div>
      )}

      {/* Stats row */}
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-2 text-xs">
        <Stat label="Classified" value={progress.classifiedThisRun.toLocaleString()} />
        <Stat label="Batches" value={progress.batches.toString()} />
        <Stat label="Last batch" value={progress.lastBatchClassified.toLocaleString()} />
        <Stat label="Elapsed" value={`${mm}:${ss}`} />
        <Stat
          label={remainingEstimate !== null ? `~Remaining (ETA ${etaText})` : "Throughput"}
          value={remainingEstimate !== null ? `~${remainingEstimate.toLocaleString()}` : `${rowsPerMin}/min`}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">{value}</p>
    </div>
  );
}

interface PushResultData {
  status: "success" | "partial" | "error";
  requested: number;
  attached: number | null;
  campaignId: number | null;
  campaignUuid: string | null;
  campaignName: string | null;
  message?: string;
  obMessage?: string;
  error?: string;
  failures?: Array<{ id: string; reason: string }>;
}

function PushResultDialog({
  result,
  onClose,
}: {
  result: PushResultData | null;
  onClose: () => void;
}) {
  // Group validation failures by reason for a clean breakdown.
  const failureBuckets = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of result?.failures || []) {
      m.set(f.reason, (m.get(f.reason) || 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [result]);

  if (!result) return null;

  const accent =
    result.status === "success"
      ? { bg: "bg-emerald-50", border: "border-emerald-200", ring: "ring-emerald-500/20", text: "text-emerald-700", num: "text-emerald-700" }
      : result.status === "partial"
      ? { bg: "bg-amber-50", border: "border-amber-200", ring: "ring-amber-500/20", text: "text-amber-700", num: "text-amber-700" }
      : { bg: "bg-rose-50", border: "border-rose-200", ring: "ring-rose-500/20", text: "text-rose-700", num: "text-rose-700" };

  const title =
    result.status === "success"
      ? "Push complete"
      : result.status === "partial"
      ? "Partial push — needs review"
      : "Push failed";

  const subtitle =
    result.status === "success"
      ? `All ${result.requested} leads landed in OutboundHero.`
      : result.status === "partial"
      ? `OutboundHero accepted ${result.attached} of ${result.requested}. Nothing was marked as added in the dashboard — investigate, then re-push.`
      : result.error || "The push request failed.";

  return (
    <Dialog open={!!result} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>

        {/* Hero stat */}
        <div className={`rounded-lg border ${accent.border} ${accent.bg} p-4 ring-4 ${accent.ring}`}>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Attached to OutboundHero</p>
          <p className={`mt-1 text-3xl font-semibold tabular-nums ${accent.num}`}>
            {(result.attached ?? 0).toLocaleString()}
            <span className="text-lg text-muted-foreground font-normal"> / {result.requested.toLocaleString()}</span>
          </p>
          {result.campaignName && (
            <p className="mt-1 text-xs text-muted-foreground">
              Campaign: <span className="font-medium text-foreground">{result.campaignName}</span>
            </p>
          )}
        </div>

        {/* Status line */}
        <p className={`text-sm ${accent.text}`}>{subtitle}</p>

        {/* OutboundHero's own message (when present and informative) */}
        {result.obMessage && (
          <div className="rounded border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground mb-1">OutboundHero said:</p>
            <p className="italic">{result.obMessage}</p>
          </div>
        )}

        {/* Validation-failure breakdown (rows our server rejected before
            ever calling OutboundHero — different from the OB-side skip). */}
        {failureBuckets.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              Skipped before push ({failureBuckets.reduce((s, [, n]) => s + n, 0)})
            </p>
            <ul className="space-y-1 text-sm">
              {failureBuckets.map(([reason, count]) => (
                <li key={reason} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{reason}</span>
                  <span className="font-medium tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {(result.campaignUuid || result.campaignId) && (
            <a
              href={
                result.campaignUuid
                  ? `https://app.outboundhero.co/campaigns/${result.campaignUuid}`
                  : `https://app.outboundhero.co/campaigns/${result.campaignId}/leads`
              }
              target="_blank"
              rel="noreferrer"
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted"
            >
              Open campaign in OutboundHero
            </a>
          )}
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
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
        <EspPill host={it.esp_host} bucket={it.esp_bucket} />
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

function EspPill({ host, bucket }: { host: string | null; bucket: "outlook" | "other" }) {
  const cls = "text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap";
  if (!host) {
    // Backfill hasn't reached this row yet — show a muted placeholder so
    // the user can tell at a glance which leads still need lookup.
    return (
      <span
        className={`${cls} bg-zinc-50 text-zinc-500 border-zinc-200`}
        title="ESP not yet detected — backfill in progress, refresh in a few minutes"
      >
        —
      </span>
    );
  }
  if (bucket === "outlook") {
    return (
      <span className={`${cls} bg-sky-50 text-sky-700 border-sky-200`} title={`EmailGuard: ${host}`}>
        {host}
      </span>
    );
  }
  return (
    <span className={`${cls} bg-violet-50 text-violet-700 border-violet-200`} title={`EmailGuard: ${host}`}>
      {host}
    </span>
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

function EmptyState({
  view, counts, onClassify, classifying,
}: {
  view: View;
  counts: Counts | null;
  onClassify: () => void;
  classifying: boolean;
}) {
  // For "Ready to nurture" specifically, the most common reason for an empty
  // state is "we have eligible rows but none classified Safe yet" — point the
  // user at Classify Unclassified instead of saying "all caught up".
  if (view === "actionable" && counts && counts.eligible > counts.eligibleSafe) {
    const unscored = counts.eligible - counts.eligibleSafe;
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-base font-medium">{unscored.toLocaleString()} eligible leads not scored yet</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
          The classifier hasn't run on these rows yet. Click below — it processes 200 replies + 200 legacy rows per click. Re-run a few times until everything is classified.
        </p>
        <Button size="sm" onClick={onClassify} disabled={classifying} className="mt-4">
          {classifying ? "Classifying…" : "Classify Unclassified"}
        </Button>
      </div>
    );
  }

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
