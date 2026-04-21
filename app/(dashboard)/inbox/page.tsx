"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { createClient } from "@supabase/supabase-js";

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
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [categoryLeads, setCategoryLeads] = useState<Record<string, ReplyListItem[]>>({});
  const [loadingCat, setLoadingCat] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReplyDetail | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterClient, setFilterClient] = useState("");
  const [clientTags, setClientTags] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Reply form
  const [replyMsg, setReplyMsg] = useState("");
  const [replyCc, setReplyCc] = useState("");
  const [replyBcc, setReplyBcc] = useState("");
  const [fwdTo, setFwdTo] = useState("");
  const [ooSubject, setOoSubject] = useState("");
  const [ooMsg, setOoMsg] = useState("");
  const [ooCc, setOoCc] = useState("");
  const [reallocTag, setReallocTag] = useState("");
  const [sending, setSending] = useState<string | null>(null);

  // Collapsible action sections
  const [openSection, setOpenSection] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/inbox?mode=client_tags")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.tags) setClientTags(d.tags); })
      .catch(() => {});
  }, []);

  const loadCounts = useCallback(async () => {
    try {
      const p = new URLSearchParams({ mode: "counts" });
      if (search) p.set("search", search);
      if (filterClient) p.set("client_tag", filterClient);
      const res = await fetch(`/api/inbox?${p}`);
      if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
      if (res.ok) { const d = await res.json(); setCounts(d.counts); setTotal(d.total); setFetchError(null); }
      else setFetchError(`Failed (${res.status})`);
    } catch (e) { setFetchError((e as Error).message); }
  }, [search, filterClient]);

  useEffect(() => { loadCounts(); }, [loadCounts]);

  async function loadCategoryLeads(cat: string) {
    setLoadingCat(cat);
    try {
      const p = new URLSearchParams({ category: cat });
      if (search) p.set("search", search);
      if (filterClient) p.set("client_tag", filterClient);
      const res = await fetch(`/api/inbox?${p}`);
      if (res.ok) { const d = await res.json(); setCategoryLeads((prev) => ({ ...prev, [cat]: d.replies })); }
    } catch { /* */ }
    setLoadingCat(null);
  }

  function toggleCategory(cat: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) { next.delete(cat); } else { next.add(cat); if (!categoryLeads[cat]) loadCategoryLeads(cat); }
      return next;
    });
  }

  useEffect(() => { setCategoryLeads({}); setExpanded(new Set()); }, [search, filterClient]);

  useEffect(() => {
    const channel = realtimeSupabase.channel("inbox-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "replies" }, (payload) => {
        const newRow = payload.new as ReplyListItem;
        const cat = newRow.lead_category || "Open Response";
        setCounts((prev) => ({ ...prev, [cat]: (prev[cat] || 0) + 1 }));
        setTotal((t) => t + 1);
        setCategoryLeads((prev) => {
          if (!prev[cat]) return prev;
          if (prev[cat].some((r) => r.id === newRow.id)) return prev;
          return { ...prev, [cat]: [newRow, ...prev[cat]] };
        });
      }).subscribe();
    return () => { realtimeSupabase.removeChannel(channel); };
  }, []);

  async function loadDetail(id: number) {
    setSelectedId(id);
    setLoading(true);
    setOpenSection(null);
    try {
      const res = await fetch(`/api/inbox/${id}`);
      if (res.ok) {
        const d = await res.json();
        setDetail(d);
        setReplyMsg(d.our_reply || "");
        setReplyCc([d.cc_email_1, d.cc_email_2, d.cc_email_3, d.cc_email_4, d.cc_email_5, d.cc_email_6].filter(Boolean).join(", "));
        setReplyBcc([d.bcc_email_1, d.bcc_email_2].filter(Boolean).join(", "));
      }
    } catch { /* */ }
    setLoading(false);
  }

  async function mutate(body: Record<string, unknown>) {
    const res = await fetch("/api/inbox/mutate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.json();
  }

  function parseCcList(raw: string) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((e) => ({ name: "", email_address: e }));
  }

  async function updateCategory(cat: string) {
    if (!detail) return;
    const d = await mutate({ action: "update-category", id: detail.id, category: cat });
    if (d.ok) {
      toast.success(`Category: ${cat}`);
      if (d.pushed_to_sheet) toast.success("Auto-pushed to Google Sheet");
      if (d.sheet_error) toast.error(`Sheet: ${d.sheet_error}`);
      loadCounts();
      const oldCat = detail.lead_category || "Open Response";
      if (categoryLeads[oldCat]) loadCategoryLeads(oldCat);
      if (categoryLeads[cat]) loadCategoryLeads(cat);
      loadDetail(detail.id);
    } else toast.error(d.error);
  }

  async function handleSend() {
    if (!detail || !replyMsg) return;
    setSending("reply");
    const d = await mutate({ action: "send-reply", id: detail.id, replyId: detail.reply_id, senderEmailId: detail.sender_id, message: replyMsg, toEmail: detail.lead_email, toName: detail.lead_name, ccEmails: replyCc ? parseCcList(replyCc) : undefined, bccEmails: replyBcc ? parseCcList(replyBcc) : undefined });
    setSending(null);
    if (d.ok) { toast.success("Reply sent"); loadDetail(detail.id); } else toast.error(d.error || "Failed");
  }

  async function handleFwd() {
    if (!detail || !fwdTo) return;
    setSending("fwd");
    const d = await mutate({ action: "forward", id: detail.id, replyId: detail.reply_id, senderEmailId: detail.sender_id, message: detail.reply_we_got, forwardTo: fwdTo, leadName: detail.lead_name });
    setSending(null);
    if (d.ok) { toast.success("Forwarded"); setFwdTo(""); loadDetail(detail.id); } else toast.error(d.error || "Failed");
  }

  async function handleOneOff() {
    if (!detail || !ooMsg || !ooSubject) return;
    setSending("oo");
    const d = await mutate({ action: "send-one-off", id: detail.id, senderEmailId: detail.sender_id, subject: ooSubject, message: ooMsg, toEmail: detail.lead_email, toName: detail.lead_name, ccEmails: ooCc ? parseCcList(ooCc) : undefined });
    setSending(null);
    if (d.ok) { toast.success("Sent"); setOoSubject(""); setOoMsg(""); setOoCc(""); } else toast.error(d.error || "Failed");
  }

  async function handleRealloc() {
    if (!detail || !reallocTag) return;
    const tag = reallocTag.toUpperCase();
    const d = await mutate({ action: "reallocate", id: detail.id, client_tag: tag });
    if (d.ok) { toast.success(`Reallocated to ${tag}`); setReallocTag(""); loadCounts(); loadDetail(detail.id); }
    else toast.error(d.error);
  }

  async function handleBlacklist() {
    if (!detail || !confirm(`Blacklist domain ${detail.lead_email?.split("@")[1]}?`)) return;
    await mutate({ action: "blacklist-domain", id: detail.id, email: detail.lead_email });
    toast.success("Domain blacklisted");
  }

  const showRealloc = detail && (
    !detail.client_tag || detail.client_tag === "N/A" ||
    POSITIVE_CATEGORIES.includes(detail.lead_category) ||
    detail.industry_audit === "Failed" || detail.industry_audit === "Residential" || detail.location_audit === "Failed"
  );

  const sortedCategories = Object.entries(counts).sort(([catA,], [catB, b]) => {
    if (catA === "Open Response") return -1;
    if (catB === "Open Response") return 1;
    const a = counts[catA]; return b - a;
  });

  const displayCategories = filterCategory
    ? sortedCategories.filter(([cat]) => cat === filterCategory)
    : sortedCategories;

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* ── LEFT PANEL ── */}
      <div className="w-80 border-r flex flex-col bg-white shrink-0">
        <div className="p-3 space-y-2 border-b">
          <Input placeholder="Search leads..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 text-xs" />
          <div className="flex gap-1.5">
            <Select value={filterClient || "all"} onValueChange={(v) => setFilterClient(v === "all" ? "" : v)}>
              <SelectTrigger className="h-7 text-[11px] flex-1"><SelectValue placeholder="All Clients" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All Clients</SelectItem>{clientTags.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={filterCategory || "all"} onValueChange={(v) => setFilterCategory(v === "all" ? "" : v)}>
              <SelectTrigger className="h-7 text-[11px] flex-1"><SelectValue placeholder="All Categories" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All Categories</SelectItem>{LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <p className="text-[11px] text-muted-foreground font-medium">{total.toLocaleString()} leads</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {displayCategories.map(([cat, count]) => (
            <div key={cat}>
              <button onClick={() => toggleCategory(cat)}
                className="w-full flex items-center justify-between px-3 py-2 bg-muted/20 hover:bg-muted/40 border-b text-left transition-colors">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${catDot[cat] || "bg-gray-400"}`} />
                  <span className="text-xs font-medium">{cat}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground tabular-nums font-medium">{count}</span>
                  <svg className={`w-3 h-3 text-muted-foreground transition-transform ${expanded.has(cat) ? "" : "-rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </div>
              </button>
              {expanded.has(cat) && (
                <>
                  {loadingCat === cat && !categoryLeads[cat] && (
                    <div className="px-3 py-3 text-xs text-muted-foreground animate-pulse">Loading leads...</div>
                  )}
                  {categoryLeads[cat]?.map((r) => (
                    <button key={r.id} onClick={() => loadDetail(r.id)}
                      className={`w-full text-left px-3 py-2.5 border-b border-muted/20 transition-all ${selectedId === r.id ? "bg-primary/5 border-l-[3px] border-l-primary" : "hover:bg-muted/10 border-l-[3px] border-l-transparent"}`}>
                      <p className="text-xs font-medium truncate">{r.lead_email}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px] text-muted-foreground truncate">{r.company_name || r.ai_categorized_lead_category || "—"}</span>
                        <span className="text-[10px] font-mono font-bold text-primary/70 shrink-0">{r.client_tag || "N/A"}</span>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          ))}
          {displayCategories.length === 0 && (
            <div className="px-3 py-8 text-xs text-muted-foreground text-center">No leads found</div>
          )}
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 overflow-y-auto bg-[#fafafa]">
        {fetchError && <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">{fetchError}</div>}
        {!detail && !loading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-sm text-muted-foreground">Select a lead to view details</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Click a category on the left to expand, then click a lead</p>
            </div>
          </div>
        )}
        {loading && <div className="flex items-center justify-center h-full"><p className="text-sm text-muted-foreground animate-pulse">Loading...</p></div>}

        {detail && !loading && (
          <div className="p-6 space-y-4 pb-16">
            {/* Header bar */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">{detail.from_name || detail.lead_name || detail.lead_email}</h2>
                <span className="text-xs font-mono font-bold bg-primary/10 text-primary px-2.5 py-1 rounded-md">{detail.client_tag || "N/A"}</span>
                <span className="text-xs bg-muted px-2 py-1 rounded-md capitalize">{detail.workflow}</span>
                {detail.pushed_to_sheet && <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded-md">Pushed to Sheet</span>}
              </div>
              <p className="text-xs text-muted-foreground">{detail.lead_email}</p>
            </div>

            {/* Two-column: Details + Audit side by side */}
            <div className="grid grid-cols-2 gap-4">
              {/* Lead details */}
              <div className="rounded-lg border bg-white p-4">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">Lead Details</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  {[
                    { l: "Company", v: detail.company_name },
                    { l: "Phone", v: detail.phone },
                    { l: "Location", v: [detail.city, detail.state].filter(Boolean).join(", ") },
                    { l: "Address", v: detail.address },
                    { l: "Campaign", v: detail.campaign_name },
                    { l: "Sender", v: detail.sender_email },
                    { l: "LinkedIn", v: detail.linkedin_url },
                    { l: "Google Maps", v: detail.google_maps_url ? "link" : null },
                    { l: "Lead ID", v: detail.lead_id },
                  ].filter((f) => f.v).map((f) => (
                    <div key={f.l}>
                      <p className="text-muted-foreground text-[10px] mb-0.5">{f.l}</p>
                      {f.l === "Google Maps" ? (
                        <a href={detail.google_maps_url as string} target="_blank" rel="noopener noreferrer" className="text-primary underline text-xs">View on Maps</a>
                      ) : (
                        <p className="font-medium break-all">{String(f.v)}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Audit + Category + Reallocate */}
              <div className="space-y-4">
                {/* Audit results */}
                {(detail.industry_audit || detail.location_audit) && (
                  <div className="rounded-lg border bg-white p-4">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">Qualification</p>
                    <div className="flex gap-2 mb-2">
                      {detail.industry_audit && (
                        <span className={`text-xs font-medium px-2.5 py-1 rounded-md ${detail.industry_audit === "Passed" ? "bg-green-50 text-green-700 border border-green-200" : detail.industry_audit === "Residential" ? "bg-yellow-50 text-yellow-700 border border-yellow-200" : "bg-red-50 text-red-700 border border-red-200"}`}>Industry: {detail.industry_audit}</span>
                      )}
                      {detail.location_audit && (
                        <span className={`text-xs font-medium px-2.5 py-1 rounded-md ${detail.location_audit === "Passed" ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>Location: {detail.location_audit}</span>
                      )}
                    </div>
                    {detail.qualification_reason && <p className="text-[11px] text-muted-foreground leading-relaxed">{detail.qualification_reason}</p>}
                    {detail.suggested_client && <p className="text-[11px] mt-1.5"><span className="text-muted-foreground">Suggested: </span><span className="font-medium">{detail.suggested_client}</span></p>}
                  </div>
                )}

                {/* Category + Reallocate */}
                <div className="rounded-lg border bg-white p-4">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">Actions</p>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground w-16 shrink-0">Category</Label>
                      <Select value={detail.lead_category || "Open Response"} onValueChange={updateCategory}>
                        <SelectTrigger className="h-8 text-xs flex-1"><SelectValue /></SelectTrigger>
                        <SelectContent>{LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    {showRealloc && (
                      <div className="flex items-center gap-2">
                        <Label className="text-xs text-muted-foreground w-16 shrink-0">Reallocate</Label>
                        <Input value={reallocTag} onChange={(e) => setReallocTag(e.target.value)} placeholder="Client tag" className="h-8 text-xs font-mono flex-1" />
                        <Button size="sm" className="h-8 text-xs" onClick={handleRealloc} disabled={!reallocTag}>Assign</Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Reply we got — full width */}
            <div className="rounded-lg border bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-muted/20 flex justify-between items-center">
                <p className="text-xs font-medium truncate flex-1">Reply: {detail.email_subject}</p>
                <span className="text-[11px] text-muted-foreground ml-3 shrink-0">{detail.reply_time && new Date(detail.reply_time).toLocaleString()}</span>
              </div>
              <div className="px-4 py-3 text-[13px] whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">{detail.reply_we_got || "No content"}</div>
            </div>

            {/* Action buttons row */}
            <div className="flex gap-2">
              {["Send Reply", "Forward", "One-Off Reply", "Notes"].map((s) => (
                <button key={s} onClick={() => setOpenSection(openSection === s ? null : s)}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${openSection === s ? "bg-primary text-primary-foreground border-primary" : "bg-white hover:bg-muted/50 border-border"}`}>
                  {s}
                </button>
              ))}
              <button onClick={handleBlacklist} className="text-xs px-3 py-1.5 rounded-md border border-red-200 text-red-600 hover:bg-red-50 transition-colors ml-auto">
                Blacklist {detail.lead_email?.split("@")[1]}
              </button>
            </div>

            {/* Collapsible action panels */}
            {openSection === "Send Reply" && (
              <div className="rounded-lg border bg-white p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">Send Reply to {detail.lead_email}</p>
                </div>
                <Textarea value={replyMsg} onChange={(e) => setReplyMsg(e.target.value)} rows={4} placeholder="Type reply..." className="text-sm" />
                <div className="grid grid-cols-2 gap-3">
                  <div><Label className="text-[10px] text-muted-foreground">CC</Label><Input value={replyCc} onChange={(e) => setReplyCc(e.target.value)} placeholder="cc1@email.com, cc2@email.com" className="text-xs h-8" /></div>
                  <div><Label className="text-[10px] text-muted-foreground">BCC</Label><Input value={replyBcc} onChange={(e) => setReplyBcc(e.target.value)} placeholder="bcc@email.com" className="text-xs h-8" /></div>
                </div>
                <Button size="sm" className="h-8 text-xs" onClick={handleSend} disabled={sending === "reply" || !replyMsg}>{sending === "reply" ? "Sending..." : "Send Reply"}</Button>
              </div>
            )}

            {openSection === "Forward" && (
              <div className="rounded-lg border bg-white p-4">
                <div className="flex items-end gap-3">
                  <div className="flex-1"><Label className="text-xs text-muted-foreground">Forward to</Label><Input value={fwdTo} onChange={(e) => setFwdTo(e.target.value)} placeholder="email@example.com" className="text-xs h-8 mt-1" /></div>
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleFwd} disabled={sending === "fwd" || !fwdTo}>{sending === "fwd" ? "Forwarding..." : "Forward"}</Button>
                </div>
              </div>
            )}

            {openSection === "One-Off Reply" && (
              <div className="rounded-lg border bg-white p-4 space-y-3">
                <p className="text-xs font-medium">One-Off Reply to {detail.lead_email}</p>
                <Input value={ooSubject} onChange={(e) => setOoSubject(e.target.value)} placeholder="Subject" className="text-xs h-8" />
                <Textarea value={ooMsg} onChange={(e) => setOoMsg(e.target.value)} rows={3} placeholder="Message" className="text-sm" />
                <div><Label className="text-[10px] text-muted-foreground">CC</Label><Input value={ooCc} onChange={(e) => setOoCc(e.target.value)} placeholder="cc@email.com" className="text-xs h-8" /></div>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleOneOff} disabled={sending === "oo" || !ooMsg || !ooSubject}>{sending === "oo" ? "Sending..." : "Send"}</Button>
              </div>
            )}

            {openSection === "Notes" && (
              <div className="rounded-lg border bg-white p-4">
                <Textarea
                  value={detail.notes || ""} onChange={(e) => setDetail({ ...detail, notes: e.target.value })}
                  onBlur={() => { mutate({ action: "update-notes", id: detail.id, notes: detail.notes || "" }); toast.success("Notes saved"); }}
                  placeholder="Add notes about this lead..." rows={3} className="text-xs"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
