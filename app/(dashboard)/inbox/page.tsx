"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReplyDetail = Record<string, any>;

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

  // Inline form states
  const [replyMessage, setReplyMessage] = useState("");
  const [replyCc, setReplyCc] = useState("");
  const [replyBcc, setReplyBcc] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [oneOffSubject, setOneOffSubject] = useState("");
  const [oneOffMessage, setOneOffMessage] = useState("");
  const [oneOffCc, setOneOffCc] = useState("");
  const [reallocateTag, setReallocateTag] = useState("");
  const [sending, setSending] = useState<string | null>(null);

  const loadReplies = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: "100" });
      if (search) params.set("search", search);
      if (filterCategory) params.set("category", filterCategory);
      if (filterWorkflow) params.set("workflow", filterWorkflow);
      const res = await fetch(`/api/inbox?${params}`);
      if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
      if (res.ok) { const data = await res.json(); setReplies(data.replies); setTotal(data.total); setFetchError(null); }
      else setFetchError(`Failed to load (${res.status})`);
    } catch (err) { setFetchError((err as Error).message); }
  }, [page, search, filterCategory, filterWorkflow]);

  useEffect(() => { loadReplies(); }, [loadReplies]);

  async function loadDetail(id: number) {
    setSelectedId(id);
    setLoading(true);
    try {
      const res = await fetch(`/api/inbox/${id}`);
      if (res.ok) {
        const d = await res.json();
        setDetail(d);
        setReplyMessage(d.our_reply || "");
      }
    } catch { /* */ }
    setLoading(false);
  }

  function toggleCategory(cat: string) {
    setCollapsedCategories((prev) => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });
  }

  async function mutate(body: Record<string, unknown>) {
    const res = await fetch("/api/inbox/mutate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return res.json();
  }

  async function updateCategory(category: string) {
    if (!detail) return;
    const data = await mutate({ action: "update-category", id: detail.id, category });
    if (data.ok) {
      toast.success(`Category: ${category}`);
      if (data.pushed_to_sheet) toast.success("Auto-pushed to Google Sheet");
      if (data.sheet_error) toast.error(`Sheet: ${data.sheet_error}`);
      loadReplies();
      loadDetail(detail.id);
    } else toast.error(data.error);
  }

  function parseCcList(raw: string): Array<{ name: string; email_address: string }> {
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((email) => ({ name: "", email_address: email }));
  }

  async function handleSendReply() {
    if (!detail || !replyMessage) return;
    setSending("reply");
    const data = await mutate({
      action: "send-reply", id: detail.id, replyId: detail.reply_id,
      senderEmailId: detail.sender_id, message: replyMessage,
      toEmail: detail.lead_email, toName: detail.lead_name,
      ccEmails: replyCc ? parseCcList(replyCc) : undefined,
      bccEmails: replyBcc ? parseCcList(replyBcc) : undefined,
    });
    setSending(null);
    if (data.ok) { toast.success("Reply sent"); loadDetail(detail.id); }
    else toast.error(data.error || "Failed");
  }

  async function handleForward() {
    if (!detail || !forwardTo) return;
    setSending("forward");
    const data = await mutate({
      action: "forward", id: detail.id, replyId: detail.reply_id,
      senderEmailId: detail.sender_id, message: detail.reply_we_got,
      forwardTo, leadName: detail.lead_name,
    });
    setSending(null);
    if (data.ok) { toast.success("Forwarded"); setForwardTo(""); loadDetail(detail.id); }
    else toast.error(data.error || "Failed");
  }

  async function handleOneOff() {
    if (!detail || !oneOffMessage || !oneOffSubject) return;
    setSending("oneoff");
    const data = await mutate({
      action: "send-one-off", id: detail.id, senderEmailId: detail.sender_id,
      subject: oneOffSubject, message: oneOffMessage,
      toEmail: detail.lead_email, toName: detail.lead_name,
      ccEmails: oneOffCc ? parseCcList(oneOffCc) : undefined,
    });
    setSending(null);
    if (data.ok) { toast.success("Sent"); setOneOffSubject(""); setOneOffMessage(""); setOneOffCc(""); }
    else toast.error(data.error || "Failed");
  }

  async function handleBlacklist() {
    if (!detail || !confirm(`Blacklist domain for ${detail.lead_email}?`)) return;
    await mutate({ action: "blacklist-domain", id: detail.id, email: detail.lead_email });
    toast.success("Domain blacklisted");
  }

  async function handleReallocate() {
    if (!detail || !reallocateTag) return;
    const tag = reallocateTag.toUpperCase();
    const data = await mutate({ action: "reallocate", id: detail.id, client_tag: tag });
    if (data.ok) {
      toast.success(`Reallocated to ${tag} — CC/BCC/template updated`);
      setReallocateTag("");
      loadReplies();
      loadDetail(detail.id);
    } else toast.error(data.error);
  }

  // Show reallocate for: N/A, positive leads, failed audits
  const showReallocate = detail && (
    !detail.client_tag || detail.client_tag === "N/A" ||
    POSITIVE_CATEGORIES.includes(detail.lead_category) ||
    detail.industry_audit === "Failed" || detail.industry_audit === "Residential" ||
    detail.location_audit === "Failed"
  );

  // Group
  const grouped = replies.reduce<Record<string, ReplyListItem[]>>((acc, r) => {
    const cat = r.lead_category || "Open Response";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(r);
    return acc;
  }, {});
  const sortedCategories = Object.entries(grouped).sort(([, a], [, b]) => b.length - a.length);

  const InfoRow = ({ label, value }: { label: string; value: string | number | null | undefined }) =>
    value ? <div className="flex gap-2 text-sm py-1"><span className="text-muted-foreground w-28 shrink-0 text-xs">{label}</span><span className="break-all">{value}</span></div> : null;

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* ── Left Panel ── */}
      <div className="w-80 border-r flex flex-col bg-white shrink-0">
        <div className="p-3 space-y-2 border-b">
          <Input placeholder="Search..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="h-8 text-sm" />
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

        <div className="flex-1 overflow-y-auto">
          {sortedCategories.map(([category, items]) => (
            <div key={category}>
              <button onClick={() => toggleCategory(category)} className="w-full flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 border-b text-left transition-colors">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${catDot[category] || "bg-gray-400"}`} />
                  <span className="text-xs font-medium">{category}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground tabular-nums">{items.length}</span>
                  <svg className={`w-3 h-3 text-muted-foreground transition-transform ${collapsedCategories.has(category) ? "" : "rotate-180"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </div>
              </button>
              {!collapsedCategories.has(category) && items.map((r) => (
                <button key={r.id} onClick={() => loadDetail(r.id)} className={`w-full text-left px-3 py-2.5 border-b border-muted/50 transition-colors ${selectedId === r.id ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/20 border-l-2 border-l-transparent"}`}>
                  <p className="text-[13px] font-medium truncate leading-tight">{r.lead_email}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] text-muted-foreground truncate">{r.ai_categorized_lead_category || "—"}</span>
                    <span className="text-[10px] font-mono font-semibold text-primary/70">{r.client_tag || "N/A"}</span>
                  </div>
                </button>
              ))}
            </div>
          ))}
          {replies.length === 0 && !fetchError && <p className="text-xs text-muted-foreground text-center py-10">No replies yet</p>}
        </div>

        {total > 100 && (
          <div className="p-2 border-t flex items-center justify-between">
            <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)} className="h-6 text-xs">Prev</Button>
            <span className="text-[11px] text-muted-foreground tabular-nums">{page}/{Math.ceil(total / 100)}</span>
            <Button size="sm" variant="ghost" disabled={page * 100 >= total} onClick={() => setPage(page + 1)} className="h-6 text-xs">Next</Button>
          </div>
        )}
      </div>

      {/* ── Right Panel ── */}
      <div className="flex-1 overflow-y-auto bg-muted/10">
        {fetchError && <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{fetchError}</div>}
        {!detail && !loading && <div className="flex items-center justify-center h-full"><p className="text-sm text-muted-foreground">Select a lead to view details</p></div>}
        {loading && <div className="flex items-center justify-center h-full"><p className="text-sm text-muted-foreground">Loading...</p></div>}

        {detail && !loading && (
          <div className="p-6 max-w-3xl mx-auto space-y-4 pb-20">
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

            {/* Lead Details — all custom vars */}
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Lead Details</p>
              <div className="grid grid-cols-2 gap-x-6">
                <InfoRow label="Company" value={detail.company_name} />
                <InfoRow label="Phone" value={detail.phone} />
                <InfoRow label="City" value={detail.city} />
                <InfoRow label="State" value={detail.state} />
                <InfoRow label="Address" value={detail.address} />
                <InfoRow label="LinkedIn" value={detail.linkedin_url} />
                <InfoRow label="Google Maps" value={detail.google_maps_url} />
                <InfoRow label="Lead ID" value={detail.lead_id} />
                <InfoRow label="First Name" value={detail.first_name} />
                <InfoRow label="Last Name" value={detail.last_name} />
                <InfoRow label="Sender" value={detail.sender_email} />
                <InfoRow label="Sender Name" value={detail.sender_name} />
                <InfoRow label="Campaign" value={detail.campaign_name} />
                <InfoRow label="Reply Status" value={detail.reply_status} />
                <InfoRow label="To" value={detail.to_email} />
                <InfoRow label="CC" value={detail.prospect_cc_email} />
              </div>
            </div>

            {/* Reply Content */}
            <div className="rounded-lg border bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-muted/30 flex justify-between items-center">
                <div>
                  <p className="text-xs font-semibold">Reply</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{detail.email_subject}</p>
                </div>
                <span className="text-[11px] text-muted-foreground">{detail.reply_time && new Date(detail.reply_time).toLocaleString()}</span>
              </div>
              <div className="p-4 text-sm whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">{detail.reply_we_got || "No content"}</div>
            </div>

            {/* Audit */}
            {(detail.industry_audit || detail.location_audit) && (
              <div className="rounded-lg border bg-white p-4 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Qualification Audit</p>
                <div className="flex gap-6">
                  {detail.industry_audit && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Industry</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${detail.industry_audit === "Passed" ? "bg-green-100 text-green-700" : detail.industry_audit === "Residential" ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>{detail.industry_audit}</span>
                    </div>
                  )}
                  {detail.location_audit && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Location</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${detail.location_audit === "Passed" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>{detail.location_audit}</span>
                    </div>
                  )}
                </div>
                {detail.qualification_reason && <p className="text-xs text-muted-foreground leading-relaxed">{detail.qualification_reason}</p>}
                {detail.suggested_client && <p className="text-xs"><span className="text-muted-foreground">Suggested: </span><span className="font-medium">{detail.suggested_client}</span></p>}
              </div>
            )}

            {/* Lead Category */}
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Lead Category</p>
              <Select value={detail.lead_category || "Open Response"} onValueChange={updateCategory}>
                <SelectTrigger className="w-64 h-9"><SelectValue /></SelectTrigger>
                <SelectContent>{LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
              {detail.pushed_to_sheet && <p className="text-[11px] text-green-600 mt-2">Pushed to sheet {detail.pushed_to_sheet_at && new Date(detail.pushed_to_sheet_at).toLocaleString()}</p>}
              <p className="text-[11px] text-muted-foreground mt-1">Selecting Interested, Meeting-Ready Lead, Follow Up, Referral Given, or Internally Forwarded auto-pushes to Google Sheet</p>
            </div>

            {/* Reallocate */}
            {showReallocate && (
              <div className="rounded-lg border bg-white p-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Reallocate to Another Client</p>
                <p className="text-[11px] text-muted-foreground mb-2">This will update the client tag and populate CC/BCC/reply template from the new client&apos;s config.</p>
                <div className="flex gap-2">
                  <Input value={reallocateTag} onChange={(e) => setReallocateTag(e.target.value)} placeholder="Client tag (e.g., ABM)" className="w-40 h-9 text-sm font-mono" />
                  <Button size="sm" className="h-9" onClick={handleReallocate} disabled={!reallocateTag}>Reallocate</Button>
                </div>
              </div>
            )}

            {/* CC/BCC Display */}
            {(detail.cc_email_1 || detail.bcc_email_1) && (
              <div className="rounded-lg border bg-white p-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">CC / BCC Recipients</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                  {[1,2,3,4,5,6].map((n) => detail[`cc_email_${n}`] && (
                    <div key={`cc${n}`} className="text-xs">
                      <span className="text-muted-foreground">CC {n}: </span>
                      {detail[`cc_name_${n}`] && <span>{detail[`cc_name_${n}`]} </span>}
                      <span className="text-primary">{detail[`cc_email_${n}`]}</span>
                    </div>
                  ))}
                  {[1,2].map((n) => detail[`bcc_email_${n}`] && (
                    <div key={`bcc${n}`} className="text-xs">
                      <span className="text-muted-foreground">BCC {n}: </span>
                      {detail[`bcc_name_${n}`] && <span>{detail[`bcc_name_${n}`]} </span>}
                      <span className="text-primary">{detail[`bcc_email_${n}`]}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Our Reply Template */}
            {detail.our_reply && (
              <div className="rounded-lg border bg-white p-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Reply Template</p>
                <div className="bg-muted/20 rounded p-3 text-sm whitespace-pre-wrap">{detail.our_reply}</div>
              </div>
            )}

            {/* ── Send Reply ── */}
            <div className="rounded-lg border bg-white p-4 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Send Reply</p>
              <p className="text-[11px] text-muted-foreground">To: {detail.lead_email}</p>
              <Textarea value={replyMessage} onChange={(e) => setReplyMessage(e.target.value)} rows={5} placeholder="Type your reply..." className="text-sm" />
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">CC (comma-separated emails)</Label><Input value={replyCc} onChange={(e) => setReplyCc(e.target.value)} placeholder="cc1@email.com, cc2@email.com" className="text-xs h-8" /></div>
                <div><Label className="text-xs text-muted-foreground">BCC (comma-separated emails)</Label><Input value={replyBcc} onChange={(e) => setReplyBcc(e.target.value)} placeholder="bcc@email.com" className="text-xs h-8" /></div>
              </div>
              <Button size="sm" onClick={handleSendReply} disabled={sending === "reply" || !replyMessage}>{sending === "reply" ? "Sending..." : "Send Reply"}</Button>
            </div>

            {/* ── Forward ── */}
            <div className="rounded-lg border bg-white p-4 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Forward Reply</p>
              <div><Label className="text-xs text-muted-foreground">Forward to</Label><Input value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} placeholder="email@example.com" className="text-sm h-9" /></div>
              <Button size="sm" variant="outline" onClick={handleForward} disabled={sending === "forward" || !forwardTo}>{sending === "forward" ? "Forwarding..." : "Forward"}</Button>
            </div>

            {/* ── One-Off Reply ── */}
            <div className="rounded-lg border bg-white p-4 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Send One-Off Reply</p>
              <p className="text-[11px] text-muted-foreground">To: {detail.lead_email}</p>
              <div><Label className="text-xs text-muted-foreground">Subject</Label><Input value={oneOffSubject} onChange={(e) => setOneOffSubject(e.target.value)} className="text-sm h-9" /></div>
              <div><Label className="text-xs text-muted-foreground">Message</Label><Textarea value={oneOffMessage} onChange={(e) => setOneOffMessage(e.target.value)} rows={4} className="text-sm" /></div>
              <div><Label className="text-xs text-muted-foreground">CC (comma-separated)</Label><Input value={oneOffCc} onChange={(e) => setOneOffCc(e.target.value)} placeholder="cc@email.com" className="text-xs h-8" /></div>
              <Button size="sm" variant="outline" onClick={handleOneOff} disabled={sending === "oneoff" || !oneOffMessage || !oneOffSubject}>{sending === "oneoff" ? "Sending..." : "Send One-Off"}</Button>
            </div>

            {/* ── Notes ── */}
            <div className="rounded-lg border bg-white p-4 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Notes</p>
              <Textarea
                value={detail.notes || ""}
                onChange={(e) => setDetail({ ...detail, notes: e.target.value })}
                onBlur={() => mutate({ action: "update-notes", id: detail.id, notes: detail.notes || "" })}
                placeholder="Add notes..." rows={2} className="text-sm resize-none"
              />
            </div>

            {/* ── Blacklist ── */}
            <div className="rounded-lg border border-destructive/20 bg-white p-4 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-destructive">Blacklist Domain</p>
                <p className="text-[11px] text-muted-foreground">Block all emails from {detail.lead_email?.split("@")[1]}</p>
              </div>
              <Button size="sm" variant="destructive" onClick={handleBlacklist}>Blacklist</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
