"use client";

/**
 * Data View (ReplyRouter spec §13) — an Airtable-style, row-based view of the
 * active inbox: wider/taller rows, readable reply content, full From/To/CC/BCC
 * visibility (§6), filtering, sorting, multi-select + drag-select, and bulk
 * actions that flow through the Bulk Review Queue (§14) — nothing runs until
 * every selected reply has been reviewed.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableCombobox } from "@/components/ui/searchable-combobox";
import { Textarea } from "@/components/ui/textarea";
import { InstanceBadge } from "@/components/instance-badge";
import { initials } from "@/components/email-participants";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  computeReplyRecipients, sendReplyTemplateFor, isSendReplyCategory,
  PRIMARY_CONTACT_CATEGORY, CAT_DOT, type Recipient,
} from "@/lib/reply-compose";

const LEAD_CATEGORIES = [
  "Open Response", "Interested", "Meeting Request", "Meeting Set", "Automated Reply",
  "Change Of Target", "Closed Won", "Do Not Contact", "Email Address Changed", "Follow Up",
  "Internally Forwarded", "Lost", "Mailbox No Longer Active", "Meeting-Ready Lead", "Needs Review",
  "Not Interested", "Not Interested (Send Reply)", "Out Of Office", "Person No Longer Employed",
  "Referral Given", "Request for Primary Point of Contact (Send Reply)", "Unqualified (Cleaning)", "Wrong Person",
];
const AI_CATEGORIES = [
  "Interested", "Meeting Request", "Follow Up at a Later Date", "Not Interested", "Out Of Office",
  "Wrong Person", "Mailbox No Longer Active", "Automated Error Message", "Automated Catch-All Message",
  "Wrong Person (Change of Target)", "Do Not Contact", "Referral Given", "Internally Forwarded",
  "Person No Longer Employed", "Email Address Changed", "Unrecognizable by AI",
];
const SORTS: { key: string; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "recently_categorized", label: "Recently categorized" },
  { key: "name_az", label: "Contact A–Z" },
  { key: "company_az", label: "Company A–Z" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

type CardType = "category" | "send-reply" | "change-of-target";
function cardTypeFor(cat: string): CardType {
  if (cat === "Change Of Target") return "change-of-target";
  if (isSendReplyCategory(cat)) return "send-reply";
  return "category";
}
function nonSendCategoryFor(cat: string): string {
  return cat.replace(/\s*\(send reply\)/i, "").trim() || "Open Response";
}

interface ReviewCard {
  row: Row;
  type: CardType;
  category: string;
  status: "pending" | "approved" | "declined";
  loading: boolean;
  error?: string;
  expanded: boolean;
  // send-reply / change-of-target
  fromEmail: string;
  senderEmailId: number | null;
  toEmail: string; toName: string;
  cc: Recipient[]; bcc: Recipient[];
  message: string;
  subject?: string;
  // change-of-target
  candidates?: { email: string; name: string | null }[];
  // send-reply regenerate
  instructions: string;
  regenerating: boolean;
}

async function mutate(body: Record<string, unknown>) {
  const res = await fetch("/api/inbox/mutate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
}

function CatPill({ cat }: { cat: string }) {
  if (!cat) return <span className="text-muted-foreground/50">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap">
      <span className={`h-1.5 w-1.5 rounded-full ${CAT_DOT[cat] || "bg-gray-300"}`} />
      {cat}
    </span>
  );
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(t));
}
function recipientCount(names?: string | null, emails?: string | null): number {
  return String(emails || "").split(",").map((s) => s.trim()).filter(Boolean).length ||
    String(names || "").split(",").map((s) => s.trim()).filter(Boolean).length;
}

export default function DataViewPage() {
  // ── Filters ──
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [clientTag, setClientTag] = useState("");
  const [category, setCategory] = useState("");
  const [aiCategory, setAiCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("newest");
  const [clientTags, setClientTags] = useState<string[]>([]);

  // ── Data ──
  const [rows, setRows] = useState<Row[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Selection ──
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const dragging = useRef(false);
  const dragAnchor = useRef<number | null>(null);
  const dragMoved = useRef(false);
  const selSnapshot = useRef<Set<number>>(new Set());

  // ── Bulk review queue ──
  const [queue, setQueue] = useState<ReviewCard[] | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async (reset: boolean) => {
    const nextOffset = reset ? 0 : offset;
    if (reset) setLoading(true); else setLoadingMore(true);
    try {
      const p = new URLSearchParams({ sort, limit: "50", offset: String(nextOffset) });
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (clientTag) p.set("client_tag", clientTag);
      if (category) p.set("category", category);
      if (aiCategory) p.set("ai_category", aiCategory);
      if (from) p.set("date_from", from);
      if (to) p.set("date_to", to);
      const res = await fetch(`/api/data-view?${p}`);
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) { setError(`Failed (${res.status})`); return; }
      const d = await res.json();
      setError(null);
      setTotal(d.page?.total ?? null);
      setHasMore(!!d.page?.hasMore);
      setOffset(nextOffset + (d.rows?.length || 0));
      setRows((prev) => (reset ? d.rows : [...prev, ...d.rows]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false); setLoadingMore(false);
    }
  }, [sort, debouncedSearch, clientTag, category, aiCategory, from, to, offset]);

  // Reset + reload whenever a filter/sort changes.
  useEffect(() => {
    setSelected(new Set()); setExpandedRow(null); setOffset(0);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, debouncedSearch, clientTag, category, aiCategory, from, to]);

  // Client tags for the filter combobox.
  useEffect(() => {
    fetch("/api/inbox?mode=client_tags").then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.clientTags) setClientTags(d.clientTags);
    }).catch(() => {});
  }, []);

  // Stop drag-select on mouse up anywhere.
  useEffect(() => {
    const up = () => {
      if (!dragging.current) return;
      if (!dragMoved.current && dragAnchor.current != null) {
        // A plain click → toggle that single row.
        const id = dragAnchor.current;
        setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
      }
      dragging.current = false; dragAnchor.current = null; dragMoved.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const idIndex = useMemo(() => new Map(rows.map((r, i) => [r.id as number, i])), [rows]);

  function onCheckboxDown(id: number) {
    dragging.current = true; dragAnchor.current = id; dragMoved.current = false;
    selSnapshot.current = new Set(selected);
  }
  function onRowEnter(id: number) {
    if (!dragging.current || dragAnchor.current == null) return;
    dragMoved.current = true;
    const a = idIndex.get(dragAnchor.current); const b = idIndex.get(id);
    if (a == null || b == null) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const next = new Set(selSnapshot.current);
    for (let i = lo; i <= hi; i++) next.add(rows[i].id as number);
    setSelected(next);
  }
  const allLoadedSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function toggleAll() {
    setSelected(allLoadedSelected ? new Set() : new Set(rows.map((r) => r.id as number)));
  }
  function clearFilters() {
    setSearch(""); setClientTag(""); setCategory(""); setAiCategory(""); setFrom(""); setTo(""); setSort("newest");
  }
  const anyFilter = !!(search || clientTag || category || aiCategory || from || to);

  // ── Open the review queue for the current selection + chosen category ──
  async function openQueue(chosenCategory: string) {
    const chosen = rows.filter((r) => selected.has(r.id));
    if (!chosen.length) return;
    const type = cardTypeFor(chosenCategory);
    const cards: ReviewCard[] = chosen.map((row) => {
      const { to: t, cc, bcc } = computeReplyRecipients(row, chosenCategory);
      return {
        row, type, category: chosenCategory, status: "pending",
        loading: type !== "category", expanded: false,
        fromEmail: String(row.sender_email || ""),
        senderEmailId: (row.sender_id as number | null) ?? null,
        toEmail: t.email, toName: t.name, cc, bcc,
        message: type === "send-reply" ? sendReplyTemplateFor(chosenCategory, row) : "",
        instructions: "", regenerating: false,
      };
    });
    setQueue(cards);

    // Prepare async data per card (COT candidates / primary-contact scenario draft).
    cards.forEach((card, i) => {
      if (card.type === "change-of-target") {
        mutate({ action: "prepare-change-of-target", id: card.row.id }).then((d) => {
          patchCard(i, d.ok
            ? {
                loading: false, candidates: d.candidates || [],
                toEmail: d.candidates?.[0]?.email || "", toName: d.candidates?.[0]?.name || "",
                subject: d.subject || "", message: (d.messageTemplate || "").replaceAll("{FIRST_NAME}", (d.candidates?.[0]?.name || "there").split(/\s+/)[0]),
                senderEmailId: d.senderEmailId ?? card.senderEmailId,
              }
            : { loading: false, error: d.reason || "Couldn't prepare Change of Target" });
        }).catch((e) => patchCard(i, { loading: false, error: String(e) }));
      } else if (card.type === "send-reply" && card.category === PRIMARY_CONTACT_CATEGORY) {
        mutate({ action: "primary-contact-reply", id: card.row.id, firstName: (String(card.row.lead_name || card.row.from_name || "there")).split(/\s+/)[0] })
          .then((d) => patchCard(i, { loading: false, message: d?.ok && d.message ? d.message : card.message }))
          .catch(() => patchCard(i, { loading: false }));
      }
    });
  }
  function patchCard(i: number, patch: Partial<ReviewCard>) {
    setQueue((prev) => prev ? prev.map((c, j) => (j === i ? { ...c, ...patch } : c)) : prev);
  }
  async function regenerateCard(i: number) {
    setQueue((prev) => { if (!prev) return prev; const c = prev[i]; if (!c) return prev; return prev.map((x, j) => j === i ? { ...x, regenerating: true } : x); });
    const c = queue?.[i]; if (!c) return;
    const d = await mutate({ action: "regenerate-reply", id: c.row.id, currentDraft: c.message, instructions: c.instructions, leadName: c.toName });
    patchCard(i, d?.ok && d.message ? { message: d.message, instructions: "", regenerating: false } : { regenerating: false });
    if (!d?.ok) toast.error(d?.error || "Couldn't regenerate");
  }

  const reviewedCount = queue ? queue.filter((c) => c.status !== "pending").length : 0;
  const approvedCount = queue ? queue.filter((c) => c.status === "approved").length : 0;
  const allReviewed = !!queue && reviewedCount === queue.length;

  // ── Run the batch: approved run their action; declined go to the matching
  //    non-send category / Open Response (§14). ──
  async function runBatch() {
    if (!queue || !allReviewed) return;
    setRunning(true);
    let ok = 0, fail = 0;
    for (const c of queue) {
      try {
        if (c.status === "declined") {
          const target = c.type === "change-of-target" ? "Open Response" : nonSendCategoryFor(c.category);
          await mutate({ action: "update-category", id: c.row.id, category: target });
          ok++;
          continue;
        }
        if (c.type === "category") {
          const d = await mutate({ action: "update-category", id: c.row.id, category: c.category });
          d.ok ? ok++ : fail++;
        } else if (c.type === "send-reply") {
          await mutate({ action: "update-category", id: c.row.id, category: c.category });
          const d = await mutate({
            action: "send-reply", id: c.row.id, replyId: c.row.reply_id, senderEmailId: c.senderEmailId,
            message: c.message, toEmail: c.toEmail, toName: c.toName,
            ccEmails: c.cc.filter((r) => r.email).map((r) => ({ name: r.name, email_address: r.email })),
            bccEmails: c.bcc.filter((r) => r.email).map((r) => ({ name: r.name, email_address: r.email })),
            clearAutoReply: true,
          });
          d.ok ? ok++ : fail++;
        } else {
          // change-of-target
          await mutate({ action: "update-category", id: c.row.id, category: "Change Of Target" });
          const d = await mutate({
            action: "send-change-of-target", id: c.row.id, senderEmailId: c.senderEmailId,
            toEmail: c.toEmail, toName: c.toName, subject: c.subject, message: c.message,
          });
          d.ok ? ok++ : fail++;
        }
      } catch { fail++; }
    }
    setRunning(false);
    setQueue(null);
    setSelected(new Set());
    toast[fail ? "warning" : "success"](`Batch done — ${ok} applied${fail ? `, ${fail} failed` : ""}`);
    load(true);
  }

  const selectedCount = selected.size;

  return (
    <div className="flex flex-col h-[calc(100vh-1px)]">
      {/* ── Header ── */}
      <div className="px-6 pt-5 pb-3 border-b bg-white">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Data View</h1>
            <p className="text-xs text-muted-foreground">{total != null ? `${total.toLocaleString()} replies` : "Active inbox"} · select rows to run bulk actions</p>
          </div>
          {anyFilter && <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>Clear filters</Button>}
        </div>

        {/* ── Filters ── */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, company, or reply content…" className="h-9 pl-8 text-sm" />
          </div>
          <div className="w-[190px]"><SearchableCombobox value={clientTag} onValueChange={setClientTag} options={clientTags} placeholder="All clients" /></div>
          <Select value={category || "all"} onValueChange={(v) => setCategory(v === "all" ? "" : v)}>
            <SelectTrigger className="h-9 w-[180px] text-xs"><SelectValue placeholder="Category" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All categories</SelectItem>{LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={aiCategory || "all"} onValueChange={(v) => setAiCategory(v === "all" ? "" : v)}>
            <SelectTrigger className="h-9 w-[180px] text-xs"><SelectValue placeholder="AI suggested" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All AI categories</SelectItem>{AI_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[140px] text-xs" title="From date" />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-[140px] text-xs" title="To date" />
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger className="h-9 w-[170px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{SORTS.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto bg-[#fafafa]">
        {error && <div className="m-4 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
        {loading ? (
          <div className="p-6 space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-14 rounded-lg bg-muted/40 animate-pulse" />)}</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-1">
            <p className="text-sm">No replies match these filters.</p>
            {anyFilter && <button onClick={clearFilters} className="text-xs text-primary hover:underline">Clear filters</button>}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-sm select-none">
            <thead className="sticky top-0 z-10">
              <tr className="[&>th]:bg-white [&>th]:border-b [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-left [&>th]:text-[10px] [&>th]:font-semibold [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-muted-foreground">
                <th className="w-10 !pl-4">
                  <input type="checkbox" checked={allLoadedSelected} onChange={toggleAll} className="h-3.5 w-3.5 cursor-pointer accent-primary" />
                </th>
                <th>Contact</th>
                <th className="w-[15%]">Company</th>
                <th className="w-[12%]">Recipients</th>
                <th className="w-[26%]">Reply</th>
                <th>Category</th>
                <th>AI Suggested</th>
                <th>Client</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isSel = selected.has(r.id);
                const isOpen = expandedRow === r.id;
                const toN = recipientCount(r.to_name, r.to_email);
                const ccN = recipientCount(r.prospect_cc_name, r.prospect_cc_email);
                const bccN = recipientCount(r.prospect_bcc_name, r.prospect_bcc_email);
                return (
                  <Fragment key={r.id}>
                    <tr
                      onMouseEnter={() => onRowEnter(r.id)}
                      className={`group cursor-pointer transition-colors [&>td]:border-b [&>td]:border-border/50 [&>td]:px-3 [&>td]:py-2.5 [&>td]:align-top ${isSel ? "bg-primary/5" : "bg-white hover:bg-muted/30"}`}
                      onClick={() => setExpandedRow(isOpen ? null : r.id)}
                    >
                      <td className="!pl-4" onClick={(e) => e.stopPropagation()} onMouseDown={() => onCheckboxDown(r.id)}>
                        <input type="checkbox" readOnly checked={isSel} className="h-3.5 w-3.5 cursor-pointer accent-primary" />
                      </td>
                      <td>
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center text-[10px] font-semibold">{initials(r.from_name || r.lead_name, r.lead_email)}</div>
                          <div className="min-w-0">
                            <div className="font-medium truncate max-w-[180px]">{r.from_name || r.lead_name || r.lead_email}</div>
                            <div className="text-[11px] text-muted-foreground truncate max-w-[180px]">{r.from_email || r.lead_email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="text-xs text-muted-foreground truncate max-w-[160px]">{r.company_name || "—"}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px]" title="To recipients">To {toN || 1}</span>
                          {ccN > 0 && <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px]" title="CC recipients">CC {ccN}</span>}
                          {bccN > 0 && <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px]" title="BCC recipients">BCC {bccN}</span>}
                        </div>
                      </td>
                      <td>
                        <p className={`text-xs text-foreground/80 ${isOpen ? "" : "line-clamp-2"} max-w-[360px] whitespace-pre-wrap`}>{r.reply_we_got || <span className="text-muted-foreground/50">No content</span>}</p>
                      </td>
                      <td><CatPill cat={r.lead_category} /></td>
                      <td className="text-[11px] text-muted-foreground max-w-[130px] truncate">{r.ai_categorized_lead_category || "—"}</td>
                      <td><span className="font-mono text-[10px] font-bold text-primary">{r.client_tag || "N/A"}</span></td>
                      <td className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtDate(r.created_at)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-white">
                        <td />
                        <td colSpan={8} className="border-b border-border/50 px-3 pb-4 pt-0">
                          <div className="rounded-lg border bg-muted/10 divide-y divide-border/40 text-[11px]">
                            <RecRow label="From" name={r.from_name} email={r.from_email || r.lead_email} />
                            <RecRow label="To" name={r.to_name} email={r.to_email} />
                            <RecRow label="CC" name={r.prospect_cc_name} email={r.prospect_cc_email} />
                            <RecRow label="BCC" name={r.prospect_bcc_name} email={r.prospect_bcc_email} />
                          </div>
                          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <InstanceBadge instance={r.bison_instance} />
                            <span>Sender: {r.sender_email || "—"}</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {hasMore && !loading && (
          <div className="p-4 text-center">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => load(false)} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}</Button>
          </div>
        )}
      </div>

      {/* ── Selection / bulk action bar ── */}
      {selectedCount > 0 && !queue && (
        <div className="sticky bottom-0 z-20 border-t bg-white/95 backdrop-blur px-6 py-3 shadow-[0_-4px_16px_-8px_rgba(0,0,0,0.15)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                {selectedCount} selected
              </span>
              <button onClick={() => setSelected(new Set())} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Apply to all →</span>
              <Select value="" onValueChange={(v) => v && openQueue(v)}>
                <SelectTrigger className="h-9 w-[240px] text-xs"><SelectValue placeholder="Choose a category / action…" /></SelectTrigger>
                <SelectContent>{LEAD_CATEGORIES.filter((c) => c !== "Open Response").map((c) => (
                  <SelectItem key={c} value={c}>{cardTypeFor(c) === "change-of-target" ? "↪ " : isSendReplyCategory(c) ? "✉ " : ""}{c}</SelectItem>
                ))}</SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk Review Queue (§14) ── */}
      {queue && (
        <ReviewQueue
          cards={queue}
          reviewed={reviewedCount}
          approved={approvedCount}
          allReviewed={allReviewed}
          running={running}
          onClose={() => !running && setQueue(null)}
          onPatch={patchCard}
          onRegenerate={regenerateCard}
          onRun={runBatch}
        />
      )}
    </div>
  );
}

function RecRow({ label, name, email }: { label: string; name?: string | null; email?: string | null }) {
  const es = String(email || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ns = String(name || "").split(",").map((s) => s.trim());
  const people = es.length ? es.map((e, i) => ({ name: ns[i] || "", email: e })) : ns.filter(Boolean).map((n) => ({ name: n, email: "" }));
  if (!people.length) return null;
  return (
    <div className="flex items-start gap-2.5 px-3 py-1.5">
      <span className="w-7 shrink-0 pt-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">{label}</span>
      <div className="flex flex-wrap gap-1">
        {people.map((p, i) => (
          <span key={i} className="inline-flex items-baseline gap-1 rounded bg-muted/50 px-1.5 py-0.5">
            {p.name && <span className="font-medium">{p.name}</span>}
            {p.email && <span className="text-muted-foreground">{p.email}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Bulk Review Queue overlay ──────────────────────────────────────────────
function ReviewQueue({
  cards, reviewed, approved, allReviewed, running, onClose, onPatch, onRegenerate, onRun,
}: {
  cards: ReviewCard[]; reviewed: number; approved: number; allReviewed: boolean; running: boolean;
  onClose: () => void; onPatch: (i: number, p: Partial<ReviewCard>) => void;
  onRegenerate: (i: number) => void; onRun: () => void;
}) {
  const action = cardTypeFor(cards[0]?.category || "");
  const actionLabel = action === "change-of-target" ? "Change of Target" : action === "send-reply" ? "Send Reply" : "Set Category";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/40">
      <div className="flex-1 overflow-hidden flex flex-col bg-[#fafafa] mt-8 rounded-t-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b bg-white px-6 py-4">
          <div>
            <h2 className="text-base font-semibold">Review Queue — Bulk {actionLabel}</h2>
            <p className="text-xs text-muted-foreground">{cards[0]?.category} · every reply must be reviewed before the batch runs</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs font-medium">{reviewed} / {cards.length} reviewed</div>
              <div className="mt-1 h-1.5 w-40 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(reviewed / cards.length) * 100}%` }} />
              </div>
            </div>
            <button onClick={onClose} disabled={running} className="text-2xl leading-none text-muted-foreground hover:text-foreground disabled:opacity-40">×</button>
          </div>
        </div>

        {/* Cards */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {cards.map((c, i) => <ReviewCardView key={c.row.id} card={c} index={i} onPatch={onPatch} onRegenerate={onRegenerate} />)}
        </div>

        {/* Footer */}
        <div className="border-t bg-white px-6 py-3 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {approved} approved · {cards.length - reviewed} awaiting review
            {!allReviewed && <span className="text-amber-600"> — review every card to run the batch</span>}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={onClose} disabled={running}>Cancel</Button>
            <Button size="sm" className="h-9 text-xs" onClick={onRun} disabled={!allReviewed || running}>
              {running ? "Running…" : `Run batch (${approved} approved)`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewCardView({ card: c, index: i, onPatch, onRegenerate }: {
  card: ReviewCard; index: number; onPatch: (i: number, p: Partial<ReviewCard>) => void; onRegenerate: (i: number) => void;
}) {
  const ring = c.status === "approved" ? "border-green-300 bg-green-50/40" : c.status === "declined" ? "border-gray-300 bg-gray-50/60 opacity-70" : "border-border bg-white";
  return (
    <div className={`rounded-xl border ${ring} transition-colors`}>
      {/* Card header */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/50">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center text-[10px] font-semibold">{initials(c.row.from_name || c.row.lead_name, c.row.lead_email)}</div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{c.row.from_name || c.row.lead_name || c.row.lead_email}</div>
            <div className="text-[11px] text-muted-foreground truncate">{c.row.lead_email} · <span className="font-mono">{c.row.client_tag || "N/A"}</span></div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <CatPill cat={c.category} />
          {c.status === "approved" && <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">Approved</span>}
          {c.status === "declined" && <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600">Declined</span>}
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Original reply */}
        <div>
          <button onClick={() => onPatch(i, { expanded: !c.expanded })} className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">Original reply {c.expanded ? "▾" : "▸"}</button>
          <p className={`mt-1 text-xs text-foreground/80 whitespace-pre-wrap ${c.expanded ? "" : "line-clamp-2"}`}>{c.row.reply_we_got || "No content"}</p>
        </div>

        {c.loading ? (
          <p className="text-xs text-muted-foreground py-2">Preparing…</p>
        ) : c.error ? (
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{c.error}</div>
        ) : c.type !== "category" ? (
          <>
            {/* Recipients + sending account */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sending account</label>
                <div className="rounded border bg-muted/20 px-2.5 py-1.5 text-xs truncate">{c.fromEmail || "—"}</div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{c.type === "change-of-target" ? "Send to" : "To"}</label>
                {c.type === "change-of-target" && (c.candidates?.length || 0) > 0 && (
                  <Select value={c.toEmail} onValueChange={(v) => { const cand = c.candidates?.find((x) => x.email === v); onPatch(i, { toEmail: v, toName: cand?.name || "" }); }}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{c.candidates?.map((cand, k) => <SelectItem key={cand.email} value={cand.email}>{cand.name ? `${cand.name} — ` : ""}{cand.email}{k === 0 ? "  · recommended" : ""}</SelectItem>)}</SelectContent>
                  </Select>
                )}
                <div className="flex gap-1.5">
                  <Input value={c.toName} onChange={(e) => onPatch(i, { toName: e.target.value })} placeholder="Name" className="h-8 text-xs flex-1" />
                  <Input value={c.toEmail} onChange={(e) => onPatch(i, { toEmail: e.target.value })} placeholder="email@example.com" className="h-8 text-xs flex-[2]" />
                </div>
              </div>
            </div>
            {c.type === "send-reply" && (c.cc.length > 0 || c.bcc.length > 0) && (
              <div className="text-[11px] text-muted-foreground">
                {c.cc.length > 0 && <span>CC: {c.cc.map((r) => r.email).join(", ")}</span>}
                {c.bcc.length > 0 && <span className="ml-3">BCC: {c.bcc.map((r) => r.email).join(", ")}</span>}
              </div>
            )}

            {/* Draft message */}
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Proposed message</label>
              {c.type === "change-of-target"
                ? <Textarea value={c.message} onChange={(e) => onPatch(i, { message: e.target.value })} rows={4} className="text-[11px] font-mono" />
                : <Textarea value={c.message} onChange={(e) => onPatch(i, { message: e.target.value })} rows={4} className="text-sm" />}
            </div>

            {/* Regenerate (send-reply) */}
            {c.type === "send-reply" && (
              <div className="flex gap-2">
                <Input value={c.instructions} onChange={(e) => onPatch(i, { instructions: e.target.value })} placeholder='AI instructions e.g. "shorter, warmer"' className="h-8 text-xs flex-1" disabled={c.regenerating} />
                <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={() => onRegenerate(i)} disabled={c.regenerating}>{c.regenerating ? "…" : "Regenerate"}</Button>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Will set the category to <strong>{c.category}</strong>.</p>
        )}

        {/* Card actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={() => onPatch(i, { status: "declined" })} disabled={c.status === "declined"}>
            {c.type === "category" ? "Skip" : "Decline"}
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={() => onPatch(i, { status: "approved" })} disabled={c.loading || !!c.error || c.status === "approved" || (c.type !== "category" && (!c.message.trim() || !c.toEmail))}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
