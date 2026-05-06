"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { createClient } from "@supabase/supabase-js";
import { INBOX_VIEWS } from "@/lib/inbox-views";
import { isPersonalDomain } from "@/lib/processing/domain-blacklist";

// Browser-side Supabase client for realtime (anon key)
const realtimeSupabase = createClient(
  "https://iiiupmanpycjcopcrkdh.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpaXVwbWFucHljamNvcGNya2RoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNjk1NzgsImV4cCI6MjA5MTg0NTU3OH0.psM-ngpfrDUJqRCy_r33eP664y5HfZq_W6elkMJ7D88"
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReplyDetail = Record<string, any>;

interface ReplyListItem {
  id: number; workflow: string; lead_email: string; lead_name: string; company_name: string;
  client_tag: string; ai_categorized_lead_category: string; lead_category: string;
  reply_status: string; industry_audit: string | null; location_audit: string | null;
  created_at: string; reply_id: number;
}

const LEAD_CATEGORIES = [
  "Open Response", "Interested", "Meeting Set", "Not Interested", "Do Not Contact",
  "Out Of Office", "Wrong Person", "Lost", "Meeting-Ready Lead", "Follow Up",
  "Automated Reply", "Needs Review", "Change Of Target", "Not Interested (Send Reply)",
  "Unqualified (Cleaning)", "Closed Won", "Mailbox No Longer Active", "Referral Given",
  "Internally Forwarded",
];

const POSITIVE_CATEGORIES = ["Interested", "Meeting Set", "Meeting-Ready Lead", "Follow Up", "Referral Given", "Internally Forwarded"];

const catDot: Record<string, string> = {
  "Interested": "bg-green-500", "Meeting Set": "bg-green-600", "Meeting-Ready Lead": "bg-green-600",
  "Follow Up": "bg-blue-500", "Not Interested": "bg-gray-400", "Do Not Contact": "bg-red-500",
  "Out Of Office": "bg-yellow-500", "Wrong Person": "bg-orange-500", "Change Of Target": "bg-orange-400",
  "Automated Reply": "bg-gray-400", "Mailbox No Longer Active": "bg-gray-400",
  "Open Response": "bg-purple-500", "Needs Review": "bg-purple-400",
  "Referral Given": "bg-blue-600", "Internally Forwarded": "bg-blue-600",
  "Closed Won": "bg-emerald-600", "Lost": "bg-gray-500",
};

export default function InboxPage() {
  // Category counts (loaded once, lightweight)
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);

  // Leads loaded per-category on expand
  const [categoryLeads, setCategoryLeads] = useState<Record<string, ReplyListItem[]>>({});
  const [loadingCat, setLoadingCat] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReplyDetail | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterClient, setFilterClient] = useState("");
  // Default to the curated Cherry view — that's where the team lives day-to-day.
  // Master Inbox ("all") is still selectable from the dropdown.
  const [view, setView] = useState<string>("base-clients-cherry");
  const [clientTags, setClientTags] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Reply form
  type Recipient = { name: string; email: string };
  const [replyMsg, setReplyMsg] = useState("");
  const [replyCc, setReplyCc] = useState<Recipient[]>([]);
  const [replyBcc, setReplyBcc] = useState<Recipient[]>([]);
  const [fwdTo, setFwdTo] = useState("");
  const [ooSubject, setOoSubject] = useState("");
  const [ooMsg, setOoMsg] = useState("");
  const [ooCc, setOoCc] = useState<Recipient[]>([]);
  const [reallocTag, setReallocTag] = useState("");
  const [sending, setSending] = useState<string | null>(null);

  // Load client tags for filter dropdown
  useEffect(() => {
    fetch("/api/inbox?mode=client_tags")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.tags) setClientTags(d.tags); })
      .catch(() => {});
  }, []);

  // Load category counts
  const loadCounts = useCallback(async () => {
    try {
      const p = new URLSearchParams({ mode: "counts" });
      if (search) p.set("search", search);
      if (filterClient) p.set("client_tag", filterClient);
      if (view && view !== "all") p.set("view", view);
      const res = await fetch(`/api/inbox?${p}`);
      if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
      if (res.ok) {
        const d = await res.json();
        setCounts(d.counts);
        setTotal(d.total);
        setFetchError(null);
      } else {
        setFetchError(`Failed (${res.status})`);
      }
    } catch (e) { setFetchError((e as Error).message); }
  }, [search, filterClient, view]);

  useEffect(() => { loadCounts(); }, [loadCounts]);

  // Load leads for a specific category
  async function loadCategoryLeads(cat: string) {
    setLoadingCat(cat);
    try {
      const p = new URLSearchParams({ category: cat });
      if (search) p.set("search", search);
      if (filterClient) p.set("client_tag", filterClient);
      if (view && view !== "all") p.set("view", view);
      const res = await fetch(`/api/inbox?${p}`);
      if (res.ok) {
        const d = await res.json();
        setCategoryLeads((prev) => ({ ...prev, [cat]: d.replies }));
      }
    } catch { /* */ }
    setLoadingCat(null);
  }

  // Toggle category expand/collapse
  function toggleCategory(cat: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
        // Load leads for this category if not already loaded
        if (!categoryLeads[cat]) {
          loadCategoryLeads(cat);
        }
      }
      return next;
    });
  }

  // When filters or view change, clear loaded leads and re-collapse
  useEffect(() => {
    setCategoryLeads({});
    setExpanded(new Set());
  }, [search, filterClient, view]);

  // Realtime: listen for new inserts
  useEffect(() => {
    const channel = realtimeSupabase
      .channel("inbox-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "replies" }, (payload) => {
        const newRow = payload.new as ReplyListItem;
        const cat = newRow.lead_category || "Open Response";
        // Update counts
        setCounts((prev) => ({ ...prev, [cat]: (prev[cat] || 0) + 1 }));
        setTotal((t) => t + 1);
        // If category is expanded, prepend the lead
        setCategoryLeads((prev) => {
          if (!prev[cat]) return prev;
          if (prev[cat].some((r) => r.id === newRow.id)) return prev;
          return { ...prev, [cat]: [newRow, ...prev[cat]] };
        });
      })
      .subscribe();

    return () => { realtimeSupabase.removeChannel(channel); };
  }, []);

  async function loadDetail(id: number) {
    setSelectedId(id);
    setLoading(true);
    try {
      const res = await fetch(`/api/inbox/${id}`);
      if (res.ok) {
        const d = await res.json();
        setDetail(d);
        setReplyMsg(d.our_reply || "");
        const ccs: Recipient[] = ([1, 2, 3, 4, 5, 6] as const)
          .map((n) => ({ name: d[`cc_name_${n}`] || "", email: d[`cc_email_${n}`] || "" }))
          .filter((r) => r.name || r.email);
        const bccs: Recipient[] = ([1, 2] as const)
          .map((n) => ({ name: d[`bcc_name_${n}`] || "", email: d[`bcc_email_${n}`] || "" }))
          .filter((r) => r.name || r.email);
        setReplyCc(ccs);
        setReplyBcc(bccs);
        setOoCc([]);
      }
    } catch { /* */ }
    setLoading(false);
  }

  async function mutate(body: Record<string, unknown>) {
    const res = await fetch("/api/inbox/mutate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return res.json();
  }

  function recipientsToApi(recipients: Recipient[]) {
    return recipients
      .filter((r) => r.email.trim())
      .map((r) => ({ name: r.name.trim(), email_address: r.email.trim() }));
  }

  function RecipientList({
    label, value, onChange, max, addLabel,
  }: {
    label: string; value: Recipient[]; onChange: (next: Recipient[]) => void;
    max: number; addLabel: string;
  }) {
    function update(idx: number, field: "name" | "email", v: string) {
      const next = value.slice();
      next[idx] = { ...next[idx], [field]: v };
      onChange(next);
    }
    function remove(idx: number) {
      onChange(value.filter((_, i) => i !== idx));
    }
    function add() {
      if (value.length >= max) return;
      onChange([...value, { name: "", email: "" }]);
    }
    return (
      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground">{label}</Label>
        {value.map((r, idx) => (
          <div key={idx} className="flex gap-1.5">
            <Input
              value={r.name}
              onChange={(e) => update(idx, "name", e.target.value)}
              placeholder="Name"
              className="text-[11px] h-7 flex-1"
            />
            <Input
              value={r.email}
              onChange={(e) => update(idx, "email", e.target.value)}
              placeholder="email@example.com"
              className="text-[11px] h-7 flex-[1.5]"
            />
            <button
              type="button"
              onClick={() => remove(idx)}
              className="h-7 w-7 shrink-0 rounded border border-border text-xs text-muted-foreground hover:bg-muted hover:text-destructive transition-colors"
              title="Remove"
            >×</button>
          </div>
        ))}
        {value.length < max && (
          <button
            type="button"
            onClick={add}
            className="text-[11px] text-primary hover:underline"
          >+ {addLabel}</button>
        )}
      </div>
    );
  }

  async function updateCategory(cat: string) {
    if (!detail) return;
    const oldCat = detail.lead_category || "Open Response";
    if (oldCat === cat) return;

    // ── Optimistic local-state patch — NO refetches, NO page flash ──
    // The detail panel updates instantly, the sidebar tile counts shift, and
    // the lead row moves between category buckets in place. The reply
    // composer and CC/BCC inputs are NOT touched.
    setDetail((prev) => (prev ? { ...prev, lead_category: cat } : prev));
    setCounts((prev) => {
      const next = { ...prev };
      if (oldCat) next[oldCat] = Math.max(0, (next[oldCat] || 0) - 1);
      next[cat] = (next[cat] || 0) + 1;
      return next;
    });
    setCategoryLeads((prev) => {
      const next = { ...prev };
      // Remove from old bucket if present
      if (next[oldCat]) {
        next[oldCat] = next[oldCat].filter((r) => r.id !== detail.id);
      }
      // Add to new bucket if loaded — keep top of list so user sees the move
      if (next[cat]) {
        const existing = next[cat].find((r) => r.id === detail.id);
        const moved = { ...(existing || (categoryLeads[oldCat] || []).find((r) => r.id === detail.id)), lead_category: cat } as ReplyListItem;
        if (moved && moved.id) {
          next[cat] = [moved, ...next[cat].filter((r) => r.id !== detail.id)];
        }
      }
      return next;
    });

    const d = await mutate({ action: "update-category", id: detail.id, category: cat });
    if (d.ok) {
      toast.success(`Category: ${cat}`);
      if (d.pushed_to_sheet) toast.success("Auto-pushed to Google Sheet");
      if (d.sheet_error) toast.error(`Sheet: ${d.sheet_error}`);
    } else {
      // Rollback on failure
      toast.error(d.error || "Category update failed — reverting");
      setDetail((prev) => (prev ? { ...prev, lead_category: oldCat } : prev));
      setCounts((prev) => {
        const next = { ...prev };
        next[cat] = Math.max(0, (next[cat] || 0) - 1);
        next[oldCat] = (next[oldCat] || 0) + 1;
        return next;
      });
      setCategoryLeads((prev) => {
        const next = { ...prev };
        if (next[cat]) next[cat] = next[cat].filter((r) => r.id !== detail.id);
        if (next[oldCat]) next[oldCat] = [{ ...detail, lead_category: oldCat } as unknown as ReplyListItem, ...next[oldCat]];
        return next;
      });
    }
  }

  async function handleSend() {
    if (!detail || !replyMsg) return;
    setSending("reply");
    const d = await mutate({
      action: "send-reply", id: detail.id, replyId: detail.reply_id,
      senderEmailId: detail.sender_id, message: replyMsg,
      toEmail: detail.lead_email, toName: detail.lead_name,
      ccEmails: replyCc.length ? recipientsToApi(replyCc) : undefined,
      bccEmails: replyBcc.length ? recipientsToApi(replyBcc) : undefined,
    });
    setSending(null);
    if (d.ok) { toast.success("Reply sent"); loadDetail(detail.id); } else toast.error(d.error || "Failed");
  }

  async function handleFwd() {
    if (!detail || !fwdTo) return;
    setSending("fwd");
    const d = await mutate({
      action: "forward", id: detail.id, replyId: detail.reply_id,
      senderEmailId: detail.sender_id, message: detail.reply_we_got, forwardTo: fwdTo, leadName: detail.lead_name,
    });
    setSending(null);
    if (d.ok) { toast.success("Forwarded"); setFwdTo(""); loadDetail(detail.id); } else toast.error(d.error || "Failed");
  }

  async function handleOneOff() {
    if (!detail || !ooMsg || !ooSubject) return;
    setSending("oo");
    const d = await mutate({
      action: "send-one-off", id: detail.id, senderEmailId: detail.sender_id,
      subject: ooSubject, message: ooMsg, toEmail: detail.lead_email, toName: detail.lead_name,
      ccEmails: ooCc.length ? recipientsToApi(ooCc) : undefined,
    });
    setSending(null);
    if (d.ok) { toast.success("Sent"); setOoSubject(""); setOoMsg(""); setOoCc([]); } else toast.error(d.error || "Failed");
  }

  async function handleRealloc() {
    if (!detail || !reallocTag) return;
    const tag = reallocTag.toUpperCase();
    const d = await mutate({ action: "reallocate", id: detail.id, client_tag: tag });
    if (d.ok) { toast.success(`Reallocated to ${tag}`); setReallocTag(""); loadCounts(); loadDetail(detail.id); }
    else toast.error(d.error);
  }

  async function handleBlacklist() {
    if (!detail?.lead_email) return;
    const domain = detail.lead_email.split("@")[1] || "";

    // Personal mailbox providers (gmail.com, outlook.com, …) must NEVER be
    // blacklisted — that would block every legitimate prospect on that
    // provider. Reject early with a clear error.
    if (isPersonalDomain(domain)) {
      toast.error(`Cannot blacklist ${domain} — it's a personal email provider (gmail.com, outlook.com, etc.). Use email-level blacklist instead.`);
      return;
    }

    if (!confirm(
      `Blacklist domain ${domain}?\n\nThis will block ALL future emails from any address ending @${domain} across every campaign in OutboundHero. This action is hard to reverse.`
    )) return;

    const r = await mutate({ action: "blacklist-domain", id: detail.id, email: detail.lead_email });
    if (r.ok) toast.success(`Domain ${domain} blacklisted`);
    else toast.error(r.error || "Blacklist failed");
  }

  const showRealloc = detail && (
    !detail.client_tag || detail.client_tag === "N/A" ||
    POSITIVE_CATEGORIES.includes(detail.lead_category) ||
    detail.industry_audit === "Failed" || detail.industry_audit === "Residential" || detail.location_audit === "Failed"
  );

  // Sort categories: by count descending
  // Sort: Open Response always first, then by count descending
  const sortedCategories = Object.entries(counts).sort(([catA, a], [catB, b]) => {
    if (catA === "Open Response") return -1;
    if (catB === "Open Response") return 1;
    return b - a;
  });

  // If filter by category is set, only show that category
  const displayCategories = filterCategory
    ? sortedCategories.filter(([cat]) => cat === filterCategory)
    : sortedCategories;

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* ── LEFT PANEL ── */}
      <div className="w-72 border-r flex flex-col bg-white shrink-0">
        {/* View selector — clean header style */}
        <div className="px-3 py-2.5 border-b bg-muted/20">
          <Select value={view} onValueChange={setView}>
            <SelectTrigger className="h-9 w-full text-sm font-semibold bg-white border-border hover:bg-muted/30 transition-colors">
              <SelectValue placeholder="Master Inbox" />
            </SelectTrigger>
            <SelectContent>
              {INBOX_VIEWS.map((v) => (
                <SelectItem key={v.id} value={v.id} className="text-sm font-medium py-2">
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="p-2.5 space-y-1.5 border-b">
          <Input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-7 text-xs" />
          <div className="flex gap-1">
            <Select value={filterClient || "all"} onValueChange={(v) => { setFilterClient(v === "all" ? "" : v); }}>
              <SelectTrigger className="h-6 text-[11px]"><SelectValue placeholder="All Clients" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Clients</SelectItem>
                {clientTags.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filterCategory || "all"} onValueChange={(v) => { setFilterCategory(v === "all" ? "" : v); }}>
              <SelectTrigger className="h-6 text-[11px]"><SelectValue placeholder="All Categories" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <p className="text-[10px] text-muted-foreground">{total} leads</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {displayCategories.map(([cat, count]) => (
            <div key={cat}>
              {/* Category header — always visible */}
              <button
                onClick={() => toggleCategory(cat)}
                className="w-full flex items-center justify-between px-3 py-1.5 bg-muted/30 hover:bg-muted/50 border-b text-left"
              >
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${catDot[cat] || "bg-gray-400"}`} />
                  <span className="text-[11px] font-medium">{cat}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-muted-foreground tabular-nums">{count}</span>
                  <svg className={`w-2.5 h-2.5 text-muted-foreground transition-transform ${expanded.has(cat) ? "" : "-rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </div>
              </button>

              {/* Leads list — only when expanded */}
              {expanded.has(cat) && (
                <>
                  {loadingCat === cat && !categoryLeads[cat] && (
                    <div className="px-3 py-2 text-[10px] text-muted-foreground">Loading...</div>
                  )}
                  {categoryLeads[cat]?.map((r) => (
                    <button key={r.id} onClick={() => loadDetail(r.id)}
                      className={`w-full text-left px-3 py-2 border-b border-muted/30 transition-colors ${selectedId === r.id ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/10 border-l-2 border-l-transparent"}`}>
                      <p className="text-xs font-medium truncate">{r.lead_email}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-[10px] text-muted-foreground truncate">{r.ai_categorized_lead_category || "—"}</span>
                        <span className="text-[10px] font-mono font-bold text-primary/60">{r.client_tag || "N/A"}</span>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          ))}

          {displayCategories.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">No leads found</div>
          )}
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 overflow-y-auto bg-[#fafafa]">
        {fetchError && <div className="m-4 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{fetchError}</div>}
        {!detail && !loading && <div className="flex items-center justify-center h-full"><p className="text-sm text-muted-foreground">Select a lead</p></div>}
        {loading && <div className="flex items-center justify-center h-full"><p className="text-sm text-muted-foreground">Loading...</p></div>}

        {detail && !loading && (
          <div className="p-5 max-w-2xl mx-auto space-y-3 pb-16">
            {/* Header */}
            <div className="flex items-start justify-between pb-2 border-b">
              <div>
                <h2 className="text-base font-semibold">{detail.from_name || detail.lead_name || detail.lead_email}</h2>
                <p className="text-xs text-muted-foreground">{detail.lead_email}</p>
              </div>
              <div className="flex gap-1.5 items-center">
                {detail.sheet_url && (
                  <a
                    href={detail.sheet_url as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-medium bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 px-2 py-0.5 rounded inline-flex items-center gap-1 transition-colors"
                    title="Open client's Google Sheet"
                  >
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M19.5 3h-15A1.5 1.5 0 003 4.5v15A1.5 1.5 0 004.5 21h15a1.5 1.5 0 001.5-1.5v-15A1.5 1.5 0 0019.5 3zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-8v-2h8v2zm0-4h-8v-2h8v2zm0-4h-8V7h8v2z"/></svg>
                    Sheet
                  </a>
                )}
                <span className="text-[11px] font-mono font-bold bg-primary/10 text-primary px-2 py-0.5 rounded">{detail.client_tag || "N/A"}</span>
                <span className="text-[11px] bg-muted px-2 py-0.5 rounded">{detail.workflow}</span>
              </div>
            </div>

            {/* Lead Details - compact */}
            <div className="rounded border bg-white px-4 py-3">
              <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-xs">
                {[
                  { l: "Company", v: detail.company_name },
                  { l: "Phone", v: detail.phone },
                  { l: "Location", v: [detail.city, detail.state].filter(Boolean).join(", ") },
                  { l: "Address", v: detail.address },
                  { l: "Campaign", v: detail.campaign_name },
                  { l: "Sender", v: detail.sender_email },
                  { l: "LinkedIn", v: detail.linkedin_url },
                  { l: "Google Maps", v: detail.google_maps_url ? "View" : null },
                  { l: "Lead ID", v: detail.lead_id },
                ].filter((f) => f.v).map((f) => (
                  <div key={f.l}>
                    <span className="text-muted-foreground">{f.l}: </span>
                    {f.l === "Google Maps" && detail.google_maps_url ? (
                      <a href={detail.google_maps_url as string} target="_blank" rel="noopener noreferrer" className="text-primary underline">View</a>
                    ) : (
                      <span className="break-all">{String(f.v)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Reply */}
            <div className="rounded border bg-white overflow-hidden">
              <div className="px-4 py-2 border-b bg-muted/20 flex justify-between items-center">
                <p className="text-xs text-muted-foreground truncate flex-1">{detail.email_subject}</p>
                <span className="text-[10px] text-muted-foreground ml-2 shrink-0">{detail.reply_time && new Date(detail.reply_time).toLocaleString()}</span>
              </div>
              <div className="px-4 py-3 text-[13px] whitespace-pre-wrap leading-relaxed max-h-52 overflow-y-auto">{detail.reply_we_got || "No content"}</div>
            </div>

            {/* Audit */}
            {(detail.industry_audit || detail.location_audit) && (
              <div className="rounded border bg-white px-4 py-3 space-y-1.5">
                <div className="flex gap-4 items-center">
                  {detail.industry_audit && (
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${detail.industry_audit === "Passed" ? "bg-green-50 text-green-700" : detail.industry_audit === "Residential" ? "bg-yellow-50 text-yellow-700" : "bg-red-50 text-red-700"}`}>Industry: {detail.industry_audit}</span>
                  )}
                  {detail.location_audit && (
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${detail.location_audit === "Passed" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>Location: {detail.location_audit}</span>
                  )}
                </div>
                {detail.qualification_reason && <p className="text-[11px] text-muted-foreground">{detail.qualification_reason}</p>}
                {detail.suggested_client && <p className="text-[11px]"><span className="text-muted-foreground">Suggested: </span>{detail.suggested_client}</p>}
              </div>
            )}

            {/* Category */}
            <div className="flex items-center gap-3 rounded border bg-white px-4 py-3">
              <span className="text-xs text-muted-foreground shrink-0">Category</span>
              <Select value={detail.lead_category || "Open Response"} onValueChange={updateCategory}>
                <SelectTrigger className="w-52 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
              {detail.pushed_to_sheet && <span className="text-[10px] text-green-600">Pushed to sheet</span>}
            </div>

            {/* Reallocate */}
            {showRealloc && (
              <div className="rounded border bg-white px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">Reallocate</span>
                  <Input value={reallocTag} onChange={(e) => setReallocTag(e.target.value)} placeholder="New client tag" className="w-32 h-8 text-xs font-mono" />
                  <Button size="sm" className="h-8 text-xs" onClick={handleRealloc} disabled={!reallocTag}>Assign</Button>
                  <span className="text-[10px] text-muted-foreground">Updates CC/BCC/template</span>
                </div>
              </div>
            )}

            {/* ── Send Reply (with CC/BCC pre-populated) ── */}
            <div className="rounded border bg-white px-4 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Send Reply</p>
                <span className="text-[10px] text-muted-foreground">To: {detail.lead_email}</span>
              </div>
              <Textarea value={replyMsg} onChange={(e) => setReplyMsg(e.target.value)} rows={4} placeholder="Type reply..." className="text-sm" />
              <div className="grid grid-cols-2 gap-3">
                <RecipientList label="CC Recipients" value={replyCc} onChange={setReplyCc} max={6} addLabel="Add CC" />
                <RecipientList label="BCC Recipients" value={replyBcc} onChange={setReplyBcc} max={2} addLabel="Add BCC" />
              </div>
              <Button size="sm" className="h-8 text-xs" onClick={handleSend} disabled={sending === "reply" || !replyMsg}>{sending === "reply" ? "Sending..." : "Send Reply"}</Button>
            </div>

            {/* ── Forward ── */}
            <div className="rounded border bg-white px-4 py-3 flex items-end gap-2">
              <div className="flex-1"><Label className="text-[10px] text-muted-foreground">Forward to</Label><Input value={fwdTo} onChange={(e) => setFwdTo(e.target.value)} placeholder="email@example.com" className="text-xs h-8" /></div>
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleFwd} disabled={sending === "fwd" || !fwdTo}>{sending === "fwd" ? "..." : "Forward"}</Button>
            </div>

            {/* ── One-Off ── */}
            <div className="rounded border bg-white px-4 py-3 space-y-2">
              <p className="text-xs font-medium">One-Off Reply <span className="text-muted-foreground font-normal">to {detail.lead_email}</span></p>
              <Input value={ooSubject} onChange={(e) => setOoSubject(e.target.value)} placeholder="Subject" className="text-xs h-8" />
              <Textarea value={ooMsg} onChange={(e) => setOoMsg(e.target.value)} rows={3} placeholder="Message" className="text-sm" />
              <RecipientList label="CC Recipients" value={ooCc} onChange={setOoCc} max={6} addLabel="Add CC" />
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleOneOff} disabled={sending === "oo" || !ooMsg || !ooSubject}>{sending === "oo" ? "..." : "Send"}</Button>
            </div>

            {/* Notes */}
            <div className="rounded border bg-white px-4 py-3">
              <Textarea
                value={detail.notes || ""} onChange={(e) => setDetail({ ...detail, notes: e.target.value })}
                onBlur={() => mutate({ action: "update-notes", id: detail.id, notes: detail.notes || "" })}
                placeholder="Notes..." rows={2} className="text-xs resize-none border-0 p-0 focus-visible:ring-0 shadow-none"
              />
            </div>

            {/* Blacklist */}
            <button onClick={handleBlacklist} className="w-full text-left rounded border border-red-200 bg-white px-4 py-2.5 hover:bg-red-50 transition-colors">
              <span className="text-xs text-red-600 font-medium">Blacklist Domain</span>
              <span className="text-[10px] text-muted-foreground ml-2">{detail.lead_email?.split("@")[1]}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
