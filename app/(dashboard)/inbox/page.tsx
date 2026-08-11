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
import { INBOX_VIEWS, getView, replyMatchesView, hasDedicatedMasterView, dedicatedMasterViewId, POSITIVE_AI_CATEGORIES } from "@/lib/inbox-views";
import { isReconnectableSendError } from "@/lib/inboxing-upload";
import { useSession } from "@/components/session-provider";
import { peekFreshBootstrap, DEFAULT_VIEW, type InboxBootstrap } from "@/lib/inbox-prefetch";
import { useDebouncedValue } from "@/lib/use-debounced-value";
// Pure / no server deps — must NOT import from domain-blacklist (which
// pulls in @/lib/db and crashes the browser bundle with URL_INVALID).
import { isPersonalDomain } from "@/lib/processing/personal-domains";
// Pure (Intl/Date only) — safe in the browser bundle. Builds the
// "Not Interested (Send Reply)" acknowledgment the same way the cron does.
import { buildNotInterestedReply } from "@/lib/processing/not-interested-reply";
import { primaryContactFallback } from "@/lib/processing/primary-contact-reply";
import { InstanceBadge } from "@/components/instance-badge";
import { EmailParticipants, initials } from "@/components/email-participants";
import { QualificationLookup } from "@/components/qualification-lookup";
import { InboxBestFit } from "@/components/inbox-best-fit";
import { htmlToText, textToHtml } from "@/lib/html-text";
import { useInboxPresence } from "@/lib/use-inbox-presence";
import { getPresenceProfile } from "@/lib/presence-users";

// Browser-side Supabase client for realtime (anon key).
// eventsPerSecond raised from the default 10 → 40 so rapid presence track()
// calls (switching leads quickly) aren't dropped by the client rate limiter,
// which would otherwise leave a viewer's presence stuck on a stale lead.
const realtimeSupabase = createClient(
  "https://iiiupmanpycjcopcrkdh.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpaXVwbWFucHljamNvcGNya2RoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNjk1NzgsImV4cCI6MjA5MTg0NTU3OH0.psM-ngpfrDUJqRCy_r33eP664y5HfZq_W6elkMJ7D88",
  { realtime: { params: { eventsPerSecond: 40 } } }
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
  "Email Address Changed",
  "Follow Up",
  "Internally Forwarded",
  "Lost",
  "Mailbox No Longer Active",
  "Meeting-Ready Lead",
  "Needs Review",
  "Not Interested",
  "Not Interested (Send Reply)",
  "Out Of Office",
  "Person No Longer Employed",
  "Referral Given",
  "Request for Primary Point of Contact (Send Reply)",
  "Unqualified (Cleaning)",
  "Wrong Person",
];

// AI Suggested categories the §18 filter can narrow to (mirror of the
// categorizer's VALID_CATEGORIES + legacy values still present on rows).
const AI_FILTER_CATEGORIES = [
  "Interested", "Meeting Request", "Follow Up at a Later Date", "Not Interested", "Out Of Office",
  "Wrong Person", "Mailbox No Longer Active", "Automated Error Message", "Automated Catch-All Message",
  "Wrong Person (Change of Target)", "Do Not Contact", "Referral Given", "Internally Forwarded",
  "Person No Longer Employed", "Email Address Changed", "Unrecognizable by AI",
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

// Generic primary-contact ask (client-approved structure) — paints instantly;
// the scenario-aware AI draft (org named in the reply, etc.) swaps in async.

function leadFirstName(d: ReplyDetail): string {
  const first = (d.first_name && String(d.first_name).trim()) || "";
  if (first) return first;
  const name = String(d.lead_name || d.from_name || "").trim();
  return name ? name.split(/\s+/)[0] : "there";
}
function resolvePrimaryContactTemplate(d: ReplyDetail): string {
  return primaryContactFallback(leadFirstName(d), String(d.sender_name || "").trim().split(/\s+/)[0] || "");
}

// The pre-set reply template each (Send Reply) category loads into the draft.
// The user can still edit or regenerate it before approving. Falls back to the
// client's generic reply (our_reply) for any send-reply category without a
// dedicated template.
function sendReplyTemplateFor(category: string, d: ReplyDetail): string {
  if (category === PRIMARY_CONTACT_CATEGORY) return resolvePrimaryContactTemplate(d);
  if (category === "Not Interested (Send Reply)") {
    return buildNotInterestedReply(
      String(d.lead_name || d.from_name || ""),
      String(d.sender_name || ""),
    );
  }
  return String(d.our_reply || "");
}

// Split the stored comma-joined name/email strings back into paired people.
function splitPairs(names?: string | null, emails?: string | null): { name: string; email: string }[] {
  const es = String(emails || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ns = String(names || "").split(",").map((s) => s.trim());
  return es.map((email, i) => ({ name: ns[i] || "", email }));
}

/**
 * Reply-all recipients for an outgoing reply (spec §7/§8):
 *   - To  = the person who actually replied (the lead).
 *   - CC  = everyone else already on the inbound thread — the reply's other
 *           To recipients + its CC — minus our own sending account; PLUS the
 *           client-team CC when the category is positive (§8). Deduped, ≤6.
 *   - BCC = the client-team BCC, positive categories only (§8). ≤2.
 * Every list stays editable in the composer/preview before sending.
 */
function computeReplyRecipients(d: ReplyDetail, category: string): {
  to: { name: string; email: string };
  cc: { name: string; email: string }[];
  bcc: { name: string; email: string }[];
} {
  const norm = (e: string) => e.trim().toLowerCase();
  const ours = norm(String(d.sender_email || ""));
  const leadEmail = norm(String(d.from_email || d.lead_email || ""));
  const to = { name: String(d.from_name || d.lead_name || ""), email: String(d.from_email || d.lead_email || "") };
  // Loop in the client's configured team (CC/BCC) when the lead is AI-classified
  // positive (gated on ai_categorized_lead_category so Open-Response-bucket leads
  // that are AI-positive still get the client CC'd), OR any (Send Reply) category.
  const includeTeam = POSITIVE_AI_CATEGORIES.includes(String(d.ai_categorized_lead_category || "")) || /\(send reply\)/i.test(category);

  const seen = new Set<string>([ours, leadEmail].filter(Boolean));
  const cc: { name: string; email: string }[] = [];
  const pushCc = (r: { name: string; email: string }) => {
    const e = norm(r.email);
    if (!e || seen.has(e)) return;
    seen.add(e);
    cc.push({ name: r.name.trim(), email: r.email.trim() });
  };
  // Other original To recipients (the lead addressed us + maybe colleagues) → CC.
  splitPairs(d.to_name, d.to_email).forEach(pushCc);
  // Keep the inbound reply's own CC on the thread.
  splitPairs(d.prospect_cc_name, d.prospect_cc_email).forEach(pushCc);
  // Loop in the client's team for positive + Send-Reply categories (§8).
  if (includeTeam) {
    ([1, 2, 3, 4, 5, 6] as const).forEach((n) => {
      const email = String(d[`cc_email_${n}`] || "");
      if (email) pushCc({ name: String(d[`cc_name_${n}`] || ""), email });
    });
  }

  const bcc: { name: string; email: string }[] = [];
  if (includeTeam) {
    ([1, 2] as const).forEach((n) => {
      const email = String(d[`bcc_email_${n}`] || "");
      if (email) bcc.push({ name: String(d[`bcc_name_${n}`] || ""), email });
    });
  }
  return { to, cc: cc.slice(0, 6), bcc: bcc.slice(0, 2) };
}

function fmtDuration(secs: number): string {
  const m = Math.floor(secs / 60), s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Human date for the OOO re-send banner, rendered in PT (matches the cron's TZ).
function fmtSendDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "America/Los_Angeles",
  }).format(new Date(t));
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

interface CotState {
  replyId: number;
  loading: boolean;
  error?: string;
  candidates: { email: string; name: string | null }[];
  toEmail: string;
  toName: string;
  subject: string;
  messageTemplate: string;
  message: string;
  messageDirty: boolean;
  senderEmailId: number | null;
  sending: boolean;
  manual?: boolean;   // untracked fallback: generic draft, no original email wrapped (§26)
}
function firstNameOf(name: string): string {
  const n = (name || "").trim();
  return n ? n.split(/\s+/)[0] : "there";
}

// Change-of-Target destination name: the AI-extracted contact name, else a safe
// "<Company> Team" fallback so the Name field is NEVER empty (the send needs it).
// Company from the lead's company_name, else derived from the email domain.
function cotTeamName(email: string | null | undefined, companyName: string | null | undefined): string {
  let co = (companyName || "").trim();
  if (!co) {
    const dom = ((email || "").split("@")[1] || "").split(".")[0] || "";
    co = dom ? dom.charAt(0).toUpperCase() + dom.slice(1) : "";
  }
  return co ? `${co} Team` : "Team";
}

// Pull the suggested CLIENT TAGS (+ their short reason) out of the stored
// suggested_client string, dropping non-tags like "A". Works for both the new
// concise format ("SI (serves nationwide) · PPS (...)") and old verbose rows
// ("SI (Active) (long paragraph), DBSNJ (Active) (...)"). Validated against the
// real tag list when available so hallucinated tokens never show. The reason is
// surfaced only on hover, so the chip stays compact.
function parseSuggestedTags(raw: string, validSet: Set<string>): { tag: string; reason: string }[] {
  const out: { tag: string; reason: string }[] = [];
  const seen = new Set<string>();
  // Split on " · " (new) OR ", " that precedes another "TAG (" (old, without
  // breaking reasons that contain commas).
  const segments = String(raw || "").split(/\s+·\s+|,\s*(?=[A-Za-z][A-Za-z0-9&-]{1,11}\s*[(⚠])/);
  for (const segRaw of segments) {
    const seg = segRaw.trim();
    const m = seg.match(/^([A-Za-z][A-Za-z0-9&-]{1,11})\b/); // ≥2 chars → drops "A"
    if (!m) continue;
    const tag = m[1].toUpperCase();
    if (seen.has(tag)) continue;
    if (validSet.size && !validSet.has(tag)) continue;
    let reason = seg.slice(m[1].length)
      .replace(/^[⚠\s]+/, "")                          // drop the inactive flag
      .replace(/^\((?:active|inactive[^)]*)\)\s*/i, "") // drop "(Active)"/"(INACTIVE…)"
      .replace(/^\[inactive[^\]]*\]\s*/i, "")
      .replace(/^\(|\)\s*$/g, "")                       // strip outer parens
      .trim();
    // No length cap — the hover bubble wraps + grows, so show the FULL reason.
    seen.add(tag);
    out.push({ tag, reason });
    if (out.length >= 5) break;
  }
  return out;
}

// Send-Reply preview (spec §15): stage the draft, recipients + sending account;
// edit / regenerate / decline / approve — nothing sends until "Approve & Send".
interface SendPrevState {
  replyId: number;                  // our replies.id
  bisonReplyId: number | null;      // Bison reply id, for the threaded send
  senderEmailId: number | null;     // sending account id
  category: string;                 // the (Send Reply) category that opened this
  fromEmail: string;                // sending account (read-only)
  toEmail: string;
  toName: string;
  message: string;
  cc: { name: string; email: string }[];
  bcc: { name: string; email: string }[];
  instructions: string;             // freeform guidance for "Regenerate with AI"
  regenerating: boolean;
  sending: boolean;
  confirm: boolean;                 // second-step confirm before the send fires
}

export default function InboxPage() {
  // Per-user scope comes from the server session (context) — no /api/auth fetch.
  const session = useSession();
  const scopedTags = session?.allowedClientTags && session.allowedClientTags.length
    ? session.allowedClientTags : null;
  const initialClient = scopedTags && scopedTags.length === 1 ? scopedTags[0] : "";
  // Scoped users (their own client login) default to their Master Inbox — the
  // base "Cherry" view excludes their tags, so it would show nothing. If they
  // have a dedicated master (e.g. "SBSPO Master Inbox") default to it (the
  // generic "all" is hidden for them); otherwise fall back to the generic one.
  // Admins keep the curated Cherry default.
  const initialView = scopedTags ? (dedicatedMasterViewId(scopedTags) ?? "all") : DEFAULT_VIEW;

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
  // Every category section starts COLLAPSED (user preference) — no bucket opens
  // on its own; the first bucket's leads are still preloaded for instant expand.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Per-category pagination cursor for "Load more".
  const [catPage, setCatPage] = useState<Record<string, { offset: number; hasMore: boolean }>>(
    boot?.firstCategory ? { [boot.firstCategory]: { offset: boot.leads.length, hasMore: boot.hasMore } } : {}
  );
  // False until the first bootstrap (or prefetch hydrate) resolves — drives skeletons.
  const [booted, setBooted] = useState(!!boot);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReplyDetail | null>(null);

  // Real-time lead presence (Google-Docs-style): show who is currently viewing
  // each lead. Identity = the signed-in user; color from getPresenceProfile.
  const me = getPresenceProfile(session?.email);
  const presenceByLead = useInboxPresence(realtimeSupabase, {
    email: session?.email,
    name: me.name,
    color: me.color,
    currentLeadId: selectedId,
  });
  // Teammates (not me) currently viewing the open lead — warns of a collision.
  const otherViewers = (selectedId != null ? presenceByLead.get(selectedId) ?? [] : [])
    .filter((v) => v.email.toLowerCase() !== (session?.email || "").toLowerCase());
  const [search, setSearch] = useState("");
  // Fetches run off the debounced value so typing doesn't fire a request/char.
  const debouncedSearch = useDebouncedValue(search, 300);
  const [filterCategory, setFilterCategory] = useState("");
  // §18: filter buckets/leads by the AI Suggested category (server-side).
  const [filterAi, setFilterAi] = useState("");
  // Current filters mirrored into a ref so the realtime handler (which doesn't
  // re-subscribe on every keystroke) can honor them without stale closures.
  const filtersRef = useRef({ search: "", client: "", category: "", ai: "" });
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
  // Change-of-Target preview (spec §22): prepared candidates + editable message.
  const [cotPreview, setCotPreview] = useState<CotState | null>(null);
  // Send-Reply preview (spec §15): staged draft awaiting review + approval.
  const [sendPreview, setSendPreview] = useState<SendPrevState | null>(null);
  const detailReqRef = useRef(0);
  const sheetCache = useRef<Record<string, string | null>>({});
  // Hover-prefetched full details, so a click paints instantly.
  const detailCache = useRef<Map<number, ReplyDetail>>(new Map());
  const detailInflight = useRef<Set<number>>(new Set());

  // Reply form
  type Recipient = { name: string; email: string };
  const [replyMsg, setReplyMsg] = useState("");
  const [replyCc, setReplyCc] = useState<Recipient[]>([]);
  const [replyBcc, setReplyBcc] = useState<Recipient[]>([]);
  // Optional freeform instructions for Generate Reply (empty = adapt normally).
  const [genInstructions, setGenInstructions] = useState("");
  // Email history (Bison conversation thread + our ReplyRouter send attempts).
  interface ThreadMsg { direction: "sent" | "received"; at: string; subject: string; body: string; sender: string }
  interface SendRow { id: number; status: string; error: string | null; created_at: string }
  const [history, setHistory] = useState<{ thread: ThreadMsg[]; sends: SendRow[] } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Collapse the rarely-used secondary send tools (Forward / One-Off) to keep
  // the detail panel compact.
  const [moreOpen, setMoreOpen] = useState(false);
  const loadSendHistory = useCallback(async (rid: number) => {
    try {
      const res = await fetch(`/api/inbox/${rid}/thread`);
      if (res.ok) setHistory(await res.json());
    } catch { /* non-fatal */ }
  }, []);
  // Load the email history whenever a different lead is opened.
  useEffect(() => {
    setHistory(null); setHistoryOpen(false);
    if (selectedId) loadSendHistory(selectedId);
  }, [selectedId, loadSendHistory]);

  // NOTE: the qualification audit runs AT INGEST (lib/processing/tracked.ts) for
  // the positive AI lead categories — NOT on open. Opening a lead never triggers
  // it; the manual "Run Audit" button is still available for anything missing.
  const [fwdTo, setFwdTo] = useState("");
  const [ooSubject, setOoSubject] = useState("");
  const [ooMsg, setOoMsg] = useState("");
  const [ooCc, setOoCc] = useState<Recipient[]>([]);
  const [reallocTag, setReallocTag] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  // Change-AI-category + client-tag/sheet-override editors (below the lead details).
  const [aiSaving, setAiSaving] = useState(false);
  const [tsTag, setTsTag] = useState("");
  const [tsSaving, setTsSaving] = useState(false);
  // §29: inline sends require an explicit second click before firing.
  const [confirmInline, setConfirmInline] = useState<"reply" | "fwd" | "oo" | null>(null);
  // Client qualification rules drawer (search audits/locations from the inbox).
  const [showQual, setShowQual] = useState(false);

  // One request for the whole inbox: counts + the first non-empty bucket's
  // leads + client tags. Resets per-category expansion (matches the old
  // reset-on-filter-change behavior).
  const loadBootstrap = useCallback(async () => {
    try {
      const p = new URLSearchParams({ mode: "bootstrap" });
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (filterClient) p.set("client_tag", filterClient);
      if (filterAi) p.set("ai_category", filterAi);
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
      setExpanded(new Set()); // collapsed by default
      setFetchError(null);
      setBooted(true);
    } catch (e) {
      setFetchError((e as Error).message);
      setBooted(true);
    }
  }, [debouncedSearch, filterClient, filterAi, view]);

  // Run on mount + whenever view / client / (debounced) search change. When we
  // hydrated from the app-load prefetch the UI is already painted (booted), so
  // this becomes a silent background revalidate — instant AND fresh.
  useEffect(() => { loadBootstrap(); }, [loadBootstrap]);

  // Keep the realtime handler's view of the active filters current.
  useEffect(() => {
    filtersRef.current = { search: debouncedSearch || "", client: filterClient || "", category: filterCategory || "", ai: filterAi || "" };
  }, [debouncedSearch, filterClient, filterCategory, filterAi]);

  // Load leads for a specific category (paginated). `append` pulls the next
  // page and concatenates; otherwise it loads the first page.
  async function loadCategoryLeads(cat: string, append = false) {
    setLoadingCat(cat);
    try {
      const offset = append ? (catPage[cat]?.offset ?? 0) : 0;
      const p = new URLSearchParams({ category: cat, offset: String(offset), limit: "100" });
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (filterClient) p.set("client_tag", filterClient);
      if (filterAi) p.set("ai_category", filterAi);
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

  // Keep a ref of which categories are expanded so the realtime refresh can
  // update them in place without re-subscribing on every expand/collapse.
  const expandedRef = useRef<Set<string>>(new Set());
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  // Live refresh (realtime). Re-pulls counts + total and refreshes the currently
  // expanded buckets IN PLACE (no collapse), all through the authenticated
  // /api/inbox route — so realtime carries no data itself, just a "refresh" nudge.
  const refreshLive = useCallback(async () => {
    try {
      const p = new URLSearchParams({ mode: "bootstrap" });
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (filterClient) p.set("client_tag", filterClient);
      if (filterAi) p.set("ai_category", filterAi);
      if (view && view !== "all") p.set("view", view);
      const res = await fetch(`/api/inbox?${p}`);
      if (res.ok) {
        const d = await res.json();
        setCounts(d.counts || {});
        setTotal(d.total || 0);
      }
    } catch { /* transient — next signal refreshes */ }
    for (const cat of expandedRef.current) loadCategoryLeads(cat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, filterClient, filterAi, view]);
  const refreshLiveRef = useRef<() => void>(() => {});
  useEffect(() => { refreshLiveRef.current = refreshLive; }, [refreshLive]);

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

  // Realtime: the server BROADCASTS a minimal, non-PII "reply-change" signal on
  // every reply ingest (lib/realtime-broadcast.ts). We can't use the old
  // postgres_changes subscription anymore — that needed the anon key to read the
  // `replies` table, and RLS now denies anon all access (the anon key was
  // publicly exposed). Broadcast carries NO lead data; on a signal that could
  // belong to the active view we do a debounced refresh through the
  // authenticated /api/inbox route (which enforces per-user client scoping).
  useEffect(() => {
    const activeView = getView(view);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = realtimeSupabase
      .channel("inbox-realtime")
      .on("broadcast", { event: "reply-change" }, ({ payload }) => {
        const sig = (payload || {}) as {
          client_tag?: string | null;
          lead_category?: string | null;
          ai_categorized_lead_category?: string | null;
          inbox_is_noise?: boolean;
        };
        // Same membership gate as before (all non-PII fields) — skip signals that
        // couldn't appear in this view / the active client-tag scope, so we don't
        // refresh needlessly. Scoped users never react to other clients' signals.
        if (!replyMatchesView(activeView, sig, allowedClientTags)) return;
        const f = filtersRef.current;
        if (f.client && sig.client_tag !== f.client) return;
        if (f.category && (sig.lead_category || "Open Response") !== f.category) return;
        if (f.ai && (sig.ai_categorized_lead_category || "") !== f.ai) return;
        // Coalesce bursts, then refresh via the authenticated route.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => refreshLiveRef.current?.(), 600);
      })
      .subscribe();

    return () => { if (timer) clearTimeout(timer); realtimeSupabase.removeChannel(channel); };
  }, [allowedClientTags, view]);

  // Non-blocking Google-Sheet URL (cached per client tag) — pops the Sheet
  // button in once it resolves, without ever blocking the detail render.
  async function loadSheetUrl(tag: string) {
    if (!tag || tag === "N/A") return;
    if (tag in sheetCache.current) {
      const url = sheetCache.current[tag];
      setDetail((prev) => (prev && prev.client_tag === tag ? { ...prev, sheet_url: url } : prev));
      return;
    }
    try {
      const res = await fetch(`/api/client-sheet?tag=${encodeURIComponent(tag)}`);
      if (!res.ok) return;
      const { sheet_url } = await res.json();
      sheetCache.current[tag] = sheet_url ?? null;
      setDetail((prev) => (prev && prev.client_tag === tag ? { ...prev, sheet_url } : prev));
    } catch { /* */ }
  }

  // Apply a full reply row to the detail pane + composer.
  function applyDetail(d: ReplyDetail, mergeById?: number) {
    setDetail((prev) => (mergeById && prev && prev.id === mergeById ? { ...prev, ...d } : d));
    setReplyMsg(d.lead_category === PRIMARY_CONTACT_CATEGORY ? resolvePrimaryContactTemplate(d) : (d.our_reply || ""));
    // Reply-all: pre-fill CC/BCC from the inbound thread + client team (§7/§8).
    const { cc, bcc } = computeReplyRecipients(d, String(d.lead_category || "Open Response"));
    setReplyCc(cc);
    setReplyBcc(bcc);
    setOoCc([]);
    setGenInstructions(""); // instructions are per-lead — don't carry over
    setConfirmInline(null); // new lead → reset any pending send confirmation
    if (d.client_tag) loadSheetUrl(d.client_tag);
  }

  // Prefetch a reply's full detail on hover so the click paints instantly.
  function prefetchDetail(id: number) {
    if (detailCache.current.has(id) || detailInflight.current.has(id)) return;
    detailInflight.current.add(id);
    fetch(`/api/inbox/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) detailCache.current.set(id, d); })
      .catch(() => {})
      .finally(() => detailInflight.current.delete(id));
  }

  async function loadDetail(id: number, partial?: ReplyListItem) {
    const mine = ++detailReqRef.current;
    setSelectedId(id);
    // Reflect the open reply in the URL so it can be shared / deep-linked.
    try { window.history.replaceState(null, "", `${window.location.pathname}?reply=${id}`); } catch { /* */ }
    // Instant when we've hover-prefetched this reply's full detail.
    const cached = detailCache.current.get(id);
    if (cached) { applyDetail(cached); setLoading(false); return; }
    // Else paint the header/basics from the clicked row, fetch the rest.
    if (partial) { setDetail({ ...partial } as ReplyDetail); setLoading(false); loadSheetUrl(partial.client_tag); }
    else setLoading(true);
    try {
      const res = await fetch(`/api/inbox/${id}`);
      if (mine !== detailReqRef.current) return; // a newer lead was opened
      if (res.ok) {
        const d = await res.json();
        detailCache.current.set(id, d);
        applyDetail(d, id);
      }
    } catch { /* */ }
    if (mine === detailReqRef.current) setLoading(false);
  }

  // Deep-link: if the URL carries ?reply=<id> (a shared link), open that reply.
  useEffect(() => {
    const rid = new URLSearchParams(window.location.search).get("reply");
    if (rid && Number(rid) > 0) loadDetail(Number(rid));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mutate(body: Record<string, unknown>) {
    // The row may change — drop its prefetch cache so a re-open re-fetches fresh.
    if (typeof body.id === "number") detailCache.current.delete(body.id);
    const res = await fetch("/api/inbox/mutate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return res.json();
  }

  // ── Change-of-Target preview (§22): prepare candidates, pick + edit, approve ──
  async function openCot(replyId: number) {
    setCotPreview({ replyId, loading: true, candidates: [], toEmail: "", toName: "", subject: "", messageTemplate: "", message: "", messageDirty: false, senderEmailId: null, sending: false });
    const d = await mutate({ action: "prepare-change-of-target", id: replyId });
    const cands = (d.candidates || []) as { email: string; name: string | null }[];
    const first = cands[0];
    // Name field: AI name → "<Company> Team" fallback (never empty). Greeting is
    // computed from the REAL name only, so a fallback team name still greets "Hi
    // there," rather than "Hi <Company>,".
    const toName = (first?.name || "").trim() || cotTeamName(first?.email, detail?.company_name);
    const messageTemplate = d.messageTemplate || "";
    setCotPreview((prev) => (prev && prev.replyId === replyId ? {
      ...prev, loading: false,
      error: d.ok ? undefined : (d.reason || "Could not prepare Change of Target"),
      candidates: cands, toEmail: first?.email || "", toName,
      subject: d.subject || "", messageTemplate,
      message: messageTemplate.replaceAll("{FIRST_NAME}", firstNameOf(first?.name || "")),
      senderEmailId: d.senderEmailId ?? null,
      manual: !!d.manual,
    } : prev));
  }
  function cotPatch(patch: Partial<CotState>) {
    setCotPreview((prev) => (prev ? { ...prev, ...patch } : prev));
  }
  function cotSelectRecipient(email: string) {
    setCotPreview((prev) => {
      if (!prev) return prev;
      const c = prev.candidates.find((x) => x.email === email);
      const toName = (c?.name || "").trim() || cotTeamName(email, detail?.company_name);
      const message = prev.messageDirty ? prev.message : prev.messageTemplate.replaceAll("{FIRST_NAME}", firstNameOf(c?.name || ""));
      return { ...prev, toEmail: email, toName, message };
    });
  }
  async function sendCot() {
    if (!cotPreview?.toEmail || !cotPreview.senderEmailId) { toast.error("Pick a destination email first"); return; }
    cotPatch({ sending: true });
    // Final guard: never send with an empty name (e.g. field cleared or a raw
    // email typed) — fall back to "<Company> Team".
    const toName = (cotPreview.toName || "").trim() || cotTeamName(cotPreview.toEmail, detail?.company_name);
    const d = await mutate({
      action: "send-change-of-target", id: cotPreview.replyId, senderEmailId: cotPreview.senderEmailId,
      toEmail: cotPreview.toEmail, toName, subject: cotPreview.subject, message: cotPreview.message,
    });
    if (d.ok) { toast.success(`Change of Target sent to ${cotPreview.toEmail}`); setCotPreview(null); }
    else { toast.error(d.error || "Send failed"); cotPatch({ sending: false }); }
  }

  // ── Send-Reply preview (§15): stage draft, review + approve; nothing sends
  //    until "Approve & Send". Opened when a (Send Reply) category is picked. ──
  function openSendPreview(d: ReplyDetail, category: string) {
    // Reply-all recipients from the inbound thread (§7/§8).
    const { to, cc, bcc } = computeReplyRecipients(d, category);
    const message = sendReplyTemplateFor(category, d);
    setSendPreview({
      replyId: d.id, bisonReplyId: (d.reply_id as number | null) ?? null,
      senderEmailId: (d.sender_id as number | null) ?? null,
      category, fromEmail: String(d.sender_email || ""),
      toEmail: to.email, toName: to.name,
      message, cc, bcc, instructions: "", regenerating: false, sending: false, confirm: false,
    });
    // §23: upgrade the primary-contact draft to the scenario-specific wording
    // (property-mgmt / first-name / forwarded / department). Paints instantly
    // with the generic ask, then swaps in the tailored one — unless the user
    // has already edited it.
    if (category === PRIMARY_CONTACT_CATEGORY) {
      mutate({ action: "primary-contact-reply", id: d.id, firstName: leadFirstName(d) })
        .then((r) => {
          if (r?.ok && r.message) {
            setSendPreview((prev) => (prev && prev.replyId === d.id && prev.message === message ? { ...prev, message: r.message } : prev));
          }
        })
        .catch(() => {});
    }
  }
  function sendPatch(patch: Partial<SendPrevState>) {
    setSendPreview((prev) => (prev ? { ...prev, ...patch } : prev));
  }
  async function regenerateSend() {
    if (!sendPreview) return;
    sendPatch({ regenerating: true });
    const d = await mutate({
      action: "regenerate-reply", id: sendPreview.replyId,
      currentDraft: sendPreview.message, instructions: sendPreview.instructions,
      leadName: sendPreview.toName,
    });
    if (d.ok && d.message) { sendPatch({ message: d.message, instructions: "", regenerating: false, confirm: false }); toast.success("Draft regenerated"); }
    else { toast.error(d.error || "Couldn't regenerate — edit manually."); sendPatch({ regenerating: false }); }
  }
  async function approveSend() {
    if (!sendPreview) return;
    if (!sendPreview.confirm) { sendPatch({ confirm: true }); return; } // require an explicit second click (§29)
    if (!sendPreview.message.trim()) { toast.error("The draft is empty."); return; }
    sendPatch({ sending: true });
    const d = await mutate({
      action: "send-reply", id: sendPreview.replyId, replyId: sendPreview.bisonReplyId,
      senderEmailId: sendPreview.senderEmailId, message: sendPreview.message,
      toEmail: sendPreview.toEmail, toName: sendPreview.toName,
      ccEmails: sendPreview.cc.length ? recipientsToApi(sendPreview.cc) : undefined,
      bccEmails: sendPreview.bcc.length ? recipientsToApi(sendPreview.bcc) : undefined,
      clearAutoReply: true,
    });
    if (d.ok) { toast.success(`Reply sent to ${sendPreview.toEmail}`); setSendPreview(null); if (selectedId === sendPreview.replyId) loadDetail(sendPreview.replyId); }
    else { toast.error(d.error || "Send failed"); sendPatch({ sending: false, confirm: false }); }
  }
  async function declineSend() {
    if (!sendPreview) return;
    const rid = sendPreview.replyId;
    setSendPreview(null);
    // Decline → move off the send flow, back to Open Response for re-triage (§15).
    await mutate({ action: "update-category", id: rid, category: "Open Response" });
    setDetail((prev) => (prev && prev.id === rid ? { ...prev, lead_category: "Open Response" } : prev));
    setCounts((prev) => ({ ...prev, "Open Response": (prev["Open Response"] || 0) + 1 }));
    toast.success("Declined — moved back to Open Response");
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
    // Advance to the lead ABOVE (idx-1 = the newer record in a newest-first
    // list); fall back to the one below if we're already at the top.
    const nextLead = idx >= 0 ? (bucket[idx - 1] || bucket[idx + 1] || null) : null;
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
        if (d.auto_reply_due_at) {
          const when = fmtSendDate(d.auto_reply_due_at);
          toast.success(d.out_of_office_return_date
            ? `Original cold email will re-send ${when} (day after the lead's return date)`
            : `No return date found — requeued; original cold email will re-send ${when}`);
        } else if (d.auto_reply_schedule_error) {
          toast.error(`Couldn't schedule the OOO re-send: ${d.auto_reply_schedule_error}`);
        }
      }
      // Change of Target → open the review/preview (pick destination + approve)
      // instead of auto-sending (spec §22).
      if (cat === "Change Of Target") openCot(detail.id);
      // Any (Send Reply) category → stage the draft in the Send-Reply preview
      // (spec §15): review recipients + sending account, edit/regenerate, then
      // approve. Nothing sends until the user approves.
      else if (/\(send reply\)/i.test(cat)) openSendPreview({ ...detail, lead_category: cat }, cat);
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
    if (confirmInline !== "reply") { setConfirmInline("reply"); return; } // §29 confirm
    setConfirmInline(null);
    setSending("reply");
    const detailId = detail.id;
    const sentBody = replyMsg;
    const d = await mutate({
      action: "send-reply", id: detail.id, replyId: detail.reply_id,
      senderEmailId: detail.sender_id, message: replyMsg,
      toEmail: detail.lead_email, toName: detail.lead_name,
      ccEmails: replyCc.length ? recipientsToApi(replyCc) : undefined,
      bccEmails: replyBcc.length ? recipientsToApi(replyBcc) : undefined,
    });
    setSending(null);
    const now = new Date().toISOString();
    if (d.ok) {
      // Success: clear the composer + show a persistent "sent" confirmation on
      // the lead (last_sent_at), and clear any prior send error.
      setReplyMsg(""); setReplyCc([]); setReplyBcc([]);
      setDetail((prev) => (prev && prev.id === detailId ? { ...prev, send_error: null, send_error_at: null, last_sent_at: now, sent_reply: sentBody } : prev));
      toast.success("Reply sent");
      loadSendHistory(detailId);
    } else {
      // Failure: KEEP the draft (don't reload) and surface the error
      // persistently on the lead until the next successful send.
      setDetail((prev) => (prev && prev.id === detailId ? { ...prev, send_error: d.error || "Send failed", send_error_at: now } : prev));
      toast.error(d.error || "Send failed — your draft is kept, retry when ready");
    }
  }

  async function handleFwd() {
    if (!detail || !fwdTo) return;
    if (confirmInline !== "fwd") { setConfirmInline("fwd"); return; } // §29 confirm
    setConfirmInline(null);
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
    if (confirmInline !== "oo") { setConfirmInline("oo"); return; } // §29 confirm
    setConfirmInline(null);
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
    setSending("realloc");
    const d = await mutate({ action: "reallocate", id: detail.id, client_tag: tag });
    setSending(null);
    if (d.ok) { toast.success(`Reallocated to ${tag} — CC/BCC, template & sheet routing updated`); setReallocTag(""); loadBootstrap(); loadDetail(detail.id); }
    else toast.error(d.error);
  }

  // Reset the client-tag editor to the open lead's current tag.
  useEffect(() => {
    setTsTag(detail?.client_tag && detail.client_tag !== "N/A" ? String(detail.client_tag) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id]);

  // Change the AI-classified category → the lead moves into the views that match
  // (e.g. Interested → the Cherry views). Works for scoped users too (server-enforced).
  async function updateAiCategory(cat: string) {
    if (!detail || !cat || cat === detail.ai_categorized_lead_category) return;
    setAiSaving(true);
    const d = await mutate({ action: "set-ai-category", id: detail.id, aiCategory: cat });
    setAiSaving(false);
    if (d.ok) {
      setDetail((prev) => (prev ? { ...prev, ai_categorized_lead_category: cat } : prev));
      detailCache.current.delete(detail.id);
      toast.success(`AI category set to "${cat}" — views updated`);
      loadBootstrap(); // the lead may enter/leave the current view
    } else toast.error(d.error || "Couldn't update the AI category");
  }

  // Relabel the client tag (no template reroute). The lead-tracking sheet is
  // resolved automatically from the tag; if the lead fits a push category it's
  // routed to that client's sheet on save.
  async function saveTagSheet() {
    if (!detail) return;
    const tag = (tsTag || "").trim().toUpperCase();
    if (!tag) { toast.error("Pick a client tag."); return; }
    if (tag === detail.client_tag) return;
    setTsSaving(true);
    const d = await mutate({ action: "set-tag-sheet", id: detail.id, client_tag: tag });
    setTsSaving(false);
    if (d.ok) {
      detailCache.current.delete(detail.id);
      toast.success(d.pushed ? `Client tag set to ${d.client_tag} — routed to its sheet.` : `Client tag set to ${d.client_tag}.`);
      loadBootstrap();
      loadDetail(detail.id);
    } else toast.error(d.error || "Couldn't save");
  }

  // Generate Reply — use the client's template as the core and adapt it to the
  // actual conversation. Fills the composer; does not send.
  async function handleGenerateReply() {
    if (!detail) return;
    setSending("gen");
    try {
      const res = await fetch("/api/inbox/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: detail.id, instructions: genInstructions.trim() || undefined }) });
      const d = await res.json();
      if (d.ok && d.reply) { setReplyMsg(d.reply); setConfirmInline(null); toast.success(d.error ? d.error : "Reply generated from the client template"); }
      else toast.error(d.error || "Couldn't generate a reply");
    } catch (e) { toast.error((e as Error).message); }
    setSending(null);
  }

  // Run (or re-run) the qualification audit for this lead on demand — for
  // leads whose audit failed / never ran at ingest, or to refresh it.
  async function handleRunAudit(opts?: { silent?: boolean }) {
    if (!detail) return;
    const rid = detail.id;
    setSending("audit");
    try {
      const res = await fetch("/api/inbox/qualify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: rid }) });
      const d = await res.json();
      if (d.ok) {
        if (!opts?.silent) toast.success("Audit complete");
        // Merge ONLY the audit fields into the open detail — never reload, so a
        // manually edited / generated reply draft is preserved (items 8 & 9).
        const audit = (d.audit || {}) as Record<string, unknown>;
        setDetail((prev) => (prev && prev.id === rid ? { ...prev, ...audit } : prev));
        const cached = detailCache.current.get(rid);
        if (cached) detailCache.current.set(rid, { ...cached, ...audit });
      } else if (!opts?.silent) toast.error(d.error || "Audit failed");
    } catch (e) { if (!opts?.silent) toast.error((e as Error).message); }
    setSending(null);
  }

  // Pull the CURRENT client's latest template + CC/BCC into this lead and map
  // the variables — for leads that were in the inbox before the template existed.
  async function handleSyncTemplate() {
    if (!detail) return;
    setSending("synctpl");
    const d = await mutate({ action: "sync-template", id: detail.id });
    setSending(null);
    if (d.ok) { toast.success("Template + CC/BCC synced from the latest client config"); loadDetail(detail.id); }
    else toast.error(d.error || "Sync failed");
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
              {INBOX_VIEWS.filter((v) => {
                // Admins (no scope) see every view. Scoped users only see views
                // that would surface THEIR leads: Master Inbox, plus any view
                // whose tag filter overlaps their scope. Views that exclude all
                // of their tags (e.g. Base Clients Cherry excludes CWSJ) are hidden.
                if (!allowedClientTags || !allowedClientTags.length) return true;
                // Hide the generic Master Inbox when a dedicated one (e.g. "SBSPO
                // Master Inbox") already covers this user's whole scope — no dupe.
                if (v.id === "all") return !hasDedicatedMasterView(allowedClientTags);
                if (v.clientTag) return allowedClientTags.includes(v.clientTag);
                if (v.includeClientTags) return v.includeClientTags.some((t) => allowedClientTags.includes(t));
                if (v.excludeClientTags) return allowedClientTags.some((t) => !v.excludeClientTags!.includes(t));
                return true;
              }).map((v) => (
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
          {/* §18: AI Suggested category filter (server-side, all buckets). */}
          <SearchableCombobox
            value={filterAi}
            onValueChange={(v) => setFilterAi(v === "All AI Suggested" ? "" : v)}
            options={["All AI Suggested", ...AI_FILTER_CATEGORIES]}
            placeholder="All AI Suggested"
            searchPlaceholder="Search AI categories..."
            triggerClassName="h-6 text-[11px] py-0"
          />
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">{total} leads</p>
            {/* Client qualification rules — search audits/locations without leaving the inbox */}
            <button
              onClick={() => setShowQual(true)}
              title="Client qualification rules — search industries & locations, find best-fit client"
              className="inline-flex items-center gap-1 rounded border bg-white px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h10M7 13h6" /></svg>
              Rules
            </button>
          </div>
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
                  {categoryLeads[cat]?.map((r) => {
                    const viewers = presenceByLead.get(r.id);
                    return (
                    <button key={r.id} onClick={() => loadDetail(r.id, r)} onMouseEnter={() => prefetchDetail(r.id)}
                      className={`relative w-full text-left px-3 py-2 border-b border-muted/30 transition-colors ${selectedId === r.id ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/10 border-l-2 border-l-transparent"}`}>
                      {/* Live presence: who's viewing this lead — a top bar split
                          evenly by color, left-to-right by who opened it first. */}
                      {viewers && viewers.length > 0 && (
                        <div className="absolute top-0 left-0 right-0 flex h-1" aria-hidden>
                          {viewers.map((v, i) => (
                            <div key={`${v.email}-${i}`} style={{ backgroundColor: v.color, flex: 1 }} title={`${v.name} is viewing`} />
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-medium truncate flex-1">{r.lead_email}</p>
                        {/* Colored dots — one per viewer — unambiguously mark this row. */}
                        {viewers && viewers.length > 0 && (
                          <span className="flex -space-x-1 shrink-0">
                            {viewers.map((v, i) => (
                              <span key={`${v.email}-${i}`} title={`${v.name} is viewing`}
                                className="h-2.5 w-2.5 rounded-full ring-2 ring-white" style={{ backgroundColor: v.color }} />
                            ))}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-[10px] text-muted-foreground truncate">{r.ai_categorized_lead_category || "—"}</span>
                        <span className="text-[10px] font-mono font-bold text-primary/60">{r.client_tag || "N/A"}</span>
                        <InstanceBadge instance={r.bison_instance} size="xs" />
                      </div>
                    </button>
                    );
                  })}
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
          <div className="p-5 max-w-4xl mx-auto space-y-3 pb-16">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 pb-3 border-b">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center text-sm font-semibold shadow-sm">
                  {initials(detail.from_name || detail.lead_name, detail.lead_email)}
                </div>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold truncate">{detail.from_name || detail.lead_name || detail.lead_email}</h2>
                  <p className="text-xs text-muted-foreground truncate">{detail.lead_email}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 items-center justify-end">
                {/* Live collision warning: teammates also viewing this lead. */}
                {otherViewers.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-800"
                    title={`Also viewing: ${otherViewers.map((v) => v.name).join(", ")}`}
                  >
                    <span className="flex -space-x-1">
                      {otherViewers.map((v, i) => (
                        <span
                          key={`${v.email}-${i}`}
                          className="h-3.5 w-3.5 rounded-full ring-1 ring-white"
                          style={{ backgroundColor: v.color }}
                        />
                      ))}
                    </span>
                    {otherViewers.length === 1 ? `${otherViewers[0].name} also viewing` : `${otherViewers.length} also viewing`}
                  </span>
                )}
                {(detail.lead_category || "Open Response") === "Open Response" ? (
                  <LiveTimer startIso={detail.open_response_at || detail.created_at} />
                ) : detail.time_to_categorize_seconds != null ? (
                  // Completed record (§9): total time + who categorized; entered/left
                  // Open Response timestamps in the tooltip.
                  <span
                    className="text-[11px] px-2 py-0.5 rounded bg-emerald-50 text-emerald-700"
                    title={`Entered Open Response: ${detail.open_response_at ? new Date(detail.open_response_at).toLocaleString() : "—"}\nLeft Open Response: ${detail.categorized_at ? new Date(detail.categorized_at).toLocaleString() : "—"}\nCategorized by: ${detail.categorized_by || "—"}`}
                  >
                    ✓ moved in {fmtDuration(Number(detail.time_to_categorize_seconds))}
                    {detail.categorized_by ? <span className="text-emerald-600/70"> · by {String(detail.categorized_by).split("@")[0]}</span> : null}
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

            {/* Out-of-office re-send schedule (§21): when the original cold email
                is (or was) queued to re-send on the lead's stated return date. */}
            {detail.lead_category === "Out Of Office" && detail.auto_reply_kind === "out_of_office" && detail.auto_reply_due_at && (
              <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-3.5 py-2.5 text-xs text-yellow-800 flex items-center gap-2">
                <span className="shrink-0">📅</span>
                {detail.auto_reply_sent_at ? (
                  <span>Original cold email was re-sent on <strong>{fmtSendDate(detail.auto_reply_due_at)}</strong>.</span>
                ) : (
                  <span>Out of office — next eligible send date: <strong>{fmtSendDate(detail.auto_reply_due_at)}</strong> (9:00 AM PT). The original cold email re-sends then.</span>
                )}
              </div>
            )}

            {/* Email participants — From / To / CC / BCC */}
            <EmailParticipants detail={detail} />

            {/* Lead Details — compact label-on-top grid, theme-matched */}
            <div className="rounded-lg border bg-white px-3.5 py-3">
              <div className="grid grid-cols-3 gap-x-4 gap-y-2.5 text-xs">
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
                  <div key={f.l} className="min-w-0">
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-0.5">{f.l}</p>
                    {f.l === "Google Maps" && detail.google_maps_url ? (
                      <a href={detail.google_maps_url as string} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Open map ↗</a>
                    ) : f.l === "LinkedIn" && detail.linkedin_url ? (
                      <a href={detail.linkedin_url as string} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">Profile ↗</a>
                    ) : (
                      <p className="text-foreground break-words">{String(f.v)}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Change AI category (left) + Client tag & lead sheet (right) ── */}
            <div className="grid grid-cols-2 gap-3">
              {/* AI Lead Category — moves the lead into the views that match. */}
              <div className="rounded border bg-white px-4 py-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">AI Lead Category</span>
                  {aiSaving && <span className="text-[10px] text-muted-foreground">saving…</span>}
                </div>
                <SearchableCombobox
                  value={detail.ai_categorized_lead_category || ""}
                  onValueChange={updateAiCategory}
                  options={AI_FILTER_CATEGORIES}
                  placeholder="Set AI category…"
                  searchPlaceholder="Search categories…"
                  triggerClassName="w-full h-8 text-xs"
                />
                <p className="text-[10px] text-muted-foreground">Moves this lead into the views that match — e.g. Interested → the Cherry views.</p>
              </div>
              {/* Client tag — its lead-tracking sheet is auto-resolved from the registry. */}
              <div className="rounded border bg-white px-4 py-3 space-y-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Client Tag</span>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <SearchableCombobox
                      value={tsTag}
                      onValueChange={(v) => setTsTag((v || "").toUpperCase())}
                      options={(allowedClientTags ?? clientTags)}
                      placeholder="Pick a client tag…"
                      searchPlaceholder="Search tags…"
                      triggerClassName="w-full h-8 text-xs"
                    />
                  </div>
                  <Button size="sm" className="h-8 text-xs shrink-0" onClick={saveTagSheet} disabled={tsSaving || !tsTag || tsTag === detail.client_tag}>{tsSaving ? "Saving…" : "Save"}</Button>
                </div>
                <p className="text-[10px] text-muted-foreground">Relabels the lead&apos;s client tag (no template change). Its lead-tracking sheet is picked up automatically — if the lead fits a push category, it&apos;s routed to that client&apos;s sheet.</p>
              </div>
            </div>

            {/* Reply */}
            <div className="rounded border bg-white overflow-hidden">
              <div className="px-4 py-2 border-b bg-muted/20 flex justify-between items-center">
                <p className="text-xs text-muted-foreground truncate flex-1">{detail.email_subject}</p>
                <span className="text-[10px] text-muted-foreground ml-2 shrink-0">{detail.reply_time && new Date(detail.reply_time).toLocaleString()}</span>
              </div>
              <div className="px-4 py-3 text-[13px] whitespace-pre-wrap leading-relaxed max-h-52 overflow-y-auto">
                {detail.reply_we_got === undefined ? (
                  <div className="space-y-2 animate-pulse">
                    <div className="h-3 w-full rounded bg-muted" />
                    <div className="h-3 w-11/12 rounded bg-muted" />
                    <div className="h-3 w-3/5 rounded bg-muted" />
                  </div>
                ) : (detail.reply_we_got || "No content")}
              </div>
            </div>

            {/* No audit yet → let the team run it on demand. */}
            {!detail.industry_audit && !detail.location_audit && detail.client_tag && detail.client_tag !== "N/A" && (
              <div className="rounded border bg-white px-4 py-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium">No audit yet</p>
                  <p className="text-[11px] text-muted-foreground">Run the industry + location audit for this lead.</p>
                </div>
                <Button size="sm" className="h-8 text-xs shrink-0" onClick={() => handleRunAudit()} disabled={sending === "audit"}>{sending === "audit" ? "Auditing…" : "Run Audit"}</Button>
              </div>
            )}

            {/* Audit — industry + location split onto their own lines, with the
                suggested client tag surfaced when an audit failed. */}
            {(detail.industry_audit || detail.location_audit) && (() => {
              // qualification_reason is one combined string; split it back out.
              const parts = String(detail.qualification_reason || "").split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
              const industryReason = parts.find((p) => /^industry/i.test(p));
              const locationReason = parts.find((p) => /^location audit/i.test(p));
              const metaReasons = parts.filter((p) => p !== industryReason && p !== locationReason);
              const industryBad = detail.industry_audit === "Failed" || detail.industry_audit === "Residential";
              const locationBad = detail.location_audit === "Failed";
              // Suggested client on a failed audit (non-CW leads store a tag here;
              // CW leads use suggested_client for routing messages, shown below).
              const isCW = !!detail.client_tag?.toUpperCase().startsWith("CW");
              const suggested = !isCW && (industryBad || locationBad) ? String(detail.suggested_client || "").trim() : "";
              return (
                <div className="rounded border bg-white px-4 py-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Audit</span>
                    <button onClick={() => handleRunAudit()} disabled={sending === "audit"} className="text-[10px] text-muted-foreground hover:text-primary disabled:opacity-50">{sending === "audit" ? "Refreshing…" : "↻ Refresh"}</button>
                  </div>
                  {/* Industry */}
                  {detail.industry_audit && (
                    <div className="space-y-1">
                      <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full ${detail.industry_audit === "Passed" ? "bg-green-50 text-green-700" : detail.industry_audit === "Residential" ? "bg-yellow-50 text-yellow-700" : "bg-red-50 text-red-700"}`}>Industry: {detail.industry_audit}</span>
                      {industryReason && <p className="text-[11px] text-muted-foreground leading-relaxed">{industryReason.replace(/^industry audit:\s*/i, "")}</p>}
                    </div>
                  )}
                  {/* Location */}
                  {detail.location_audit && (
                    <div className="space-y-1">
                      <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full ${detail.location_audit === "Passed" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>Location: {detail.location_audit}</span>
                      {locationReason && <p className="text-[11px] text-muted-foreground leading-relaxed">{locationReason.replace(/^location audit:\s*/i, "")}</p>}
                    </div>
                  )}
                  {/* Source / data notes */}
                  {metaReasons.length > 0 && <p className="text-[10px] text-muted-foreground/70 leading-relaxed border-t pt-1.5">{metaReasons.join(" · ")}</p>}
                  {/* Suggested client on a failed audit — concise clickable tag
                      chips (click prefills the reallocation below). */}
                  {(() => {
                    const tags = suggested ? parseSuggestedTags(suggested, new Set(clientTags.map((t) => t.toUpperCase()))) : [];
                    // Failed audit but nothing to suggest — tell the user it ran and found none.
                    if (!tags.length) {
                      if (!isCW && (industryBad || locationBad)) {
                        return <p className="text-[11px] text-muted-foreground border-t pt-2">Suggested client: <span className="italic">no matching client found</span></p>;
                      }
                      return null;
                    }
                    return (
                      <div className="flex items-center gap-1.5 flex-wrap border-t pt-2">
                        <span className="text-[11px] text-muted-foreground">Suggested client:</span>
                        {tags.map(({ tag, reason }) => (
                          <span key={tag} className="relative group/sug inline-block">
                            <button
                              onClick={() => { setReallocTag(tag); toast.info(`Prefilled reallocation with ${tag}`); }}
                              className="text-[11px] font-mono font-bold text-primary bg-primary/10 px-2 py-0.5 rounded hover:bg-primary/20 transition-colors"
                            >{tag}</button>
                            {reason && (
                              <span className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-80 rounded-md bg-gray-900 px-3 py-2 text-[11px] leading-relaxed text-white shadow-lg group-hover/sug:block whitespace-normal">
                                {reason}
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {/* Find Best Fit Client — embedded below the audit; auto-populates
                location (reply-first, from the audit) + industry, shows the
                recommended tag, and prefills reallocation on click. */}
            <InboxBestFit
              leadKey={detail.id}
              initialLocation={[detail.audit_city || detail.city, detail.audit_state || detail.state].map((s) => String(s || "").trim()).filter(Boolean).join(", ")}
              initialIndustry={String(detail.audit_industry || "").trim()}
              onPick={(tag) => { setReallocTag(tag.toUpperCase()); toast.info(`Prefilled reallocation with ${tag}`); }}
            />

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

            {/* Client & Template — on every lead. Sync pulls the current
                client's latest template + CC/BCC (with variables mapped);
                Reallocate moves the lead to a different client tag and rewrites
                everything (template, CC/BCC, and which sheet it lands in). */}
            <div className="rounded border bg-white px-4 py-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Client &amp; Template</span>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleSyncTemplate} disabled={sending === "synctpl" || !detail.client_tag || detail.client_tag === "N/A"}>
                  {sending === "synctpl" ? "Syncing…" : "↻ Sync Template"}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground -mt-1">Syncs the latest template + CC/BCC from <span className="font-mono font-semibold">{detail.client_tag || "—"}</span> and maps the variables.</p>
              <div className="flex items-center gap-2 border-t pt-2.5">
                <span className="text-xs text-muted-foreground shrink-0">Reallocate to</span>
                <div className="w-44">
                  <SearchableCombobox
                    value={reallocTag}
                    onValueChange={(v) => setReallocTag((v || "").toUpperCase())}
                    options={(allowedClientTags ?? clientTags)}
                    placeholder="Pick a client…"
                    searchPlaceholder="Search client tags…"
                  />
                </div>
                <Button size="sm" className="h-8 text-xs" onClick={handleRealloc} disabled={!reallocTag || sending === "realloc"}>{sending === "realloc" ? "…" : "Assign"}</Button>
                <span className="text-[10px] text-muted-foreground">reroutes CC/BCC, template &amp; sheet</span>
              </div>
            </div>

            {/* Category — sits between Client & Template and Send Reply. */}
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

            {/* ── Send Reply (with CC/BCC pre-populated) ── */}
            <div className="rounded border bg-white px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium">Send Reply</p>
                <span className="text-[10px] text-muted-foreground">To: {detail.lead_email}</span>
              </div>
              {/* Optional Generate-Reply instructions + the Generate button to its right. */}
              <div className="flex items-center gap-2">
                <Input value={genInstructions} onChange={(e) => setGenInstructions(e.target.value)} placeholder="Optional instructions for ✨ Generate Reply (e.g. 'confirm we can start in December')" className="h-7 text-[11px] flex-1" />
                <Button size="sm" variant="outline" className="h-7 text-[11px] shrink-0" onClick={handleGenerateReply} disabled={sending === "gen"} title="Draft a reply from this client's template, tailored to the conversation">
                  {sending === "gen" ? "Generating…" : "✨ Generate Reply"}
                </Button>
              </div>
              {/* Persistent send status: failure stays until the next success. */}
              {detail.send_error && (
                <div className="rounded border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-800 space-y-1">
                  <div><span className="font-semibold">⚠ Last send failed:</span> {detail.send_error}. Your draft is kept — fix and retry.</div>
                  {isReconnectableSendError(detail.send_error) && (
                    <div className="text-[10px] text-rose-700">
                      🔌 This inbox lost its connection — we&apos;re reconnecting it and will automatically retry your reply (in ~1 hour, then ~2 hours). No action needed; your draft is kept.
                    </div>
                  )}
                </div>
              )}
              {detail.last_sent_at && !detail.send_error && (
                <p className="text-[11px] text-green-700">✓ Reply sent {new Date(detail.last_sent_at).toLocaleString()}</p>
              )}
              <Textarea value={replyMsg} onChange={(e) => { setReplyMsg(e.target.value); setConfirmInline(null); }} rows={4} placeholder="Type reply..." className="text-sm" />
              <div className="grid grid-cols-2 gap-3">
                <RecipientList label="CC Recipients" value={replyCc} onChange={setReplyCc} max={6} addLabel="Add CC" />
                <RecipientList label="BCC Recipients" value={replyBcc} onChange={setReplyBcc} max={2} addLabel="Add BCC" />
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-8 text-xs" onClick={handleSend} disabled={sending === "reply" || !replyMsg}>{sending === "reply" ? "Sending..." : confirmInline === "reply" ? "Confirm & Send" : "Send Reply"}</Button>
                {confirmInline === "reply" && <button onClick={() => setConfirmInline(null)} className="text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>}
                {confirmInline === "reply" && <span className="text-[11px] text-amber-700">Sends to {detail.lead_email} — confirm?</span>}
              </div>
            </div>

            {/* ── Email history (full conversation + our send attempts) ── */}
            <div className="rounded border bg-white px-4 py-2.5">
              <button onClick={() => setHistoryOpen((o) => !o)} className="w-full flex items-center justify-between text-xs font-medium">
                <span>Email history{history ? ` (${history.thread?.length || 0} message${(history.thread?.length || 0) === 1 ? "" : "s"})` : "…"}</span>
                <span className="text-muted-foreground">{historyOpen ? "▲" : "▼"}</span>
              </button>
              {historyOpen && (
                <div className="mt-2 space-y-1.5 max-h-80 overflow-y-auto">
                  {!history && <p className="text-[11px] text-muted-foreground">Loading…</p>}
                  {history && history.thread.length === 0 && <p className="text-[11px] text-muted-foreground">No prior messages found for this lead.</p>}
                  {history?.thread.map((m, i) => (
                    <div key={i} className={`rounded border px-2.5 py-1.5 text-[11px] ${m.direction === "sent" ? "bg-blue-50 border-blue-200" : "bg-slate-50 border-slate-200"}`}>
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span className="font-semibold">{m.direction === "sent" ? "→ Sent" : "← Received"}{m.sender ? ` · ${m.sender}` : ""}</span>
                        <span>{m.at ? new Date(m.at).toLocaleDateString() : ""}</span>
                      </div>
                      {m.subject && <p className="font-medium mt-0.5">{m.subject}</p>}
                      <p className="whitespace-pre-wrap text-muted-foreground mt-0.5">{m.body.length > 500 ? m.body.slice(0, 500) + "…" : m.body}</p>
                    </div>
                  ))}
                  {history && history.sends.length > 0 && (
                    <div className="pt-1.5 border-t space-y-0.5">
                      <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">ReplyRouter sends</p>
                      {history.sends.map((s) => (
                        <p key={s.id} className={`text-[10px] ${s.status === "failed" ? "text-rose-700" : "text-green-700"}`}>
                          {s.status === "sent" ? "✓ sent" : "⚠ failed"} · {new Date(s.created_at).toLocaleString()}{s.error ? ` · ${s.error}` : ""}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── More actions (Forward / One-Off) — collapsed by default ── */}
            <div className="rounded border bg-white">
              <button onClick={() => setMoreOpen((o) => !o)} className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-medium">
                <span>More actions <span className="font-normal text-muted-foreground">— forward, one-off reply</span></span>
                <span className="text-muted-foreground">{moreOpen ? "▲" : "▼"}</span>
              </button>
              {moreOpen && (
                <div className="px-4 pb-3 space-y-3 border-t pt-3">
                  {/* Forward */}
                  <div className="flex items-end gap-2">
                    <div className="flex-1"><Label className="text-[10px] text-muted-foreground">Forward to</Label><Input value={fwdTo} onChange={(e) => setFwdTo(e.target.value)} placeholder="email@example.com" className="text-xs h-8" /></div>
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleFwd} disabled={sending === "fwd" || !fwdTo}>{sending === "fwd" ? "..." : confirmInline === "fwd" ? "Confirm?" : "Forward"}</Button>
                  </div>
                  {/* One-Off */}
                  <div className="space-y-2 border-t pt-3">
                    <p className="text-xs font-medium">One-Off Reply</p>
                    <div className="text-[11px] text-muted-foreground space-y-0.5">
                      <p><span className="font-medium text-foreground">From:</span> {detail.sender_email || "—"}</p>
                      <p><span className="font-medium text-foreground">To:</span> {detail.lead_name ? `${detail.lead_name} — ` : ""}{detail.lead_email}</p>
                    </div>
                    <Input value={ooSubject} onChange={(e) => setOoSubject(e.target.value)} placeholder="Subject" className="text-xs h-8" />
                    <Textarea value={ooMsg} onChange={(e) => setOoMsg(e.target.value)} rows={3} placeholder="Message" className="text-sm" />
                    <RecipientList label="CC Recipients" value={ooCc} onChange={setOoCc} max={6} addLabel="Add CC" />
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleOneOff} disabled={sending === "oo" || !ooMsg || !ooSubject}>{sending === "oo" ? "..." : confirmInline === "oo" ? "Confirm & Send" : "Send"}</Button>
                  </div>
                </div>
              )}
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

      {/* Change-of-Target review (§22): pick the destination + edit + approve. */}
      {cotPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !cotPreview.sending && setCotPreview(null)}>
          <div className="w-full max-w-3xl rounded-xl border bg-white shadow-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">Change of Target — review before sending</h3>
                <p className="text-[11px] text-muted-foreground">Re-pitch the original cold email to the new contact.</p>
              </div>
              <button onClick={() => !cotPreview.sending && setCotPreview(null)} className="text-lg leading-none text-muted-foreground hover:text-foreground">×</button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {cotPreview.loading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Finding contacts &amp; preparing the email…</p>
              ) : (
                <>
                  {cotPreview.error && <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{cotPreview.error}</div>}
                  {cotPreview.manual && !cotPreview.error && <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-800">This reply isn&apos;t linked to the original campaign, so we couldn&apos;t attach the original cold email. Here&apos;s an editable re-pitch draft instead — review it before sending.</div>}

                  {/* The lead's original reply, for context while reviewing (§22). */}
                  {detail && detail.id === cotPreview.replyId && (
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-muted-foreground">Original reply</label>
                      <div className="rounded border bg-muted/20 px-3 py-2 text-[13px] leading-relaxed max-h-96 overflow-y-auto whitespace-pre-wrap">{detail.reply_we_got || "(no content)"}</div>
                    </div>
                  )}

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Send to</label>
                    {cotPreview.candidates.length > 0 && (
                      <Select value={cotPreview.toEmail} onValueChange={cotSelectRecipient}>
                        <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Choose recipient" /></SelectTrigger>
                        <SelectContent>
                          {cotPreview.candidates.map((c, i) => (
                            <SelectItem key={c.email} value={c.email}>{c.name ? `${c.name} — ` : ""}{c.email}{i === 0 ? "  ·  recommended" : ""}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <div className="flex gap-2">
                      <Input value={cotPreview.toName} onChange={(e) => cotPatch({ toName: e.target.value, message: cotPreview.messageDirty ? cotPreview.message : cotPreview.messageTemplate.replaceAll("{FIRST_NAME}", firstNameOf(e.target.value)) })} placeholder="Name" className="h-8 text-xs flex-1" />
                      <Input value={cotPreview.toEmail} onChange={(e) => cotPatch({ toEmail: e.target.value })} placeholder="email@example.com" className="h-8 text-xs flex-[2]" />
                    </div>
                    {cotPreview.candidates.length > 0 && <p className="text-[10px] text-muted-foreground">{cotPreview.candidates.length} contact{cotPreview.candidates.length > 1 ? "s" : ""} found in the reply — pick which one to pitch (or edit above).</p>}
                    {cotPreview.candidates.length === 0 && !cotPreview.error && <p className="text-[10px] text-muted-foreground">No contact auto-detected — enter the destination email above.</p>}
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Subject</label>
                    <Input value={cotPreview.subject} onChange={(e) => cotPatch({ subject: e.target.value })} className="h-8 text-xs" />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Message — edit as plain text</label>
                    <Textarea value={htmlToText(cotPreview.message)} onChange={(e) => cotPatch({ message: textToHtml(e.target.value), messageDirty: true })} rows={7} className="text-xs" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Live preview — exactly what will send</label>
                    <div className="rounded border bg-muted/20 px-3 py-2 text-[13px] max-h-52 overflow-y-auto" dangerouslySetInnerHTML={{ __html: cotPreview.message }} />
                  </div>
                </>
              )}
            </div>

            {!cotPreview.loading && (
              <div className="flex justify-end gap-2 border-t px-4 py-3">
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setCotPreview(null)} disabled={cotPreview.sending}>Cancel</Button>
                <Button size="sm" className="h-8 text-xs" onClick={sendCot} disabled={cotPreview.sending || !cotPreview.toEmail || !cotPreview.senderEmailId}>
                  {cotPreview.sending ? "Sending…" : "Approve & Send"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Send-Reply review (§15): stage the draft, edit/regenerate, then approve. */}
      {sendPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !sendPreview.sending && !sendPreview.regenerating && setSendPreview(null)}>
          <div className="w-full max-w-2xl rounded-xl border bg-white shadow-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">Send Reply — review before sending</h3>
                <p className="text-[11px] text-muted-foreground">{sendPreview.category} · nothing sends until you approve.</p>
              </div>
              <button onClick={() => !sendPreview.sending && !sendPreview.regenerating && setSendPreview(null)} className="text-lg leading-none text-muted-foreground hover:text-foreground">×</button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {/* The lead's inbound message, for context. */}
              {detail && detail.id === sendPreview.replyId && (
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Lead&apos;s reply</label>
                  <div className="rounded border bg-muted/20 px-3 py-2 text-[12px] max-h-32 overflow-y-auto whitespace-pre-wrap">{detail.reply_we_got || "(no content)"}</div>
                </div>
              )}

              {/* Sending account + recipients. */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Sending account (From)</label>
                  <div className="rounded border bg-muted/20 px-3 py-1.5 text-xs truncate" title={sendPreview.fromEmail}>{sendPreview.fromEmail || "—"}</div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">To</label>
                  <div className="flex gap-2">
                    <Input value={sendPreview.toName} onChange={(e) => sendPatch({ toName: e.target.value })} placeholder="Name" className="h-8 text-xs flex-1" />
                    <Input value={sendPreview.toEmail} onChange={(e) => sendPatch({ toEmail: e.target.value })} placeholder="email@example.com" className="h-8 text-xs flex-[2]" />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <RecipientList label="CC Recipients" value={sendPreview.cc} onChange={(next) => sendPatch({ cc: next })} max={6} addLabel="Add CC" />
                <RecipientList label="BCC Recipients" value={sendPreview.bcc} onChange={(next) => sendPatch({ bcc: next })} max={2} addLabel="Add BCC" />
              </div>

              {/* The draft — editable. */}
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">Reply draft</label>
                <Textarea value={sendPreview.message} onChange={(e) => sendPatch({ message: e.target.value, confirm: false })} rows={7} className="text-sm" placeholder="Type the reply…" />
              </div>

              {/* Regenerate with AI (optional freeform instructions). */}
              <div className="rounded border bg-muted/10 px-3 py-2 space-y-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">Regenerate with AI <span className="font-normal">(optional instructions)</span></label>
                <div className="flex gap-2">
                  <Input value={sendPreview.instructions} onChange={(e) => sendPatch({ instructions: e.target.value })} placeholder='e.g. "shorter and warmer", "offer a call Tuesday"' className="h-8 text-xs flex-1" disabled={sendPreview.regenerating} />
                  <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={regenerateSend} disabled={sendPreview.regenerating || sendPreview.sending}>
                    {sendPreview.regenerating ? "Rewriting…" : "Regenerate"}
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
              <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={declineSend} disabled={sendPreview.sending || sendPreview.regenerating}>Decline</Button>
              <div className="flex items-center gap-2">
                {sendPreview.confirm && <span className="text-[11px] text-amber-700">Send now?</span>}
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setSendPreview(null)} disabled={sendPreview.sending || sendPreview.regenerating}>Cancel</Button>
                <Button size="sm" className="h-8 text-xs" onClick={approveSend} disabled={sendPreview.sending || sendPreview.regenerating || !sendPreview.message.trim() || !sendPreview.toEmail || !sendPreview.senderEmailId}>
                  {sendPreview.sending ? "Sending…" : sendPreview.confirm ? "Confirm & Send" : "Approve & Send"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Client qualification rules drawer — search audits / locations / a
          client's industries + locations without leaving the inbox. */}
      {showQual && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setShowQual(false)}>
          <div className="w-full max-w-md bg-white h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">Client Qualification Rules</h3>
                <p className="text-[11px] text-muted-foreground">Search industries, locations, or find the best-fit client.</p>
              </div>
              <button onClick={() => setShowQual(false)} className="text-lg leading-none text-muted-foreground hover:text-foreground">×</button>
            </div>
            <div className="flex-1 overflow-hidden">
              <QualificationLookup />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
