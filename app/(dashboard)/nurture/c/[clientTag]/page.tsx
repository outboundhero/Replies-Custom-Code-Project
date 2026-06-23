"use client";

import { useEffect, useState, useCallback, useMemo, useRef, Fragment } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronDown, ChevronRight, RefreshCw, Search, ArrowLeft, X, Rocket, CheckCircle2, AlertCircle, Loader2, Circle } from "lucide-react";
import { toast } from "sonner";
import { getInstanceBaseUrl } from "@/lib/bison-instances-shared";
import { InstanceBadge } from "@/components/instance-badge";
import TargetCampaigns from "./_components/TargetCampaigns";
import { ESP_LABEL, detectCampaignEsp, isCanonicalNurtureCampaign, type Esp } from "@/lib/nurture/esp";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";

type Source = "soft_negative" | "out_of_office" | "sequence_finished" | "legacy_airtable" | "other";
type View = "actionable" | "eligible" | "waiting" | "added";
type SortKey = "email" | "company" | "client" | "source" | "safety" | "eligibility";
type SortDir = "asc" | "desc";

interface NurtureItem {
  id: string;
  source: Source;
  client_tag: string | null;
  /** Bison workspace the row originated from. Null for legacy/Airtable rows. */
  bison_instance: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  trigger_at: string;
  eligible_at: string;
  days_until_eligible: number;
  is_eligible: boolean;
  added_at: string | null;
  skipped: boolean;
  esp_host: string | null;          // raw "Outlook" / "Gmail" / "Office 365" / null when un-backfilled
  esp_bucket: Esp;  // routing bucket — "google" | "outlook" | "segs"
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
  total_leads?: number;
  /** Which Bison instance this campaign lives on (e.g. "outboundhero", "facilityreach"). */
  bison_instance: string;
}

/**
 * Composite selection key for the campaign dropdown. Numeric campaign ids can
 * COLLIDE across Bison workspaces (the same id exists in B2B#1 and B2B#2), so a
 * bare id is ambiguous once a client's campaigns span both instances. Keying on
 * `${instance}:${id}` makes each option unique and lets pushSelected route the
 * attach to the right workspace.
 */
const campaignKey = (c: { bison_instance: string; id: number }) => `${c.bison_instance}:${c.id}`;

interface Counts {
  total: number;
  eligible: number;
  eligibleSafe: number;
  waiting: number;
  added: number;
}

// Show rows up-front instead of paginating. /api/nurture caps each request at
// 2000; loadPage auto-chains follow-ups when hasMore is true, up to
// ABSOLUTE_CAP. The cap is a RENDER limit for page speed — the authoritative
// totals come from the cached counts endpoint (shown in the tiles/pipeline),
// and a "showing first N of M" notice appears when a client exceeds it. Kept at
// 4000 (2 fetches) so even huge clients settle in ~1-2s instead of stalling on
// a 5-fetch 10k drain.
const PAGE_SIZE = 2000;
const ABSOLUTE_CAP = 4000;

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

// ── "Confirm & enable sending" progress model (persistent panel) ────────────
type EnablePhaseStatus = "pending" | "running" | "done" | "error";
interface EnableAttachRow { instance: string; esp: string; campaign: string | null; pool: number; connected: number; attached: number; alreadyPresent: number; error?: string }
interface EnableActivateRow { instance: string; esp: string; campaign: string | null; activated: boolean; error?: string }
interface EnableSendingState {
  clientTag: string;
  attach: { status: EnablePhaseStatus; rows: EnableAttachRow[]; total: number };
  route: { status: EnablePhaseStatus; routed: number; batches: number };
  activate: { status: EnablePhaseStatus; rows: EnableActivateRow[]; total: number };
}

export default function NurturePage() {
  // URL param locks this page to a single client tag. All queries below
  // are automatically scoped to it because clientFilter is initialised
  // from this value and the UI dropdown for switching clients is hidden.
  const routeParams = useParams<{ clientTag: string }>();
  const lockedClientTag = useMemo(
    () => (routeParams?.clientTag ? decodeURIComponent(routeParams.clientTag) : ""),
    [routeParams],
  );

  const [view, setView] = useState<View>("actionable");
  const [items, setItems] = useState<NurtureItem[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  // The "Ready to nurture" tile is driven by the actual drained actionable
  // list (the server now returns the full deduped + noise-filtered
  // eligible+safe set for this client in one shot), NOT by
  // /api/nurture/counts. The counts endpoint sums raw per-source rows with
  // no cross-source dedupe and no noise filtering, so it over-reports (it
  // read 2,427 while the real deduped set is ~2,100). Driving the tile from
  // the list keeps tile === table === "Select all". Falls back to
  // counts.eligibleSafe only until the actionable list first loads.
  const [readyFromList, setReadyFromList] = useState<number | null>(null);
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
  // clientFilter is forced to the URL-locked client tag — every load
  // through loadPage / loadCounts uses this value as the client_tag
  // query param.
  const [clientFilter, setClientFilter] = useState<string>(lockedClientTag);
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  // Keep clientFilter in sync if the route param updates (e.g. nav between
  // clients without full page reload).
  useEffect(() => {
    setClientFilter(lockedClientTag);
  }, [lockedClientTag]);

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
    esp?: Esp;
    source?: string;
  } | null>(null);
  const [pushTargetCampaignId, setPushTargetCampaignId] = useState<string>("");
  const [pushing, setPushing] = useState(false);
  // "Route all ready" — server-side loop that routes the client's ENTIRE
  // ESP-resolved ready pool (not just rendered rows), batch by batch.
  const [routingAll, setRoutingAll] = useState(false);
  const [routeAllProgress, setRouteAllProgress] = useState<{ routed: number; batches: number } | null>(null);
  const routeAllAbortRef = useRef(false);
  // Target-campaign map confirmation — gates all sending (must pick campaigns first).
  const [mapConfirmedAt, setMapConfirmedAt] = useState<string | null>(null);
  // Persistent "Confirm & enable sending" progress (attach → route → activate).
  // Stays on screen until the operator dismisses it (no auto-hide).
  const [enableProgress, setEnableProgress] = useState<EnableSendingState | null>(null);
  // Per-client auto-nurture state. Loaded once for the current
  // clientFilter via /api/config/clients/[tag]. Flipped automatically
  // after a successful Auto-route push (the operator clicks ONE button
  // and from then on the cron keeps the funnel flowing).
  const [autoNurture, setAutoNurture] = useState<{
    enabled: boolean;
    enabled_at: string | null;
    last_run_at: string | null;
  } | null>(null);
  const [autoNurtureToggling, setAutoNurtureToggling] = useState(false);

  // Helper to flip the auto-nurture flag. Used both by the Stop button
  // and implicitly after a successful Auto-route push.
  const setAutoNurtureEnabled = useCallback(async (clientTag: string, enabled: boolean) => {
    setAutoNurtureToggling(true);
    try {
      const res = await fetch("/api/clients/auto-nurture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTag, enabled }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || `Failed to ${enabled ? "enable" : "disable"} auto-push (${res.status})`);
        return;
      }
      setAutoNurture((prev) => ({
        enabled,
        enabled_at: enabled ? (prev?.enabled_at || new Date().toISOString()) : (prev?.enabled_at ?? null),
        last_run_at: prev?.last_run_at ?? null,
      }));
      if (enabled) toast.success(`Auto-push enabled for ${clientTag} — eligible leads will be pushed every 2h.`);
      else toast.success(`Auto-push disabled for ${clientTag}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAutoNurtureToggling(false);
    }
  }, []);

  // Fetch the current auto-nurture state when the client filter changes.
  useEffect(() => {
    if (!clientFilter) { setAutoNurture(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/config/clients/${encodeURIComponent(clientFilter)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setAutoNurture(data.auto_nurture || null);
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [clientFilter]);
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
    /** Bison instance the campaign lives on — used to build dashboard URLs. */
    bisonInstance: string;
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
        let cursor = resetOffset ? 0 : offset;
        const accumulated: NurtureItem[] = [];
        let pageHasMore = false;

        // Auto-paginate: keep fetching pages until the API says hasMore=false
        // or we hit the safety cap. The user wants to see every lead at once
        // for a client, so we don't surface a Load-more button anymore.
        const maxFetches = Math.ceil(ABSOLUTE_CAP / PAGE_SIZE);
        for (let i = 0; i < maxFetches; i++) {
          const p = new URLSearchParams();
          p.set("status", status);
          p.set("safety", safety);
          p.set("limit", String(PAGE_SIZE));
          p.set("offset", String(cursor));
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
          accumulated.push(...newItems);
          cursor += newItems.length;
          pageHasMore = !!data.page?.hasMore;
          // After the FIRST page paint the table immediately so the user
          // sees something while we keep fetching the rest in background.
          if (i === 0) {
            if (append) setItems((prev) => [...prev, ...accumulated]);
            else { setItems(accumulated.slice()); setSelected(new Set()); setSelectedMeta(new Map()); }
            if (pageHasMore) setLoadingMore(true); // banner stays up while we keep going
          }
          if (!pageHasMore || newItems.length === 0) break;
        }

        // Final replace once everything's in to capture all rows from the
        // chained fetches.
        if (append) setItems((prev) => [...prev.slice(0, prev.length - accumulated.length), ...accumulated]);
        else setItems(accumulated);
        setHasMore(false); // we always drain to the end now
        setOffset(cursor);
        setFetchError(null);

        // Keep the "Ready to nurture" tile in lockstep with what the table
        // actually loaded — but ONLY when we drained the whole population. If
        // we hit the display cap (big clients like TGS have far more than
        // ABSOLUTE_CAP eligible+safe leads), the loaded length is just the cap,
        // NOT the true total — using it would make the tile wrongly drop from
        // the real count (e.g. 48k) to 10k. In that case leave readyFromList
        // null so the tile/pipeline fall back to the authoritative
        // counts.eligibleSafe.
        if (!append && view === "actionable" && sourceFilter === "all") {
          setReadyFromList(accumulated.length < ABSOLUTE_CAP ? accumulated.length : null);
        }
      } catch (e) {
        setFetchError((e as Error).message);
      }
      setLoading(false);
      setLoadingMore(false);
    },
    [view, clientFilter, sourceFilter, offset, sortKey, sortDir]
  );

  const loadCounts = useCallback(async (fresh = false) => {
    try {
      const p = new URLSearchParams();
      if (clientFilter) p.set("client_tag", clientFilter);
      // Initial load reads the precomputed cache (instant). After a mutation
      // the caller passes fresh=true to force a live recompute so the tiles
      // reflect the action immediately.
      if (fresh) p.set("fresh", "1");
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
    // Pass the client tag so the API only hits THIS client's Bison
    // instance (fast path — one fetch instead of fanning out across
    // all four instances).
    const q = lockedClientTag ? `?clientTag=${encodeURIComponent(lockedClientTag)}` : "";
    fetch(`/api/nurture/campaigns${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.campaigns) setCampaigns(d.campaigns); })
      .catch(() => {});
  }, [lockedClientTag]);

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
    // Only ever surface the canonical "[Nurture] (Cleaning Client)" campaigns.
    // Legacy/source/parenthetical-(Nurture) variants are hidden from the
    // dropdown — and auto-route targets this same set (isCanonicalNurtureCampaign).
    const canonical = campaigns.filter((c) => isCanonicalNurtureCampaign(c.name));
    const tagsToMatch =
      selectedClientTags.length > 0 ? selectedClientTags
      : clientFilter ? [clientFilter]
      : null;
    if (!tagsToMatch) return canonical;
    // EXACT client-tag match only. client_tag is the tag extracted from the
    // campaign name by /api/nurture/campaigns, so "JPC" never matches "JPC&A".
    // (The old word-boundary fallback matched JPC&A for JPC because "&" is a
    // regex word boundary.)
    const want = new Set(tagsToMatch.map((t) => t.toUpperCase()));
    return canonical.filter((c) => !!c.client_tag && want.has(c.client_tag.toUpperCase()));
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
    type Sub = { esp: Esp; items: NurtureItem[] };
    type Group = { client: string; subs: Sub[] };
    const groups = new Map<string, Map<Esp, NurtureItem[]>>();
    for (const it of visibleItems) {
      const client = it.client_tag || "(no client)";
      if (!groups.has(client)) groups.set(client, new Map());
      const subMap = groups.get(client)!;
      const esp = it.esp_bucket;
      if (!subMap.has(esp)) subMap.set(esp, []);
      subMap.get(esp)!.push(it);
    }
    const out: Group[] = [];
    // Show buckets in fixed order: Outlook (smallest), SEGs, Google (catch-all).
    const ORDER: Esp[] = ["outlook", "segs", "google"];
    for (const [client, subMap] of groups) {
      const subs: Sub[] = [];
      for (const esp of ORDER) {
        if (subMap.has(esp)) subs.push({ esp, items: subMap.get(esp)! });
      }
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
  async function bulkSelectMatching(filters: { client_tag?: string; source?: string; esp?: Esp }) {
    if (!filters.client_tag) {
      toast.error("Pick a Client filter first — nurture campaigns are per-client, so the bulk select needs to be scoped to one client at a time.");
      return;
    }
    setBulkSelecting(true);
    try {
      // Inherit the active view's status/safety filters so bulk-select
      // pulls the same population the page is showing. Critical on the
      // Added view — we used to hardcode status=eligible+safety=safe,
      // which meant the per-group "Select all" buttons returned 0–3 rows
      // (whatever happened to also be eligible+safe), making rollback
      // unusable at scale.
      const { status: viewStatus, safety: viewSafety } = viewToFilters(view);

      // Paginate /api/nurture until hasMore=false (or we hit the sanity
      // ceiling). Old behavior: one call with limit=1000 — any client
      // with >1000 eligible leads was silently truncated (JPH has 2k+,
      // JPNYC has 2.1k+). Now we stream pages of 1000 and the operator
      // sees the real count.
      const PAGE_SIZE = 1000;
      const SANITY_CEILING = 10000;
      const fetched: NurtureItem[] = [];
      let hasMore = true;
      let pageNum = 0;
      while (hasMore && fetched.length < SANITY_CEILING) {
        const p = new URLSearchParams();
        p.set("client_tag", filters.client_tag);
        p.set("status", viewStatus);
        p.set("safety", viewSafety);
        p.set("limit", String(PAGE_SIZE));
        p.set("offset", String(fetched.length));
        if (filters.source && filters.source !== "all") p.set("source", filters.source);
        if (filters.esp) p.set("esp", filters.esp);

        const res = await fetch(`/api/nurture?${p}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          toast.error(body.error || `Bulk select failed (${res.status})`);
          return;
        }
        const data = await res.json() as { items: NurtureItem[]; page?: { hasMore?: boolean } };
        const items = data.items || [];
        fetched.push(...items);
        hasMore = !!data.page?.hasMore;
        pageNum++;
        // Surface mid-flight progress for big pulls so the operator
        // knows we're still working.
        if (hasMore && pageNum > 1) {
          toast.loading(`Loading ${fetched.length.toLocaleString()}+ leads…`, { id: "bulk-select-progress" });
        }
      }
      toast.dismiss("bulk-select-progress");

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
      // Per client convention there is exactly one canonical nurture
      // campaign per ESP per client — its name ends in "(Cleaning
      // Client)" — and older legacy variants like "(Nurture) (2)" may
      // also still exist on Bison. We restrict the auto-pick to the
      // canonical variant so legacy campaigns never get accidentally
      // chosen. See isCanonicalNurtureCampaign().
      if (filters.esp) {
        const matches = campaigns.filter((c) => {
          // EXACT client-tag match — "JPC" must never match "JPC&A".
          const tagMatches = !!c.client_tag && c.client_tag.toUpperCase() === (filters.client_tag || "").toUpperCase();
          return tagMatches && isCanonicalNurtureCampaign(c.name) && detectCampaignEsp(c.name) === filters.esp;
        });
        if (matches.length === 1) {
          setPushTargetCampaignId(campaignKey(matches[0]));
        }
      }

      const espLabel = filters.esp ? ` ${ESP_LABEL[filters.esp]}` : "";
      const noun = `for ${filters.client_tag}${espLabel}`;
      const hitCeiling = fetched.length >= 10000;
      toast.success(
        hitCeiling
          ? `Selected ${fetched.length.toLocaleString()} leads ${noun} (capped at 10,000 — refine filters and re-run for the rest)`
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
      await Promise.all([loadPage(true, false), loadCounts(true)]);
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
      await Promise.all([loadPage(true, false), loadCounts(true)]);
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
      await Promise.all([loadPage(true, false), loadCounts(true)]);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSyncing(false);
  }

  /**
   * Auto-route + fan-out push.
   *
   * Partitions the current selection by ESP bucket (google / outlook /
   * segs). For each non-empty bucket, finds the matching client nurture
   * campaign by name (detectCampaignEsp) and fires a single push-to-
   * nurture call. The N calls run in parallel and we aggregate the
   * results into one summary toast.
   *
   * Refuses when:
   *   - selection spans multiple client_tags (campaigns are per-client)
   *   - any bucket has no matching campaign in the client's campaign set
   *
   * Otherwise the operator clicks ONE button and the system handles
   * routing — exactly what "automate the nurture process" means.
   */
  async function pushSelectedAutoRoute() {
    if (selected.size === 0) return;
    setPushing(true);
    try {
      // Pull the full row for every selected id so we can read esp_bucket
      // + client_tag. Selection-mode bulkSelectMatching already loaded
      // these into items; otherwise we still have them in items[] from
      // the current page.
      const itemMap = new Map(items.map((i) => [i.id, i]));
      const refs: Array<{ id: string; ob_lead_id?: number; client_tag: string | null; esp: Esp }> = [];
      // Leads whose mailbox provider isn't confirmed yet (no esp_host from
      // Bison's tags). effectiveEsp() falls these back to the Google
      // catch-all, which dumped custom-domain Outlook/SEG mailboxes into the
      // Google campaign — the misrouting we hit. Hold them back; they route
      // correctly once the hourly ESP backfill stamps esp_host.
      let heldBackNoEsp = 0;
      for (const id of selected) {
        const it = itemMap.get(id);
        if (!it) continue;
        if (!it.esp_host) { heldBackNoEsp++; continue; }
        const meta = selectedMeta.get(id);
        refs.push({
          id,
          ob_lead_id: meta?.ob_lead_id ?? it.ob_lead_id,
          client_tag: it.client_tag,
          esp: it.esp_bucket || "google",
        });
      }
      if (refs.length === 0) {
        toast.error(
          heldBackNoEsp > 0
            ? `None of the ${heldBackNoEsp.toLocaleString()} selected leads have a confirmed ESP yet — the hourly ESP backfill hasn't reached them. Wait for it to catch up (it stamps ~400/run), then re-route.`
            : "Selection has no resolvable rows — refresh and try again",
        );
        return;
      }
      if (heldBackNoEsp > 0) {
        toast.info(
          `Holding back ${heldBackNoEsp.toLocaleString()} lead${heldBackNoEsp === 1 ? "" : "s"} with no confirmed ESP yet — routing the ${refs.length.toLocaleString()} that do. The rest become routable as the ESP backfill fills them in.`,
        );
      }

      // Refuse cross-client selections — nurture campaigns are per-client.
      const distinctClients = new Set(refs.map((r) => r.client_tag).filter(Boolean));
      if (distinctClients.size > 1) {
        toast.error(`Selection spans ${distinctClients.size} clients — scope to one client first (campaigns are per-client).`);
        return;
      }
      const clientTag = refs[0]?.client_tag;
      if (!clientTag) {
        toast.error("Selection has no client_tag — can't auto-route");
        return;
      }

      // Partition selection by ESP bucket.
      const byBucket = new Map<Esp, typeof refs>();
      for (const r of refs) {
        if (!byBucket.has(r.esp)) byBucket.set(r.esp, []);
        byBucket.get(r.esp)!.push(r);
      }

      // Look up the matching CANONICAL campaign per bucket — i.e. the
      // one whose name ends in "(Cleaning Client)". Per the client
      // (confirmed in chat): "There will be a outlook, google, and segs
      // for each client" and "It's only the ones where it reads
      // (Nurture) (Cleaning Client)". Legacy variants like
      // "JPNNJ: Outlook (Nurture) (2)" are intentionally ignored so
      // auto-route can't pick them by mistake.
      const plan: Array<{ esp: Esp; campaign: NurtureCampaign; items: typeof refs }> = [];
      const planErrors: string[] = [];
      for (const [esp, bucketRefs] of byBucket) {
        const matches = campaigns.filter((c) => {
          // EXACT client-tag match — "JPC" must never match "JPC&A".
          const tagMatches = !!c.client_tag && c.client_tag.toUpperCase() === clientTag.toUpperCase();
          return tagMatches && isCanonicalNurtureCampaign(c.name) && detectCampaignEsp(c.name) === esp;
        });
        if (matches.length === 0) {
          planErrors.push(`${ESP_LABEL[esp]}: no canonical nurture campaign for ${clientTag} — looked for a campaign named like "${clientTag}: ${ESP_LABEL[esp]} [Nurture] (Cleaning Client)"`);
        } else if (matches.length > 1) {
          planErrors.push(`${ESP_LABEL[esp]}: ${matches.length} canonical candidates — rename one so only one matches: ${matches.map((m) => `"${m.name}"`).join(", ")}`);
        } else {
          plan.push({ esp, campaign: matches[0], items: bucketRefs });
        }
      }
      if (planErrors.length > 0) {
        toast.error("Auto-route can't run yet:\n" + planErrors.join("\n"));
        return;
      }

      // Fire all bucket pushes in parallel.
      const results = await Promise.all(plan.map(async ({ esp, campaign, items: bucketItems }) => {
        try {
          const res = await fetch("/api/nurture/mutate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "push-to-nurture",
              nurtureCampaignId: campaign.id,
              bisonInstance: campaign.bison_instance,
              items: bucketItems.map((i) => ({ id: i.id, ob_lead_id: i.ob_lead_id })),
            }),
          });
          const data = await res.json();
          return { esp, campaign, requested: bucketItems.length, ok: res.ok && data.ok, data };
        } catch (e) {
          return { esp, campaign, requested: bucketItems.length, ok: false, data: { error: (e as Error).message } };
        }
      }));

      // Summarise per-bucket — single toast lists each.
      const lines = results.map((r) => {
        const attached = r.data.attached ?? 0;
        const status = r.ok ? "✓" : "✗";
        return `${status} ${ESP_LABEL[r.esp]}: ${attached}/${r.requested} → ${r.campaign.name}`;
      });
      const allOk = results.every((r) => r.ok);
      const totalAttached = results.reduce((s, r) => s + (r.data.attached ?? 0), 0);
      const totalReq = results.reduce((s, r) => s + r.requested, 0);
      if (allOk) {
        toast.success(`Added ${totalAttached}/${totalReq} across ${results.length} campaigns:\n${lines.join("\n")}`);
        setSelected(new Set());
        setSelectedMeta(new Map());
        setPushTargetCampaignId("");
        setSelectionScope(null);
        // Enable auto-push for this client so subsequent eligible leads
        // are pushed by the cron without operator action. Only flip on
        // success and only if it isn't already enabled — silent no-op
        // otherwise.
        if (!autoNurture?.enabled) {
          await setAutoNurtureEnabled(clientTag, true);
        }
      } else {
        toast.warning(`Partial push — ${totalAttached}/${totalReq} attached:\n${lines.join("\n")}`);
      }
      // Free the button the moment the attach calls return — the toast
      // already reports the result. Refreshing the table re-drains the full
      // client set (~2k rows) which is slow and NOT something the operator
      // needs to wait on, so fire it in the background.
      void Promise.all([loadPage(true, false), loadCounts(true)]);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setPushing(false);
  }

  // Core route-all drain loop: keeps firing /route-all (≤800/batch) until the
  // server reports nothing left. Returns a summary; callers render the UI.
  async function drainRouteAll(onProgress?: (routed: number, batches: number) => void): Promise<{ routed: number; batches: number; stopped: boolean; errored: boolean; bucketErrs: string[] }> {
    let routed = 0, batches = 0; let stopped = false, errored = false; let bucketErrs: string[] = [];
    // Id cursors page through the ENTIRE eligible pool. Unmappable-lane leads
    // (e.g. B2C when only B2B is mapped) are scanned and passed over — the
    // cursor advances past them so they never block newer mappable leads.
    let seqAfterId = 0, repAfterId = 0;
    const SAFETY_MAX_BATCHES = 1000;
    try {
      for (;;) {
        if (routeAllAbortRef.current) { stopped = true; break; }
        if (batches >= SAFETY_MAX_BATCHES) { stopped = true; break; }
        const res = await fetch("/api/nurture/route-all", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientTag: clientFilter, seqAfterId, repAfterId }),
        });
        if (res.redirected || res.status === 401) { window.location.href = "/login"; errored = true; break; }
        const data = await res.json();
        if (!res.ok) { errored = true; bucketErrs = [data.error || `HTTP ${res.status}`]; break; }
        batches++;
        routed += data.totalAttached || 0;
        seqAfterId = data.nextSeqAfterId ?? seqAfterId;
        repAfterId = data.nextRepAfterId ?? repAfterId;
        onProgress?.(routed, batches);
        // Keep the latest bucket errors for messaging, but DON'T stop on them —
        // a batch of unmappable leads is expected; we page past it.
        bucketErrs = (data.perBucket || []).filter((b: { error?: string }) => b.error).map((b: { esp: string; error: string }) => `${b.esp}: ${b.error}`);
        if (data.done) break; // scanned the whole pool
      }
    } catch (e) { errored = true; bucketErrs = [(e as Error).message]; }
    return { routed, batches, stopped, errored, bucketErrs };
  }

  // Standalone "Route all ready" button — drains with toasts.
  async function routeAllReady() {
    if (!clientFilter) return;
    if (routingAll) { routeAllAbortRef.current = true; return; } // click again = stop
    routeAllAbortRef.current = false;
    setRoutingAll(true);
    setRouteAllProgress({ routed: 0, batches: 0 });
    const r = await drainRouteAll((routed, batches) => setRouteAllProgress({ routed, batches }));
    if (r.errored) toast.error(r.bucketErrs[0] || "Route-all failed");
    else if (r.stopped && r.routed === 0 && r.bucketErrs.length) toast.error(`Couldn't route — ${r.bucketErrs.join("; ")}`);
    else if (r.stopped) toast.info(`Stopped — routed ${r.routed.toLocaleString()} so far.`);
    else {
      toast.success(`Routed ${r.routed.toLocaleString()} ready lead${r.routed === 1 ? "" : "s"} into ${clientFilter}'s nurture campaigns.`);
      if (r.routed > 0 && !autoNurture?.enabled) await setAutoNurtureEnabled(clientFilter, true);
    }
    setRoutingAll(false);
    void Promise.all([loadPage(true, false), loadCounts(true)]);
  }

  // Full "Confirm & enable sending" hand-off (attach inboxes → route ready
  // leads → activate). Drives the persistent EnableSendingProgress panel; the
  // map was already confirmed by TargetCampaigns before calling this.
  async function enableSendingFlow() {
    if (!clientFilter) return;
    const tag = clientFilter;
    setEnableProgress({
      clientTag: tag,
      attach: { status: "running", rows: [], total: 0 },
      route: { status: "pending", routed: 0, batches: 0 },
      activate: { status: "pending", rows: [], total: 0 },
    });

    // 1) ATTACH inboxes (ESP-split) to each mapped campaign.
    try {
      const res = await fetch("/api/nurture/enable-sending", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTag: tag, phase: "attach" }),
      });
      const d = await res.json();
      if (!res.ok) { setEnableProgress((p) => p && { ...p, attach: { ...p.attach, status: "error" } }); toast.error(d.error || "Inbox attach failed"); return; }
      const rows: EnableAttachRow[] = (d.campaigns || []).map((c: { instance: string; esp: string; campaignName: string | null; poolTotal: number; connected: number; attached: number; alreadyPresent: number; error?: string }) => ({ instance: c.instance, esp: c.esp, campaign: c.campaignName, pool: c.poolTotal, connected: c.connected, attached: c.attached, alreadyPresent: c.alreadyPresent, error: c.error }));
      setEnableProgress((p) => p && { ...p, attach: { status: "done", rows, total: d.totalAttached || 0 }, route: { ...p.route, status: "running" } });
    } catch (e) { setEnableProgress((p) => p && { ...p, attach: { ...p.attach, status: "error" } }); toast.error((e as Error).message); return; }

    // 2) ROUTE all ready leads (by ESP + B2B/B2C lane).
    routeAllAbortRef.current = false;
    setRoutingAll(true);
    const r = await drainRouteAll((routed, batches) => setEnableProgress((p) => p && { ...p, route: { status: "running", routed, batches } }));
    setRoutingAll(false);
    setEnableProgress((p) => p && { ...p, route: { status: r.errored ? "error" : "done", routed: r.routed, batches: r.batches }, activate: { ...p.activate, status: "running" } });
    void Promise.all([loadPage(true, false), loadCounts(true)]);

    // 3) ACTIVATE the campaigns.
    try {
      const res = await fetch("/api/nurture/enable-sending", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTag: tag, phase: "activate" }),
      });
      const d = await res.json();
      if (!res.ok) { setEnableProgress((p) => p && { ...p, activate: { ...p.activate, status: "error" } }); toast.error(d.error || "Activate failed"); return; }
      const rows: EnableActivateRow[] = (d.campaigns || []).map((c: { instance: string; esp: string; campaignName: string | null; activated: boolean; error?: string }) => ({ instance: c.instance, esp: c.esp, campaign: c.campaignName, activated: c.activated, error: c.error }));
      setEnableProgress((p) => p && { ...p, activate: { status: "done", rows, total: d.totalActivated || 0 } });
      if ((d.totalActivated || 0) > 0 && !autoNurture?.enabled) await setAutoNurtureEnabled(tag, true);
    } catch (e) { setEnableProgress((p) => p && { ...p, activate: { ...p.activate, status: "error" } }); toast.error((e as Error).message); }
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
      // pushTargetCampaignId is the composite `${instance}:${id}` key — match
      // on it so we never grab a same-id campaign from the wrong workspace.
      const campaign = campaigns.find((c) => campaignKey(c) === pushTargetCampaignId) || null;
      const res = await fetch("/api/nurture/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push-to-nurture",
          nurtureCampaignId: campaign?.id ?? null,
          // Route the attach to whichever Bison instance the campaign
          // lives on. /api/nurture/campaigns now returns bison_instance
          // per row, so we just forward it.
          bisonInstance: campaign?.bison_instance,
          items: itemRefs,
        }),
      });
      const data = await res.json();

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
          bisonInstance: campaign?.bison_instance ?? "outboundhero",
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
          bisonInstance: campaign?.bison_instance ?? "outboundhero",
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
          bisonInstance: campaign?.bison_instance ?? "outboundhero",
          error: data.error || "Push failed",
          failures: data.failures || [],
        });
      }
      if (data.failures?.length) console.warn("Push failures:", data.failures);
      // Background the table re-drain — the result modal/toast already fired.
      void Promise.all([loadPage(true, false), loadCounts(true)]);
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
      await Promise.all([loadPage(true, false), loadCounts(true)]);
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
        await Promise.all([loadPage(true, false), loadCounts(true)]);
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
    <div className="space-y-6 max-w-[1500px] mx-auto">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/nurture"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-1.5"
          >
            <ArrowLeft className="size-3.5" />
            All clients
          </Link>
          <h1 className="text-[26px] font-semibold tracking-tight flex items-center gap-3">
            Nurture
            <span className="text-muted-foreground/50 font-light">/</span>
            <span className="font-mono text-emerald-700">{lockedClientTag || "—"}</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Re-engage soft-negative, out-of-office, and sequence-finished leads for this client after the 45-day cooldown.
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

      {/* ── Stat tiles (also act as view tabs) — Eligible tile dropped
            per workflow simplification: every safe-and-eligible lead just
            shows up under Ready. Unsafe leads stay out of the queue. ── */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile
          label="Ready to nurture"
          sublabel="Eligible & safe — push these"
          value={readyFromList ?? counts?.eligibleSafe}
          accent="text-emerald-700"
          active={view === "actionable"}
          activeBorder="border-emerald-500"
          onClick={() => setView("actionable")}
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

      {/* ── Nurture pipeline status (orientation for anyone opening the page) ── */}
      {clientFilter && (
        <NurturePipeline clientTag={clientFilter} counts={counts} campaigns={filteredCampaigns} readyCount={readyFromList} />
      )}

      {/* ── Target campaigns — operator picks destinations; gates sending ── */}
      {clientFilter && (
        <TargetCampaigns clientTag={clientFilter} campaigns={campaigns} onConfirmedChange={setMapConfirmedAt} onSendingEnabled={enableSendingFlow} />
      )}

      {/* ── Enable-sending progress (persistent until dismissed) ── */}
      {enableProgress && (
        <EnableSendingProgress
          progress={enableProgress}
          routing={routingAll}
          onStopRouting={() => { routeAllAbortRef.current = true; }}
          onDismiss={() => setEnableProgress(null)}
        />
      )}

      {/* ── Classify progress banner (visible while classify-loop is active) ── */}
      {classifyProgress.status !== "idle" && (
        <ClassifyProgressBanner
          progress={classifyProgress}
          counts={counts}
          onStop={cancelClassify}
          onDismiss={dismissClassifyProgress}
        />
      )}

      {/* ── Charts + campaigns ── */}
      <ClientInsights
        items={items}
        counts={counts}
        clientTag={lockedClientTag}
        campaigns={campaigns}
      />

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
        {/* Client filter dropdown hidden — this page is permanently
            scoped to lockedClientTag via the URL param. */}
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
              <span> · <span className={ESP_TEXT_COLOR[selectionScope.esp]}>
                {ESP_LABEL[selectionScope.esp]}
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

      {/* ── Auto-push status banner (only shown when enabled) ── */}
      {clientFilter && autoNurture?.enabled && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-emerald-900">
            <span className="font-semibold">Auto-push is ON</span> for <span className="font-mono">{clientFilter}</span>.
            <span className="text-emerald-800">
              {" "}Every 2 hours the cron pushes newly-eligible Ready leads into the
              {" "}3 canonical Bison nurture campaigns (Google / Outlook / SEGs).
            </span>
            {autoNurture.last_run_at && (
              <span className="text-xs text-emerald-700/80 block mt-0.5">
                Last run: {new Date(autoNurture.last_run_at).toLocaleString()}
              </span>
            )}
          </div>
          <button
            onClick={() => setAutoNurtureEnabled(clientFilter, false)}
            disabled={autoNurtureToggling}
            className="text-xs text-emerald-800 hover:underline disabled:opacity-50 shrink-0"
            title="Stop the cron from pushing more leads automatically. The leads already pushed stay pushed."
          >
            {autoNurtureToggling ? "Saving…" : "Stop auto-push"}
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
                      {selectionScope.esp && ` · ${ESP_LABEL[selectionScope.esp]}`})
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
          {/* Bulk select: one button for the full client, then a per-ESP
              row so the operator can grab a single bucket and the
              campaign auto-picks itself. */}
          <button
            onClick={() => bulkSelectMatching({ client_tag: clientFilter || undefined, source: sourceFilter })}
            disabled={bulkSelecting || !clientFilter}
            className="text-xs text-primary hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
            title={
              clientFilter
                ? `Select every pushable ${clientFilter} lead across the whole dataset (capped at 1000). Use Auto-route to push all 3 ESP buckets in one click.`
                : "Pick a Client filter first — nurture campaigns are per-client."
            }
          >
            {bulkSelecting ? "Selecting…" : clientFilter ? `Select all for ${clientFilter}` : "Select all (pick a client first)"}
          </button>
          {clientFilter && (
            <div className="flex items-center gap-1.5">
              {(["google", "outlook", "segs"] as Esp[]).map((esp) => (
                <button
                  key={esp}
                  onClick={() => bulkSelectMatching({ client_tag: clientFilter, source: sourceFilter, esp })}
                  disabled={bulkSelecting}
                  className={`text-xs px-1.5 py-0.5 rounded border hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed ${ESP_PILL_CLASSES[esp]}`}
                  title={`Select all ${ESP_LABEL[esp]} leads for ${clientFilter} and auto-pick the matching campaign in the dropdown.`}
                >
                  {ESP_LABEL[esp]}
                </button>
              ))}
            </div>
          )}
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
                  <SelectItem key={campaignKey(c)} value={campaignKey(c)}>
                    <span className="flex items-center gap-2">
                      <InstanceBadge instance={c.bison_instance} size="xs" />
                      <span>{c.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            size="sm"
            onClick={pushSelected}
            disabled={pushing || !pushTargetCampaignId || selected.size === 0}
            className="h-9"
            title="Send the entire selection to the single campaign chosen in the dropdown."
          >
            {pushing ? "Pushing…" : `Add to nurture${selected.size > 0 ? ` (${selected.size})` : ""}`}
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={pushSelectedAutoRoute}
            disabled={pushing || selected.size === 0 || !mapConfirmedAt}
            className="h-9 bg-emerald-600 hover:bg-emerald-700 text-white"
            title={!mapConfirmedAt ? "Confirm your Target Campaigns first to enable sending." : "Split the selection by email provider (Google / Outlook / SEGs) and push each bucket to its matching nurture campaign automatically."}
          >
            {pushing ? "Pushing…" : `Auto-route${selected.size > 0 ? ` (${selected.size})` : ""}`}
          </Button>
          {view === "actionable" && (
            <Button
              size="sm"
              variant="default"
              onClick={routeAllReady}
              disabled={pushing || !mapConfirmedAt}
              className={`h-9 ${routingAll ? "bg-rose-600 hover:bg-rose-700" : "bg-violet-600 hover:bg-violet-700"} text-white`}
              title={!mapConfirmedAt
                ? "Confirm your Target Campaigns first to enable sending."
                : "Route EVERY ESP-resolved ready lead for this client into the campaigns you mapped — creating each lead in the correct B2B/B2C Bison instance, server-side, all of them. Click again to stop."}
            >
              {routingAll
                ? `Stop (routed ${routeAllProgress?.routed.toLocaleString() ?? 0})`
                : "Route all ready"}
            </Button>
          )}
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

      {/* Capped-list notice — the table renders at most ABSOLUTE_CAP rows for
          performance, but the tile/pipeline show the TRUE total. Make the gap
          explicit so a big client (e.g. 48k ready, 10k shown) isn't confusing. */}
      {view === "actionable" && sourceFilter === "all" && items.length >= ABSOLUTE_CAP &&
        typeof counts?.eligibleSafe === "number" && counts.eligibleSafe > items.length && (
        <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-4 py-2.5 text-xs text-sky-800 flex items-center gap-2">
          <span className="font-medium">Showing the first {items.length.toLocaleString()} of {counts.eligibleSafe.toLocaleString()} ready leads.</span>
          <span className="text-sky-700/80">The list caps rows for speed — use <strong>Route all ready</strong> to auto-route every ESP-resolved lead (all {counts.eligibleSafe.toLocaleString()}, not just these) into the correct campaigns.</span>
        </div>
      )}

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
                {/* "Client" column dropped — page is locked to one client */}
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Address
                </TableHead>
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
                          const espLabel = ESP_LABEL[sub.esp];
                          const espDot = ESP_DOT_COLOR[sub.esp];
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
        {loadingMore && items.length > 0 && (
          <div className="p-2 text-center border-t bg-muted/20 text-xs text-muted-foreground">
            Loading more rows in the background…
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
                        loadCounts(true);
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

function EnablePhaseIcon({ status }: { status: EnablePhaseStatus }) {
  if (status === "running") return <Loader2 className="size-4 animate-spin text-sky-600" />;
  if (status === "done") return <CheckCircle2 className="size-4 text-emerald-600" />;
  if (status === "error") return <AlertCircle className="size-4 text-rose-600" />;
  return <Circle className="size-4 text-muted-foreground/40" />;
}

/**
 * Persistent progress panel for "Confirm & enable sending" — shows the three
 * phases (attach inboxes → route ready leads → activate) with per-campaign
 * detail. Stays on screen until the operator dismisses it with the ✕.
 */
function EnableSendingProgress({ progress, routing, onStopRouting, onDismiss }: {
  progress: EnableSendingState;
  routing: boolean;
  onStopRouting: () => void;
  onDismiss: () => void;
}) {
  const { attach, route, activate } = progress;
  const allDone = attach.status === "done" && route.status === "done" && activate.status === "done";
  const anyError = [attach.status, route.status, activate.status].includes("error")
    || attach.rows.some((r) => r.error) || activate.rows.some((r) => r.error);
  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b">
        <div className="flex items-center gap-2">
          <Rocket className={`size-4 ${allDone ? "text-emerald-600" : anyError ? "text-amber-600" : "text-sky-600"}`} />
          <span className="text-sm font-semibold">Enabling sending — <span className="font-mono">{progress.clientTag}</span></span>
          {allDone && <span className="text-[11px] font-medium text-emerald-700">— all steps complete</span>}
        </div>
        <button onClick={onDismiss} title="Dismiss" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      <div className="p-4 space-y-4 text-sm">
        {/* 1. Attach inboxes */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <EnablePhaseIcon status={attach.status} />
            <span className="font-medium">1. Attach inboxes</span>
            {attach.status !== "pending" && <span className="text-xs text-muted-foreground"><span className="text-emerald-700 font-medium">{attach.total.toLocaleString()}</span> newly attached</span>}
          </div>
          {attach.rows.length > 0 && (
            <div className="ml-6 space-y-1">
              {attach.rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="uppercase font-semibold text-muted-foreground w-16 shrink-0">{r.esp}</span>
                  <InstanceBadge instance={r.instance} size="xs" />
                  {r.error
                    ? <span className="text-rose-600">{r.error}</span>
                    : r.attached === 0 && r.alreadyPresent > 0
                      ? <span className="text-muted-foreground">all <span className="font-medium text-foreground">{r.alreadyPresent.toLocaleString()}</span> inboxes already present — none added <span className="text-muted-foreground/60">· pool {r.pool.toLocaleString()}</span></span>
                      : <span className="text-muted-foreground"><span className="text-emerald-700 font-medium">{r.attached.toLocaleString()}</span> inbox{r.attached === 1 ? "" : "es"} attached{r.alreadyPresent > 0 ? `, ${r.alreadyPresent.toLocaleString()} already present` : ""} <span className="text-muted-foreground/60">· pool {r.pool.toLocaleString()}</span></span>}
                </div>
              ))}
            </div>
          )}
        </div>
        {/* 2. Route ready leads */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <EnablePhaseIcon status={route.status} />
            <span className="font-medium">2. Route ready leads</span>
            {route.status !== "pending" && <span className="text-xs text-muted-foreground"><span className="text-emerald-700 font-medium">{route.routed.toLocaleString()}</span> pushed{route.batches ? ` · ${route.batches} batch${route.batches === 1 ? "" : "es"}` : ""}</span>}
            {routing && route.status === "running" && (
              <button onClick={onStopRouting} className="ml-auto text-[11px] rounded border px-2 py-0.5 hover:bg-muted">Stop</button>
            )}
          </div>
        </div>
        {/* 3. Activate campaigns */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <EnablePhaseIcon status={activate.status} />
            <span className="font-medium">3. Activate campaigns</span>
            {(activate.status === "done" || activate.status === "error") && <span className="text-xs text-muted-foreground"><span className="text-emerald-700 font-medium">{activate.total}</span> activated</span>}
          </div>
          {activate.rows.length > 0 && (
            <div className="ml-6 space-y-1">
              {activate.rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="uppercase font-semibold text-muted-foreground w-16 shrink-0">{r.esp}</span>
                  <InstanceBadge instance={r.instance} size="xs" />
                  {r.activated
                    ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="size-3" /> activated</span>
                    : <span className="text-rose-600">{r.error || "not activated"}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
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
  /** Bison instance the campaign lives on — used to build dashboard URLs. */
  bisonInstance: string;
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
                  ? `${getInstanceBaseUrl(result.bisonInstance)}/campaigns/${result.campaignUuid}`
                  : `${getInstanceBaseUrl(result.bisonInstance)}/campaigns/${result.campaignId}/leads`
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

// Campaign-status → badge classes (full strings so Tailwind doesn't purge them).
const CAMPAIGN_STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700",
  paused: "bg-amber-100 text-amber-700",
  draft: "bg-slate-100 text-slate-600",
  archived: "bg-rose-100 text-rose-600",
  completed: "bg-slate-100 text-slate-500",
};

/**
 * Pipeline status panel — gives anyone opening a client's nurture page an
 * at-a-glance "what's been done" view: Synced → Ready → Routed → Sending,
 * plus the live status of each of the 3 canonical ESP campaigns (so archived/
 * not-set-up campaigns are visible).
 */
function NurturePipeline({
  clientTag, counts, campaigns, readyCount,
}: {
  clientTag: string;
  counts: Counts | null;
  campaigns: NurtureCampaign[];
  readyCount: number | null;
}) {
  // Group canonical campaigns by INSTANCE, then ESP. A client's nurture
  // campaigns can live in both its group's B2B and B2C workspaces (identical
  // ESP names, different instances), so we render one block per instance rather
  // than collapsing across them.
  const byInstance = useMemo(() => {
    const rank = (s: string) => (s === "active" ? 0 : s === "paused" ? 1 : s === "draft" ? 2 : s === "archived" ? 4 : 3);
    const m = new Map<string, Partial<Record<Esp, NurtureCampaign>>>();
    for (const c of campaigns) {
      const esp = detectCampaignEsp(c.name);
      if (!esp) continue;
      const inst = c.bison_instance || "outboundhero";
      if (!m.has(inst)) m.set(inst, {});
      const espMap = m.get(inst)!;
      const cur = espMap[esp];
      if (!cur || rank(c.status) < rank(cur.status)) espMap[esp] = c; // prefer routable status
    }
    return m;
  }, [campaigns]);
  const instanceKeys = useMemo(() => [...byInstance.keys()].sort(), [byInstance]);

  const total = counts?.total ?? 0;
  const ready = readyCount ?? counts?.eligibleSafe ?? 0;
  const added = counts?.added ?? 0;
  const waiting = counts?.waiting ?? 0;
  const anyActive = [...byInstance.values()].some((espMap) =>
    (["google", "outlook", "segs"] as Esp[]).some((e) => espMap[e]?.status === "active"),
  );

  const stages: Array<{ n: number; label: string; value: number | string; hint: string; lit: boolean }> = [
    { n: 1, label: "Synced", value: total, hint: "pulled from Bison", lit: total > 0 },
    { n: 2, label: "Ready", value: ready, hint: "eligible + ESP-resolved", lit: ready > 0 },
    { n: 3, label: "Routed", value: added, hint: "added to campaigns", lit: added > 0 },
    { n: 4, label: "Sending", value: anyActive ? "Active" : "Not yet", hint: "campaign status", lit: anyActive },
  ];

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm font-semibold">Nurture pipeline — <span className="font-mono">{clientTag}</span></p>
        <span className="text-xs text-muted-foreground">{waiting.toLocaleString()} still in cooldown (Waiting)</span>
      </div>
      <div className="flex items-stretch gap-1.5">
        {stages.map((st, i) => (
          <Fragment key={st.label}>
            <div className="flex-1 rounded-md border bg-muted/10 px-3 py-2">
              <div className="flex items-center gap-1.5">
                <span className={`size-1.5 rounded-full ${st.lit ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                <span className="text-[11px] font-medium text-muted-foreground">{st.n}. {st.label}</span>
              </div>
              <p className="text-lg font-semibold tabular-nums mt-0.5">{typeof st.value === "number" ? st.value.toLocaleString() : st.value}</p>
              <p className="text-[10px] text-muted-foreground">{st.hint}</p>
            </div>
            {i < stages.length - 1 && <ChevronRight className="size-4 text-muted-foreground/50 self-center shrink-0" />}
          </Fragment>
        ))}
      </div>
      {instanceKeys.length === 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {(["outlook", "google", "segs"] as Esp[]).map((esp) => (
            <div key={esp} className="rounded-md border px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{ESP_LABEL[esp]} campaign</p>
              <p className="text-xs text-rose-600 mt-1">not set up</p>
            </div>
          ))}
        </div>
      ) : (
        instanceKeys.map((inst) => {
          const espMap = byInstance.get(inst)!;
          return (
            <div key={inst} className="space-y-1.5">
              <InstanceBadge instance={inst} size="xs" />
              <div className="grid grid-cols-3 gap-2">
                {(["outlook", "google", "segs"] as Esp[]).map((esp) => {
                  const c = espMap[esp];
                  return (
                    <div key={esp} className="rounded-md border px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{ESP_LABEL[esp]} campaign</p>
                      {c ? (
                        <div className="flex items-center justify-between gap-2 mt-1">
                          <span className="text-sm font-semibold tabular-nums" title={c.name}>{(c.total_leads ?? 0).toLocaleString()} leads</span>
                          <span className={`text-[10px] rounded-full px-1.5 py-0.5 shrink-0 ${CAMPAIGN_STATUS_BADGE[c.status] ?? "bg-slate-100 text-slate-600"}`}>{c.status}</span>
                        </div>
                      ) : <p className="text-xs text-rose-600 mt-1">not set up</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
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
      <TableCell className="cursor-pointer max-w-[220px]" onClick={onClick}>
        {it.address || it.city || it.state ? (
          <div className="text-xs leading-tight">
            {it.address && <div className="truncate">{it.address}</div>}
            {(it.city || it.state) && (
              <div className="text-muted-foreground truncate">
                {[it.city, it.state].filter(Boolean).join(", ")}
              </div>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="cursor-pointer" onClick={onClick}>
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span className={`size-2 rounded-full ${SOURCE_DOT[it.source]}`} />
            <span className="text-muted-foreground">{SOURCE_LABEL[it.source]}</span>
          </span>
          <InstanceBadge instance={it.bison_instance} size="xs" />
        </div>
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

// Tailwind color tokens per ESP bucket. Kept in module scope so it can
// be reused across UI components (banner badges, group headers, pills,
// donut chart) — there's no good way to extract these via Tailwind
// runtime helpers.
const ESP_PILL_CLASSES: Record<Esp, string> = {
  google:  "bg-violet-50 text-violet-700 border-violet-200",
  outlook: "bg-sky-50 text-sky-700 border-sky-200",
  segs:    "bg-amber-50 text-amber-700 border-amber-200",
};
const ESP_DOT_COLOR: Record<Esp, string> = {
  google:  "bg-violet-500",
  outlook: "bg-sky-500",
  segs:    "bg-amber-500",
};
const ESP_TEXT_COLOR: Record<Esp, string> = {
  google:  "text-violet-700",
  outlook: "text-sky-700",
  segs:    "text-amber-700",
};
const ESP_CHART_HEX: Record<Esp, string> = {
  google:  "#8b5cf6",
  outlook: "#0ea5e9",
  segs:    "#f59e0b",
};

function EspPill({ host, bucket }: { host: string | null; bucket: Esp }) {
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
  return (
    <span className={`${cls} ${ESP_PILL_CLASSES[bucket]}`} title={`EmailGuard: ${host}`}>
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

// ─────────────────────────────────────────────────────────────────────
// Client-detail charts + campaigns
// ─────────────────────────────────────────────────────────────────────

const SOURCE_DISPLAY: Record<string, { label: string; color: string }> = {
  soft_negative:      { label: "Soft Negative",      color: "#22c55e" },
  out_of_office:      { label: "Out of Office",      color: "#f59e0b" },
  sequence_finished:  { label: "Sequence Finished",  color: "#a855f7" },
  legacy_airtable:    { label: "Legacy (Airtable)",  color: "#f43f5e" },
  other:              { label: "Other",              color: "#9ca3af" },
};


function ClientInsights({
  items, counts, clientTag, campaigns,
}: {
  items: NurtureItem[];
  counts: Counts | null;
  clientTag: string;
  campaigns: NurtureCampaign[];
}) {
  // ── Source breakdown from the visible items (donut) ──
  const sourceData = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) map.set(it.source, (map.get(it.source) || 0) + 1);
    return Array.from(map.entries()).map(([source, value]) => ({
      name: SOURCE_DISPLAY[source]?.label || source,
      value,
      color: SOURCE_DISPLAY[source]?.color || "#9ca3af",
    }));
  }, [items]);

  // ── ESP routing breakdown (donut) ──
  const espData = useMemo(() => {
    const map = new Map<Esp, number>();
    for (const it of items) {
      const b: Esp = it.esp_bucket || "google";
      map.set(b, (map.get(b) || 0) + 1);
    }
    const ORDER: Esp[] = ["outlook", "segs", "google"];
    const out: { name: string; value: number; color: string }[] = [];
    for (const b of ORDER) {
      if (map.get(b)) out.push({ name: ESP_LABEL[b], value: map.get(b)!, color: ESP_CHART_HEX[b] });
    }
    return out;
  }, [items]);

  // ── Eligibility forecast for the next 30 days ──
  const forecastData = useMemo(() => {
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const buckets: { date: string; label: string; count: number; cumulative: number }[] = [];
    for (let d = 0; d < 30; d++) {
      const dt = new Date(today.getTime() + d * dayMs);
      buckets.push({
        date: dt.toISOString().slice(0, 10),
        label: dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        count: 0,
        cumulative: 0,
      });
    }
    let alreadyEligible = 0;
    for (const it of items) {
      const eligibleAt = new Date(it.eligible_at);
      eligibleAt.setHours(0, 0, 0, 0);
      const diff = Math.round((eligibleAt.getTime() - today.getTime()) / dayMs);
      if (diff < 0) { alreadyEligible++; continue; }
      if (diff >= 30) continue;
      buckets[diff].count++;
    }
    let running = alreadyEligible;
    for (const b of buckets) {
      running += b.count;
      b.cumulative = running;
    }
    return buckets;
  }, [items]);

  // ── Campaigns for this client (filtered from the global list) ──
  // Only the canonical "[Nurture] (Cleaning Client)" campaigns — legacy/source
  // variants are hidden everywhere on this page.
  const clientCampaigns = useMemo(() => {
    // EXACT client-tag match only (no word-boundary fallback — "JPC" must not
    // match "JPC&A").
    return campaigns
      .filter((c) => isCanonicalNurtureCampaign(c.name) && !!c.client_tag && c.client_tag.toUpperCase() === clientTag.toUpperCase())
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [campaigns, clientTag]);

  const total = counts?.total ?? 0;

  return (
    <div className="space-y-4">
      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <ChartCard title="Source breakdown" subtitle="Where these leads came from">
          {sourceData.length === 0 ? (
            <EmptyChart text="No data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={sourceData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={45}
                  outerRadius={80}
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {sourceData.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v) => (typeof v === "number" ? v.toLocaleString() : String(v))} />
              </PieChart>
            </ResponsiveContainer>
          )}
          <Legend data={sourceData} />
        </ChartCard>

        <ChartCard title="ESP routing" subtitle="Outlook vs everything else">
          {espData.length === 0 ? (
            <EmptyChart text="ESP not detected yet" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={espData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={45}
                  outerRadius={80}
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {espData.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v) => (typeof v === "number" ? v.toLocaleString() : String(v))} />
              </PieChart>
            </ResponsiveContainer>
          )}
          <Legend data={espData} />
        </ChartCard>

        <ChartCard title="Eligibility forecast (30 days)" subtitle="When more leads cross the 45-day cooldown">
          {forecastData.every((d) => d.count === 0) ? (
            <EmptyChart text="No upcoming eligibility on this page" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={forecastData} margin={{ top: 10, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={4} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  formatter={(v) => (typeof v === "number" ? v.toLocaleString() : String(v))}
                  labelFormatter={(l) => `Day: ${l}`}
                />
                <Bar dataKey="count" fill="#10b981" radius={[2, 2, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <p className="text-[10px] text-muted-foreground mt-1">
            From the loaded page ({items.length.toLocaleString()} rows). Open more pages to extend the forecast.
          </p>
        </ChartCard>
      </div>

      {/* Campaigns row */}
      <div className="rounded-lg border bg-card">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Nurture campaigns for {clientTag}</p>
            <p className="text-[11px] text-muted-foreground">
              {clientCampaigns.length === 0
                ? "No matching nurture campaigns in OutboundHero"
                : `${clientCampaigns.length} matching campaign${clientCampaigns.length === 1 ? "" : "s"}`}
              {total ? ` · ${total.toLocaleString()} leads in the pool` : ""}
            </p>
          </div>
        </div>
        {clientCampaigns.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            Create a campaign in OutboundHero with <code className="text-xs">[Nurture]</code> in the name and <code className="text-xs">{clientTag}</code> in the title to wire it up. It will appear here automatically.
          </div>
        ) : (
          <div className="divide-y">
            {clientCampaigns.map((c) => (
              <a
                key={campaignKey(c)}
                href={c.uuid ? `${getInstanceBaseUrl(c.bison_instance)}/campaigns/${c.uuid}` : `${getInstanceBaseUrl(c.bison_instance)}/campaigns/${c.id}/leads`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30"
              >
                <span className={`size-1.5 rounded-full ${c.status === "active" ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
                <InstanceBadge instance={c.bison_instance} size="xs" />
                <span className="text-sm flex-1 truncate">{c.name}</span>
                {typeof c.total_leads === "number" && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {c.total_leads.toLocaleString()} leads
                  </span>
                )}
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  {c.status || ""}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-[11px] text-muted-foreground mb-2">{subtitle}</p>
      {children}
    </div>
  );
}

function Legend({ data }: { data: { name: string; value: number; color: string }[] }) {
  if (!data.length) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
      {data.map((d) => (
        <div key={d.name} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="size-2 rounded-full" style={{ backgroundColor: d.color }} />
          {d.name} <span className="text-foreground tabular-nums">{d.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
      {text}
    </div>
  );
}
