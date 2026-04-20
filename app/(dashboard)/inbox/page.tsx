"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const categoryColor: Record<string, string> = {
  "Interested": "bg-green-100 text-green-800",
  "Meeting Set": "bg-green-200 text-green-900",
  "Meeting-Ready Lead": "bg-green-200 text-green-900",
  "Follow Up": "bg-blue-100 text-blue-800",
  "Not Interested": "bg-gray-100 text-gray-600",
  "Do Not Contact": "bg-red-100 text-red-800",
  "Out Of Office": "bg-yellow-100 text-yellow-800",
  "Wrong Person": "bg-orange-100 text-orange-800",
  "Change Of Target": "bg-orange-100 text-orange-800",
  "Automated Reply": "bg-gray-100 text-gray-600",
  "Mailbox No Longer Active": "bg-gray-100 text-gray-600",
  "Open Response": "bg-purple-100 text-purple-800",
  "Needs Review": "bg-purple-100 text-purple-800",
  "Referral Given": "bg-blue-200 text-blue-900",
  "Internally Forwarded": "bg-blue-200 text-blue-900",
};

export default function InboxPage() {
  const [replies, setReplies] = useState<ReplyListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReplyDetail | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterWorkflow, setFilterWorkflow] = useState<string>("");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Dialog states
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
      const params = new URLSearchParams({ page: String(page), limit: "50" });
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
      if (res.ok) {
        setDetail(await res.json());
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function updateCategory(id: number, category: string) {
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update-category", id, category }),
    });
    const data = await res.json();
    if (res.ok) {
      toast.success(`Category updated to ${category}`);
      if (data.pushed_to_sheet) toast.success("Pushed to Google Sheet");
      if (data.sheet_error) toast.error(`Sheet push failed: ${data.sheet_error}`);
      loadReplies();
      if (detail?.id === id) loadDetail(id);
    } else {
      toast.error(data.error || "Failed to update");
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
        action: "send-reply",
        id: detail.id,
        replyId: detail.reply_id,
        senderEmailId: detail.sender_id,
        message: replyMessage,
        toEmail: detail.lead_email,
        toName: detail.lead_name,
      }),
    });
    const data = await res.json();
    setSending(false);
    if (data.ok) {
      toast.success("Reply sent");
      setReplyDialogOpen(false);
      setReplyMessage("");
      loadDetail(detail.id);
    } else {
      toast.error(data.error || "Failed to send");
    }
  }

  async function handleForward() {
    if (!detail || !forwardTo) return;
    setSending(true);
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "forward",
        id: detail.id,
        replyId: detail.reply_id,
        senderEmailId: detail.sender_id,
        message: detail.reply_we_got,
        forwardTo,
        leadName: detail.lead_name,
      }),
    });
    const data = await res.json();
    setSending(false);
    if (data.ok) {
      toast.success("Forwarded");
      setForwardDialogOpen(false);
      setForwardTo("");
      loadDetail(detail.id);
    } else {
      toast.error(data.error || "Forward failed");
    }
  }

  async function handleOneOff() {
    if (!detail || !oneOffMessage || !oneOffSubject) return;
    setSending(true);
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send-one-off",
        id: detail.id,
        senderEmailId: detail.sender_id,
        subject: oneOffSubject,
        message: oneOffMessage,
        toEmail: detail.lead_email,
        toName: detail.lead_name,
      }),
    });
    const data = await res.json();
    setSending(false);
    if (data.ok) {
      toast.success("One-off reply sent");
      setOneOffDialogOpen(false);
      setOneOffSubject("");
      setOneOffMessage("");
    } else {
      toast.error(data.error || "Failed to send");
    }
  }

  async function handleBlacklist() {
    if (!detail) return;
    if (!confirm(`Blacklist domain for ${detail.lead_email}?`)) return;
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
    if (data.ok) {
      toast.success("Pushed to Google Sheet");
      loadDetail(detail.id);
    } else {
      toast.error(data.error || "Push failed");
    }
  }

  async function handleReallocate(clientTag: string) {
    if (!detail) return;
    const res = await fetch("/api/inbox/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reallocate", id: detail.id, client_tag: clientTag }),
    });
    if (res.ok) {
      toast.success(`Reallocated to ${clientTag}`);
      loadReplies();
      loadDetail(detail.id);
    }
  }

  // Group replies by category for left panel
  const grouped = replies.reduce<Record<string, ReplyListItem[]>>((acc, r) => {
    const cat = r.lead_category || "Open Response";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(r);
    return acc;
  }, {});

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-0">
      {/* Left Panel - Lead List */}
      <div className="w-72 border-r overflow-y-auto shrink-0 bg-muted/20">
        <div className="p-3 border-b space-y-2">
          <Input
            placeholder="Search email, name, company..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="text-xs h-8"
          />
          <div className="flex gap-1">
            <Select value={filterWorkflow} onValueChange={(v) => { setFilterWorkflow(v === "all" ? "" : v); setPage(1); }}>
              <SelectTrigger className="text-xs h-7 flex-1"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="tracked">Tracked</SelectItem>
                <SelectItem value="untracked">Untracked</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterCategory} onValueChange={(v) => { setFilterCategory(v === "all" ? "" : v); setPage(1); }}>
              <SelectTrigger className="text-xs h-7 flex-1"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="divide-y">
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category}>
              <div className="px-3 py-1.5 bg-muted/50 flex items-center justify-between">
                <Badge variant="secondary" className={`text-xs ${categoryColor[category] || ""}`}>
                  {category}
                </Badge>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </div>
              {items.map((r) => (
                <div
                  key={r.id}
                  className={`px-3 py-2 cursor-pointer hover:bg-muted/40 border-l-2 ${selectedId === r.id ? "bg-muted border-l-primary" : "border-l-transparent"}`}
                  onClick={() => loadDetail(r.id)}
                >
                  <p className="text-xs font-medium truncate">{r.lead_email}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Badge variant="secondary" className={`text-[10px] px-1 py-0 ${categoryColor[r.ai_categorized_lead_category || ""] || ""}`}>
                      {r.ai_categorized_lead_category || "—"}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1 py-0 font-mono">
                      {r.client_tag || "N/A"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Pagination */}
        {total > 50 && (
          <div className="p-2 border-t flex items-center justify-between">
            <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)} className="text-xs h-7">Prev</Button>
            <span className="text-xs text-muted-foreground">{page} / {Math.ceil(total / 50)}</span>
            <Button size="sm" variant="outline" disabled={page * 50 >= total} onClick={() => setPage(page + 1)} className="text-xs h-7">Next</Button>
          </div>
        )}
      </div>

      {/* Right Panel - Detail */}
      <div className="flex-1 overflow-y-auto p-4">
        {fetchError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
            {fetchError}
          </div>
        )}

        {!detail && !loading && (
          <p className="text-sm text-muted-foreground text-center py-20">Select a lead from the left panel</p>
        )}

        {loading && <p className="text-sm text-muted-foreground text-center py-20">Loading...</p>}

        {detail && !loading && (
          <div className="space-y-4 max-w-4xl">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">{detail.from_name || detail.lead_name || detail.lead_email}</h2>
                <p className="text-sm text-muted-foreground">{detail.lead_email}</p>
              </div>
              <div className="flex gap-2">
                <Badge variant="outline" className="font-mono">{detail.client_tag || "N/A"}</Badge>
                <Badge variant={detail.workflow === "tracked" ? "default" : "secondary"}>{detail.workflow}</Badge>
              </div>
            </div>

            {/* Lead Info */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Lead Info</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                  {detail.company_name && <div><span className="text-muted-foreground">Company:</span> {detail.company_name}</div>}
                  {detail.phone && <div><span className="text-muted-foreground">Phone:</span> {detail.phone}</div>}
                  {detail.city && <div><span className="text-muted-foreground">City:</span> {detail.city}</div>}
                  {detail.state && <div><span className="text-muted-foreground">State:</span> {detail.state}</div>}
                  {detail.address && <div className="col-span-2"><span className="text-muted-foreground">Address:</span> {detail.address}</div>}
                  {detail.sender_email && <div><span className="text-muted-foreground">Sender:</span> {detail.sender_email}</div>}
                  {detail.campaign_name && <div><span className="text-muted-foreground">Campaign:</span> {detail.campaign_name}</div>}
                </div>
              </CardContent>
            </Card>

            {/* Reply Content */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Reply</CardTitle></CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-1">Subject: {detail.email_subject}</p>
                <div className="bg-muted/30 rounded p-3 text-sm whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {detail.reply_we_got || "No reply content"}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {detail.reply_time && new Date(detail.reply_time).toLocaleString()}
                </p>
              </CardContent>
            </Card>

            {/* Audit */}
            {(detail.industry_audit || detail.location_audit) && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Audit</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex gap-4">
                    <div>
                      <span className="text-xs text-muted-foreground">Industry: </span>
                      <Badge className={detail.industry_audit === "Passed" ? "bg-green-600" : detail.industry_audit === "Residential" ? "bg-yellow-600" : "bg-red-600"}>
                        {detail.industry_audit}
                      </Badge>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground">Location: </span>
                      <Badge className={detail.location_audit === "Passed" ? "bg-green-600" : "bg-red-600"}>
                        {detail.location_audit}
                      </Badge>
                    </div>
                  </div>
                  {detail.qualification_reason && (
                    <p className="text-xs text-muted-foreground">{detail.qualification_reason}</p>
                  )}
                  {detail.suggested_client && (
                    <p className="text-xs"><span className="text-muted-foreground">Suggested:</span> {detail.suggested_client}</p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Lead Category */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Lead Category</CardTitle></CardHeader>
              <CardContent>
                <Select value={detail.lead_category || "Open Response"} onValueChange={(v) => updateCategory(detail.id, v)}>
                  <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
                {detail.pushed_to_sheet && (
                  <p className="text-xs text-green-600 mt-1">Pushed to sheet {detail.pushed_to_sheet_at && `at ${new Date(detail.pushed_to_sheet_at).toLocaleString()}`}</p>
                )}
              </CardContent>
            </Card>

            {/* Reallocate (for N/A untracked) */}
            {(detail.client_tag === "N/A" || !detail.client_tag) && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Reallocate Client</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Enter client tag (e.g., ABM)"
                      id="reallocate-tag"
                      className="w-48 text-xs"
                    />
                    <Button size="sm" onClick={() => {
                      const input = document.getElementById("reallocate-tag") as HTMLInputElement;
                      if (input?.value) handleReallocate(input.value.toUpperCase());
                    }}>Reallocate</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Our Reply / Template */}
            {detail.our_reply && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Our Reply (Template)</CardTitle></CardHeader>
                <CardContent>
                  <div className="bg-muted/30 rounded p-3 text-sm whitespace-pre-wrap">{detail.our_reply}</div>
                </CardContent>
              </Card>
            )}

            {/* Notes */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Notes</CardTitle></CardHeader>
              <CardContent>
                <Textarea
                  value={detail.notes || ""}
                  onChange={(e) => setDetail({ ...detail, notes: e.target.value })}
                  onBlur={() => updateNotes(detail.id, detail.notes || "")}
                  placeholder="Add notes..."
                  rows={3}
                  className="text-xs"
                />
              </CardContent>
            </Card>

            {/* Action Buttons */}
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" onClick={() => { setReplyMessage(detail.our_reply || ""); setReplyDialogOpen(true); }}>
                Send Reply
              </Button>
              <Button size="sm" variant="outline" onClick={() => setForwardDialogOpen(true)}>
                Forward
              </Button>
              <Button size="sm" variant="outline" onClick={() => setOneOffDialogOpen(true)}>
                One-Off Reply
              </Button>
              <Button size="sm" variant="outline" onClick={handlePushToSheet}>
                Push to Sheet
              </Button>
              <Button size="sm" variant="destructive" onClick={handleBlacklist}>
                Blacklist Domain
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Send Reply Dialog */}
      <Dialog open={replyDialogOpen} onOpenChange={setReplyDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Send Reply</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">To: {detail?.lead_email}</Label>
            </div>
            <Textarea
              value={replyMessage}
              onChange={(e) => setReplyMessage(e.target.value)}
              rows={8}
              placeholder="Type your reply..."
              className="text-sm"
            />
            <Button onClick={handleSendReply} disabled={sending} className="w-full">
              {sending ? "Sending..." : "Send"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Forward Dialog */}
      <Dialog open={forwardDialogOpen} onOpenChange={setForwardDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Forward Reply</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Forward to</Label>
              <Input value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} placeholder="email@example.com" className="text-sm" />
            </div>
            <Button onClick={handleForward} disabled={sending} className="w-full">
              {sending ? "Forwarding..." : "Forward"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* One-Off Reply Dialog */}
      <Dialog open={oneOffDialogOpen} onOpenChange={setOneOffDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Send One-Off Reply</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">To: {detail?.lead_email}</Label>
            </div>
            <div>
              <Label className="text-xs">Subject</Label>
              <Input value={oneOffSubject} onChange={(e) => setOneOffSubject(e.target.value)} className="text-sm" />
            </div>
            <div>
              <Label className="text-xs">Message</Label>
              <Textarea value={oneOffMessage} onChange={(e) => setOneOffMessage(e.target.value)} rows={6} className="text-sm" />
            </div>
            <Button onClick={handleOneOff} disabled={sending} className="w-full">
              {sending ? "Sending..." : "Send"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
