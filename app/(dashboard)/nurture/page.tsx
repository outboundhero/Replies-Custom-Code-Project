"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Source = "soft_negative" | "out_of_office" | "sequence_finished";
type Status = "waiting" | "eligible" | "added" | "skipped" | "all";
type Safety = "safe" | "unsafe" | "unknown" | "unclassified" | "all";

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
  total_leads?: number;
}

const SOURCE_LABEL: Record<Source, string> = {
  soft_negative: "Soft Negative",
  out_of_office: "Out of Office",
  sequence_finished: "Sequence Finished",
};

const SOURCE_COLOR: Record<Source, string> = {
  soft_negative: "bg-blue-100 text-blue-700 border-blue-200",
  out_of_office: "bg-yellow-100 text-yellow-700 border-yellow-200",
  sequence_finished: "bg-purple-100 text-purple-700 border-purple-200",
};

export default function NurturePage() {
  const [items, setItems] = useState<NurtureItem[]>([]);
  const [campaigns, setCampaigns] = useState<NurtureCampaign[]>([]);
  const [counts, setCounts] = useState<{
    total: number;
    bySource: Record<string, number>;
    byStatus: Record<string, number>;
    bySafety: Record<string, number>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Filters
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [clientFilter, setClientFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<Status>("all");
  const [safetyFilter, setSafetyFilter] = useState<Safety>("all");

  // Selection (for bulk push)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pushTargetCampaignId, setPushTargetCampaignId] = useState<string>("");
  const [pushing, setPushing] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (sourceFilter !== "all") p.set("source", sourceFilter);
      if (clientFilter) p.set("client_tag", clientFilter);
      if (statusFilter !== "all") p.set("status", statusFilter);
      if (safetyFilter !== "all") p.set("safety", safetyFilter);

      const res = await fetch(`/api/nurture?${p}`);
      if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFetchError(data.error || `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setItems(data.items || []);
      setCounts(data.counts || null);
      setFetchError(null);
      setSelected(new Set());
    } catch (e) {
      setFetchError((e as Error).message);
    }
    setLoading(false);
  }, [sourceFilter, clientFilter, statusFilter, safetyFilter]);

  useEffect(() => { load(); }, [load]);

  // Load nurture campaigns
  useEffect(() => {
    fetch("/api/nurture/campaigns")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.campaigns) setCampaigns(d.campaigns); })
      .catch(() => {});
  }, []);

  // Distinct client tags from items, for filter dropdown
  const clientTags = Array.from(new Set(items.map((i) => i.client_tag).filter(Boolean))).sort() as string[];

  // Campaigns matching the selected client filter
  const campaignsForClient = clientFilter
    ? campaigns.filter((c) => c.client_tag === clientFilter)
    : campaigns;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const selectable = items.filter((i) => isPushable(i));
    if (selected.size === selectable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((i) => i.id)));
    }
  }

  function isPushable(it: NurtureItem): boolean {
    if (!it.is_eligible) return false;
    if (it.added_at) return false;
    if (it.skipped) return false;
    if (it.source !== "sequence_finished" && it.nurture_safety !== "safe") return false;
    return true;
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
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setClassifying(false);
  }

  async function syncSequenceFinished() {
    setSyncing(true);
    try {
      const res = await fetch("/api/nurture/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Synced ${data.upserted} leads from ${data.campaignsScanned} campaigns`);
        if (data.errors?.length) toast.error(`${data.errors.length} errors — see console`);
        if (data.errors?.length) console.warn("Sync errors:", data.errors);
      } else {
        toast.error(data.error || "Sync failed");
      }
      load();
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
        if (data.failures?.length) toast.error(`${data.failures.length} skipped — see console`);
        if (data.failures?.length) console.warn("Push failures:", data.failures);
      } else {
        toast.error(data.error || "Push failed");
        if (data.failures?.length) console.warn("Push failures:", data.failures);
      }
      load();
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
    if (res.ok) { toast.success(`Skipped ${data.updated} leads`); load(); }
    else toast.error(data.error);
  }

  const selectableCount = items.filter(isPushable).length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Nurture</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Re-engage leads after a 45-day cooldown — strict exclusion for wrong-person, remote, or do-not-contact replies.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={syncSequenceFinished} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync Sequence-Finished"}
          </Button>
          <Button size="sm" variant="outline" onClick={classifyAllUnclassified} disabled={classifying}>
            {classifying ? "Classifying…" : "Classify Unclassified"}
          </Button>
        </div>
      </div>

      {/* Top counters */}
      {counts && (
        <div className="grid grid-cols-4 gap-3">
          <CountCard label="Total candidates" value={counts.total} />
          <CountCard label="Eligible now" value={counts.byStatus.eligible} accent="text-green-700" />
          <CountCard label="Waiting (45-day)" value={counts.byStatus.waiting} accent="text-amber-700" />
          <CountCard label="Already added" value={counts.byStatus.added} accent="text-blue-700" />
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="py-3 flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Source</Label>
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger className="h-8 text-xs w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sources</SelectItem>
                <SelectItem value="soft_negative">Soft Negative</SelectItem>
                <SelectItem value="out_of_office">Out of Office</SelectItem>
                <SelectItem value="sequence_finished">Sequence Finished</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Client</Label>
            <Select value={clientFilter || "all"} onValueChange={(v) => setClientFilter(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 text-xs w-40"><SelectValue placeholder="All clients" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Clients</SelectItem>
                {clientTags.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Status</Label>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as Status)}>
              <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="eligible">Eligible Now</SelectItem>
                <SelectItem value="waiting">Waiting</SelectItem>
                <SelectItem value="added">Added</SelectItem>
                <SelectItem value="skipped">Skipped</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Safety</Label>
            <Select value={safetyFilter} onValueChange={(v) => setSafetyFilter(v as Safety)}>
              <SelectTrigger className="h-8 text-xs w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="safe">Safe</SelectItem>
                <SelectItem value="unsafe">Unsafe</SelectItem>
                <SelectItem value="unknown">Unknown</SelectItem>
                <SelectItem value="unclassified">Unclassified</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" variant="ghost" onClick={load} disabled={loading} className="h-8 text-xs ml-auto">
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </CardContent>
      </Card>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="py-3 flex items-center gap-3">
            <p className="text-sm font-medium">{selected.size} selected</p>
            <Select value={pushTargetCampaignId} onValueChange={setPushTargetCampaignId}>
              <SelectTrigger className="h-8 text-xs w-72"><SelectValue placeholder="Choose nurture campaign…" /></SelectTrigger>
              <SelectContent>
                {campaignsForClient.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">No matching nurture campaigns</div>}
                {campaignsForClient.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={pushSelected} disabled={pushing || !pushTargetCampaignId} className="h-8 text-xs">
              {pushing ? "Pushing…" : "Add to Nurture"}
            </Button>
            <Button size="sm" variant="outline" onClick={skipSelected} className="h-8 text-xs">
              Skip
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} className="h-8 text-xs ml-auto">
              Clear
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Lead table */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{items.length} candidates</CardTitle>
            {selectableCount > 0 && (
              <button
                onClick={toggleSelectAll}
                className="text-xs text-primary hover:underline"
              >
                {selected.size === selectableCount ? "Deselect all" : `Select all eligible & safe (${selectableCount})`}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {fetchError && (
            <div className="mx-4 mb-3 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{fetchError}</div>
          )}
          {!loading && items.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No nurture candidates match these filters.</p>
          )}
          <div className="divide-y">
            {items.map((it) => {
              const pushable = isPushable(it);
              const isSelected = selected.has(it.id);
              return (
                <div key={it.id} className={`px-4 py-3 flex gap-3 items-start ${isSelected ? "bg-primary/5" : ""}`}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(it.id)}
                    disabled={!pushable}
                    className="mt-1.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{it.email}</span>
                      {it.first_name && <span className="text-xs text-muted-foreground">{it.first_name} {it.last_name}</span>}
                      {it.company && <span className="text-xs text-muted-foreground">· {it.company}</span>}
                      {it.client_tag && <Badge variant="outline" className="text-[10px] font-mono">{it.client_tag}</Badge>}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${SOURCE_COLOR[it.source]}`}>{SOURCE_LABEL[it.source]}</span>
                      {it.ai_category && <Badge variant="secondary" className="text-[10px]">{it.ai_category}</Badge>}
                    </div>
                    {it.reply_text && (
                      <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{it.reply_text}</p>
                    )}
                    {it.campaign_name && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">From: {it.campaign_name}</p>
                    )}
                    {it.nurture_safety_reason && (
                      <p className="text-[11px] text-muted-foreground mt-0.5 italic">Safety: {it.nurture_safety_reason}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0 text-right">
                    <SafetyBadge safety={it.nurture_safety} source={it.source} />
                    <EligibilityBadge it={it} />
                    {it.added_at && (
                      <span className="text-[10px] text-blue-700">Added {new Date(it.added_at).toLocaleDateString()}</span>
                    )}
                    {it.skipped && (
                      <span className="text-[10px] text-muted-foreground">Skipped</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CountCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className={`text-2xl font-semibold tabular-nums ${accent || ""}`}>{value.toLocaleString()}</p>
      </CardContent>
    </Card>
  );
}

function SafetyBadge({ safety, source }: { safety: string | null | undefined; source: Source }) {
  if (source === "sequence_finished") {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">No reply / no bounce</span>;
  }
  if (!safety) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 text-gray-600 border border-gray-200">Unclassified</span>;
  if (safety === "safe") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200">Safe</span>;
  if (safety === "unsafe") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">Unsafe</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">Unknown</span>;
}

function EligibilityBadge({ it }: { it: NurtureItem }) {
  if (it.is_eligible) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200">Eligible now</span>;
  }
  return <span className="text-[10px] text-muted-foreground">In {Math.abs(it.days_until_eligible)}d</span>;
}
