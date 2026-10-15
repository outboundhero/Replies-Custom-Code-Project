"use client";

/**
 * Onboarding › Email copy — the master copy each client type's campaigns are
 * built from, and the clients that have their own copy instead (e.g. extra
 * lines for Canada). Edit the emails, the days between them and how each one
 * goes out (a new thread, or a reply in the same thread); add, remove and
 * reorder emails; see a live preview; save as a new version with a note; look
 * at or restore any earlier version. A client's own copy can be compared with
 * the shared one, and the page says when the shared copy has moved on.
 *
 * Text is Email Bison's own syntax (lib/onboarding/copy-model.ts), shown with
 * highlighting: {VARIABLES} blue, [[client fields]] violet, {spin|options}
 * amber. Unsaved edits survive switching tabs and are kept in this browser
 * until they are saved or discarded.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";
import { Popover as PopoverPrimitive } from "radix-ui";
import {
  AlertCircle, AlertTriangle, ArrowDown, ArrowUp, Braces, Check, ChevronDown, CircleCheck, CornerDownRight, FileText, GitCompareArrows,
  History, Loader2, Mail, Plus, RotateCcw, Save, Search, Shuffle, SlidersHorizontal, Sparkles, Trash2, Undo2, UserRound, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  CLIENT_FIELDS, CLIENT_TYPES, KNOWN_VARIABLES, LIMITS, checkSequence, cleanSequence, countVariants, defaultStructure, isClientType, normClientTag,
  renderSpin, seeded, sendDays, subjectOf, threadStart, tokenize,
  type ClientTypeKey, type CopyStep, type StepIssue, type ThreadMode,
} from "@/lib/onboarding/copy-model";

// ─────────────────────────── types & helpers ───────────────────────────

type Mode = "custom" | "shared";
/** One saved version — of a client type's shared copy, or of one client's own copy. */
type Version = {
  id: string; version: number; savedBy: string | null; savedAt: string; note: string | null;
  clientType: ClientTypeKey;
  /** A client's version can say "use the shared copy" (no emails). A type's is always "custom". */
  mode: Mode;
  /** A client's copy: the shared version it was made from or last checked against. */
  basedOn: number | null;
  sequence: { steps: CopyStep[] } | null;
};
type VersionMeta = Omit<Version, "sequence">;
type Target = { kind: "type"; type: ClientTypeKey } | { kind: "client"; tag: string };
/** Something the editor can open: a type's shared copy, or one client's own copy. */
type Entry = {
  key: string;
  target: Target;
  /** The emails in use (null: none yet, or a client that uses the shared copy). */
  current: Version | null;
  /** The newest version number — what a save must be based on. */
  latest: number | null;
  versions: VersionMeta[];
  basedOn: number | null;
  /** A type: itself. A client: the shared copy it follows / was made from. */
  clientType: ClientTypeKey;
};
type EditStep = CopyStep & { uid: string };
type Draft = { steps: EditStep[]; base: number | null; clientType: ClientTypeKey; basedOn: number | null };
type Drafts = Record<string, Draft>;
type PickClient = { tag: string; name: string | null };

const API = "/api/onboarding/email-copy";
const STORAGE_KEY = "onboarding-email-copy-drafts-v2";

let uidCounter = 0;
const newUid = () => `e${++uidCounter}`;
const toEdit = (steps: CopyStep[]): EditStep[] => steps.map((s) => ({ ...s, uid: newUid() }));
const toPlain = (steps: EditStep[]): CopyStep[] => steps.map((s) => ({ waitDays: s.waitDays, thread: s.thread, subject: s.subject, body: s.body }));
const fromVersion = (v: Version, latest: number | null): Draft => ({ steps: toEdit(v.sequence?.steps ?? []), base: latest ?? v.version, clientType: v.clientType, basedOn: v.basedOn });

/* eslint-disable @typescript-eslint/no-explicit-any -- shapes straight from our own API */
const asTypeVersion = (v: any): Version => ({
  id: String(v.id), version: Number(v.version), savedBy: v.savedBy ?? null, savedAt: String(v.savedAt), note: v.note ?? null,
  clientType: v.clientType, mode: "custom", basedOn: null, sequence: v.sequence ?? null,
});
const asClientVersion = (v: any): Version => ({
  id: String(v.id), version: Number(v.version), savedBy: v.savedBy ?? null, savedAt: String(v.savedAt), note: v.note ?? null,
  clientType: v.clientType, mode: v.mode === "shared" ? "shared" : "custom", basedOn: v.basedOn ?? null, sequence: v.sequence ?? null,
});
const metaOf = (v: Version): VersionMeta => ({ id: v.id, version: v.version, savedBy: v.savedBy, savedAt: v.savedAt, note: v.note, clientType: v.clientType, mode: v.mode, basedOn: v.basedOn });
const emptyClientEntry = (tag: string): Entry => ({ key: `client:${tag}`, target: { kind: "client", tag }, current: null, latest: null, versions: [], basedOn: null, clientType: "cleaning" });

/** The API's answer as editor entries: the four types, every client with a copy, and any client picked here. */
function buildEntries(lib: any[], clients: any[], picked: string[]): Entry[] {
  const types: Entry[] = lib.map((e) => {
    const cur = e.current ? asTypeVersion(e.current) : null;
    return {
      key: `type:${e.type}`, target: { kind: "type", type: e.type }, current: cur, latest: cur?.version ?? null,
      versions: (e.versions ?? []).map((v: any) => metaOf(asTypeVersion(v))), basedOn: null, clientType: e.type,
    };
  });
  const own: Entry[] = clients.map((c) => {
    const l = asClientVersion(c.latest);
    return {
      key: `client:${c.tag}`, target: { kind: "client", tag: c.tag }, current: l.mode === "custom" && l.sequence ? l : null, latest: l.version,
      versions: (c.versions ?? []).map((v: any) => metaOf(asClientVersion(v))), basedOn: l.basedOn, clientType: l.clientType,
    };
  });
  const have = new Set(own.map((e) => e.key));
  return [...types, ...own, ...picked.filter((t) => !have.has(`client:${t}`)).map(emptyClientEntry)];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The steps as the server will store them (mirrors cleanSequence), for "is anything changed?". */
function canon(steps: CopyStep[]): string {
  return JSON.stringify(steps.map((s, i) => [
    i ? s.waitDays : 0,
    i ? s.thread : "new",
    i === 0 ? s.subject ?? "" : s.thread === "new" ? s.subject : null,
    s.body.replace(/\r\n|\r/g, "\n"),
  ]));
}
function isDirty(draft: Draft | null | undefined, current: Version | null): boolean {
  if (!draft) return false;
  if (!current?.sequence) return true;
  return canon(toPlain(draft.steps)) !== canon(current.sequence.steps);
}

const typeLabel = (k: ClientTypeKey) => CLIENT_TYPES.find((t) => t.key === k)!.label;
const typeShort = (k: ClientTypeKey) => CLIENT_TYPES.find((t) => t.key === k)!.short;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
function fmtVariants(n: number): string {
  if (n >= 1e12) return "1T+";
  return n < 1000 ? String(n) : compact.format(n);
}
const whoSaved = (by: string | null) => (by ? by.split("@")[0] : "imported from Clay");
const savedLine = (by: string | null, at: string) => (by ? `saved by ${whoSaved(by)}, ${fmtWhen(at)}` : `imported from Clay, ${fmtWhen(at)}`);

// ── Moving emails around. The waits stay with their place in the schedule;
// the text (and how it's threaded) moves. Email 1 always starts a thread and
// owns the sequence's subject.

function moveStep(steps: EditStep[], i: number, dir: -1 | 1): EditStep[] {
  const j = i + dir;
  if (j < 0 || j >= steps.length) return steps;
  const out = steps.slice();
  const a = steps[i], b = steps[j];
  out[i] = { ...b, waitDays: a.waitDays };
  out[j] = { ...a, waitDays: b.waitDays };
  if (i === 0 || j === 0) {
    const oldFirst = steps[0], newFirst = i === 0 ? b : a;
    const k = i === 0 ? j : i; // where the old email 1 went
    const ownSubject = newFirst.thread === "new" && newFirst.subject !== null && newFirst.subject.trim() !== "";
    out[0] = { ...out[0], thread: "new", waitDays: 0, subject: ownSubject ? newFirst.subject : oldFirst.subject ?? "" };
    out[k] = { ...out[k], thread: "new", subject: ownSubject ? oldFirst.subject ?? "" : null };
  }
  return out;
}
function removeStep(steps: EditStep[], i: number): EditStep[] {
  const out = steps.filter((_, k) => k !== i);
  if (i === 0 && out.length) {
    const nf = out[0];
    const ownSubject = nf.thread === "new" && nf.subject !== null && nf.subject.trim() !== "";
    out[0] = { ...nf, thread: "new", waitDays: 0, subject: ownSubject ? nf.subject : steps[0].subject ?? "" };
  }
  return out;
}

// ── Highlighting (computed outside render components so they stay pure).

type Part = { text: string; cls?: string; title?: string };
const DEPTH_BG = ["", "bg-amber-400/[0.06]", "bg-amber-400/[0.12]", "bg-amber-400/[0.18]"];
const HL = {
  variable: "rounded-[3px] bg-sky-500/10 text-sky-700 ring-1 ring-inset ring-sky-500/25 dark:text-sky-300",
  unknownVariable: "rounded-[3px] bg-orange-500/10 text-orange-700 ring-1 ring-inset ring-orange-500/35 dark:text-orange-300",
  field: "rounded-[3px] bg-violet-500/10 text-violet-700 ring-1 ring-inset ring-violet-500/30 dark:text-violet-300",
  brace: "text-amber-600 dark:text-amber-400",
  pipe: "text-amber-500 dark:text-amber-400/80",
  bad: "rounded-[3px] bg-red-500/15 text-red-600 underline decoration-wavy decoration-red-500/70 dark:text-red-400",
};
const KNOWN = new Set<string>(KNOWN_VARIABLES);
const FIELD_KEYS = new Set<string>(CLIENT_FIELDS.map((f) => f.key));

function highlightParts(text: string): Part[] {
  const parts: Part[] = [];
  let depth = 0;
  for (const t of tokenize(text)) {
    const bg = DEPTH_BG[Math.min(depth, 3)];
    if (t.kind === "open") { depth++; parts.push({ text: t.text, cls: cn(HL.brace, DEPTH_BG[Math.min(depth, 3)]) }); continue; }
    if (t.kind === "close") { parts.push({ text: t.text, cls: cn(HL.brace, bg) }); depth = Math.max(0, depth - 1); continue; }
    if (t.kind === "pipe") { parts.push({ text: t.text, cls: cn(HL.pipe, bg) }); continue; }
    if (t.kind === "variable") {
      const known = KNOWN.has(t.text.slice(1, -1));
      parts.push({ text: t.text, cls: known ? HL.variable : HL.unknownVariable, title: known ? "Lead / sender variable" : "Not one of the usual variables" });
      continue;
    }
    if (t.kind === "field") {
      const key = t.text.slice(2, -2);
      parts.push({ text: t.text, cls: FIELD_KEYS.has(key) ? HL.field : HL.bad, title: FIELD_KEYS.has(key) ? "Filled in per client when the campaigns are made" : "Not a client field" });
      continue;
    }
    if (t.kind === "bad") { parts.push({ text: t.text, cls: HL.bad, title: "Email Bison deletes anything in angle brackets" }); continue; }
    parts.push({ text: t.text, cls: bg || undefined });
  }
  return parts;
}

function Highlighted({ text }: { text: string }) {
  const parts = useMemo(() => highlightParts(text), [text]);
  return <>{parts.map((p, i) => (p.cls ? <span key={i} className={p.cls} title={p.title}>{p.text}</span> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

// ── Preview: one way an email can read, with the substituted values marked.

const MK_OPEN = "", MK_SEP = "", MK_CLOSE = "";
type Sample = Record<string, string>;
const DEFAULT_SAMPLE: Sample = {
  FIRST_NAME: "Jordan", LAST_NAME: "Reyes", COMPANY: "Lakeside Dental", TITLE: "Office Manager",
  EMAIL: "jordan@lakesidedental.com", CITY: "Plano", STATE: "TX", QUESTION: "who handles cleaning for your office?",
  SENDER_FIRST_NAME: "Madison", SENDER_LAST_NAME: "Clark", SENDER_FULL_NAME: "Madison Clark",
  SERVICE_AREA: "Serving Plano, Frisco, McKinney & the rest of North Dallas",
  OFFICE_ADDRESS: "6100 Windhaven Pkwy, Plano, TX 75093",
  COMPANY_NAME: "Brightline Commercial Cleaning",
};
const SAMPLE_FIELDS: { key: string; label: string; wide?: boolean }[] = [
  { key: "FIRST_NAME", label: "First name" }, { key: "COMPANY", label: "Company" },
  { key: "CITY", label: "City" }, { key: "SENDER_FULL_NAME", label: "Sender" },
  { key: "SERVICE_AREA", label: "Service area", wide: true }, { key: "OFFICE_ADDRESS", label: "Office address", wide: true },
  { key: "COMPANY_NAME", label: "Client company", wide: true },
];

function markedValues(text: string, sample: Sample, filled: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tokenize(text)) {
    if (t.kind !== "variable" && t.kind !== "field") continue;
    const key = t.kind === "variable" ? t.text.slice(1, -1) : t.text.slice(2, -2);
    const v = sample[key]?.trim();
    out[key] = `${MK_OPEN}${filled && v ? "v" : "t"}${t.text}${MK_SEP}${filled && v ? v : t.text}${MK_CLOSE}`;
  }
  return out;
}
function renderPreview(text: string, seed: number, sample: Sample, filled: boolean): string {
  return renderSpin(text, seeded(seed), markedValues(text, sample, filled));
}
function Marked({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/([\s\S]*?)/), [text]);
  return (
    <>
      {parts.map((p, i) => {
        if (!p.startsWith(MK_OPEN)) return <Fragment key={i}>{p}</Fragment>;
        const body = p.slice(1, -1);
        const [head, value] = body.split(MK_SEP);
        const filled = head[0] === "v", tag = head.slice(1);
        return filled
          ? <span key={i} title={tag} className="rounded-sm bg-sky-500/[0.07] underline decoration-sky-500/40 decoration-dotted underline-offset-[3px]">{value}</span>
          : <span key={i} className={cn("rounded-[3px] px-0.5 font-mono text-[0.86em]", tag.startsWith("[[") ? HL.field : KNOWN.has(tag.slice(1, -1)) ? HL.variable : HL.unknownVariable)}>{value}</span>;
      })}
    </>
  );
}
const stripMarks = (s: string) => s.replace(/[vt][^]*([\s\S]*?)/g, "$1");

// ─────────────────────────── small building blocks ───────────────────────────

const FIELD_TEXT = "m-0 whitespace-pre-wrap [overflow-wrap:anywhere] px-3.5 py-2.5 font-mono text-[12.5px] leading-[1.75] [tab-size:4]";

/**
 * A textarea with live highlighting: the text is drawn by a layer behind a
 * transparent textarea with the exact same font and wrapping. It grows with
 * its content; `single` keeps it to one line (Enter does nothing).
 */
function CodeField({ value, onChange, textareaRef, single = false, placeholder, invalid, label, minRows = 1, onFocus }: {
  value: string; onChange: (v: string) => void; textareaRef: RefObject<HTMLTextAreaElement | null>;
  single?: boolean; placeholder?: string; invalid?: boolean; label: string; minRows?: number; onFocus?: () => void;
}) {
  const grow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [textareaRef]);
  useLayoutEffect(grow, [value, grow]);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = 0;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w !== lastWidth) { lastWidth = w; grow(); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [grow, textareaRef]);

  return (
    <div className={cn(
      "relative rounded-lg border bg-background shadow-xs transition-[border-color,box-shadow]",
      "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30",
      invalid && "border-destructive/50 focus-within:border-destructive/60 focus-within:ring-destructive/15",
    )}>
      <div aria-hidden className={cn(FIELD_TEXT, "pointer-events-none absolute inset-0 overflow-hidden text-foreground")}>
        <Highlighted text={value} />{"​"}
      </div>
      <textarea
        ref={textareaRef}
        aria-label={label}
        value={value}
        rows={minRows}
        spellCheck={false}
        placeholder={placeholder}
        onFocus={onFocus}
        onChange={(e) => onChange(single ? e.target.value.replace(/\r?\n/g, " ") : e.target.value)}
        onKeyDown={(e) => { if (single && e.key === "Enter") e.preventDefault(); }}
        style={{ minHeight: `calc(${minRows} * 1.75 * 12.5px + 1.25rem + 2px)` }}
        className={cn(
          FIELD_TEXT,
          "relative block w-full resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none",
          "placeholder:text-muted-foreground/55 selection:bg-sky-500/25 selection:text-transparent",
        )}
      />
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, size = "sm" }: {
  value: T; onChange: (v: T) => void; size?: "sm" | "xs";
  options: { value: T; label: string; icon?: ReactNode; title?: string }[];
}) {
  return (
    <div role="radiogroup" className="inline-flex items-center rounded-lg bg-muted p-0.5 text-muted-foreground">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title}
          onClick={() => { if (o.value !== value) onChange(o.value); }}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            size === "sm" ? "h-7 px-2.5 text-xs" : "h-6 px-2 text-[11px]",
            value === o.value ? "bg-background text-foreground shadow-xs" : "hover:text-foreground",
          )}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground outline-none">
      <span className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring/50",
        checked ? "bg-foreground" : "bg-input",
      )}>
        <span className={cn("size-3 rounded-full bg-background shadow-sm transition-transform", checked ? "translate-x-3.5" : "translate-x-0.5")} />
      </span>
      {label}
    </button>
  );
}

/** A button that asks once more ("Sure?") before doing something you can't undo. */
function ConfirmButton({ onConfirm, children, confirmLabel, className, icon, size = "sm", title, disabled }: {
  onConfirm: () => void; children?: ReactNode; confirmLabel: string; className?: string; icon?: ReactNode;
  size?: "sm" | "icon-sm"; title?: string; disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return armed && !disabled ? (
    <Button type="button" size="sm" variant="destructive" className={cn("h-8", className)}
      onClick={() => { if (timer.current) clearTimeout(timer.current); setArmed(false); onConfirm(); }}>
      {confirmLabel}
    </Button>
  ) : (
    <Button type="button" size={size} variant="ghost" title={title} aria-label={title} className={className} disabled={disabled}
      onClick={() => { setArmed(true); timer.current = setTimeout(() => setArmed(false), 3500); }}>
      {icon}{children}
    </Button>
  );
}

/** Put `snippet` at the caret (or wrap the selection) and keep typing from there. */
function insertInto(el: HTMLTextAreaElement | null, value: string, set: (v: string) => void, snippet: string, spin = false) {
  const s = el?.selectionStart ?? value.length, e = el?.selectionEnd ?? value.length;
  let next: string, caret: number;
  if (spin) {
    const sel = value.slice(s, e);
    next = `${value.slice(0, s)}{${sel}|}${value.slice(e)}`;
    caret = sel ? s + sel.length + 2 : s + 1;
  } else {
    next = value.slice(0, s) + snippet + value.slice(e);
    caret = s + snippet.length;
  }
  set(next);
  requestAnimationFrame(() => { if (!el) return; el.focus(); el.setSelectionRange(caret, caret); });
}

/**
 * Keep `col` in view while its `bound` scrolls past (wide screens only).
 * CSS sticky can't do it here: the dashboard's <main> is overflow:auto but
 * the window is what scrolls, so a sticky element never sticks.
 */
function useFollowScroll(col: RefObject<HTMLDivElement | null>, bound: RefObject<HTMLDivElement | null>, key: unknown, gap = 16) {
  useEffect(() => {
    if (!col.current || !bound.current) return;
    let raf = 0;
    const place = (shift: number) => {
      const el = col.current;
      if (el) el.style.transform = shift > 0 ? `translateY(${Math.round(shift)}px)` : "";
    };
    const update = () => {
      raf = 0;
      const c = col.current, b = bound.current;
      if (!c || !b) return;
      if (window.innerWidth < 1024) { place(0); return; }
      const box = b.getBoundingClientRect();
      place(Math.max(0, Math.min(gap - box.top, box.height - c.offsetHeight)));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    ro?.observe(bound.current); ro?.observe(col.current);
    update();
    return () => {
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      place(0);
    };
  }, [col, bound, key, gap]);
}

// ─────────────────────────── the editor ───────────────────────────

const labelOf = (t: Target) => (t.kind === "type" ? typeShort(t.type) : t.tag);

export function EmailCopyEditor({ active, clients: pickable, openClient }: {
  active: boolean;
  /** Onboarding clients — the ones that can be given their own copy. */
  clients: PickClient[];
  /** Open this client's copy first (from its page). */
  openClient?: string | null;
}) {
  const session = useSession();
  // Unsaved edits are kept per person in this browser.
  const storageKey = `${STORAGE_KEY}:${session?.email ?? "anon"}`;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState("type:cleaning");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [saveOpen, setSaveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [busy, setBusy] = useState<"use-shared" | "checked" | null>(null);
  const entriesRef = useRef<Entry[] | null>(null);
  // Clients opened here that have nothing saved yet (they still get a chip).
  const pickedRef = useRef<string[]>([]);
  const restoredRef = useRef(false);
  // Each load (and each save applied here) takes a number; an answer that isn't the newest is ignored.
  const seqRef = useRef(0);
  const openClientRef = useRef(normClientTag(openClient));
  // What this tab has changed — only these are written to (or cleared from) storage,
  // so another tab's kept edits are left alone.
  const touchedRef = useRef(new Set<string>());
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const putEntries = useCallback((list: Entry[]) => { entriesRef.current = list; setEntries(list); }, []);
  const addPicked = useCallback((tag: string) => { if (!pickedRef.current.includes(tag)) pickedRef.current = [...pickedRef.current, tag]; }, []);

  const load = useCallback(async (reset?: string) => {
    const seq = ++seqRef.current;
    try {
      const r = await fetch(API, { cache: "no-store" });
      if (r.status === 401) { window.location.href = "/login"; return; }
      const j = await r.json().catch(() => null);
      if (seq !== seqRef.current) return; // a newer load or a save happened meanwhile
      if (!r.ok || !j?.ok) { setLoadErr(j?.error ?? `Couldn't load the email copy (${r.status}).`); return; }
      const prev = entriesRef.current;

      if (!restoredRef.current) {
        // First load: start from what's saved, then put back any edits this
        // browser kept. Edits made on an older version come back too, still
        // based on it — saving them then asks whether to replace the newer one.
        restoredRef.current = true;
        let stored: Record<string, { base?: unknown; steps?: unknown; clientType?: unknown; basedOn?: unknown }> = {};
        try { const raw = JSON.parse(localStorage.getItem(storageKey) || "{}"); if (raw && typeof raw === "object") stored = raw; } catch { /* no storage */ }
        for (const k of Object.keys(stored)) { const t = k.startsWith("client:") ? normClientTag(k.slice(7)) : null; if (t) addPicked(t); }
        const want = openClientRef.current;
        if (want) addPicked(want);
        const list = buildEntries(j.library ?? [], j.clients ?? [], pickedRef.current);
        putEntries(list);
        setLoadErr(null);
        const next: Drafts = {};
        const restored: string[] = [], stale: string[] = [];
        for (const e of list) {
          if (e.current) next[e.key] = fromVersion(e.current, e.latest);
          const s = stored[e.key];
          const seq = s ? cleanSequence({ steps: s.steps }) : null;
          if (!s || !seq?.steps.length || seq.steps.length > LIMITS.maxSteps) continue;
          if (e.current?.sequence && canon(seq.steps) === canon(e.current.sequence.steps)) continue; // nothing left to save
          const base = Number.isInteger(s.base) ? Number(s.base) : null;
          next[e.key] = {
            steps: toEdit(seq.steps), base,
            clientType: e.target.kind === "type" ? e.target.type : isClientType(s.clientType) ? s.clientType : e.clientType,
            basedOn: e.target.kind === "type" ? null : Number.isInteger(s.basedOn) ? Number(s.basedOn) : e.basedOn,
          };
          (base === e.latest ? restored : stale).push(labelOf(e.target));
        }
        setDrafts(next);
        if (want) setTargetKey(`client:${want}`);
        if (restored.length) toast.info(`Your unsaved edits to the ${restored.join(" and ")} copy are back.`);
        if (stale.length) toast.warning(`Your unsaved edits to the ${stale.join(" and ")} copy are back, but someone saved a newer version since. Saving will ask whether to replace it.`, { duration: 10000 });
        return;
      }

      const list = buildEntries(j.library ?? [], j.clients ?? [], pickedRef.current);
      putEntries(list);
      setLoadErr(null);
      setDrafts((d) => {
        const next = { ...d };
        for (const e of list) {
          const mine = next[e.key];
          const before = prev?.find((p) => p.key === e.key)?.current ?? null;
          if (mine && e.key !== reset && isDirty(mine, before)) continue; // keep unsaved edits
          if (e.current) next[e.key] = fromVersion(e.current, e.latest); else delete next[e.key];
        }
        return next;
      });
    } catch (e) {
      if (seq === seqRef.current) setLoadErr((e as Error).message || "Couldn't load the email copy.");
    }
  }, [storageKey, putEntries, addPicked]);

  // Load when the tab is first shown, and refresh each time it's shown again (unsaved edits are kept).
  useEffect(() => { if (active) load(); }, [active, load]);

  /** Put a version the server just saved straight into the page (no second request needed). */
  const applyVersion = useCallback((key: string, v: Version) => {
    seqRef.current++; // an answer to a load sent before this save is out of date
    putEntries((entriesRef.current ?? []).map((e) => (e.key !== key ? e : {
      ...e,
      current: v.mode === "custom" && v.sequence ? v : null,
      latest: v.version,
      basedOn: v.basedOn,
      clientType: v.clientType,
      versions: [metaOf(v), ...e.versions.filter((x) => x.version !== v.version)],
    })));
    touchedRef.current.add(key);
    setDrafts((d) => {
      const next = { ...d };
      if (v.mode === "custom" && v.sequence) next[key] = fromVersion(v, v.version); else delete next[key];
      return next;
    });
  }, [putEntries]);

  const entry = entries?.find((e) => e.key === targetKey) ?? null;
  const target: Target = entry?.target ?? { kind: "type", type: "cleaning" };
  const current = entry?.current ?? null;
  const draft = drafts[targetKey] ?? null;
  const steps = useMemo(() => draft?.steps ?? [], [draft]);
  const plain = useMemo(() => toPlain(steps), [steps]);
  const check = useMemo(() => checkSequence({ steps: plain }), [plain]);
  const days = useMemo(() => sendDays({ steps: plain }), [plain]);
  const dirty = isDirty(draft, current);
  const dirtyKeys = useMemo(() => (entries ?? []).filter((e) => isDirty(drafts[e.key], e.current)).map((e) => e.key), [entries, drafts]);
  const anyDirty = dirtyKeys.length > 0;
  const sel = Math.min(selected, Math.max(0, steps.length - 1));
  const nameByTag = useMemo(() => new Map(pickable.map((c) => [c.tag.toUpperCase(), c.name])), [pickable]);
  const sharedOf = useCallback((t: ClientTypeKey) => entries?.find((e) => e.key === `type:${t}`)?.current ?? null, [entries]);
  useFollowScroll(previewRef, gridRef, `${entries ? 1 : 0}-${draft ? targetKey : "none"}`);

  // Keep unsaved edits in this browser (and warn before leaving the page).
  useEffect(() => {
    if (!entries || !touchedRef.current.size) return;
    try {
      let kept: Record<string, unknown> = {};
      try { const raw = JSON.parse(localStorage.getItem(storageKey) || "{}"); if (raw && typeof raw === "object") kept = raw; } catch { /* unreadable → start over */ }
      for (const k of touchedRef.current) {
        const d = drafts[k], cur = entries.find((e) => e.key === k)?.current ?? null;
        if (d && isDirty(d, cur)) kept[k] = { base: d.base, steps: toPlain(d.steps), clientType: d.clientType, basedOn: d.basedOn };
        else delete kept[k];
      }
      if (Object.keys(kept).length) localStorage.setItem(storageKey, JSON.stringify(kept));
      else localStorage.removeItem(storageKey);
    } catch { /* storage unavailable — edits still live in the page */ }
  }, [entries, drafts, storageKey]);
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const setSteps = useCallback((fn: (s: EditStep[]) => EditStep[]) => {
    touchedRef.current.add(targetKey);
    setDrafts((d) => {
      const cur = d[targetKey];
      return cur ? { ...d, [targetKey]: { ...cur, steps: fn(cur.steps) } } : d;
    });
  }, [targetKey]);
  const patchStep = useCallback((i: number, patch: Partial<CopyStep>) => {
    setSteps((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  }, [setSteps]);

  // The email that just moved is briefly highlighted, so it's easy to see where it went.
  const [flashUid, setFlashUid] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const flash = useCallback((uid: string) => {
    setFlashUid(uid);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashUid(null), 1800);
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`copy-email-${uid}`)?.scrollIntoView({ behavior: "smooth", block: "center" })));
  }, []);

  /** Move an email up or down — shown, highlighted, and undoable. */
  const moveEmail = (i: number, dir: -1 | 1) => {
    const before = steps;
    const moved = steps[i];
    const to = i + dir;
    if (!moved || to < 0 || to >= steps.length) return;
    setSteps((x) => moveStep(x, i, dir));
    setSelected(to);
    flash(moved.uid);
    toast.success(`Email ${i + 1} moved ${dir > 0 ? "down" : "up"} — it's now email ${to + 1}.`, {
      description: i === 0 || to === 0
        ? "The first email keeps the sequence's subject, and the waits stay with their place in the schedule."
        : "The waits stay with their place in the schedule.",
      action: { label: "Undo", onClick: () => { setSteps(() => before); setSelected(i); flash(moved.uid); } },
    });
  };
  /** Remove an email — undoable for a few seconds. */
  const removeEmail = (i: number) => {
    const before = steps;
    setSteps((x) => removeStep(x, i));
    setSelected(Math.max(0, i - 1));
    toast.success(`Email ${i + 1} removed.`, {
      description: steps.length - 1 === 1 ? "One email is left." : `${steps.length - 1} emails are left.`,
      action: { label: "Undo", onClick: () => { setSteps(() => before); setSelected(i); flash(before[i].uid); } },
    });
  };

  const focusEmail = useCallback((i: number, uid?: string) => {
    setSelected(i);
    if (uid) {
      setCollapsed((c) => (c[uid] ? { ...c, [uid]: false } : c));
      requestAnimationFrame(() => document.getElementById(`copy-email-${uid}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }, []);

  const startDraft = (from: CopyStep[], clientType: ClientTypeKey, basedOn: number | null) => {
    touchedRef.current.add(targetKey);
    setDrafts((d) => ({ ...d, [targetKey]: { steps: toEdit(from), base: entry?.latest ?? null, clientType, basedOn } }));
    setSelected(0);
  };
  const discard = () => {
    touchedRef.current.add(targetKey);
    setDrafts((d) => {
      const next = { ...d };
      if (current) next[targetKey] = fromVersion(current, entry?.latest ?? null); else delete next[targetKey];
      return next;
    });
    setSelected(0);
    toast.success("Changes discarded.");
  };
  const addEmail = () => {
    if (steps.length >= LIMITS.maxSteps) return;
    const uid = newUid();
    setSteps((s) => [...s, { uid, waitDays: 3, thread: "reply", subject: null, body: "" }]);
    focusEmail(steps.length, uid);
  };
  const open = (key: string) => { setTargetKey(key); setSelected(0); };
  const pickClient = (tag: string) => {
    const t = tag.toUpperCase();
    addPicked(t);
    if (!(entriesRef.current ?? []).some((e) => e.key === `client:${t}`)) putEntries([...(entriesRef.current ?? []), emptyClientEntry(t)]);
    open(`client:${t}`);
  };

  const requestSave = useCallback(() => {
    if (!draft) return;
    if (!dirty) { toast("Nothing to save — no changes yet."); return; }
    if (check.errors.length) {
      const first = check.errors[0];
      toast.error(`Fix ${plural(check.errors.length, "problem")} before saving.`, { description: first.step && !first.message.startsWith(`Email ${first.step} `) ? `Email ${first.step}: ${first.message}` : first.message });
      const s = steps[Math.max(0, first.step - 1)];
      if (s) focusEmail(Math.max(0, first.step - 1), s.uid);
      return;
    }
    setSaveOpen(true);
  }, [draft, dirty, check.errors, steps, focusEmail]);

  // ⌘S / Ctrl+S — only while this tab is the one showing.
  const requestSaveRef = useRef(requestSave);
  useEffect(() => { requestSaveRef.current = requestSave; }, [requestSave]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      e.preventDefault();
      requestSaveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** A client's "use the shared copy again" / "mark as checked". */
  const clientAction = async (action: "use-shared" | "checked") => {
    if (!entry || entry.target.kind !== "client") return;
    const tag = entry.target.tag;
    setBusy(action);
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, client: tag, baseVersion: entry.latest }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok || !j.version) { toast.error(j.error ?? `Couldn't do that (${r.status}).`); if (r.status === 409) void load(); return; }
      const v = asClientVersion(j.version);
      applyVersion(entry.key, v);
      toast.success(action === "use-shared"
        ? `${tag} uses the shared ${typeShort(v.clientType)} copy again. Its own versions stay in the history.`
        : `Noted: ${tag}'s copy was checked against the shared ${typeShort(v.clientType)} copy, version ${v.basedOn}.`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!entries) {
    return (
      <div ref={rootRef} className="space-y-4">
        {loadErr ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <span>{loadErr}</span>
            <Button size="sm" variant="outline" onClick={() => load()}><RotateCcw /> Try again</Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{CLIENT_TYPES.map((t) => <div key={t.key} className="h-[74px] animate-pulse rounded-xl border bg-muted/40" />)}</div>
            <div className="h-[72px] animate-pulse rounded-xl border bg-muted/30" />
            <div className="grid gap-5 lg:grid-cols-12">
              <div className="space-y-3 lg:col-span-7">{[0, 1, 2].map((i) => <div key={i} className="h-48 animate-pulse rounded-xl border bg-muted/30" />)}</div>
              <div className="h-96 animate-pulse rounded-xl border bg-muted/30 lg:col-span-5" />
            </div>
          </>
        )}
      </div>
    );
  }

  const typeEntries = entries.filter((e) => e.target.kind === "type");
  const clientEntries = entries.filter((e) => e.target.kind === "client");
  const isClient = target.kind === "client";
  const clientTag = target.kind === "client" ? target.tag : null;
  const followType: ClientTypeKey = draft?.clientType ?? entry?.clientType ?? (target.kind === "type" ? target.type : "cleaning");
  const sharedNow = sharedOf(followType);
  const basedOnNow = draft?.basedOn ?? entry?.basedOn ?? null;
  const sharedMoved = isClient && !!(current || draft) && !!sharedNow && basedOnNow != null && sharedNow.version > basedOnNow;
  const cleaningCurrent = sharedOf("cleaning");
  const totalDays = days[days.length - 1] ?? 0;
  const threads = plain.filter((s, i) => i === 0 || s.thread === "new").length;
  const title = target.kind === "type" ? `the ${typeLabel(target.type)} copy` : `${target.tag}'s copy`;

  return (
    <div ref={rootRef} className="space-y-5">
      {loadErr && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          <span>{loadErr}</span>
          <Button size="sm" variant="outline" onClick={() => load()}><RotateCcw /> Try again</Button>
        </div>
      )}

      {/* Shared copy per client type — what each has, at a glance */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {typeEntries.map((e) => {
          const t = (e.target as { type: ClientTypeKey }).type;
          const isOn = e.key === targetKey, isEdited = dirtyKeys.includes(e.key);
          const n = e.current?.sequence?.steps.length ?? 0;
          return (
            <button key={e.key} type="button" onClick={() => open(e.key)} aria-pressed={isOn}
              className={cn(
                "group relative rounded-xl border bg-card px-4 py-3 text-left transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                isOn ? "border-foreground/25 shadow-sm ring-1 ring-foreground/10" : "hover:border-foreground/15 hover:bg-accent/30",
              )}>
              <div className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", isEdited ? "bg-amber-500" : e.current ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                <span className="text-sm font-medium">{typeLabel(t)}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {isEdited ? <span className="text-amber-600 dark:text-amber-400">Unsaved changes</span>
                  : e.current ? <>{plural(n, "email")} · version {e.current.version}</>
                  : "No copy yet"}
              </div>
              {isOn && <span className="absolute inset-x-4 -bottom-px h-0.5 rounded-full bg-foreground" />}
            </button>
          );
        })}
      </div>

      <ClientCopiesCard entries={clientEntries} selectedKey={targetKey} dirtyKeys={dirtyKeys} names={nameByTag}
        sharedVersion={(t) => sharedOf(t)?.version ?? null} pickable={pickable} onOpen={open} onPick={pickClient} />

      {target.kind === "type" && target.type === "os" && (
        <div className="flex items-start gap-2.5 rounded-xl border border-sky-500/20 bg-sky-500/[0.04] px-4 py-3 text-sm text-muted-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
          <span>OS clients&apos; campaigns are set up by hand. This copy is kept here so it can be edited in one place for every OS client.</span>
        </div>
      )}

      {isClient && clientTag && (draft || current) && (
        <ClientHeader tag={clientTag} name={nameByTag.get(clientTag) ?? null} followType={followType}
          own={!!current} dirty={dirty} basedOn={basedOnNow} sharedNow={sharedNow?.version ?? null} sharedMoved={sharedMoved} busy={busy}
          onCompare={() => setCompareOpen(true)} onChecked={() => clientAction("checked")} onUseShared={() => clientAction("use-shared")} />
      )}

      {!draft ? (
        isClient && clientTag ? (
          <ClientEmpty key={clientTag} tag={clientTag} name={nameByTag.get(clientTag) ?? null} typeEntries={typeEntries} defaultType={entry?.clientType ?? "cleaning"}
            hadOwn={(entry?.versions.length ?? 0) > 0} onHistory={() => setHistoryOpen(true)}
            onStart={(t) => { const s = sharedOf(t); if (s?.sequence) startDraft(s.sequence.steps, t, s.version); }} />
        ) : (
          <EmptyCopy label={typeLabel(followType)} who={`${typeShort(followType)} clients`} hasCleaning={!!cleaningCurrent && followType !== "cleaning"}
            onFromCleaning={() => cleaningCurrent?.sequence && startDraft(cleaningCurrent.sequence.steps, followType, null)}
            onBlank={() => startDraft(defaultStructure(), followType, null)} />
        )
      ) : (
        <>
          {/* Toolbar: what's in use, and the actions */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={current?.note ?? undefined}>
              {current ? (
                <span>
                  <span className="font-medium text-foreground">Version {current.version}</span> in use
                  <span className="mx-1.5 text-muted-foreground/50">·</span>{savedLine(current.savedBy, current.savedAt)}
                  {current.note && <><span className="mx-1.5 text-muted-foreground/50">·</span><span className="italic">“{current.note}”</span></>}
                </span>
              ) : isClient ? (
                <span><span className="font-medium text-foreground">Not saved yet</span> — {clientTag}&apos;s campaigns still use the shared {typeShort(followType)} copy.</span>
              ) : (
                <span><span className="font-medium text-foreground">New copy</span> — not saved yet, so no campaign uses it.</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {entry && entry.versions.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}><History /> History <span className="tabular-nums text-muted-foreground">{entry.versions.length}</span></Button>
              )}
              {dirty && <ConfirmButton onConfirm={discard} confirmLabel="Discard all changes?" icon={<Undo2 />}>Discard</ConfirmButton>}
              <Button size="sm" onClick={requestSave} disabled={!dirty} title="Save (⌘S)">
                <Save /> Save{dirty && check.errors.length > 0 && <span className="ml-0.5 rounded-full bg-destructive px-1.5 text-[10px] leading-4 text-white tabular-nums">{check.errors.length}</span>}
              </Button>
            </div>
          </div>

          {/* The schedule at a glance */}
          <div className="rounded-xl border bg-card px-5 py-4">
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Sequence</div>
                <div className="mt-1 text-lg font-semibold tracking-tight">
                  {plural(steps.length, "email")} <span className="font-normal text-muted-foreground">over</span> {plural(totalDays, "day")}
                </div>
                <div className="text-xs text-muted-foreground">{plural(threads, "thread")} · each wait counts from the email before; the campaign&apos;s schedule sets the sending times</div>
              </div>
              <SequenceRibbon steps={steps} days={days} selected={sel} onPick={(i) => focusEmail(i, steps[i]?.uid)} />
            </div>
          </div>

          <div ref={gridRef} className="grid items-start gap-5 lg:grid-cols-12">
            {/* Emails */}
            <div className="lg:col-span-7">
              <div className="relative">
                <div aria-hidden className="absolute bottom-10 left-[17px] top-5 w-px bg-border" />
                {steps.map((s, i) => (
                  <Fragment key={s.uid}>
                    {i > 0 && (
                      <WaitConnector value={s.waitDays} day={days[i]} thread={s.thread}
                        onChange={(v) => patchStep(i, { waitDays: v })} />
                    )}
                    <StepCard
                      index={i} step={s} total={steps.length} day={days[i]} firstSubject={plain[0]?.subject ?? ""}
                      threadSubject={subjectOf({ steps: plain }, i)}
                      selected={i === sel} collapsed={!!collapsed[s.uid]}
                      issues={{ errors: check.errors.filter((x) => x.step === i + 1), warnings: check.warnings.filter((x) => x.step === i + 1) }}
                      onSelect={() => setSelected(i)}
                      onToggleCollapse={() => setCollapsed((c) => ({ ...c, [s.uid]: !c[s.uid] }))}
                      onChange={(patch) => patchStep(i, patch)}
                      flash={flashUid === s.uid}
                      onMove={(dir) => moveEmail(i, dir)}
                      onDelete={() => removeEmail(i)}
                    />
                  </Fragment>
                ))}
                <div className="relative mt-3 grid grid-cols-[36px_1fr] gap-3">
                  <div className="flex justify-center pt-2"><span className="size-2 rounded-full bg-border" /></div>
                  <button type="button" onClick={addEmail} disabled={steps.length >= LIMITS.maxSteps}
                    className="flex h-12 items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-accent/30 hover:text-foreground disabled:pointer-events-none disabled:opacity-50">
                    <Plus className="size-4" />
                    {steps.length >= LIMITS.maxSteps ? `At most ${LIMITS.maxSteps} emails` : "Add an email"}
                  </button>
                </div>
              </div>
              {check.errors.some((e) => e.step === 0) && (
                <p className="mt-3 text-sm text-destructive">{check.errors.filter((e) => e.step === 0).map((e) => e.message).join(" ")}</p>
              )}
            </div>

            {/* Preview */}
            <div ref={previewRef} className="will-change-transform lg:col-span-5">
              <PreviewPanel steps={plain} days={days} selected={sel} onPick={(i) => focusEmail(i, steps[i]?.uid)}
                companyName={clientTag ? nameByTag.get(clientTag) ?? null : null} />
            </div>
          </div>
        </>
      )}

      {draft && entry && (
        <SaveDialog key={`save-${targetKey}`} open={saveOpen} onOpenChange={setSaveOpen}
          title={`Save ${title}`}
          description={`Saved as version ${(entry.latest ?? 0) + 1}: ${plural(steps.length, "email")} over ${plural(totalDays, "day")}. ${isClient
            ? `${clientTag}'s campaigns made from now on use it instead of the shared ${typeShort(followType)} copy.`
            : "Campaigns made from now on use it."} Campaigns that already exist are not changed.`}
          nextVersion={(entry.latest ?? 0) + 1} warnings={check.warnings.length}
          body={(note) => (target.kind === "type"
            ? { action: "save", type: target.type, steps: plain, note, baseVersion: draft.base }
            : { action: "save", client: target.tag, type: draft.clientType, steps: plain, note, baseVersion: draft.base, basedOn: draft.basedOn })}
          onSaved={(raw) => { applyVersion(targetKey, target.kind === "type" ? asTypeVersion(raw) : asClientVersion(raw)); void load(); }}
          onReloadNewest={async () => { await load(targetKey); }}
          onKeepMine={async (latest) => {
            await load();
            touchedRef.current.add(targetKey);
            setDrafts((d) => (d[targetKey] ? { ...d, [targetKey]: { ...d[targetKey], base: latest } } : d));
          }} />
      )}
      {entry && (
        <HistoryDialog key={`history-${targetKey}`} open={historyOpen} onOpenChange={setHistoryOpen}
          title={target.kind === "type" ? `${typeLabel(target.type)} copy — history` : `${target.tag}'s copy — history`}
          versions={entry.versions} current={current} latest={entry.latest} dirty={dirty}
          sharedText={(v) => `From version ${v.version}, ${clientTag} used the shared ${typeShort(v.clientType)} copy again.`}
          versionBody={(v) => (target.kind === "type" ? { action: "version", type: target.type, version: v } : { action: "version", client: target.tag, version: v })}
          restoreBody={(v) => (target.kind === "type" ? { action: "restore", type: target.type, version: v, baseVersion: entry.latest } : { action: "restore", client: target.tag, version: v, baseVersion: entry.latest })}
          parse={target.kind === "type" ? asTypeVersion : asClientVersion}
          onRestored={(v) => { applyVersion(targetKey, v); setSelected(0); void load(); }}
          onConflict={() => { void load(); }} />
      )}
      {isClient && clientTag && (
        <CompareDialog open={compareOpen} onOpenChange={setCompareOpen} tag={clientTag} typeName={typeShort(followType)}
          shared={sharedNow} mine={draft ? plain : current?.sequence?.steps ?? []} unsaved={dirty} />
      )}
    </div>
  );
}

// ─────────────────────────── pieces ───────────────────────────

function EmptyCopy({ label, who, hasCleaning, onFromCleaning, onBlank }: {
  label: string; who: string; hasCleaning: boolean; onFromCleaning: () => void; onBlank: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed bg-card/50 px-6 py-14 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-background shadow-xs">
        <FileText className="size-5 text-muted-foreground" />
      </div>
      <h3 className="mt-4 text-base font-semibold tracking-tight">No {label} copy yet</h3>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
        Campaigns for {who} can&apos;t be built from the library until their emails are written here.
        Start from the Cleaning copy and change what&apos;s different, or start from the usual four emails.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {hasCleaning && <Button onClick={onFromCleaning}><FileText /> Start from the Cleaning copy</Button>}
        <Button variant={hasCleaning ? "outline" : "default"} onClick={onBlank}><Plus /> Start with 4 empty emails</Button>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">Nothing is used until you save it.</p>
    </div>
  );
}

function SequenceRibbon({ steps, days, selected, onPick }: { steps: EditStep[]; days: number[]; selected: number; onPick: (i: number) => void }) {
  return (
    <div className="flex min-w-0 max-w-full flex-1 items-start overflow-x-auto pb-1 sm:max-w-xl">
      {steps.map((s, i) => (
        <Fragment key={s.uid}>
          {i > 0 && (
            <div className="relative min-w-10 flex-1 px-1 pt-[13px]" title={s.thread === "reply" ? "Replies in the same thread" : "Starts a new thread"}>
              <div className={cn("h-0 border-t", s.thread === "reply" ? "border-foreground/30" : "border-dashed border-foreground/30")} />
              <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 rounded-full border bg-background px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">+{s.waitDays}d</span>
            </div>
          )}
          <button type="button" onClick={() => onPick(i)} className="group flex shrink-0 flex-col items-center gap-1 outline-none">
            <span className={cn(
              "grid size-7 place-items-center rounded-full border text-xs font-semibold tabular-nums transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring/50",
              i === selected ? "border-foreground bg-foreground text-background" : "bg-background group-hover:border-foreground/40",
            )}>{i + 1}</span>
            <span className="text-[10px] tabular-nums text-muted-foreground">Day {days[i]}</span>
          </button>
        </Fragment>
      ))}
    </div>
  );
}

function WaitConnector({ value, day, thread, onChange }: { value: number; day: number; thread: ThreadMode; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : String(value);
  const clamp = (n: number) => Math.min(LIMITS.maxWait, Math.max(LIMITS.minWait, Math.round(n)));
  const bad = !Number.isInteger(value) || value < LIMITS.minWait || value > LIMITS.maxWait;
  return (
    <div className="relative grid grid-cols-[36px_1fr] gap-3 py-2.5">
      <div className="flex justify-center"><span className="relative z-10 mt-2 size-1.5 rounded-full bg-muted-foreground/40" /></div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <span>Wait</span>
        <div className={cn("inline-flex h-7 items-center rounded-lg border bg-background shadow-xs", bad && "border-destructive/50")}>
          <button type="button" aria-label="One day less" onClick={() => onChange(clamp(value - 1))} disabled={value <= LIMITS.minWait}
            className="grid h-full w-6 place-items-center rounded-l-lg hover:bg-accent disabled:opacity-40">−</button>
          <input aria-label="Days to wait" inputMode="numeric" value={shown}
            onFocus={() => { setText(String(value)); setEditing(true); }}
            onChange={(e) => { const t = e.target.value.replace(/[^\d]/g, "").slice(0, 2); setText(t); if (t) onChange(Number(t)); }}
            onBlur={() => { setEditing(false); onChange(clamp(Number(text) || value)); }}
            onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); onChange(clamp(value + 1)); } if (e.key === "ArrowDown") { e.preventDefault(); onChange(clamp(value - 1)); } }}
            className="h-full w-8 border-x bg-transparent text-center text-xs font-semibold tabular-nums text-foreground outline-none" />
          <button type="button" aria-label="One day more" onClick={() => onChange(clamp(value + 1))} disabled={value >= LIMITS.maxWait}
            className="grid h-full w-6 place-items-center rounded-r-lg hover:bg-accent disabled:opacity-40">+</button>
        </div>
        <span>{value === 1 ? "day" : "days"}, then {thread === "reply" ? "reply in the same thread" : "start a new thread"}</span>
        <span className="text-muted-foreground/60">· day {day}</span>
      </div>
    </div>
  );
}

function StepCard({ index, step, total, day, firstSubject, threadSubject, selected, collapsed, flash, issues, onSelect, onToggleCollapse, onChange, onMove, onDelete }: {
  index: number; step: EditStep; total: number; day: number; firstSubject: string; threadSubject: string; selected: boolean; collapsed: boolean; flash?: boolean;
  issues: { errors: StepIssue[]; warnings: StepIssue[] };
  onSelect: () => void; onToggleCollapse: () => void; onChange: (p: Partial<CopyStep>) => void;
  onMove: (dir: -1 | 1) => void; onDelete: () => void;
}) {
  const subjectRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<"subject" | "body">("body");
  const n = index + 1;
  const ownSubject = index === 0 || (step.thread === "new" && step.subject !== null);
  const variants = useMemo(() => countVariants(step.body) * (ownSubject ? countVariants(step.subject ?? "") : 1), [step.body, step.subject, ownSubject]);
  const errs = issues.errors.length, warns = issues.warnings.length;
  const summary = useMemo(() => stripMarks(renderPreview(step.body, 7, DEFAULT_SAMPLE, true)).replace(/\s+/g, " ").trim(), [step.body]);

  const insert = (snippet: string, spin = false) => {
    const useSubject = lastField.current === "subject" && ownSubject;
    if (useSubject) insertInto(subjectRef.current, step.subject ?? "", (v) => onChange({ subject: v }), snippet, spin);
    else insertInto(bodyRef.current, step.body, (v) => onChange({ body: v }), snippet, spin);
  };
  const jump = (iss: StepIssue) => {
    const el = iss.part === "subject" ? subjectRef.current : iss.part === "body" ? bodyRef.current : null;
    if (!el) return;
    el.focus();
    if (iss.start != null) el.setSelectionRange(iss.start, iss.start + 1);
  };

  return (
    // Selecting a card shows its insert bar, which moves the cards below it. So a card is
    // selected on click (after a button in it has done its job) or when a text field in it
    // gets focus — never on mouse-down, which made the first click on a button miss.
    <div id={`copy-email-${step.uid}`} className="relative grid scroll-mt-4 grid-cols-[36px_1fr] gap-3"
      onFocusCapture={(e) => { if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) onSelect(); }}
      onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a, [role='button']")) onSelect(); }}>
      <div className="flex justify-center pt-3">
        <span className={cn(
          "relative z-10 grid size-9 place-items-center rounded-full border text-sm font-semibold tabular-nums transition-colors",
          selected ? "border-foreground bg-foreground text-background shadow-sm" : "bg-background",
          errs > 0 && !selected && "border-destructive/50 text-destructive",
        )}>{n}</span>
      </div>

      <div className={cn(
        "min-w-0 rounded-xl border bg-card transition-[box-shadow,border-color] duration-500",
        selected ? "border-foreground/20 shadow-md ring-1 ring-foreground/[0.04]" : "shadow-xs hover:border-foreground/15",
        flash && "border-sky-500/60 ring-4 ring-sky-500/20",
      )}>
        {/* header */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">Email {n}</span>
            <span className="text-xs tabular-nums text-muted-foreground">Day {day}</span>
          </div>
          {index === 0 ? (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs font-medium text-muted-foreground"><Mail className="size-3.5" /> Starts the thread</span>
          ) : (
            <Segmented<ThreadMode> value={step.thread}
              onChange={(v) => onChange({ thread: v })}
              options={[
                { value: "reply", label: "Reply in thread", icon: <CornerDownRight className="size-3.5" />, title: "Sent as a reply under the email before" },
                { value: "new", label: "New thread", icon: <Mail className="size-3.5" />, title: "Sent as a fresh email" },
              ]} />
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {errs > 0 && <span className="mr-1.5 inline-flex items-center gap-1 text-xs text-destructive"><AlertCircle className="size-3.5" />{errs}</span>}
            {!errs && warns > 0 && <span className="mr-1.5 inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"><AlertTriangle className="size-3.5" />{warns}</span>}
            <span className="mr-2 hidden text-xs tabular-nums text-muted-foreground sm:inline" title="Different ways this email can read">≈ {fmtVariants(variants)} {variants === 1 ? "version" : "versions"}</span>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Move up" title={index === 0 ? "Already the first email" : `Move up — it becomes email ${index}`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp /></Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Move down" title={index === total - 1 ? "Already the last email" : `Move down — it becomes email ${index + 2}`} disabled={index === total - 1} onClick={() => onMove(1)}><ArrowDown /></Button>
            {total > 1 && <ConfirmButton size="icon-sm" title="Remove this email" icon={<Trash2 />} confirmLabel="Remove?" onConfirm={onDelete} />}
            <Button type="button" size="icon-sm" variant="ghost" aria-label={collapsed ? "Expand" : "Collapse"} title={collapsed ? "Expand" : "Collapse"} onClick={onToggleCollapse}>
              <ChevronDown className={cn("transition-transform", collapsed && "-rotate-90")} />
            </Button>
          </div>
        </div>

        {collapsed ? (
          <button type="button" onClick={onToggleCollapse} className="block w-full truncate px-4 py-3 text-left text-sm text-muted-foreground hover:text-foreground">
            {summary || <span className="italic">Empty</span>}
          </button>
        ) : (
          <div className="space-y-3.5 px-4 py-4">
            {/* subject */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Subject</span>
                {index > 0 && step.thread === "new" && (
                  <Switch checked={step.subject === null} label="Same as email 1"
                    onChange={(same) => onChange({ subject: same ? null : firstSubject })} />
                )}
              </div>
              {ownSubject ? (
                <CodeField single label={`Email ${n} subject`} textareaRef={subjectRef} value={step.subject ?? ""}
                  onChange={(v) => onChange({ subject: v })} onFocus={() => { lastField.current = "subject"; }}
                  invalid={issues.errors.some((e) => e.part === "subject")}
                  placeholder={index === 0 ? "{Quick question|Cleaning for {COMPANY}}" : "This email's own subject"} />
              ) : (
                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed bg-muted/30 px-3.5 py-2 font-mono text-[12.5px] leading-[1.75] text-muted-foreground">
                  {step.thread === "reply" && <span className="shrink-0 text-foreground/70">Re:</span>}
                  <span className="min-w-0 truncate opacity-80"><Highlighted text={(step.thread === "reply" ? threadSubject : firstSubject) || "(email 1's subject)"} /></span>
                  <span className="ml-auto hidden shrink-0 font-sans text-[11px] sm:inline">{step.thread === "reply" ? "Same thread — Bison adds “Re:”" : "Email 1's subject"}</span>
                </div>
              )}
            </div>

            {/* body */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Email</span>
              <CodeField label={`Email ${n} text`} textareaRef={bodyRef} value={step.body} minRows={6}
                onChange={(v) => onChange({ body: v })} onFocus={() => { lastField.current = "body"; }}
                invalid={issues.errors.some((e) => e.part === "body")}
                placeholder={"{Hi|Hey} {FIRST_NAME},\n\n…"} />
            </div>

            {selected && <InsertBar onInsert={insert} />}

            {(errs > 0 || warns > 0) && (
              <ul className="space-y-1">
                {[...issues.errors.map((e) => ({ ...e, level: "error" as const })), ...issues.warnings.map((w) => ({ ...w, level: "warning" as const }))].map((iss, k) => (
                  <li key={k}>
                    <button type="button" onClick={() => jump(iss)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                        iss.level === "error" ? "bg-destructive/[0.06] text-destructive hover:bg-destructive/10" : "bg-amber-500/[0.07] text-amber-700 hover:bg-amber-500/10 dark:text-amber-400",
                      )}>
                      {iss.level === "error" ? <AlertCircle className="mt-px size-3.5 shrink-0" /> : <AlertTriangle className="mt-px size-3.5 shrink-0" />}
                      <span><span className="font-medium capitalize">{iss.part}</span> — {iss.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function InsertBar({ onInsert }: { onInsert: (snippet: string, spin?: boolean) => void }) {
  const chip = "inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 font-mono text-[11px] text-foreground/80 transition-colors hover:border-foreground/25 hover:bg-accent hover:text-foreground";
  const keep = (e: ReactMouseEvent) => e.preventDefault(); // keep the caret where it is
  const lead = ["FIRST_NAME", "LAST_NAME", "COMPANY", "TITLE", "CITY", "STATE", "EMAIL", "QUESTION"];
  const sender = ["SENDER_FIRST_NAME", "SENDER_LAST_NAME", "SENDER_FULL_NAME"];
  return (
    <div className="space-y-2 rounded-lg bg-muted/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 w-14 shrink-0 text-[11px] text-muted-foreground">Lead</span>
        {lead.map((v) => <button key={v} type="button" onMouseDown={keep} onClick={() => onInsert(`{${v}}`)} className={chip}><span className="size-1.5 rounded-full bg-sky-500" />{v}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 w-14 shrink-0 text-[11px] text-muted-foreground">Sender</span>
        {sender.map((v) => <button key={v} type="button" onMouseDown={keep} onClick={() => onInsert(`{${v}}`)} className={chip}><span className="size-1.5 rounded-full bg-sky-500" />{v}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 w-14 shrink-0 text-[11px] text-muted-foreground">Client</span>
        {CLIENT_FIELDS.map((f) => (
          <button key={f.key} type="button" title={f.hint} onMouseDown={keep} onClick={() => onInsert(`[[${f.key}]]`)} className={chip}>
            <span className="size-1.5 rounded-full bg-violet-500" />{f.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        <button type="button" title="Options — one is picked per email. Select text first to turn it into the first option." onMouseDown={keep} onClick={() => onInsert("", true)} className={chip}>
          <Braces className="size-3 text-amber-600 dark:text-amber-400" />{"{ a | b }"}
        </button>
      </div>
    </div>
  );
}

function PreviewPanel({ steps, days, selected, onPick, companyName }: {
  steps: CopyStep[]; days: number[]; selected: number; onPick: (i: number) => void; companyName?: string | null;
}) {
  const [seed, setSeed] = useState(1);
  const [filled, setFilled] = useState(true);
  const [edited, setSample] = useState<Sample>(DEFAULT_SAMPLE);
  // A client's own copy previews with its company name (unless it was typed over).
  const sample = useMemo(() => (companyName && edited.COMPANY_NAME === DEFAULT_SAMPLE.COMPANY_NAME ? { ...edited, COMPANY_NAME: companyName } : edited), [edited, companyName]);
  const [showSample, setShowSample] = useState(false);
  const step = steps[selected];
  const seq = useMemo(() => ({ steps }), [steps]);

  const view = useMemo(() => {
    if (!step) return null;
    // A reply shows its thread's subject, spun the same way as the email that started the thread.
    const start = threadStart(seq, selected);
    const usesFirst = start === 0 || seq.steps[start]?.subject === null;
    const subjectSeed = usesFirst ? seed * 1009 : seed * 1009 + start * 7;
    const subject = renderPreview(subjectOf(seq, selected), subjectSeed, sample, filled);
    const body = renderPreview(step.body, seed * 7919 + selected * 31, sample, filled);
    return { subject, body, reply: selected > 0 && step.thread === "reply" };
  }, [step, selected, seq, seed, sample, filled]);

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="text-sm font-semibold">Preview</div>
        <div className="flex items-center gap-1.5">
          <Segmented size="xs" value={filled ? "filled" : "tags"} onChange={(v) => setFilled(v === "filled")}
            options={[{ value: "filled", label: "Sample lead" }, { value: "tags", label: "Variables" }]} />
          <Button size="icon-sm" variant="ghost" aria-label="Show another version" title="Show another version" onClick={() => setSeed((s) => s + 1)}><Shuffle /></Button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b bg-muted/30 px-3 py-2">
        {steps.map((s, i) => (
          <button key={i} type="button" onClick={() => onPick(i)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              i === selected ? "bg-background font-medium text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
            )}>
            {i === 0 || s.thread === "new" ? <Mail className="size-3" /> : <CornerDownRight className="size-3" />}
            {i + 1}<span className="text-muted-foreground/70 tabular-nums">· d{days[i]}</span>
          </button>
        ))}
      </div>

      {view ? (
        <div className="p-4">
          <div className="overflow-hidden rounded-lg border bg-background">
            <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 border-b px-4 py-3 text-[13px]">
              <dt className="text-muted-foreground">From</dt>
              <dd className="min-w-0 truncate">{filled ? sample.SENDER_FULL_NAME || "Sender" : <Marked text={`${MK_OPEN}t{SENDER_FULL_NAME}${MK_SEP}{SENDER_FULL_NAME}${MK_CLOSE}`} />}</dd>
              <dt className="text-muted-foreground">To</dt>
              <dd className="min-w-0 truncate">{filled ? <>{sample.FIRST_NAME} {sample.LAST_NAME} <span className="text-muted-foreground">· {sample.COMPANY}</span></> : <span className="text-muted-foreground">the lead</span>}</dd>
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="min-w-0 font-medium">{view.reply && "Re: "}{stripMarks(view.subject).trim() ? <Marked text={view.subject} /> : <span className="font-normal italic text-muted-foreground">No subject yet</span>}</dd>
            </dl>
            <div className="max-h-[58vh] overflow-auto whitespace-pre-wrap break-words px-4 py-4 text-[14px] leading-relaxed">
              {stripMarks(view.body).trim() ? <Marked text={view.body} /> : <span className="italic text-muted-foreground">Nothing written yet.</span>}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Day {days[selected]} · {selected === 0 ? "starts the thread" : step.thread === "reply" ? `reply under email ${threadStart(seq, selected) + 1}` : step.subject === null ? "new thread, email 1's subject" : "new thread, its own subject"}
            </span>
            <button type="button" onClick={() => setShowSample((v) => !v)} className="inline-flex items-center gap-1 hover:text-foreground">
              <SlidersHorizontal className="size-3" /> Sample values
            </button>
          </div>
          {showSample && (
            <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3">
              {SAMPLE_FIELDS.map((f) => (
                <label key={f.key} className={cn("space-y-1", f.wide && "col-span-2")}>
                  <span className="text-[11px] text-muted-foreground">{f.label}</span>
                  <Input value={sample[f.key] ?? ""} onChange={(e) => setSample((s) => ({ ...s, [f.key]: e.target.value }))} className="h-8 bg-background text-xs" />
                </label>
              ))}
              <div className="col-span-2 flex justify-end">
                <Button size="xs" variant="ghost" onClick={() => setSample(DEFAULT_SAMPLE)}><RotateCcw /> Reset</Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="px-4 py-12 text-center text-sm text-muted-foreground">Add an email to see it here.</div>
      )}
    </div>
  );
}

// ─────────────────────────── a client's own copy ───────────────────────────

function TagPill({ tag, className }: { tag: string; className?: string }) {
  return <span className={cn("inline-flex h-5 items-center rounded-md border bg-background px-1.5 font-mono text-[11px] font-semibold tracking-tight", className)}>{tag}</span>;
}

/** Clients with their own copy, and the way to give one to another client. */
function ClientCopiesCard({ entries, selectedKey, dirtyKeys, names, sharedVersion, pickable, onOpen, onPick }: {
  entries: Entry[]; selectedKey: string; dirtyKeys: string[]; names: Map<string, string | null>;
  sharedVersion: (t: ClientTypeKey) => number | null; pickable: PickClient[];
  onOpen: (key: string) => void; onPick: (tag: string) => void;
}) {
  const taken = new Set(entries.map((e) => (e.target as { tag: string }).tag));
  return (
    <div className="rounded-xl border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-background"><Users className="size-4 text-muted-foreground" /></div>
          <div className="min-w-0">
            <div className="text-sm font-medium">Client copies</div>
            <div className="text-xs text-muted-foreground">A client that needs something different — like the extra lines a Canadian client needs — gets its own copy. Its campaigns use it instead of the shared one.</div>
          </div>
        </div>
        <ClientPicker pickable={pickable} taken={taken} onPick={onPick} />
      </div>
      {entries.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
          {entries.map((e) => {
            const tag = (e.target as { tag: string }).tag;
            const isOn = e.key === selectedKey, edited = dirtyKeys.includes(e.key);
            const sv = sharedVersion(e.clientType);
            const moved = !!e.current && e.basedOn != null && sv != null && sv > e.basedOn;
            const state = edited ? "Unsaved changes" : e.current ? `Own copy · ${typeShort(e.clientType)}` : e.versions.length ? "Back on the shared copy" : "Not customized yet";
            return (
              <button key={e.key} type="button" onClick={() => onOpen(e.key)} aria-pressed={isOn} title={names.get(tag) ?? undefined}
                className={cn(
                  "group inline-flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                  isOn ? "border-foreground/25 bg-accent/40 shadow-sm ring-1 ring-foreground/10" : "bg-background hover:border-foreground/15 hover:bg-accent/30",
                )}>
                <span className={cn("size-2 shrink-0 rounded-full", edited ? "bg-amber-500" : e.current ? "bg-violet-500" : "bg-muted-foreground/30")} />
                <span className="font-mono text-xs font-semibold">{tag}</span>
                <span className={cn("text-xs", edited ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{state}</span>
                {moved && !edited && <span title="The shared copy changed since this was made"><AlertTriangle className="size-3.5 text-amber-500" /></span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClientPicker({ pickable, taken, onPick }: { pickable: PickClient[]; taken: Set<string>; onPick: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...pickable]
      .sort((a, b) => a.tag.localeCompare(b.tag))
      .filter((c) => !s || c.tag.toLowerCase().includes(s) || (c.name ?? "").toLowerCase().includes(s))
      .slice(0, 60);
  }, [pickable, q]);
  const pick = (tag: string) => { setOpen(false); onPick(tag); };
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(v) => { setOpen(v); if (v) setQ(""); }}>
      <PopoverPrimitive.Trigger asChild>
        <Button size="sm" variant="outline"><Plus /> Customize a client</Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content align="end" sideOffset={6}
          className="z-50 w-80 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="border-b p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an onboarding client…" className="h-8 pl-8 text-sm"
                onKeyDown={(e) => { if (e.key === "Enter" && list[0]) { e.preventDefault(); pick(list[0].tag); } }} />
            </div>
          </div>
          <div className="max-h-72 overflow-auto p-1">
            {list.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">No onboarding client matches.</div>
            ) : list.map((c) => (
              <button key={c.tag} type="button" onClick={() => pick(c.tag)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
                <TagPill tag={c.tag} />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.name || "—"}</span>
                {taken.has(c.tag.toUpperCase()) && <span className="shrink-0 text-[11px] text-violet-600 dark:text-violet-400">has a copy</span>}
              </button>
            ))}
          </div>
          <div className="border-t bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">Clients on the onboarding checklist — their campaigns are the ones built from this copy.</div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function ClientHeader({ tag, name, followType, own, dirty, basedOn, sharedNow, sharedMoved, busy, onCompare, onChecked, onUseShared }: {
  tag: string; name: string | null; followType: ClientTypeKey; own: boolean; dirty: boolean;
  basedOn: number | null; sharedNow: number | null; sharedMoved: boolean; busy: "use-shared" | "checked" | null;
  onCompare: () => void; onChecked: () => void; onUseShared: () => void;
}) {
  const t = typeShort(followType);
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300"><UserRound className="size-4" /></div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <TagPill tag={tag} />
              {name && <span className="truncate text-sm font-medium">{name}</span>}
              <span className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                own ? "bg-violet-500/10 text-violet-700 dark:text-violet-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
              )}>{own ? "Own copy" : "New — not saved"}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {own ? <>Its campaigns use this copy instead of the shared {t} copy</> : <>Until it&apos;s saved, its campaigns use the shared {t} copy</>}
              {basedOn != null && <> · made from the shared copy&apos;s version {basedOn}</>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={onCompare} disabled={!sharedNow}><GitCompareArrows /> Compare with shared</Button>
          {own && (
            <ConfirmButton onConfirm={onUseShared} confirmLabel="Use the shared copy?" icon={busy === "use-shared" ? <Loader2 className="animate-spin" /> : <Undo2 />}
              disabled={dirty || busy !== null} title={dirty ? "Save or discard your changes first" : `Go back to the shared ${t} copy (this copy stays in the history)`}>
              Use shared copy
            </ConfirmButton>
          )}
        </div>
      </div>
      {sharedMoved && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-amber-500/20 bg-amber-500/[0.06] px-4 py-2.5">
          <div className="flex min-w-0 items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>
              The shared {t} copy has changed since this copy was made <span className="text-muted-foreground">(version {basedOn} → {sharedNow})</span>.
              {" "}{tag} keeps its own emails — compare them and bring over anything it should have too.
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={onCompare}><GitCompareArrows /> Compare</Button>
            {own && (
              <Button size="sm" variant="outline" onClick={onChecked} disabled={dirty || busy !== null} title={dirty ? "Save or discard your changes first" : undefined}>
                {busy === "checked" ? <Loader2 className="animate-spin" /> : <CircleCheck />} Mark as checked
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ClientEmpty({ tag, name, typeEntries, defaultType, hadOwn, onStart, onHistory }: {
  tag: string; name: string | null; typeEntries: Entry[]; defaultType: ClientTypeKey; hadOwn: boolean;
  onStart: (t: ClientTypeKey) => void; onHistory: () => void;
}) {
  const withCopy = typeEntries.filter((e) => e.current).map((e) => (e.target as { type: ClientTypeKey }).type);
  const [from, setFrom] = useState<ClientTypeKey>(withCopy.includes(defaultType) ? defaultType : withCopy[0] ?? defaultType);
  const fromEntry = typeEntries.find((e) => e.key === `type:${from}`);
  return (
    <div className="rounded-2xl border border-dashed bg-card/50 px-6 py-12 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-background shadow-xs">
        <UserRound className="size-5 text-muted-foreground" />
      </div>
      <h3 className="mt-4 flex items-center justify-center gap-2 text-base font-semibold tracking-tight">
        <TagPill tag={tag} /> uses the shared copy
      </h3>
      {name && <div className="mt-1 text-sm text-muted-foreground">{name}</div>}
      <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
        Its campaigns are built from the shared copy for its client type. Give it its own version when it needs something different —
        it starts as a copy of the shared emails, and later changes to the shared copy won&apos;t touch it.
      </p>
      {withCopy.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No client type has a shared copy yet — write one first.</p>
      ) : (
        <div className="mt-6 flex flex-col items-center gap-3">
          <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>Start from</span>
            <Segmented<ClientTypeKey> size="xs" value={from} onChange={setFrom}
              options={withCopy.map((t) => ({ value: t, label: typeShort(t) }))} />
            {fromEntry?.current && <span className="tabular-nums">version {fromEntry.current.version}</span>}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => onStart(from)}><Sparkles /> Customize for {tag}</Button>
            {hadOwn && <Button variant="outline" onClick={onHistory}><History /> Earlier versions</Button>}
          </div>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">Nothing changes until you save.</p>
    </div>
  );
}

/** One client's emails next to the shared copy, email by email, with the lines that differ marked. */
function CompareDialog({ open, onOpenChange, tag, typeName, shared, mine, unsaved }: {
  open: boolean; onOpenChange: (v: boolean) => void; tag: string; typeName: string;
  shared: Version | null; mine: CopyStep[]; unsaved: boolean;
}) {
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [full, setFull] = useState(false);
  const left = useMemo(() => shared?.sequence?.steps ?? [], [shared]);
  const rows = useMemo(() => {
    const n = Math.max(left.length, mine.length);
    const lDays = sendDays({ steps: left }), rDays = sendDays({ steps: mine });
    const body = (x: CopyStep) => x.body.replace(/\r\n|\r/g, "\n");
    return Array.from({ length: n }, (_, i) => {
      const a = left[i], b = mine[i];
      const aSubj = a ? subjectOf({ steps: left }, i) : "", bSubj = b ? subjectOf({ steps: mine }, i) : "";
      // Same = same text, subject, wait and threading (email 1 always starts the thread).
      const same = !!a && !!b && body(a) === body(b) && aSubj === bSubj && (i === 0 || (a.waitDays === b.waitDays && a.thread === b.thread));
      const marks = a && b ? diffLines(body(a).split("\n"), body(b).split("\n")) : null;
      return { i, a, b, same, aDay: lDays[i], bDay: rDays[i], aSubj, bSubj, markA: marks?.a ?? null, markB: marks?.b ?? null };
    });
  }, [left, mine]);
  const diffCount = rows.filter((r) => !r.same).length;
  const shown = onlyDiff ? rows.filter((r) => !r.same) : rows;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-6xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2"><GitCompareArrows className="size-4" /> {tag} next to the shared {typeName} copy</DialogTitle>
          <DialogDescription>
            {diffCount === 0 ? "Every email is the same as the shared copy." : `${plural(diffCount, "email")} ${diffCount === 1 ? "differs" : "differ"} — changed lines are marked${full ? "" : ", the rest is folded away"}.`}
            {unsaved && " Showing your unsaved edits."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 border-b bg-muted/30 text-xs font-medium text-muted-foreground">
          <div className="px-6 py-2">Shared {typeName} copy{shared ? ` · version ${shared.version}` : ""}</div>
          <div className="border-l px-6 py-2">{tag}&apos;s copy</div>
        </div>
        <div className="max-h-[64vh] overflow-auto">
          {shown.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-muted-foreground">Nothing differs.</div>
          ) : shown.map((r) => (
            <div key={r.i} className="border-b last:border-b-0">
              <div className="flex items-center gap-2 px-6 pt-3 text-xs">
                <span className="font-semibold">Email {r.i + 1}</span>
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  r.same ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : !r.a ? "bg-violet-500/10 text-violet-700 dark:text-violet-300"
                    : !r.b ? "bg-muted text-muted-foreground"
                    : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
                )}>{r.same ? "Same" : !r.a ? `Only in ${tag}'s` : !r.b ? `Not in ${tag}'s` : "Different"}</span>
              </div>
              <div className="grid grid-cols-2">
                <CompareSide step={r.a} index={r.i} day={r.aDay} subject={r.aSubj} other={r.b} otherSubject={r.bSubj} marked={r.markA} fold={!full} sameAs="the shared copy" />
                <div className="border-l"><CompareSide step={r.b} index={r.i} day={r.bDay} subject={r.bSubj} other={r.a} otherSubject={r.aSubj} marked={r.markB} fold={!full} sameAs={`${tag}'s`} /></div>
              </div>
            </div>
          ))}
        </div>
        <DialogFooter className="flex-row items-center justify-between border-t px-6 py-3 sm:justify-between">
          <div className="flex flex-wrap items-center gap-5">
            <Switch checked={onlyDiff} onChange={setOnlyDiff} label="Only the emails that differ" />
            <Switch checked={full} onChange={setFull} label="Full emails" />
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which lines differ between two texts, by position (a longest-common-subsequence
 * diff): moved, repeated and blank lines count too, not just lines missing from the other side.
 */
function diffLines(a: string[], b: string[]): { a: boolean[]; b: boolean[] } {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ma = new Array<boolean>(n).fill(true), mb = new Array<boolean>(m).fill(true);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { ma[i] = false; mb[j] = false; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { a: ma, b: mb };
}

/** Which lines to show when folding: the marked ones with `context` lines around them; the rest become gaps. */
function foldLines(marked: boolean[], context = 2): ({ kind: "line"; i: number } | { kind: "gap"; count: number })[] {
  const keep = marked.map(() => false);
  marked.forEach((m, i) => { if (m) for (let k = Math.max(0, i - context); k <= Math.min(marked.length - 1, i + context); k++) keep[k] = true; });
  const out: ({ kind: "line"; i: number } | { kind: "gap"; count: number })[] = [];
  let gap = 0;
  keep.forEach((k, i) => {
    if (!k) { gap++; return; }
    if (gap) { out.push({ kind: "gap", count: gap }); gap = 0; }
    out.push({ kind: "line", i });
  });
  if (gap) out.push({ kind: "gap", count: gap });
  return out;
}

function CompareSide({ step, index, day, subject, other, otherSubject, marked: given, fold, sameAs }: {
  step: CopyStep | undefined; index: number; day: number | undefined; subject: string; other: CopyStep | undefined; otherSubject: string;
  marked: boolean[] | null; fold: boolean; sameAs: string;
}) {
  if (!step) return <div className="px-6 py-4 text-sm italic text-muted-foreground">No email {index + 1}.</div>;
  const lines = step.body.replace(/\r\n|\r/g, "\n").split("\n");
  const marked = given ?? lines.map(() => false);
  // Fold only when there's something to compare against; an email the other side doesn't have is shown whole.
  const parts = fold && other ? foldLines(marked) : lines.map((_, i) => ({ kind: "line" as const, i }));
  const how = index === 0 ? "starts the thread" : step.thread === "reply" ? `reply, +${step.waitDays}d` : `new thread, +${step.waitDays}d`;
  const howOther = !other ? null : index === 0 ? "starts the thread" : other.thread === "reply" ? `reply, +${other.waitDays}d` : `new thread, +${other.waitDays}d`;
  const subjectDiffers = !!other && otherSubject !== subject;
  const mark = "rounded-[4px] bg-amber-400/15 ring-1 ring-inset ring-amber-500/20";
  return (
    <div className="space-y-2 px-6 py-3">
      <div className={cn("inline-block px-1 text-[11px] text-muted-foreground", howOther !== null && howOther !== how && mark)}>Day {day} · {how}</div>
      {fold && other && !subjectDiffers ? (
        <div className="text-[11px] text-muted-foreground">{step.thread === "reply" && index > 0 ? "Re: subject" : "Subject"} — same as {sameAs}</div>
      ) : (
        <div className={cn("font-mono text-[12px] leading-[1.7]", subjectDiffers && mark)}>
          <span className="mr-2 font-sans text-[11px] text-muted-foreground">{step.thread === "reply" && index > 0 ? "Re:" : "Subject"}</span>
          <Highlighted text={subject} />
        </div>
      )}
      <div className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[12px] leading-[1.7]">
        {parts.map((p, k) => p.kind === "gap" ? (
          <div key={`g${k}`} className="my-1.5 flex items-center gap-2 font-sans text-[11px] text-muted-foreground">
            <span className="h-px flex-1 bg-border" />{plural(p.count, "line")} unchanged<span className="h-px flex-1 bg-border" />
          </div>
        ) : (
          <div key={p.i} className={cn("-mx-1 px-1", marked[p.i] && mark)}>
            {lines[p.i] ? <Highlighted text={lines[p.i]} /> : "\u200b"}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── save & history ───────────────────────────

function SaveDialog({ open, onOpenChange, title, description, nextVersion, warnings, body, onSaved, onReloadNewest, onKeepMine }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; description: string; nextVersion: number; warnings: number;
  body: (note: string) => Record<string, unknown>;
  onSaved: (raw: unknown) => void; onReloadNewest: () => Promise<void>; onKeepMine: (latest: number | null) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ message: string; latest: number | null } | null>(null);

  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body(note)) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) { setConflict({ message: j.error ?? "Someone else saved this copy meanwhile.", latest: typeof j.current === "number" ? j.current : null }); return; }
      if (!r.ok || !j.ok || !j.version) { toast.error(j.error ?? `Couldn't save (${r.status}).`); return; }
      onSaved(j.version);
      toast.success(`Saved — version ${j.version.version} is now in use.`);
      setNote("");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message || "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) { onOpenChange(v); if (!v) setConflict(null); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {conflict ? (
          <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p className="text-destructive">{conflict.message.replace(/ Reload it, then make your changes again\.$/, "")}</p>
            <p className="text-muted-foreground">
              Look at the newest version first (History) if you&apos;re not sure. Then either keep your edits — saving them replaces
              version {conflict.latest ?? "?"} — or load version {conflict.latest ?? "?"} and drop your edits.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy}
                onClick={async () => { setBusy(true); try { await onKeepMine(conflict.latest); setConflict(null); } finally { setBusy(false); } }}>
                <Check /> Keep my edits
              </Button>
              <Button size="sm" variant="outline" disabled={busy}
                onClick={async () => { setBusy(true); try { await onReloadNewest(); setConflict(null); onOpenChange(false); } finally { setBusy(false); } }}>
                <RotateCcw /> Load the newest version
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <label htmlFor="copy-save-note" className="text-sm font-medium">What changed? <span className="font-normal text-muted-foreground">(optional)</span></label>
            <Input id="copy-save-note" autoFocus value={note} maxLength={500} placeholder="e.g. Shorter email 3, new P.S. line"
              onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) save(); }} />
            {warnings > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-3.5" /> {plural(warnings, "thing")} worth a second look — saving is still fine.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          {!conflict && <Button disabled={busy} onClick={save}>{busy ? <Loader2 className="animate-spin" /> : <Check />} Save version {nextVersion}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ open, onOpenChange, title, versions, current, latest, dirty, sharedText, versionBody, restoreBody, parse, onRestored, onConflict }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string;
  versions: VersionMeta[]; current: Version | null; latest: number | null; dirty: boolean;
  sharedText: (v: VersionMeta) => string;
  versionBody: (v: number) => Record<string, unknown>; restoreBody: (v: number) => Record<string, unknown>;
  parse: (raw: unknown) => Version; onRestored: (v: Version) => void; onConflict: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<Record<number, Version>>({});
  const [busy, setBusy] = useState(false);
  const shown = picked ?? latest;
  const meta = versions.find((v) => v.version === shown) ?? null;
  // An older "use the shared copy" version means nothing while the client already uses the shared copy.
  const alreadyShared = meta?.mode === "shared" && !current;
  const version = shown == null ? null : current && current.version === shown ? current : loaded[shown] ?? null;

  const pick = async (v: number) => {
    setPicked(v);
    const m = versions.find((x) => x.version === v);
    if (m?.mode === "shared" || (current && current.version === v) || loaded[v]) return;
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(versionBody(v)) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { toast.error(j.error ?? "Couldn't load that version."); return; }
      setLoaded((all) => ({ ...all, [v]: parse(j.version) }));
    } catch (e) { toast.error((e as Error).message); }
  };

  const restore = async () => {
    if (shown == null) return;
    setBusy(true);
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(restoreBody(shown)) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) { toast.error(`${j.error ?? "Someone saved meanwhile."} The list is up to date now — pick the version again.`); onConflict(); setPicked(null); onOpenChange(false); return; }
      if (!r.ok || !j.ok || !j.version) { toast.error(j.error ?? `Couldn't restore (${r.status}).`); return; }
      onRestored(parse(j.version));
      toast.success(meta?.mode === "shared" ? "Back on the shared copy." : `Version ${shown} is back in use (saved as version ${j.version.version}).`);
      setPicked(null);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const vSteps = version?.sequence?.steps ?? [];
  const vDays = sendDays({ steps: vSteps });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) { onOpenChange(v); if (!v) setPicked(null); } }}>
      <DialogContent className="gap-0 p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Every save is kept. Restoring an old version saves it again as the newest.</DialogDescription>
        </DialogHeader>
        <div className="grid md:grid-cols-[17rem_1fr]">
          <ol className="max-h-[62vh] space-y-1 overflow-auto border-b p-3 md:border-r md:border-b-0">
            {versions.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => pick(v.version)}
                  className={cn("w-full rounded-lg px-3 py-2.5 text-left transition-colors", v.version === shown ? "bg-accent ring-1 ring-border" : "hover:bg-accent/50")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Version {v.version}</span>
                    <span className="flex items-center gap-1">
                      {v.mode === "shared" && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Shared copy</span>}
                      {v.version === latest && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">In use</span>}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{v.savedBy ? whoSaved(v.savedBy) : "Imported from Clay"} · {fmtWhen(v.savedAt)}</div>
                  {v.note && <div className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">“{v.note}”</div>}
                </button>
              </li>
            ))}
          </ol>
          <div className="flex min-h-[20rem] min-w-0 flex-col">
            <div className="max-h-[52vh] flex-1 space-y-3 overflow-auto p-5">
              {meta?.mode === "shared" ? (
                <div className="grid h-full place-items-center py-16 text-center text-sm text-muted-foreground">
                  <div className="max-w-sm space-y-2">
                    <Undo2 className="mx-auto size-5" />
                    <p>{sharedText(meta)}</p>
                  </div>
                </div>
              ) : !version ? (
                <div className="grid h-full place-items-center py-16 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
              ) : vSteps.map((s, i) => (
                <div key={i} className="rounded-lg border bg-background">
                  <div className="flex flex-wrap items-center gap-2 border-b px-3.5 py-2 text-xs">
                    <span className="font-semibold">Email {i + 1}</span>
                    <span className="text-muted-foreground">Day {vDays[i]}</span>
                    <span className="text-muted-foreground">· {i === 0 ? "starts the thread" : s.thread === "reply" ? `reply, +${s.waitDays}d` : `new thread, +${s.waitDays}d`}</span>
                  </div>
                  {(i === 0 || (s.thread === "new" && s.subject !== null)) && (
                    <div className="border-b px-3.5 py-2 font-mono text-[12px] leading-[1.7]"><span className="mr-2 font-sans text-[11px] text-muted-foreground">Subject</span><Highlighted text={s.subject ?? ""} /></div>
                  )}
                  <div className="whitespace-pre-wrap [overflow-wrap:anywhere] px-3.5 py-2.5 font-mono text-[12px] leading-[1.7]"><Highlighted text={s.body} /></div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3">
              {shown !== latest && dirty && <span className="mr-auto text-xs text-amber-700 dark:text-amber-400">Restoring replaces your unsaved edits.</span>}
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Close</Button>
              <Button disabled={busy || shown == null || shown === latest || alreadyShared || (meta?.mode !== "shared" && !version)} onClick={restore}>
                {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                {shown === latest ? "This version is in use" : alreadyShared ? "Already on the shared copy" : meta?.mode === "shared" ? "Use the shared copy again" : `Restore version ${shown}`}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
