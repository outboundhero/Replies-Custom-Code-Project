"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

interface ReplyListItem {
  id: number;
  workflow: string;
  lead_email: string;
  lead_name: string;
  company_name: string;
  client_tag: string;
  ai_categorized_lead_category: string;
  lead_category: string;
  reply_status: string;
  industry_audit: string | null;
  location_audit: string | null;
  created_at: string;
  reply_id: number;
}

interface ReplyDetail {
  id: number;
  workflow: string;
  lead_id: number;
  lead_email: string;
  lead_name: string;
  first_name: string;
  last_name: string;
  company_name: string;
  campaign_id: number;
  campaign_name: string;
  client_tag: string;
  sender_id: number;
  sender_email: string;
  sender_name: string;
  reply_id: number;
  email_subject: string;
  reply_we_got: string;
  reply_time: string;
  from_name: string;
  from_email: string;
  to_email: string;
  to_name: string;
  prospect_cc_email: string;
  prospect_cc_name: string;
  phone: string;
  linkedin_url: string;
  address: string;
  city: string;
  state: string;
  google_maps_url: string;
  lead_category: string;
  ai_categorized_lead_category: string;
  reply_status: string;
  cc_name_1: string; cc_email_1: string;
  cc_name_2: string; cc_email_2: string;
  cc_name_3: string; cc_email_3: string;
  cc_name_4: string; cc_email_4: string;
  cc_name_5: string; cc_email_5: string;
  cc_name_6: string; cc_email_6: string;
  bcc_name_1: string; bcc_email_1: string;
  bcc_name_2: string; bcc_email_2: string;
  our_reply: string;
  industry_audit: string;
  location_audit: string;
  qualification_reason: string;
  suggested_client: string;
  sent_reply: string;
  forwarded_to: string;
  notes: string;
  pushed_to_sheet: boolean;
  pushed_to_sheet_at: string;
}

const LEAD_CATEGORIES = [
  "Open Response", "Interested", "Meeting Set", "Not Interested", "Do Not Contact",
  "Out Of Office", "Wrong Person", "Lost", "Meeting-Ready Lead", "Follow Up",
  "Automated Reply", "Needs Review", "Change Of Target", "Not Interested (Send Reply)",
  "Unqualified (Cleaning)", "Closed Won", "Mailbox No Longer Active", "Referral Given",
  "Internally Forwarded",
];

const catDot: Record<string, string> = {
  "Interested": "bg-green-500",
  "Meeting Set": "bg-green-600",
  "Meeting-Ready Lead": "bg-green-600",
  "Follow Up": "bg-blue-500",
  "Not Interested": "bg-gray-400",
  "Do Not Contact": "bg-red-500",
  "Out Of Office": "bg-yellow-500",
  "Wrong Person": "bg-orange-500",
  "Change Of Target": "bg-orange-400",
  "Automated Reply": "bg-gray-400",
  "Mailbox No Longer Active": "bg-gray-400",
  "Open Response": "bg-purple-500",
  "Needs Review": "bg-purple-400",
  "Referral Given": "bg-blue-600",
  "Internally Forwarded": "bg-blue-600",
  "Closed Won": "bg-emerald-600",
  "Lost": "bg-gray-500",
};

export default function InboxPage() {
  const [replies, setReplies] = useState<ReplyListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReplyDetail | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterWorkflow, setFilterWorkflow] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Dialogs
  const [replyDialogOpen, setReplyDialogOpen] = useState(false);
  const [forwardDialogOpen, setForwardDialogOpen] = useState(false);
  const [oneOffDialogOpen, setOneOffDialogOpen] = useState(false);
  const [replyMessage, setReplyMessage] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [oneOffSubject, setOneOffSubject] = useState("");
  const [oneOffMessage, setOneOffMessage] = useState("");
  const [sending, setSending] = useState(false);

  const loadReplies = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: "100" });
      if (search) params.set("search", search);
      if (filterCategory) params.set("category", filterCategory);
      if (filterWorkflow) params.set("workflow", filterWorkflow);

      const res = await fetch(`/api/inbox?${params}`);
      if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
      if (res.ok) {
        const data = await res.json();
        setReplies(data.replies);
        setTotal(data.total);
        setFetchError(null);
      } else {
        setFetchError(`Failed to load inbox (${res.status})`);
      }
    } catch (err) {
      setFetchError(`Network error: ${(err as Error).message}`);
    }
  }, [page, search, filterCategory, filterWorkflow]);

  useEffect(() => { loadReplies(); }, [loadReplies]);

  async function loadDetail(id: number) {
    setSelectedId(id);
    setLoading(true);
    try {
      const res = await fetch(`/api/inbox/${id}`);
      if (res.ok) setDetail(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }

  function toggleCategory(cat: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  async function updateCategory(id: number, category: string) {
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update-category", id, category }),
    });
    const data = await res.json();
    if (res.ok) {
      toast.success(`Category: ${category}`);
      if (data.pushed_to_sheet) toast.success("Pushed to Google Sheet");
      if (data.sheet_error) toast.error(`Sheet: ${data.sheet_error}`);
      loadReplies();
      if (detail?.id === id) loadDetail(id);
    } else {
      toast.error(data.error || "Failed");
    }
  }

  async function updateNotes(id: number, notes: string) {
    await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update-notes", id, notes }),
    });
  }

  async function handleSendReply() {
    if (!detail || !replyMessage) return;
    setSending(true);
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send-reply", id: detail.id, replyId: detail.reply_id,
        senderEmailId: detail.sender_id, message: replyMessage,
        toEmail: detail.lead_email, toName: detail.lead_name,
      }),
    });
    const data = await res.json();
    setSending(false);
    if (data.ok) { toast.success("Reply sent"); setReplyDialogOpen(false); setReplyMessage(""); loadDetail(detail.id); }
    else toast.error(data.error || "Failed");
  }

  async function handleForward() {
    if (!detail || !forwardTo) return;
    setSending(true);
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "forward", id: detail.id, replyId: detail.reply_id,
        senderEmailId: detail.sender_id, message: detail.reply_we_got,
        forwardTo, leadName: detail.lead_name,
      }),
    });
    const data = await res.json();
    setSending(false);
    if (data.ok) { toast.success("Forwarded"); setForwardDialogOpen(false); setForwardTo(""); loadDetail(detail.id); }
    else toast.error(data.error || "Failed");
  }

  async function handleOneOff() {
    if (!detail || !oneOffMessage || !oneOffSubject) return;
    setSending(true);
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send-one-off", id: detail.id, senderEmailId: detail.sender_id,
        subject: oneOffSubject, message: oneOffMessage,
        toEmail: detail.lead_email, toName: detail.lead_name,
      }),
    });
    const data = await res.json();
    setSending(false);
    if (data.ok) { toast.success("Sent"); setOneOffDialogOpen(false); setOneOffSubject(""); setOneOffMessage(""); }
    else toast.error(data.error || "Failed");
  }

  async function handleBlacklist() {
    if (!detail || !confirm(`Blacklist domain for ${detail.lead_email}?`)) return;
    await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "blacklist-domain", id: detail.id, email: detail.lead_email }),
    });
    toast.success("Domain blacklisted");
  }

  async function handlePushToSheet() {
    if (!detail) return;
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "push-to-sheet", id: detail.id }),
    });
    const data = await res.json();
    if (data.ok) { toast.success("Pushed to Google Sheet"); loadDetail(detail.id); }
    else toast.error(data.error || "Push failed");
  }

  async function handleReallocate(clientTag: string) {
    if (!detail) return;
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reallocate", id: detail.id, client_tag: clientTag }),
    });
    if (res.ok) { toast.success(`Reallocated to ${clientTag}`); loadReplies(); loadDetail(detail.id); }
  }

  // Group by category
  const grouped = replies.reduce<Record<string, ReplyListItem[]>>((acc, r) => {
    const cat = r.lead_category || "Open Response";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(r);
    return acc;
  }, {});

  // Sort categories: put ones with items first
  const sortedCategories = Object.entries(grouped).sort(([, a], [, b]) => b.length - a.length);

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* Left Panel */}
      <div className="w-80 border-r flex flex-col bg-white shrink-0">
        {/* Search & Filters */}
        <div className="p-3 space-y-2 border-b">
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="h-8 text-sm"
          />
          <div className="flex gap-1.5">
            <Select value={filterWorkflow || "all"} onValueChange={(v) => { setFilterWorkflow(v === "all" ? "" : v); setPage(1); }}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="tracked">Tracked</SelectItem>
                <SelectItem value="untracked">Untracked</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterCategory || "all"} onValueChange={(v) => { setFilterCategory(v === "all" ? "" : v); setPage(1); }}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="text-[11px] text-muted-foreground">{total} leads</div>
        </div>

        {/* Lead List */}
        <div className="flex-1 overflow-y-auto">
          {sortedCategories.map(([category, items]) => {
            const isCollapsed = collapsedCategories.has(category);
            return (
              <div key={category}>
                {/* Category Header */}
                <button
                  onClick={() => toggleCategory(category)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 border-b text-left transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${catDot[category] || "bg-gray-400"}`} />
                    <span className="text-xs font-medium text-foreground">{category}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground tabular-nums">{items.length}</span>
                    <svg className={`w-3 h-3 text-muted-foreground transition-transform ${isCollapsed ? "" : "rotate-180"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </button>

                {/* Leads */}
                {!isCollapsed && items.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => loadDetail(r.id)}
                    className={`w-full text-left px-3 py-2.5 border-b border-muted/50 transition-colors ${
                      selectedId === r.id
                        ? "bg-primary/5 border-l-2 border-l-primary"
                        : "hover:bg-muted/20 border-l-2 border-l-transparent"
                    }`}
                  >
                    <p className="text-[13px] font-medium truncate text-foreground leading-tight">{r.lead_email}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      {r.ai_categorized_lead_category && (
                        <span className="text-[10px] text-muted-foreground truncate">{r.ai_categorized_lead_category}</span>
                      )}
                      <span className="text-[10px] font-mono font-semibold text-primary/70">{r.client_tag || "N/A"}</span>
                    </div>
                  </button>
                ))}
              </div>
            );
          })}

          {replies.length === 0 && !fetchError && (
            <p className="text-xs text-muted-foreground text-center py-10">No replies yet</p>
          )}
        </div>

        {/* Pagination */}
        {total > 100 && (
          <div className="p-2 border-t flex items-center justify-between bg-white">
            <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)} className="h-6 text-xs">Prev</Button>
            <span className="text-[11px] text-muted-foreground tabular-nums">{page}/{Math.ceil(total / 100)}</span>
            <Button size="sm" variant="ghost" disabled={page * 100 >= total} onClick={() => setPage(page + 1)} className="h-6 text-xs">Next</Button>
          </div>
        )}
      </div>

      {/* Right Panel */}
      <div className="flex-1 overflow-y-auto bg-muted/10">
        {fetchError && (
          <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {fetchError}
          </div>
        )}

        {!detail && !loading && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">Select a lead to view details</p>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {detail && !loading && (
          <div className="p-6 max-w-3xl mx-auto space-y-5">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">{detail.from_name || detail.lead_name || detail.lead_email}</h2>
                <p className="text-sm text-muted-foreground">{detail.lead_email}</p>
              </div>
              <div className="flex gap-2">
                <span className="text-xs font-mono font-semibold bg-primary/10 text-primary px-2 py-1 rounded">{detail.client_tag || "N/A"}</span>
                <span className="text-xs bg-muted px-2 py-1 rounded">{detail.workflow}</span>
              </div>
            </div>

            {/* Info Grid */}
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 rounded-lg border bg-white p-4">
              {[
                { label: "Company", value: detail.company_name },
                { label: "Phone", value: detail.phone },
                { label: "Location", value: [detail.city, detail.state].filter(Boolean).join(", ") },
                { label: "Sender", value: detail.sender_email },
                { label: "Campaign", value: detail.campaign_name },
                { label: "Address", value: detail.address },
              ].filter((f) => f.value).map((f) => (
                <div key={f.label} className="flex gap-2 text-sm">
                  <span className="text-muted-foreground shrink-0 w-20">{f.label}</span>
                  <span className="truncate">{f.value}</span>
                </div>
              ))}
            </div>

            {/* Reply */}
            <div className="rounded-lg border bg-white">
              <div className="px-4 py-2.5 border-b bg-muted/30">
                <p className="text-xs font-medium">Reply</p>
                <p className="text-xs text-muted-foreground mt-0.5">{detail.email_subject}</p>
              </div>
              <div className="p-4 text-sm whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
                {detail.reply_we_got || "No content"}
              </div>
              <div className="px-4 py-2 border-t bg-muted/20">
                <p className="text-[11px] text-muted-foreground">{detail.reply_time && new Date(detail.reply_time).toLocaleString()}</p>
              </div>
            </div>

            {/* Audit */}
            {(detail.industry_audit || detail.location_audit) && (
              <div className="rounded-lg border bg-white p-4 space-y-3">
                <p className="text-xs font-medium">Qualification Audit</p>
                <div className="flex gap-6">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Industry</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      detail.industry_audit === "Passed" ? "bg-green-100 text-green-700" :
                      detail.industry_audit === "Residential" ? "bg-yellow-100 text-yellow-700" :
                      "bg-red-100 text-red-700"
                    }`}>{detail.industry_audit}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Location</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      detail.location_audit === "Passed" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                    }`}>{detail.location_audit}</span>
                  </div>
                </div>
                {detail.qualification_reason && (
                  <p className="text-xs text-muted-foreground leading-relaxed">{detail.qualification_reason}</p>
                )}
                {detail.suggested_client && (
                  <p className="text-xs"><span className="text-muted-foreground">Suggested: </span><span className="font-medium">{detail.suggested_client}</span></p>
                )}
              </div>
            )}

            {/* Category + Reallocate */}
            <div className="flex gap-4 items-start">
              <div className="rounded-lg border bg-white p-4 flex-1">
                <p className="text-xs font-medium mb-2">Lead Category</p>
                <Select value={detail.lead_category || "Open Response"} onValueChange={(v) => updateCategory(detail.id, v)}>
                  <SelectTrigger className="w-56 h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
                {detail.pushed_to_sheet && (
                  <p className="text-[11px] text-green-600 mt-2">Pushed to sheet {detail.pushed_to_sheet_at && new Date(detail.pushed_to_sheet_at).toLocaleString()}</p>
                )}
              </div>

              {(!detail.client_tag || detail.client_tag === "N/A") && (
                <div className="rounded-lg border bg-white p-4">
                  <p className="text-xs font-medium mb-2">Reallocate</p>
                  <div className="flex gap-2">
                    <Input id="reallocate-input" placeholder="Client tag" className="w-28 h-9 text-sm" />
                    <Button size="sm" className="h-9" onClick={() => {
                      const v = (document.getElementById("reallocate-input") as HTMLInputElement)?.value;
                      if (v) handleReallocate(v.toUpperCase());
                    }}>Assign</Button>
                  </div>
                </div>
              )}
            </div>

            {/* Our Reply Template */}
            {detail.our_reply && (
              <div className="rounded-lg border bg-white p-4">
                <p className="text-xs font-medium mb-2">Our Reply (Template)</p>
                <div className="bg-muted/20 rounded p-3 text-sm whitespace-pre-wrap">{detail.our_reply}</div>
              </div>
            )}

            {/* Notes */}
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs font-medium mb-2">Notes</p>
              <Textarea
                value={detail.notes || ""}
                onChange={(e) => setDetail({ ...detail, notes: e.target.value })}
                onBlur={() => updateNotes(detail.id, detail.notes || "")}
                placeholder="Add notes..."
                rows={2}
                className="text-sm resize-none"
              />
            </div>

            {/* Actions */}
            <div className="flex gap-2 flex-wrap pb-6">
              <Button size="sm" onClick={() => { setReplyMessage(detail.our_reply || ""); setReplyDialogOpen(true); }}>
                Send Reply
              </Button>
              <Button size="sm" variant="outline" onClick={() => setForwardDialogOpen(true)}>Forward</Button>
              <Button size="sm" variant="outline" onClick={() => setOneOffDialogOpen(true)}>One-Off</Button>
              <Button size="sm" variant="outline" onClick={handlePushToSheet}>Push to Sheet</Button>
              <Button size="sm" variant="destructive" onClick={handleBlacklist}>Blacklist</Button>
            </div>
          </div>
        )}
      </div>

      {/* Send Reply Dialog */}
      <Dialog open={replyDialogOpen} onOpenChange={setReplyDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Send Reply</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">To: {detail?.lead_email}</p>
            <Textarea value={replyMessage} onChange={(e) => setReplyMessage(e.target.value)} rows={8} className="text-sm" />
            <Button onClick={handleSendReply} disabled={sending} className="w-full">{sending ? "Sending..." : "Send"}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Forward Dialog */}
      <Dialog open={forwardDialogOpen} onOpenChange={setForwardDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Forward Reply</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">Forward to</Label><Input value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} placeholder="email@example.com" /></div>
            <Button onClick={handleForward} disabled={sending} className="w-full">{sending ? "Forwarding..." : "Forward"}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* One-Off Dialog */}
      <Dialog open={oneOffDialogOpen} onOpenChange={setOneOffDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>One-Off Reply</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">To: {detail?.lead_email}</p>
            <div><Label className="text-xs">Subject</Label><Input value={oneOffSubject} onChange={(e) => setOneOffSubject(e.target.value)} /></div>
            <div><Label className="text-xs">Message</Label><Textarea value={oneOffMessage} onChange={(e) => setOneOffMessage(e.target.value)} rows={6} /></div>
            <Button onClick={handleOneOff} disabled={sending} className="w-full">{sending ? "Sending..." : "Send"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
