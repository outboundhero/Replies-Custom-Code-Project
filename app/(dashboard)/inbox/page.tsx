"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableCombobox } from "@/components/ui/searchable-combobox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { createClient } from "@supabase/supabase-js";
import { INBOX_VIEWS, getView, POSITIVE_CATEGORIES } from "@/lib/inbox-views";
import { useSession } from "@/components/session-provider";
import { peekFreshBootstrap, DEFAULT_VIEW, type InboxBootstrap } from "@/lib/inbox-prefetch";
import { useDebouncedValue } from "@/lib/use-debounced-value";
// Pure / no server deps — must NOT import from domain-blacklist (which
// pulls in @/lib/db and crashes the browser bundle with URL_INVALID).
import { isPersonalDomain } from "@/lib/processing/personal-domains";
import { InstanceBadge } from "@/components/instance-badge";

// Browser-side Supabase client for realtime (anon key)
const realtimeSupabase = createClient(
  "https://iiiupmanpycjcopcrkdh.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpaXVwbWFucHljamNvcGNya2RoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNjk1NzgsImV4cCI6MjA5MTg0NTU3OH0.psM-ngpfrDUJqRCy_r33eP664y5HfZq_W6elkMJ7D88"
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReplyDetail = Record<string, any>;

interface ReplyListItem {
  id: number; workflow: string; lead_email: string; lead_name: string; company_name: string;
  client_tag: string; bison_instance: string | null;
  ai_categorized_lead_category: string; lead_category: string;
  reply_status: string; industry_audit: string | null; location_audit: string | null;
  created_at: string; reply_id: number;
}

// Order: Open Response on top, then the three positive-engagement values
// (Interested, Meeting Request, Meeting Set), then everything else alphabetically.
// Keeps the most-used categories one click away.
const LEAD_CATEGORIES = [
  "Open Response",
  "Interested",
  "Meeting Request",
  "Meeting Set",
  // ── alphabetical from here ──
  "Automated Reply",
  "Change Of Target",
  "Closed Won",
  "Do Not Contact",
  "Follow Up",
  "Internally Forwarded",
  "Lost",
  "Mailbox No Longer Active",
  "Meeting-Ready Lead",
  "Needs Review",
  "Not Interested",
  "Not Interested (Send Reply)",
  "Out Of Office",
  "Referral Given",
  "Request for Primary Point of Contact (Send Reply)",
  "Unqualified (Cleaning)",
  "Wrong Person",
];

const catDot: Record<string, string> = {
  "Interested": "bg-green-500", "Meeting Set": "bg-green-600", "Meeting-Ready Lead": "bg-green-600",
  "Follow Up": "bg-blue-500", "Not Interested": "bg-gray-400", "Do Not Contact": "bg-red-500",
  "Out Of Office": "bg-yellow-500", "Wrong Person": "bg-orange-500", "Change Of Target": "bg-orange-400",
  "Automated Reply": "bg-gray-400", "Mailbox No Longer Active": "bg-gray-400",
  "Open Response": "bg-purple-500", "Needs Review": "bg-purple-400",
  "Referral Given": "bg-blue-600", "Internally Forwarded": "bg-blue-600",
  "Closed Won": "bg-emerald-600", "Lost": "bg-gray-500",
};

// Categories that trigger a send/approval flow — do NOT auto-advance to the
// next lead after these (the user must review/send the outgoing email).
const PRIMARY_CONTACT_CATEGORY = "Request for Primary Point of Contact (Send Reply)";
function isSendCategory(cat: string): boolean {
  return cat === "Change Of Target" || /\(send reply\)/i.test(cat);
}

// Canned reply for the primary-contact category — {FIRST_NAME} filled from the
// lead. The team reviews/sends it manually from the Send Reply composer.
const PRIMARY_CONTACT_TEMPLATE =
  "Thank you, {FIRST_NAME}. I appreciate you letting me know. Would you be able to provide the email address of your primary contact at the property management company? I'm asking because I'd like to see if they are currently in the market for the services we provide.";

function leadFirstName(d: ReplyDetail): string {
  const first = (d.first_name && String(d.first_name).trim()) || "";
  if (first) return first;
  const name = String(d.lead_name || d.from_name || "").trim();
  return name ? name.split(/\s+/)[0] : "there";
}
function resolvePrimaryContactTemplate(d: ReplyDetail): string {
  return PRIMARY_CONTACT_TEMPLATE.replaceAll("{FIRST_NAME}", leadFirstName(d));
}

function fmtDuration(secs: number): string {
  const m = Math.floor(secs / 60), s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Live, continuously-ticking speed-to-lead timer for a reply in Open Response.
function LiveTimer({ startIso }: { startIso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - Date.parse(startIso)) / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  const over = secs - 15 * 60;
  const past = over > 0;
  const pm = Math.floor(Math.abs(over) / 60), ps = String(Math.abs(over) % 60).padStart(2, "0");
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums px-2 py-0.5 rounded ${past ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"}`}
      title="Time this reply has been waiting in Open Response (standard: 15 min)"
    >
      ⚡ {mm}:{ss} waiting{past ? ` — ${pm}:${ps} past standard` : ""}
    </span>
  );
}

// Split the stored comma-joined name/email strings back into paired recipients.
function pairRecipients(names?: string | null, emails?: string | null): { name: string; email: string }[] {
  const es = String(emails || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ns = String(names || "").split(",").map((s) => s.trim());
  if (!es.length) return ns.filter(Boolean).map((name) => ({ name, email: "" }));
  return es.map((email, i) => ({ name: ns[i] || "", email }));
}
function EmailRow({ label, name, email }: { label: string; name?: string | null; email?: string | null }) {
  const people = pairRecipients(name, email);
  if (!people.length) return null;
  return (
    <div className="flex gap-2">
      <span className="w-9 shrink-0 text-muted-foreground font-medium">{label}</span>
      <span className="flex-1 break-all">
        {people.map((p, i) => (
          <span key={i}>
            {i > 0 && "; "}
            {p.name ? <span className="font-medium">{p.name} </span> : null}
            {p.email ? <span className="text-muted-foreground">&lt;{p.email}&gt;</span> : null}
          </span>
        ))}
      </span>
    </div>
  );
}

export default function InboxPage() {
  // Per-user scope comes from the server session (context) — no /api/auth fetch.
  const session = useSession();
  const scopedTags = session?.allowedClientTags && session.allowedClientTags.length
    ? session.allowedClientTags : null;
  const initialClient = scopedTags && scopedTags.length === 1 ? scopedTags[0] : "";
  const initialView = DEFAULT_VIEW;

  // One-time synchronous hydrate from the app-load prefetch (fresh data only).
  // When present we paint the counts + first bucket instantly and skip the
  // initial fetch below.
  const bootRef = useRef<InboxBootstrap | null | undefined>(undefined);
  if (bootRef.current === undefined) bootRef.current = peekFreshBootstrap(initialView, initialClient);
  const boot = bootRef.current;

  // Category counts
  const [counts, setCounts] = useState<Record<string, number>>(boot?.counts ?? {});
  const [total, setTotal] = useState(boot?.total ?? 0);

  // Leads loaded per-category on expand (first bucket seeded from bootstrap)
  const [categoryLeads, setCategoryLeads] = useState<Record<string, ReplyListItem[]>>(
    boot?.firstCategory ? { [boot.firstCategory]: boot.leads as unknown as ReplyListItem[] } : {}
  );
  const [loadingCat, setLoadingCat] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    boot?.firstCategory ? new Set([boot.firstCategory]) : new Set()
  );
  // Per-category pagination cursor for "Load more".
  const [catPage, setCatPage] = useState<Record<string, { offset: number; hasMore: boolean }>>(
    boot?.firstCategory ? { [boot.firstCategory]: { offset: boot.leads.length, hasMore: boot.hasMore } } : {}
  );
  // False until the first bootstrap (or prefetch hydrate) resolves — drives skeletons.
  const [booted, setBooted] = useState(!!boot);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReplyDetail | null>(null);
  const [search, setSearch] = useState("");
  // Fetches run off the debounced value so typing doesn't fire a request/char.
  const debouncedSearch = useDebouncedValue(search, 300);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterClient, setFilterClient] = useState(initialClient);
  // Default to the curated Cherry view — that's where the team lives day-to-day.
  // Master Inbox ("all") is still selectable from the dropdown.
  const [view, setView] = useState<string>(initialView);
  const [clientTags, setClientTags] = useState<string[]>(boot?.clientTags ?? []);
  // Per-user client scoping mirrored from the session so the controls don't lie
  // (the API enforces it server-side regardless).
  const [allowedClientTags] = useState<string[] | null>(scopedTags);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bottom-right "previous reply processed" popup after an auto-advance.
  const [prevLead, setPrevLead] = useState<{ id: number; name: string; email: string } | null>(null);
  const prevTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // One request for the whole inbox: counts + the first non-empty bucket's
  // leads + client tags. Resets per-category expansion (matches the old
  // reset-on-filter-change behavior).
  const loadBootstrap = useCallback(async () => {
    try {
      const p = new URLSearchParams({ mode: "bootstrap" });
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (filterClient) p.set("client_tag", filterClient);
      if (view && view !== "all") p.set("view", view);
      const res = await fetch(`/api/inbox?${p}`);
      if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) { setFetchError(`Failed (${res.status})`); setBooted(true); return; }
      const d = await res.json();
      const first: string | null = d.firstCategory ?? null;
      setCounts(d.counts || {});
      setTotal(d.total || 0);
      if (Array.isArray(d.clientTags)) setClientTags(d.clientTags);
      setCategoryLeads(first ? { [first]: (d.leads || []) as ReplyListItem[] } : {});
      setCatPage(first ? { [first]: { offset: (d.leads || []).length, hasMore: !!d.hasMore } } : {});
      setExpanded(first ? new Set([first]) : new Set());
      setFetchError(null);
      setBooted(true);
    } catch (e) {
      setFetchError((e as Error).message);
      setBooted(true);
    }
  }, [debouncedSearch, filterClient, view]);

  // Run on mount + whenever view / client / (debounced) search change. When we
  // hydrated from the app-load prefetch the UI is already painted (booted), so
  // this becomes a silent background revalidate — instant AND fresh.
  useEffect(() => { loadBootstrap(); }, [loadBootstrap]);

  // Load leads for a specific category (paginated). `append` pulls the next
  // page and concatenates; otherwise it loads the first page.
  async function loadCategoryLeads(cat: string, append = false) {
    setLoadingCat(cat);
    try {
      const offset = append ? (catPage[cat]?.offset ?? 0) : 0;
      const p = new URLSearchParams({ category: cat, offset: String(offset), limit: "100" });
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (filterClient) p.set("client_tag", filterClient);
      if (view && view !== "all") p.set("view", view);
      const res = await fetch(`/api/inbox?${p}`);
      if (res.ok) {
        const d = await res.json();
        const rows: ReplyListItem[] = d.replies || [];
        setCategoryLeads((prev) => ({ ...prev, [cat]: append ? [...(prev[cat] || []), ...rows] : rows }));
        setCatPage((prev) => ({ ...prev, [cat]: { offset: offset + rows.length, hasMore: !!d.page?.hasMore } }));
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

  // (Filter/view resets + first-bucket auto-expand are handled inside
  // loadBootstrap, which re-runs whenever view / client / debounced search change.)

  // Realtime: listen for new inserts. Realtime uses the anon key directly
  // (bypasses our /api/inbox auth), so for client-scoped users we MUST
  // drop any row whose client_tag isn't in their allowed list — otherwise
  // their counts and lists would silently leak other clients' inserts.
  useEffect(() => {
    const activeView = getView(view);
    const channel = realtimeSupabase
      .channel("inbox-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "replies" }, (payload) => {
        const newRow = payload.new as ReplyListItem & { inbox_is_noise?: boolean; ai_categorized_lead_category?: string | null };
        if (allowedClientTags && allowedClientTags.length) {
          if (!newRow.client_tag || !allowedClientTags.includes(newRow.client_tag)) return;
        }
        // Mirror the active view's server-side filter so realtime doesn't add
        // rows the view would hide (noise, non-allowlisted AI, negative bucket).
        if (activeView) {
          if (activeView.excludeNoise && newRow.inbox_is_noise) return;
          if (activeView.aiCategoryAllowlist?.length &&
              !activeView.aiCategoryAllowlist.includes(newRow.ai_categorized_lead_category || "")) return;
        }
        const cat = newRow.lead_category || "Open Response";
        if (activeView?.hiddenLeadCategories?.includes(cat)) return;
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
  }, [allowedClientTags, view]);

  async function loadDetail(id: number) {
    setSelectedId(id);
    setLoading(true);
    // Reflect the open reply in the URL so it can be shared / deep-linked.
    try { window.history.replaceState(null, "", `${window.location.pathname}?reply=${id}`); } catch { /* */ }
    try {
      const res = await fetch(`/api/inbox/${id}`);
      if (res.ok) {
        const d = await res.json();
        setDetail(d);
        // Primary-contact category pre-fills the composer with the templated ask.
        setReplyMsg(d.lead_category === PRIMARY_CONTACT_CATEGORY ? resolvePrimaryContactTemplate(d) : (d.our_reply || ""));
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

  // Deep-link: if the URL carries ?reply=<id> (a shared link), open that reply.
  useEffect(() => {
    const rid = new URLSearchParams(window.location.search).get("reply");
    if (rid && Number(rid) > 0) loadDetail(Number(rid));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    // Auto-advance target: the next lead in the bucket we're working (captured
    // BEFORE the optimistic patch removes the current one). Send/approval
    // categories don't advance (the user must review the outgoing email).
    const isSend = isSendCategory(cat);
    const bucket = categoryLeads[oldCat] || [];
    const idx = bucket.findIndex((r) => r.id === detail.id);
    const nextLead = idx >= 0 ? (bucket[idx + 1] || bucket[idx - 1] || null) : null;
    const prev = { id: detail.id, name: String(detail.lead_name || detail.from_name || detail.lead_email || ""), email: String(detail.lead_email || "") };

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
      // Out Of Office auto-reschedule outcome (server extracted the
      // return date from the lead's reply; cron re-sends the original
      // first cold email on that date).
      if (cat === "Out Of Office") {
        if (d.out_of_office_return_date) {
          toast.success(`Will re-send the original cold email on ${d.out_of_office_return_date} (lead's stated return date)`);
        } else if (d.out_of_office_reason) {
          toast.warning(d.out_of_office_reason);
        }
      }
      // Change-of-Target re-pitch outcome (server fetched the first
      // cold email + sent it to the AI-extracted new contact).
      if (d.change_of_target) {
        const cot = d.change_of_target as { ok: boolean; reason?: string; new_email?: string; first_email_subject?: string };
        if (cot.ok) {
          toast.success(`Re-pitched original cold email to ${cot.new_email}${cot.first_email_subject ? ` ("${cot.first_email_subject}")` : ""}`);
        } else {
          toast.error(`Change of Target: ${cot.reason || "send failed"}`);
        }
      }
      // Primary-contact category → fill the composer with the templated ask.
      if (cat === PRIMARY_CONTACT_CATEGORY) setReplyMsg(resolvePrimaryContactTemplate(detail));
      // Auto-advance to the next lead for non-send categories; send/approval
      // categories stay put so the user can review the outgoing email.
      if (!isSend) {
        setPrevLead(prev);
        if (prevTimerRef.current) clearTimeout(prevTimerRef.current);
        prevTimerRef.current = setTimeout(() => setPrevLead(null), 5000);
        if (nextLead) loadDetail(nextLead.id);
      }
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
    if (d.ok) { toast.success(`Reallocated to ${tag}`); setReallocTag(""); loadBootstrap(); loadDetail(detail.id); }
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
            {/* Scoped users with exactly one allowed tag see a locked badge
                instead of a dropdown — there's nothing to choose. With
                multiple allowed tags they get a normal dropdown limited
                to that subset. */}
            {allowedClientTags && allowedClientTags.length === 1 ? (
              <div className="flex-1 h-6 px-2 flex items-center text-[11px] font-mono font-bold bg-primary/10 text-primary rounded border border-primary/30" title="You are scoped to this client only">
                {allowedClientTags[0]}
              </div>
            ) : (
              <Select value={filterClient || "all"} onValueChange={(v) => { setFilterClient(v === "all" ? "" : v); }}>
                <SelectTrigger className="h-6 text-[11px]"><SelectValue placeholder="All Clients" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{allowedClientTags ? `All (${allowedClientTags.length} clients)` : "All Clients"}</SelectItem>
                  {(allowedClientTags ?? clientTags).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {/* Searchable combobox — Radix Select doesn't tolerate a nested
                Input (typing made the popper detach and float right). */}
            <SearchableCombobox
              value={filterCategory}
              onValueChange={(v) => setFilterCategory(v === "All Categories" ? "" : v)}
              options={["All Categories", ...LEAD_CATEGORIES]}
              placeholder="All Categories"
              searchPlaceholder="Search categories..."
              triggerClassName="h-6 text-[11px] py-0"
            />
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
                        <InstanceBadge instance={r.bison_instance} size="xs" />
                      </div>
                    </button>
                  ))}
                  {categoryLeads[cat] && catPage[cat]?.hasMore && (
                    <button
                      onClick={() => loadCategoryLeads(cat, true)}
                      disabled={loadingCat === cat}
                      className="w-full px-3 py-1.5 text-[10px] font-medium text-primary hover:bg-primary/5 border-b disabled:opacity-50"
                    >
                      {loadingCat === cat ? "Loading…" : "Load more"}
                    </button>
                  )}
                </>
              )}
            </div>
          ))}

          {!booted ? (
            <div className="p-2 space-y-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between px-3 py-2 animate-pulse">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted" />
                    <span className="h-3 rounded bg-muted" style={{ width: `${5 + (i % 4) * 2}rem` }} />
                  </div>
                  <span className="h-3 w-5 rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : displayCategories.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">No leads found</div>
          ) : null}
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
                {(detail.lead_category || "Open Response") === "Open Response" ? (
                  <LiveTimer startIso={detail.open_response_at || detail.created_at} />
                ) : detail.time_to_categorize_seconds != null ? (
                  <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-50 text-emerald-700" title="Time from Open Response to categorization">
                    ✓ moved in {fmtDuration(Number(detail.time_to_categorize_seconds))}
                  </span>
                ) : null}
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
                <InstanceBadge instance={detail.bison_instance} />
                <span className="text-[11px] bg-muted px-2 py-0.5 rounded">{detail.workflow}</span>
              </div>
            </div>

            {/* Email participants — From / To / CC. The reply's own BCC is not
                delivered by Bison's webhook, so it can't be shown here. */}
            <div className="rounded border bg-white px-4 py-2.5 space-y-1 text-xs">
              <EmailRow label="From" name={detail.from_name} email={detail.from_email || detail.lead_email} />
              <EmailRow label="To" name={detail.to_name} email={detail.to_email} />
              <EmailRow label="CC" name={detail.prospect_cc_name} email={detail.prospect_cc_email} />
              <EmailRow label="BCC" name={detail.prospect_bcc_name} email={detail.prospect_bcc_email} />
            </div>

            {/* Lead Details - compact */}
            <div className="rounded border bg-white px-4 py-3">
              <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-xs">
                {[
                  { l: "Company", v: detail.company_name },
                  { l: "Phone", v: detail.phone },
                  { l: "Location", v: [detail.city, detail.state].filter(Boolean).join(", ") },
                  { l: "ZIP", v: detail.zip },
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
              </div>
            )}

            {/* City Wide Routing — only for CW* leads */}
            {detail.client_tag?.toUpperCase().startsWith("CW") && (() => {
              const sug = (detail.suggested_client as string | null) || "";
              const lowerSug = sug.toLowerCase();
              let status: "rerouted" | "kept" | "no_match" | "zip_missing" | "not_evaluated";
              let badgeClass: string;
              let statusLabel: string;
              let detailLine: string;
              if (lowerSug.startsWith("auto-rerouted")) {
                status = "rerouted"; badgeClass = "bg-blue-50 text-blue-700"; statusLabel = "Auto-rerouted"; detailLine = sug;
              } else if (lowerSug.startsWith("routed correctly")) {
                status = "kept"; badgeClass = "bg-green-50 text-green-700"; statusLabel = "Routed correctly"; detailLine = sug;
              } else if (lowerSug.startsWith("no city wide") || lowerSug.startsWith("no cw match")) {
                status = "no_match"; badgeClass = "bg-yellow-50 text-yellow-700"; statusLabel = "No match"; detailLine = sug;
              } else if (lowerSug.startsWith("zip unknown")) {
                status = "zip_missing"; badgeClass = "bg-yellow-50 text-yellow-700"; statusLabel = "ZIP unknown"; detailLine = sug;
              } else if (detail.zip_source || detail.zip) {
                // Router DID run (zip data is stamped) but the suggested_client
                // wasn't written — this is a "kept current tag" result from a
                // version of the router that didn't write that message yet.
                // Treat the same as the explicit "Routed correctly" case.
                status = "kept";
                badgeClass = "bg-green-50 text-green-700";
                statusLabel = "Routed correctly";
                detailLine = detail.zip
                  ? `ZIP ${detail.zip} is in this client's service area — no swap needed.`
                  : "Router evaluated this lead and kept the current tag.";
              } else {
                // No router-written message AND no zip data. Two sub-cases:
                //  - audit present → row predates the CW router deploy
                //  - no audit → reply category was non-qualifying so qualifyLead never ran
                status = "not_evaluated";
                badgeClass = "bg-gray-100 text-gray-600";
                statusLabel = "Not evaluated";
                detailLine = (detail.industry_audit || detail.location_audit)
                  ? "This reply arrived before the CW router was deployed."
                  : "Reply category does not trigger the router (only Interested / Meeting Request / Follow Up / Unrecognizable are evaluated).";
              }
              return (
                <div className="rounded border bg-white px-4 py-3 space-y-1.5">
                  <div className="flex gap-2 items-center">
                    <span className="text-[11px] font-medium text-muted-foreground">City Wide Routing:</span>
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${badgeClass}`}>{statusLabel}</span>
                    {detail.zip ? (
                      <span className="text-[11px] text-muted-foreground">ZIP <span className="font-mono">{detail.zip}</span></span>
                    ) : status !== "not_evaluated" && (
                      <span className="text-[11px] text-muted-foreground">no ZIP extracted</span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{detailLine}</p>
                </div>
              );
            })()}

            {/* Category */}
            <div className="flex items-center gap-3 rounded border bg-white px-4 py-3">
              <span className="text-xs text-muted-foreground shrink-0">Category</span>
              <SearchableCombobox
                value={detail.lead_category || "Open Response"}
                onValueChange={updateCategory}
                options={LEAD_CATEGORIES}
                placeholder="Open Response"
                searchPlaceholder="Search categories..."
                triggerClassName="w-52 h-8 text-xs"
              />
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

      {/* Auto-advance: "previous reply processed" popup with a way back (~5s). */}
      {prevLead && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border bg-white px-4 py-2.5 shadow-lg animate-in fade-in slide-in-from-bottom-2">
          <div className="min-w-0">
            <p className="text-[10px] text-muted-foreground">Previous reply processed</p>
            <p className="text-xs font-medium truncate max-w-[220px]">{prevLead.name || prevLead.email}</p>
            {prevLead.email && prevLead.name && <p className="text-[10px] text-muted-foreground truncate max-w-[220px]">{prevLead.email}</p>}
          </div>
          <button
            onClick={() => { loadDetail(prevLead.id); setPrevLead(null); }}
            className="shrink-0 text-xs font-medium text-primary hover:underline"
          >
            ← Back to previous
          </button>
        </div>
      )}
    </div>
  );
}
