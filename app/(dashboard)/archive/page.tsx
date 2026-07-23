"use client";

/**
 * Archived Database (ReplyRouter spec §2) — search archived replies by client
 * tag / name / email / lead category / AI category / date / reply content;
 * view, edit the category or notes, and restore to Open Response (which returns
 * the reply to the active inbox). Kept separate from the active inbox so it
 * never touches the hot path.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableCombobox } from "@/components/ui/searchable-combobox";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InstanceBadge } from "@/components/instance-badge";
import { useDebouncedValue } from "@/lib/use-debounced-value";

const LEAD_CATEGORIES = [
  "Open Response", "Interested", "Meeting Request", "Meeting Set", "Automated Reply",
  "Change Of Target", "Closed Won", "Do Not Contact", "Follow Up", "Internally Forwarded",
  "Lost", "Mailbox No Longer Active", "Meeting-Ready Lead", "Needs Review", "Not Interested",
  "Not Interested (Send Reply)", "Out Of Office", "Referral Given",
  "Request for Primary Point of Contact (Send Reply)", "Unqualified (Cleaning)", "Wrong Person",
];
const AI_CATEGORIES = [
  "Interested", "Meeting Request", "Follow Up at a Later Date", "Not Interested", "Out Of Office",
  "Wrong Person", "Mailbox No Longer Active", "Automated Error Message", "Automated Catch-All Message",
  "Wrong Person (Change of Target)", "Do Not Contact", "Referral Given", "Internally Forwarded",
  "Unrecognizable by AI",
];

interface Row {
  id: number; workflow: string; lead_email: string; lead_name: string; company_name: string;
  client_tag: string; bison_instance: string | null; ai_categorized_lead_category: string;
  lead_category: string; created_at: string; archived_at: string | null; reply_id: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Detail = Record<string, any>;

export default function ArchivePage() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [clientTag, setClientTag] = useState("");
  const [leadCategory, setLeadCategory] = useState("");
  const [aiCategory, setAiCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [clientTags, setClientTags] = useState<string[]>([]);

  const [rows, setRows] = useState<Row[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    fetch("/api/inbox?mode=client_tags").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.tags) setClientTags(d.tags); }).catch(() => {});
  }, []);

  const load = useCallback(async (append: boolean, off: number) => {
    const mine = ++reqId.current;
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (clientTag) p.set("client_tag", clientTag);
      if (leadCategory) p.set("lead_category", leadCategory);
      if (aiCategory) p.set("ai_category", aiCategory);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      p.set("offset", String(off));
      const res = await fetch(`/api/archive?${p}`);
      const d = await res.json();
      if (mine !== reqId.current) return;
      if (!res.ok) throw new Error(d?.error || `Failed (${res.status})`);
      setRows((prev) => (append ? [...prev, ...(d.rows || [])] : d.rows || []));
      setOffset(off + (d.rows?.length || 0));
      setHasMore(!!d.page?.hasMore);
    } catch (e) {
      if (mine === reqId.current) setError((e as Error).message);
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, [debouncedSearch, clientTag, leadCategory, aiCategory, from, to]);

  useEffect(() => { load(false, 0); }, [load]);

  async function openDetail(id: number) {
    setSelectedId(id); setLoadingDetail(true);
    try {
      const res = await fetch(`/api/inbox/${id}`);
      if (res.ok) setDetail(await res.json());
    } catch { /* */ }
    setLoadingDetail(false);
  }

  async function mutate(body: Record<string, unknown>) {
    const res = await fetch("/api/inbox/mutate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.json();
  }

  async function restore() {
    if (!detail) return;
    setRestoring(true);
    const d = await mutate({ action: "restore", id: detail.id });
    setRestoring(false);
    if (d.ok) {
      toast.success("Restored to Open Response — back in the active inbox");
      setRows((prev) => prev.filter((r) => r.id !== detail.id));
      setDetail(null); setSelectedId(null);
    } else toast.error(d.error || "Restore failed");
  }

  async function changeCategory(cat: string) {
    if (!detail || cat === detail.lead_category) return;
    setDetail({ ...detail, lead_category: cat });
    const d = await mutate({ action: "update-category", id: detail.id, category: cat });
    if (d.ok) toast.success(`Category: ${cat}`);
    else toast.error(d.error || "Update failed");
  }

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* Left: filters + results */}
      <div className="w-96 border-r flex flex-col bg-white shrink-0">
        <div className="p-3 border-b space-y-2">
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Archived Database</h1>
            <p className="text-[11px] text-muted-foreground">Search every archived reply — restore any to Open Response.</p>
          </div>
          <Input placeholder="Search name, email, company, or reply content…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 text-xs" />
          <div className="grid grid-cols-2 gap-1.5">
            <Select value={clientTag || "all"} onValueChange={(v) => setClientTag(v === "all" ? "" : v)}>
              <SelectTrigger className="h-7 text-[11px]"><SelectValue placeholder="All Clients" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Clients</SelectItem>
                {clientTags.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <SearchableCombobox value={leadCategory} onValueChange={(v) => setLeadCategory(v === "All Categories" ? "" : v)} options={["All Categories", ...LEAD_CATEGORIES]} placeholder="Lead Category" searchPlaceholder="Search…" triggerClassName="h-7 text-[11px] py-0" />
            <SearchableCombobox value={aiCategory} onValueChange={(v) => setAiCategory(v === "All AI Categories" ? "" : v)} options={["All AI Categories", ...AI_CATEGORIES]} placeholder="AI Category" searchPlaceholder="Search…" triggerClassName="h-7 text-[11px] py-0" />
            <div className="flex gap-1">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-7 text-[10px] px-1.5" title="From date" />
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-7 text-[10px] px-1.5" title="To date" />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && rows.length === 0 ? (
            <div className="p-3 space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}</div>
          ) : error ? (
            <div className="p-4 text-xs text-destructive text-center">{error}</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-xs text-muted-foreground text-center">No archived replies match.</div>
          ) : (
            <>
              {rows.map((r) => (
                <button key={r.id} onClick={() => openDetail(r.id)}
                  className={`w-full text-left px-3 py-2 border-b transition-colors ${selectedId === r.id ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/20 border-l-2 border-l-transparent"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium truncate">{r.lead_email}</p>
                    <span className="text-[9px] text-muted-foreground shrink-0">{r.archived_at ? new Date(r.archived_at).toLocaleDateString() : ""}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] font-mono font-bold text-primary/60">{r.client_tag || "N/A"}</span>
                    <span className="text-[10px] text-muted-foreground truncate">{r.lead_category}</span>
                    <InstanceBadge instance={r.bison_instance} size="xs" />
                  </div>
                </button>
              ))}
              {hasMore && (
                <button onClick={() => load(true, offset)} disabled={loading} className="w-full px-3 py-2 text-[11px] font-medium text-primary hover:bg-primary/5 disabled:opacity-50">
                  {loading ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: detail + restore */}
      <div className="flex-1 overflow-y-auto bg-[#fafafa]">
        {!detail && !loadingDetail && <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select an archived reply</div>}
        {loadingDetail && <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>}
        {detail && !loadingDetail && (
          <div className="p-5 max-w-2xl mx-auto space-y-3 pb-16">
            <div className="flex items-start justify-between pb-2 border-b">
              <div>
                <h2 className="text-base font-semibold">{detail.from_name || detail.lead_name || detail.lead_email}</h2>
                <p className="text-xs text-muted-foreground">{detail.lead_email}</p>
              </div>
              <div className="flex gap-1.5 items-center">
                <span className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-600">Archived{detail.archived_at ? ` ${new Date(detail.archived_at).toLocaleDateString()}` : ""}</span>
                <span className="text-[11px] font-mono font-bold bg-primary/10 text-primary px-2 py-0.5 rounded">{detail.client_tag || "N/A"}</span>
                <InstanceBadge instance={detail.bison_instance} />
              </div>
            </div>

            <div className="rounded border bg-white px-4 py-2.5 space-y-1 text-xs">
              <div className="flex gap-2"><span className="w-9 shrink-0 text-muted-foreground font-medium">From</span><span className="flex-1 break-all">{detail.from_name} {detail.from_email ? `<${detail.from_email}>` : ""}</span></div>
              {detail.to_email && <div className="flex gap-2"><span className="w-9 shrink-0 text-muted-foreground font-medium">To</span><span className="flex-1 break-all">{detail.to_email}</span></div>}
              {detail.prospect_cc_email && <div className="flex gap-2"><span className="w-9 shrink-0 text-muted-foreground font-medium">CC</span><span className="flex-1 break-all">{detail.prospect_cc_email}</span></div>}
            </div>

            <div className="rounded border bg-white overflow-hidden">
              <div className="px-4 py-2 border-b bg-muted/20 flex justify-between items-center">
                <p className="text-xs text-muted-foreground truncate flex-1">{detail.email_subject}</p>
                <span className="text-[10px] text-muted-foreground ml-2 shrink-0">{detail.reply_time && new Date(detail.reply_time).toLocaleString()}</span>
              </div>
              <div className="px-4 py-3 text-[13px] whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">{detail.reply_we_got || "No content"}</div>
            </div>

            <div className="flex items-center gap-3 rounded border bg-white px-4 py-3">
              <span className="text-xs text-muted-foreground shrink-0">Category</span>
              <SearchableCombobox value={detail.lead_category || "Open Response"} onValueChange={changeCategory} options={LEAD_CATEGORIES} placeholder="Category" searchPlaceholder="Search…" triggerClassName="w-56 h-8 text-xs" />
            </div>

            <div className="rounded border bg-white px-4 py-3">
              <Textarea value={detail.notes || ""} onChange={(e) => setDetail({ ...detail, notes: e.target.value })} onBlur={() => mutate({ action: "update-notes", id: detail.id, notes: detail.notes || "" })} placeholder="Notes…" rows={2} className="text-xs resize-none border-0 p-0 focus-visible:ring-0 shadow-none" />
            </div>

            <Button onClick={restore} disabled={restoring} className="h-9 text-sm">
              {restoring ? "Restoring…" : "↩ Restore to Open Response"}
            </Button>
            <p className="text-[11px] text-muted-foreground">Restoring returns this reply to the active inbox in Open Response and restarts its speed-to-lead clock.</p>
          </div>
        )}
      </div>
    </div>
  );
}
