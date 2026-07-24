"use client";

/**
 * Data View (ReplyRouter spec §13) — an Airtable-style grid over the active
 * inbox: resizable + drag-to-reorder columns, click-a-header sorting, inline
 * category editing, a right-side record panel (Airtable's row expander),
 * grouping with collapsible headers, full From/To/CC/BCC visibility (§6),
 * multi-select + drag-select, and bulk actions that flow through the Bulk
 * Review Queue (§14) — nothing runs until every selected reply is reviewed.
 *
 * Performance: /api/data-view fetches limit+1 rows (no COUNT — counting 127k+
 * rows blows the statement timeout), sorts only in index-served shapes, and
 * pages auto-load via an IntersectionObserver sentinel.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// ── Column model: resizable, reorderable, header-click sortable ────────────
interface ColDef { id: string; label: string; width: number; min: number; sortCol?: string }
const DEFAULT_COLS: ColDef[] = [
  { id: "contact", label: "Contact", width: 240, min: 170, sortCol: "lead_name" },
  { id: "company", label: "Company", width: 160, min: 110, sortCol: "company_name" },
  { id: "recipients", label: "Recipients", width: 120, min: 96 },
  { id: "reply", label: "Reply", width: 420, min: 200 },
  { id: "category", label: "Category", width: 200, min: 150, sortCol: "lead_category" },
  { id: "ai", label: "AI Suggested", width: 150, min: 110, sortCol: "ai_categorized_lead_category" },
  { id: "client", label: "Client", width: 90, min: 70, sortCol: "client_tag" },
  { id: "received", label: "Received", width: 120, min: 100, sortCol: "created_at" },
];
const COLS_LS_KEY = "dataview-cols-v1";

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
  fromEmail: string;
  senderEmailId: number | null;
  toEmail: string; toName: string;
  cc: Recipient[]; bcc: Recipient[];
  message: string;
  subject?: string;
  candidates?: { email: string; name: string | null }[];
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
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap max-w-full">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CAT_DOT[cat] || "bg-gray-300"}`} />
      <span className="truncate">{cat}</span>
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
  const [clientTags, setClientTags] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState("");           // "" | lead_category | client_tag | ai
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // ── Sort (click-a-header) ──
  const [sortCol, setSortCol] = useState("created_at");
  const [sortAsc, setSortAsc] = useState(false);

  // ── Columns (resize + reorder, persisted) ──
  const [cols, setCols] = useState<ColDef[]>(DEFAULT_COLS);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_LS_KEY) || "null") as { id: string; width: number }[] | null;
      if (saved?.length) {
        const byId = new Map(DEFAULT_COLS.map((c) => [c.id, c]));
        const next = saved.map((s) => byId.get(s.id) ? { ...byId.get(s.id)!, width: s.width } : null).filter(Boolean) as ColDef[];
        DEFAULT_COLS.forEach((c) => { if (!next.find((n) => n.id === c.id)) next.push(c); });
        setCols(next);
      }
    } catch { /* */ }
  }, []);
  function persistCols(next: ColDef[]) {
    setCols(next);
    try { localStorage.setItem(COLS_LS_KEY, JSON.stringify(next.map((c) => ({ id: c.id, width: c.width })))); } catch { /* */ }
  }
  // Resize
  const resizing = useRef<{ id: string; startX: number; startW: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const r = resizing.current; if (!r) return;
      setCols((prev) => prev.map((c) => c.id === r.id ? { ...c, width: Math.max(c.min, r.startW + (e.clientX - r.startX)) } : c));
    };
    const up = () => { if (resizing.current) { resizing.current = null; setCols((prev) => { persistCols(prev); return prev; }); } };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Reorder (HTML5 drag on headers)
  const dragCol = useRef<string | null>(null);
  function onColDrop(targetId: string) {
    const src = dragCol.current; dragCol.current = null;
    if (!src || src === targetId) return;
    setCols((prev) => {
      const next = prev.slice();
      const si = next.findIndex((c) => c.id === src), ti = next.findIndex((c) => c.id === targetId);
      if (si < 0 || ti < 0) return prev;
      const [moved] = next.splice(si, 1);
      next.splice(ti, 0, moved);
      persistCols(next);
      return next;
    });
  }
  function onHeaderClick(c: ColDef) {
    if (!c.sortCol) return;
    if (sortCol === c.sortCol) setSortAsc((a) => !a);
    else { setSortCol(c.sortCol); setSortAsc(c.sortCol !== "created_at" && c.sortCol !== "categorized_at"); }
  }

  // ── Data ──
  const [rows, setRows] = useState<Row[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  // ── Selection ──
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const dragging = useRef(false);
  const dragAnchor = useRef<number | null>(null);
  const dragMoved = useRef(false);
  const selSnapshot = useRef<Set<number>>(new Set());

  // ── Right-side record panel (Airtable row expander) ──
  const [panelRow, setPanelRow] = useState<Row | null>(null);
  const [panelDetail, setPanelDetail] = useState<Row | null>(null);

  // ── Inline category editing ──
  const [editingCell, setEditingCell] = useState<number | null>(null);

  // ── Bulk review queue ──
  const [queue, setQueue] = useState<ReviewCard[] | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async (reset: boolean) => {
    const mine = ++reqRef.current;
    const nextOffset = reset ? 0 : offset;
    if (reset) setLoading(true); else setLoadingMore(true);
    try {
      const p = new URLSearchParams({ sort: `${sortCol}.${sortAsc ? "asc" : "desc"}`, limit: "50", offset: String(nextOffset) });
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (clientTag) p.set("client_tag", clientTag);
      if (category) p.set("category", category);
      if (aiCategory) p.set("ai_category", aiCategory);
      if (from) p.set("date_from", from);
      if (to) p.set("date_to", to);
      const res = await fetch(`/api/data-view?${p}`);
      if (mine !== reqRef.current) return;
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) { setError(`Failed (${res.status})`); return; }
      const d = await res.json();
      setError(null);
      setHasMore(!!d.page?.hasMore);
      setOffset(nextOffset + (d.rows?.length || 0));
      setRows((prev) => (reset ? d.rows : [...prev, ...d.rows]));
    } catch (e) {
      if (mine === reqRef.current) setError((e as Error).message);
    } finally {
      if (mine === reqRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [sortCol, sortAsc, debouncedSearch, clientTag, category, aiCategory, from, to, offset]);

  // Reset + reload on filter/sort change.
  useEffect(() => {
    setSelected(new Set()); setOffset(0);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortCol, sortAsc, debouncedSearch, clientTag, category, aiCategory, from, to]);

  // Client tags for the filter combobox.
  useEffect(() => {
    fetch("/api/inbox?mode=client_tags").then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.clientTags) setClientTags(d.clientTags);
    }).catch(() => {});
  }, []);

  // Auto-load next page when the sentinel scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasMore && !loading && !loadingMore) load(false);
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadingMore, load]);

  // Drag-select: finish on mouseup anywhere.
  useEffect(() => {
    const up = () => {
      if (!dragging.current) return;
      if (!dragMoved.current && dragAnchor.current != null) {
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
    setSearch(""); setClientTag(""); setCategory(""); setAiCategory(""); setFrom(""); setTo("");
  }
  const anyFilter = !!(search || clientTag || category || aiCategory || from || to);

  // ── Grouping (client-side over loaded rows) ──
  const groupKey = useCallback((r: Row): string => {
    if (groupBy === "lead_category") return r.lead_category || "Open Response";
    if (groupBy === "client_tag") return r.client_tag || "N/A";
    if (groupBy === "ai") return r.ai_categorized_lead_category || "—";
    return "";
  }, [groupBy]);
  const grouped = useMemo(() => {
    if (!groupBy) return null;
    const order: string[] = [];
    const map = new Map<string, Row[]>();
    for (const r of rows) {
      const k = groupKey(r);
      if (!map.has(k)) { map.set(k, []); order.push(k); }
      map.get(k)!.push(r);
    }
    return order.map((k) => ({ key: k, rows: map.get(k)! }));
  }, [rows, groupBy, groupKey]);
  function toggleGroup(k: string) {
    setCollapsed((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }
  function selectGroup(rowsIn: Row[], all: boolean) {
    setSelected((prev) => {
      const n = new Set(prev);
      rowsIn.forEach((r) => { all ? n.add(r.id as number) : n.delete(r.id as number); });
      return n;
    });
  }

  // ── Open the right-side record panel ──
  function openPanel(r: Row) {
    setPanelRow(r); setPanelDetail(null);
    fetch(`/api/inbox/${r.id}`).then((res) => res.ok ? res.json() : null).then((d) => {
      setPanelDetail((prev) => (d && panelRowRef.current?.id === r.id ? d : prev));
    }).catch(() => {});
  }
  const panelRowRef = useRef<Row | null>(null);
  useEffect(() => { panelRowRef.current = panelRow; }, [panelRow]);

  // ── Inline category change (plain categories apply instantly; send/COT
  //    categories route through a single-row review queue). ──
  async function inlineSetCategory(r: Row, cat: string) {
    setEditingCell(null);
    if (cat === (r.lead_category || "Open Response")) return;
    if (cardTypeFor(cat) !== "category") {
      openQueueFor([r], cat);
      return;
    }
    const old = r.lead_category;
    setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, lead_category: cat } : x));
    setPanelDetail((prev) => (prev && prev.id === r.id ? { ...prev, lead_category: cat } : prev));
    const d = await mutate({ action: "update-category", id: r.id, category: cat });
    if (d.ok) toast.success(`Category: ${cat}`);
    else {
      toast.error(d.error || "Update failed");
      setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, lead_category: old } : x));
    }
  }

  // ── Review queue ──
  function openQueue(chosenCategory: string) {
    openQueueFor(rows.filter((r) => selected.has(r.id)), chosenCategory);
  }
  function openQueueFor(chosen: Row[], chosenCategory: string) {
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
    const c = queue?.[i]; if (!c) return;
    patchCard(i, { regenerating: true });
    const d = await mutate({ action: "regenerate-reply", id: c.row.id, currentDraft: c.message, instructions: c.instructions, leadName: c.toName });
    patchCard(i, d?.ok && d.message ? { message: d.message, instructions: "", regenerating: false } : { regenerating: false });
    if (!d?.ok) toast.error(d?.error || "Couldn't regenerate");
  }
  const reviewedCount = queue ? queue.filter((c) => c.status !== "pending").length : 0;
  const approvedCount = queue ? queue.filter((c) => c.status === "approved").length : 0;
  const allReviewed = !!queue && reviewedCount === queue.length;

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
  const totalWidth = 48 + cols.reduce((s, c) => s + c.width, 0);

  // ── Cell renderer ──
  function renderCell(c: ColDef, r: Row) {
    switch (c.id) {
      case "contact":
        return (
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center text-[10px] font-semibold">{initials(r.from_name || r.lead_name, r.lead_email)}</div>
            <div className="min-w-0">
              <div className="font-medium truncate text-[13px]">{r.from_name || r.lead_name || r.lead_email}</div>
              <div className="text-[11px] text-muted-foreground truncate">{r.from_email || r.lead_email}</div>
            </div>
          </div>
        );
      case "company":
        return <span className="text-xs text-muted-foreground line-clamp-2">{r.company_name || "—"}</span>;
      case "recipients": {
        const toN = recipientCount(r.to_name, r.to_email);
        const ccN = recipientCount(r.prospect_cc_name, r.prospect_cc_email);
        const bccN = recipientCount(r.prospect_bcc_name, r.prospect_bcc_email);
        return (
          <div className="flex flex-wrap gap-1">
            <span className="rounded bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium">To {toN || 1}</span>
            {ccN > 0 && <span className="rounded bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium">CC {ccN}</span>}
            {bccN > 0 && <span className="rounded bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium">BCC {bccN}</span>}
          </div>
        );
      }
      case "reply":
        return <p className="text-xs text-foreground/80 line-clamp-2 whitespace-pre-wrap">{r.reply_we_got || <span className="text-muted-foreground/50">No content</span>}</p>;
      case "category":
        return editingCell === r.id ? (
          <div onClick={(e) => e.stopPropagation()}>
            <Select open value={r.lead_category || "Open Response"} onOpenChange={(o) => !o && setEditingCell(null)} onValueChange={(v) => inlineSetCategory(r, v)}>
              <SelectTrigger className="h-7 text-[11px] w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{LEAD_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  <span className="inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${CAT_DOT[cat] || "bg-gray-300"}`} />{cat}</span>
                </SelectItem>
              ))}</SelectContent>
            </Select>
          </div>
        ) : (
          <button
            className="group/cat flex w-full items-center justify-between gap-1 rounded px-0.5 -mx-0.5 hover:bg-muted/40"
            onClick={(e) => { e.stopPropagation(); setEditingCell(r.id); }}
            title="Click to change category"
          >
            <CatPill cat={r.lead_category} />
            <svg className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover/cat:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="m6 9 6 6 6-6" /></svg>
          </button>
        );
      case "ai":
        return <span className="text-[11px] text-muted-foreground line-clamp-2">{r.ai_categorized_lead_category || "—"}</span>;
      case "client":
        return <span className="font-mono text-[10px] font-bold text-primary">{r.client_tag || "N/A"}</span>;
      case "received":
        return <span className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtDate(r.created_at)}</span>;
      default:
        return null;
    }
  }

  function renderRow(r: Row, ri: number) {
    const isSel = selected.has(r.id);
    const rowBg = isSel ? "bg-[#fdf6ec]" : "bg-white group-hover/row:bg-[#f8f9fb]";
    return (
      <tr
        key={r.id}
        onMouseEnter={() => onRowEnter(r.id)}
        className="group/row cursor-pointer [&>td]:border-b [&>td]:border-r [&>td]:border-border/60 [&>td]:px-3 [&>td]:py-2.5 [&>td]:align-middle"
        onClick={() => openPanel(r)}
      >
        {/* Gutter: number → checkbox on hover; expand button */}
        <td className={`!px-0 text-center sticky left-0 z-10 ${rowBg}`} style={{ width: 48, minWidth: 48 }} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-center gap-0.5" onMouseDown={() => onCheckboxDown(r.id)}>
            <span className={`text-[11px] text-muted-foreground/50 tabular-nums ${isSel ? "hidden" : "group-hover/row:hidden"}`}>{ri + 1}</span>
            <input type="checkbox" readOnly checked={isSel} className={`h-3.5 w-3.5 cursor-pointer accent-primary ${isSel ? "inline-block" : "hidden group-hover/row:inline-block"}`} />
          </div>
        </td>
        {cols.map((c, ci) => (
          <td key={c.id} className={`${rowBg} ${ci === 0 ? "sticky left-12 z-10" : ""} overflow-hidden`} style={{ width: c.width, minWidth: c.width, maxWidth: c.width }}>
            {ci === 0 ? (
              <div className="flex items-center gap-1 min-w-0">
                <div className="min-w-0 flex-1">{renderCell(c, r)}</div>
                {/* Airtable-style expand button, appears on hover */}
                <button
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-muted hover:text-foreground transition-opacity"
                  onClick={(e) => { e.stopPropagation(); openPanel(r); }}
                  title="Expand record"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
                </button>
              </div>
            ) : renderCell(c, r)}
          </td>
        ))}
      </tr>
    );
  }

  return (
    <div className="flex h-[calc(100vh-1px)]">
      <div className={`flex flex-col min-w-0 flex-1 ${panelRow ? "mr-[480px]" : ""} transition-[margin] duration-200`}>
        {/* ── Header ── */}
        <div className="px-6 pt-5 pb-3 border-b bg-white">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Data View</h1>
              <p className="text-xs text-muted-foreground">{loading ? "Loading…" : `${rows.length}${hasMore ? "+" : ""} replies`}{selectedCount > 0 ? ` · ${selectedCount} selected` : ""}</p>
            </div>
            <div className="flex items-center gap-2">
              <Select value={groupBy || "none"} onValueChange={(v) => { setGroupBy(v === "none" ? "" : v); setCollapsed(new Set()); }}>
                <SelectTrigger className="h-8 w-[170px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No grouping</SelectItem>
                  <SelectItem value="lead_category">Group by Category</SelectItem>
                  <SelectItem value="client_tag">Group by Client</SelectItem>
                  <SelectItem value="ai">Group by AI Suggested</SelectItem>
                </SelectContent>
              </Select>
              {anyFilter && <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>Clear filters</Button>}
            </div>
          </div>

          {/* ── Filters ── */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, company, or reply content…" className="h-9 pl-8 text-sm" />
            </div>
            <div className="w-[180px]"><SearchableCombobox value={clientTag} onValueChange={setClientTag} options={clientTags} placeholder="All clients" /></div>
            <Select value={category || "all"} onValueChange={(v) => setCategory(v === "all" ? "" : v)}>
              <SelectTrigger className="h-9 w-[175px] text-xs"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All categories</SelectItem>{LEAD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={aiCategory || "all"} onValueChange={(v) => setAiCategory(v === "all" ? "" : v)}>
              <SelectTrigger className="h-9 w-[175px] text-xs"><SelectValue placeholder="AI suggested" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All AI categories</SelectItem>{AI_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[135px] text-xs" title="From date" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-[135px] text-xs" title="To date" />
          </div>
        </div>

        {/* ── Grid ── */}
        <div className="flex-1 overflow-auto bg-[#fafafa]">
          {error && <div className="m-4 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
          {loading ? (
            <div className="p-6 space-y-2">{Array.from({ length: 9 }).map((_, i) => <div key={i} className="h-12 rounded-lg bg-muted/40 animate-pulse" />)}</div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-1">
              <p className="text-sm">No replies match these filters.</p>
              {anyFilter && <button onClick={clearFilters} className="text-xs text-primary hover:underline">Clear filters</button>}
            </div>
          ) : (
            <>
              <table className="border-separate border-spacing-0 text-sm select-none" style={{ width: totalWidth }}>
                <thead className="sticky top-0 z-20">
                  <tr>
                    <th className="bg-[#f6f6f7] border-b border-r border-border/70 !px-0 text-center sticky left-0 z-30" style={{ width: 48, minWidth: 48 }}>
                      <input type="checkbox" checked={allLoadedSelected} onChange={toggleAll} className="h-3.5 w-3.5 cursor-pointer accent-primary align-middle" />
                    </th>
                    {cols.map((c, ci) => {
                      const isSorted = c.sortCol && sortCol === c.sortCol;
                      return (
                        <th
                          key={c.id}
                          draggable
                          onDragStart={() => { dragCol.current = c.id; }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => onColDrop(c.id)}
                          onClick={() => onHeaderClick(c)}
                          className={`relative bg-[#f6f6f7] border-b border-r border-border/70 px-3 py-2 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap ${c.sortCol ? "cursor-pointer hover:bg-[#eeeef0]" : "cursor-grab"} ${ci === 0 ? "sticky left-12 z-30" : ""}`}
                          style={{ width: c.width, minWidth: c.width, maxWidth: c.width }}
                          title={c.sortCol ? "Click to sort · drag to reorder" : "Drag to reorder"}
                        >
                          <span className="inline-flex items-center gap-1">
                            {c.label}
                            {isSorted && (
                              <svg className="h-3 w-3 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                {sortAsc ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}
                              </svg>
                            )}
                          </span>
                          {/* Resize handle */}
                          <span
                            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); resizing.current = { id: c.id, startX: e.clientX, startW: c.width }; }}
                            onClick={(e) => e.stopPropagation()}
                            draggable={false}
                            className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                          />
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {grouped ? grouped.map((g) => {
                    const isCollapsed = collapsed.has(g.key);
                    const allSel = g.rows.every((r) => selected.has(r.id));
                    return (
                      <Fragment key={g.key}>
                        <tr className="sticky-group">
                          <td colSpan={cols.length + 1} className="border-b border-border/60 bg-[#f1f2f4] px-3 py-1.5">
                            <div className="flex items-center gap-2">
                              <button onClick={() => toggleGroup(g.key)} className="flex items-center gap-1.5 text-xs font-semibold hover:text-primary">
                                <svg className={`h-3 w-3 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path d="m6 9 6 6 6-6" /></svg>
                                {groupBy === "lead_category" && <span className={`h-2 w-2 rounded-full ${CAT_DOT[g.key] || "bg-gray-300"}`} />}
                                {g.key}
                              </button>
                              <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground border">{g.rows.length}</span>
                              <button onClick={() => selectGroup(g.rows, !allSel)} className="ml-1 text-[10px] text-muted-foreground hover:text-primary">{allSel ? "Deselect all" : "Select all"}</button>
                            </div>
                          </td>
                        </tr>
                        {!isCollapsed && g.rows.map((r) => renderRow(r, idIndex.get(r.id) ?? 0))}
                      </Fragment>
                    );
                  }) : rows.map((r, ri) => renderRow(r, ri))}
                </tbody>
              </table>
              {/* Infinite-scroll sentinel */}
              <div ref={sentinelRef} className="h-10 flex items-center justify-center">
                {loadingMore && <span className="text-xs text-muted-foreground">Loading more…</span>}
                {!hasMore && rows.length > 0 && <span className="text-[11px] text-muted-foreground/50">End of results</span>}
              </div>
            </>
          )}
        </div>

        {/* ── Selection / bulk action bar ── */}
        {selectedCount > 0 && !queue && (
          <div className="sticky bottom-0 z-20 border-t bg-white/95 backdrop-blur px-6 py-3 shadow-[0_-4px_16px_-8px_rgba(0,0,0,0.15)]">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">{selectedCount} selected</span>
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
      </div>

      {/* ── Right-side record panel (Airtable row expander) ── */}
      {panelRow && (
        <RecordPanel
          row={panelRow}
          detail={panelDetail}
          onClose={() => { setPanelRow(null); setPanelDetail(null); }}
          onSetCategory={(cat) => inlineSetCategory(panelRow, cat)}
        />
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

// ── Right-side record panel ────────────────────────────────────────────────
function RecordPanel({ row, detail, onClose, onSetCategory }: {
  row: Row; detail: Row | null; onClose: () => void; onSetCategory: (cat: string) => void;
}) {
  const d = detail || row;
  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed right-0 top-0 z-40 h-full w-[480px] border-l bg-white shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.15)] flex flex-col animate-in slide-in-from-right duration-200">
      {/* Panel header */}
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center text-xs font-semibold">{initials(d.from_name || d.lead_name, d.lead_email)}</div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate">{d.from_name || d.lead_name || d.lead_email}</h3>
            <p className="text-[11px] text-muted-foreground truncate">{d.lead_email}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <a href={`/inbox?reply=${row.id}`} className="rounded border px-2 py-1 text-[11px] font-medium hover:bg-muted" title="Open in Inbox">Open in Inbox ↗</a>
          <button onClick={onClose} className="rounded p-1 text-lg leading-none text-muted-foreground hover:bg-muted hover:text-foreground">×</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Badges */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] font-bold bg-primary/10 text-primary px-2 py-0.5 rounded">{d.client_tag || "N/A"}</span>
          <InstanceBadge instance={d.bison_instance} />
          {d.workflow && <span className="text-[10px] bg-muted px-2 py-0.5 rounded">{d.workflow}</span>}
          <span className="text-[10px] text-muted-foreground ml-auto">{fmtDate(d.created_at)}</span>
        </div>

        {/* Category (inline editable) */}
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Category</label>
          <Select value={d.lead_category || "Open Response"} onValueChange={onSetCategory}>
            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{LEAD_CATEGORIES.map((cat) => (
              <SelectItem key={cat} value={cat}>
                <span className="inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${CAT_DOT[cat] || "bg-gray-300"}`} />{cat}</span>
              </SelectItem>
            ))}</SelectContent>
          </Select>
          {d.ai_categorized_lead_category && <p className="text-[11px] text-muted-foreground">AI suggested: {d.ai_categorized_lead_category}</p>}
        </div>

        {/* Participants */}
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Participants</label>
          <div className="rounded-lg border divide-y divide-border/40 text-[11px]">
            <RecRow label="From" name={d.from_name} email={d.from_email || d.lead_email} />
            <RecRow label="To" name={d.to_name} email={d.to_email} />
            <RecRow label="CC" name={d.prospect_cc_name} email={d.prospect_cc_email} />
            <RecRow label="BCC" name={d.prospect_bcc_name} email={d.prospect_bcc_email} />
          </div>
        </div>

        {/* Details */}
        <div className="rounded-lg border px-3.5 py-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
            {[
              { l: "Company", v: d.company_name },
              { l: "Phone", v: d.phone },
              { l: "Location", v: [d.city, d.state].filter(Boolean).join(", ") },
              { l: "Sender", v: d.sender_email },
            ].map((f) => (
              <div key={f.l} className="min-w-0">
                <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">{f.l}</p>
                <p className="truncate">{f.v || "—"}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Reply content */}
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Reply</label>
          <div className="rounded-lg border bg-muted/10 px-3.5 py-3 text-[13px] whitespace-pre-wrap max-h-[320px] overflow-y-auto">
            {d.reply_we_got || <span className="text-muted-foreground/50">No content</span>}
          </div>
        </div>

        {/* Notes (when full detail is loaded) */}
        {detail && (
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Notes</label>
            <Textarea
              defaultValue={detail.notes || ""}
              onBlur={(e) => mutate({ action: "update-notes", id: row.id, notes: e.target.value })}
              placeholder="Notes…" rows={2} className="text-xs"
            />
          </div>
        )}
      </div>
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

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {cards.map((c, i) => <ReviewCardView key={c.row.id} card={c} index={i} onPatch={onPatch} onRegenerate={onRegenerate} />)}
        </div>

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
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Proposed message</label>
              {c.type === "change-of-target"
                ? <Textarea value={c.message} onChange={(e) => onPatch(i, { message: e.target.value })} rows={4} className="text-[11px] font-mono" />
                : <Textarea value={c.message} onChange={(e) => onPatch(i, { message: e.target.value })} rows={4} className="text-sm" />}
            </div>
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
