"use client";

/**
 * Onboarding › Email copy — the master copy each client type's campaigns are
 * built from. Edit the emails, the days between them and how each one goes
 * out (a new thread, or a reply in the same thread); add, remove and reorder
 * emails; see a live preview; save as a new version with a note; look at or
 * restore any earlier version.
 *
 * Text is Email Bison's own syntax (lib/onboarding/copy-model.ts), shown with
 * highlighting: {VARIABLES} blue, [[client fields]] violet, {spin|options}
 * amber. Unsaved edits survive switching tabs and are kept in this browser
 * until they are saved or discarded.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";
import {
  AlertCircle, AlertTriangle, ArrowDown, ArrowUp, Braces, Check, ChevronDown, CornerDownRight, FileText,
  History, Loader2, Mail, Plus, RotateCcw, Save, Shuffle, SlidersHorizontal, Trash2, Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  CLIENT_FIELDS, CLIENT_TYPES, KNOWN_VARIABLES, LIMITS, checkSequence, cleanSequence, countVariants, defaultStructure,
  renderSpin, seeded, sendDays, subjectOf, threadStart, tokenize,
  type ClientTypeKey, type CopyStep, type StepIssue, type ThreadMode,
} from "@/lib/onboarding/copy-model";

// ─────────────────────────── types & helpers ───────────────────────────

type VersionMeta = { id: string; clientType: ClientTypeKey; version: number; savedBy: string | null; savedAt: string; note: string | null };
type Version = VersionMeta & { sequence: { steps: CopyStep[] } };
type LibraryEntry = { type: ClientTypeKey; current: Version | null; versions: VersionMeta[] };
type EditStep = CopyStep & { uid: string };
type Draft = { steps: EditStep[]; base: number | null };
type Drafts = Partial<Record<ClientTypeKey, Draft>>;

const API = "/api/onboarding/email-copy";
const STORAGE_KEY = "onboarding-email-copy-drafts-v1";

let uidCounter = 0;
const newUid = () => `e${++uidCounter}`;
const toEdit = (steps: CopyStep[]): EditStep[] => steps.map((s) => ({ ...s, uid: newUid() }));
const toPlain = (steps: EditStep[]): CopyStep[] => steps.map((s) => ({ waitDays: s.waitDays, thread: s.thread, subject: s.subject, body: s.body }));
const fromVersion = (v: Version): Draft => ({ steps: toEdit(v.sequence.steps), base: v.version });

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
  if (!current) return true;
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
function ConfirmButton({ onConfirm, children, confirmLabel, className, icon, size = "sm", title }: {
  onConfirm: () => void; children?: ReactNode; confirmLabel: string; className?: string; icon?: ReactNode;
  size?: "sm" | "icon-sm"; title?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return armed ? (
    <Button type="button" size="sm" variant="destructive" className={cn("h-8", className)}
      onClick={() => { if (timer.current) clearTimeout(timer.current); setArmed(false); onConfirm(); }}>
      {confirmLabel}
    </Button>
  ) : (
    <Button type="button" size={size} variant="ghost" title={title} aria-label={title} className={className}
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

export function EmailCopyEditor({ active }: { active: boolean }) {
  const session = useSession();
  // Unsaved edits are kept per person in this browser.
  const storageKey = `${STORAGE_KEY}:${session?.email ?? "anon"}`;
  const [library, setLibrary] = useState<LibraryEntry[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [type, setType] = useState<ClientTypeKey>("cleaning");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [saveOpen, setSaveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const libraryRef = useRef<LibraryEntry[] | null>(null);
  const restoredRef = useRef(false);
  const loadingRef = useRef(false);
  // Types this tab has changed — only these are written to (or cleared from) storage,
  // so another tab's kept edits for other types are left alone.
  const touchedRef = useRef(new Set<ClientTypeKey>());
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (reset?: ClientTypeKey) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const r = await fetch(API, { cache: "no-store" });
      if (r.status === 401) { window.location.href = "/login"; return; }
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) { setLoadErr(j?.error ?? `Couldn't load the email copy (${r.status}).`); return; }
      const lib = j.library as LibraryEntry[];
      const prev = libraryRef.current;
      libraryRef.current = lib;
      setLoadErr(null);
      setLibrary(lib);

      if (!restoredRef.current) {
        // First load: start from the saved copy, then put back any edits this
        // browser kept. Edits made on an older version come back too, still
        // based on it — saving them then asks whether to replace the newer one.
        restoredRef.current = true;
        let stored: Record<string, { base?: unknown; steps?: unknown }> = {};
        try { const raw = JSON.parse(localStorage.getItem(storageKey) || "{}"); if (raw && typeof raw === "object") stored = raw; } catch { /* no storage */ }
        const next: Drafts = {};
        const restored: string[] = [], stale: string[] = [];
        for (const e of lib) {
          if (e.current) next[e.type] = fromVersion(e.current);
          const s = stored[e.type];
          const seq = s ? cleanSequence({ steps: s.steps }) : null;
          if (!s || !seq?.steps.length || seq.steps.length > LIMITS.maxSteps) continue;
          if (e.current && canon(seq.steps) === canon(e.current.sequence.steps)) continue; // nothing left to save
          const base = Number.isInteger(s.base) ? Number(s.base) : null;
          next[e.type] = { steps: toEdit(seq.steps), base };
          (base === (e.current?.version ?? null) ? restored : stale).push(typeShort(e.type));
        }
        setDrafts(next);
        if (restored.length) toast.info(`Your unsaved edits to the ${restored.join(" and ")} copy are back.`);
        if (stale.length) toast.warning(`Your unsaved edits to the ${stale.join(" and ")} copy are back, but someone saved a newer version since. Saving will ask whether to replace it.`, { duration: 10000 });
        return;
      }

      setDrafts((d) => {
        const next = { ...d };
        for (const e of lib) {
          const mine = next[e.type];
          const before = prev?.find((p) => p.type === e.type)?.current ?? null;
          if (mine && e.type !== reset && isDirty(mine, before)) continue; // keep unsaved edits
          if (e.current) next[e.type] = fromVersion(e.current); else delete next[e.type];
        }
        return next;
      });
    } catch (e) {
      setLoadErr((e as Error).message || "Couldn't load the email copy.");
    } finally {
      loadingRef.current = false;
    }
  }, [storageKey]);

  useEffect(() => { if (active && !libraryRef.current) load(); }, [active, load]);

  /** Put a version the server just saved straight into the page (no second request needed). */
  const applyVersion = useCallback((t: ClientTypeKey, v: Version) => {
    const meta: VersionMeta = { id: v.id, clientType: v.clientType, version: v.version, savedBy: v.savedBy, savedAt: v.savedAt, note: v.note };
    const lib = (libraryRef.current ?? []).map((e) => (e.type === t ? { ...e, current: v, versions: [meta, ...e.versions.filter((x) => x.version !== v.version)] } : e));
    libraryRef.current = lib;
    setLibrary(lib);
    touchedRef.current.add(t);
    setDrafts((d) => ({ ...d, [t]: fromVersion(v) }));
  }, []);

  const entry = library?.find((e) => e.type === type) ?? null;
  const current = entry?.current ?? null;
  const draft = drafts[type] ?? null;
  const steps = useMemo(() => draft?.steps ?? [], [draft]);
  const plain = useMemo(() => toPlain(steps), [steps]);
  const check = useMemo(() => checkSequence({ steps: plain }), [plain]);
  const days = useMemo(() => sendDays({ steps: plain }), [plain]);
  const dirty = isDirty(draft, current);
  const dirtyTypes = useMemo(
    () => (library ?? []).filter((e) => isDirty(drafts[e.type], e.current)).map((e) => e.type),
    [library, drafts],
  );
  const anyDirty = dirtyTypes.length > 0;
  const sel = Math.min(selected, Math.max(0, steps.length - 1));
  useFollowScroll(previewRef, gridRef, `${library ? 1 : 0}-${draft ? type : "none"}`);

  // Keep unsaved edits in this browser (and warn before leaving the page).
  useEffect(() => {
    if (!library || !touchedRef.current.size) return;
    try {
      let kept: Record<string, unknown> = {};
      try { const raw = JSON.parse(localStorage.getItem(storageKey) || "{}"); if (raw && typeof raw === "object") kept = raw; } catch { /* unreadable → start over */ }
      for (const t of touchedRef.current) {
        const d = drafts[t], cur = library.find((e) => e.type === t)?.current ?? null;
        if (d && isDirty(d, cur)) kept[t] = { base: d.base, steps: toPlain(d.steps) };
        else delete kept[t];
      }
      if (Object.keys(kept).length) localStorage.setItem(storageKey, JSON.stringify(kept));
      else localStorage.removeItem(storageKey);
    } catch { /* storage unavailable — edits still live in the page */ }
  }, [library, drafts, storageKey]);
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const setSteps = useCallback((fn: (s: EditStep[]) => EditStep[]) => {
    touchedRef.current.add(type);
    setDrafts((d) => {
      const cur = d[type];
      return cur ? { ...d, [type]: { ...cur, steps: fn(cur.steps) } } : d;
    });
  }, [type]);
  const patchStep = useCallback((i: number, patch: Partial<CopyStep>) => {
    setSteps((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  }, [setSteps]);

  const focusEmail = useCallback((i: number, uid?: string) => {
    setSelected(i);
    if (uid) {
      setCollapsed((c) => (c[uid] ? { ...c, [uid]: false } : c));
      requestAnimationFrame(() => document.getElementById(`copy-email-${uid}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }, []);

  const startDraft = (from: CopyStep[]) => {
    touchedRef.current.add(type);
    setDrafts((d) => ({ ...d, [type]: { steps: toEdit(from), base: current?.version ?? null } }));
    setSelected(0);
  };
  const discard = () => {
    touchedRef.current.add(type);
    setDrafts((d) => {
      const next = { ...d };
      if (current) next[type] = fromVersion(current); else delete next[type];
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

  const requestSave = useCallback(() => {
    if (!draft) return;
    if (!dirty) { toast("Nothing to save — no changes yet."); return; }
    if (check.errors.length) {
      const first = check.errors[0];
      toast.error(`Fix ${plural(check.errors.length, "problem")} before saving.`, { description: first.step ? `Email ${first.step}: ${first.message}` : first.message });
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

  const switchType = (k: ClientTypeKey) => { setType(k); setSelected(0); };

  if (!library) {
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
            <div className="grid gap-5 lg:grid-cols-12">
              <div className="space-y-3 lg:col-span-7">{[0, 1, 2].map((i) => <div key={i} className="h-48 animate-pulse rounded-xl border bg-muted/30" />)}</div>
              <div className="h-96 animate-pulse rounded-xl border bg-muted/30 lg:col-span-5" />
            </div>
          </>
        )}
      </div>
    );
  }

  const cleaningCurrent = library.find((e) => e.type === "cleaning")?.current ?? null;
  const totalDays = days[days.length - 1] ?? 0;
  const threads = plain.filter((s, i) => i === 0 || s.thread === "new").length;

  return (
    <div ref={rootRef} className="space-y-5">
      {loadErr && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          <span>{loadErr}</span>
          <Button size="sm" variant="outline" onClick={() => load()}><RotateCcw /> Try again</Button>
        </div>
      )}
      {/* Client types — what each has, at a glance */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {library.map((e) => {
          const isOn = e.type === type, isEdited = dirtyTypes.includes(e.type);
          const n = e.current?.sequence.steps.length ?? 0;
          return (
            <button key={e.type} type="button" onClick={() => switchType(e.type)} aria-pressed={isOn}
              className={cn(
                "group relative rounded-xl border bg-card px-4 py-3 text-left transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                isOn ? "border-foreground/25 shadow-sm ring-1 ring-foreground/10" : "hover:border-foreground/15 hover:bg-accent/30",
              )}>
              <div className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", isEdited ? "bg-amber-500" : e.current ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                <span className="text-sm font-medium">{typeLabel(e.type)}</span>
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

      {type === "os" && (
        <div className="flex items-start gap-2.5 rounded-xl border border-sky-500/20 bg-sky-500/[0.04] px-4 py-3 text-sm text-muted-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
          <span>OS clients&apos; campaigns are set up by hand. This copy is kept here so it can be edited in one place for every OS client.</span>
        </div>
      )}

      {!draft ? (
        <EmptyCopy label={typeLabel(type)} who={`${typeShort(type)} clients`} hasCleaning={!!cleaningCurrent && type !== "cleaning"}
          onFromCleaning={() => cleaningCurrent && startDraft(cleaningCurrent.sequence.steps)}
          onBlank={() => startDraft(defaultStructure())} />
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
                      onMove={(dir) => { setSteps((x) => moveStep(x, i, dir)); setSelected(i + dir); }}
                      onDelete={() => { setSteps((x) => removeStep(x, i)); setSelected(Math.max(0, i - 1)); }}
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
              <PreviewPanel steps={plain} days={days} selected={sel} onPick={(i) => focusEmail(i, steps[i]?.uid)} />
            </div>
          </div>
        </>
      )}

      {draft && (
        <SaveDialog open={saveOpen} onOpenChange={setSaveOpen} label={typeLabel(type)} type={type}
          steps={plain} base={draft.base} nextVersion={(current?.version ?? 0) + 1} days={totalDays}
          warnings={check.warnings.length}
          onSaved={(v) => { applyVersion(type, v); void load(); }}
          onReloadNewest={async () => { await load(type); }}
          onKeepMine={async (latest) => {
            await load();
            touchedRef.current.add(type);
            setDrafts((d) => (d[type] ? { ...d, [type]: { ...d[type]!, base: latest } } : d));
          }} />
      )}
      {entry && (
        <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} entry={entry} dirty={dirty}
          onRestored={(v) => { applyVersion(type, v); setSelected(0); void load(); }} />
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

function StepCard({ index, step, total, day, firstSubject, threadSubject, selected, collapsed, issues, onSelect, onToggleCollapse, onChange, onMove, onDelete }: {
  index: number; step: EditStep; total: number; day: number; firstSubject: string; threadSubject: string; selected: boolean; collapsed: boolean;
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
    <div id={`copy-email-${step.uid}`} className="relative grid scroll-mt-4 grid-cols-[36px_1fr] gap-3" onFocusCapture={onSelect} onMouseDown={onSelect}>
      <div className="flex justify-center pt-3">
        <span className={cn(
          "relative z-10 grid size-9 place-items-center rounded-full border text-sm font-semibold tabular-nums transition-colors",
          selected ? "border-foreground bg-foreground text-background shadow-sm" : "bg-background",
          errs > 0 && !selected && "border-destructive/50 text-destructive",
        )}>{n}</span>
      </div>

      <div className={cn(
        "min-w-0 rounded-xl border bg-card transition-[box-shadow,border-color]",
        selected ? "border-foreground/20 shadow-md ring-1 ring-foreground/[0.04]" : "shadow-xs hover:border-foreground/15",
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
            <span className="mr-2 hidden text-xs tabular-nums text-muted-foreground sm:inline" title="Different ways this email can read">≈ {fmtVariants(variants)} versions</span>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Move up" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp /></Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Move down" title="Move down" disabled={index === total - 1} onClick={() => onMove(1)}><ArrowDown /></Button>
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

function PreviewPanel({ steps, days, selected, onPick }: { steps: CopyStep[]; days: number[]; selected: number; onPick: (i: number) => void }) {
  const [seed, setSeed] = useState(1);
  const [filled, setFilled] = useState(true);
  const [sample, setSample] = useState<Sample>(DEFAULT_SAMPLE);
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

function SaveDialog({ open, onOpenChange, label, type, steps, base, nextVersion, days, warnings, onSaved, onReloadNewest, onKeepMine }: {
  open: boolean; onOpenChange: (v: boolean) => void; label: string; type: ClientTypeKey; steps: CopyStep[]; base: number | null;
  nextVersion: number; days: number; warnings: number; onSaved: (v: Version) => void;
  onReloadNewest: () => Promise<void>; onKeepMine: (latest: number | null) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ message: string; latest: number | null } | null>(null);

  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", type, steps, note, baseVersion: base }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) { setConflict({ message: j.error ?? "Someone else saved this copy meanwhile.", latest: typeof j.current === "number" ? j.current : null }); return; }
      if (!r.ok || !j.ok || !j.version) { toast.error(j.error ?? `Couldn't save (${r.status}).`); return; }
      onSaved(j.version as Version);
      toast.success(`Saved — version ${j.version?.version ?? nextVersion} of the ${label} copy is now in use.`);
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
          <DialogTitle>Save the {label} copy</DialogTitle>
          <DialogDescription>
            Saved as version {nextVersion}: {plural(steps.length, "email")} over {plural(days, "day")}. Campaigns made from now on use it; campaigns that already exist are not changed.
          </DialogDescription>
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

function HistoryDialog({ open, onOpenChange, entry, dirty, onRestored }: {
  open: boolean; onOpenChange: (v: boolean) => void; entry: LibraryEntry; dirty: boolean; onRestored: (v: Version) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<Record<number, Version>>({});
  const [busy, setBusy] = useState(false);
  const currentVersion = entry.current?.version ?? null;
  const shown = picked ?? currentVersion;
  const version = shown == null ? null : shown === currentVersion ? entry.current : loaded[shown] ?? null;

  const pick = async (v: number) => {
    setPicked(v);
    if (v === currentVersion || loaded[v]) return;
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "version", type: entry.type, version: v }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { toast.error(j.error ?? "Couldn't load that version."); return; }
      setLoaded((m) => ({ ...m, [v]: j.version as Version }));
    } catch (e) { toast.error((e as Error).message); }
  };

  const restore = async () => {
    if (shown == null) return;
    setBusy(true);
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", type: entry.type, version: shown, baseVersion: currentVersion }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok || !j.version) { toast.error(j.error ?? `Couldn't restore (${r.status}).`); return; }
      onRestored(j.version as Version);
      toast.success(`Version ${shown} is back in use (saved as version ${j.version?.version}).`);
      setPicked(null);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const vSteps = version?.sequence.steps ?? [];
  const vDays = sendDays({ steps: vSteps });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) { onOpenChange(v); if (!v) setPicked(null); } }}>
      <DialogContent className="gap-0 p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>{typeLabel(entry.type)} copy — history</DialogTitle>
          <DialogDescription>Every save is kept. Restoring an old version saves it again as the newest.</DialogDescription>
        </DialogHeader>
        <div className="grid md:grid-cols-[17rem_1fr]">
          <ol className="max-h-[62vh] space-y-1 overflow-auto border-b p-3 md:border-r md:border-b-0">
            {entry.versions.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => pick(v.version)}
                  className={cn(
                    "w-full rounded-lg px-3 py-2.5 text-left transition-colors",
                    v.version === shown ? "bg-accent ring-1 ring-border" : "hover:bg-accent/50",
                  )}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Version {v.version}</span>
                    {v.version === currentVersion && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">In use</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{v.savedBy ? whoSaved(v.savedBy) : "Imported from Clay"} · {fmtWhen(v.savedAt)}</div>
                  {v.note && <div className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">“{v.note}”</div>}
                </button>
              </li>
            ))}
          </ol>
          <div className="flex min-h-[20rem] min-w-0 flex-col">
            <div className="max-h-[52vh] flex-1 space-y-3 overflow-auto p-5">
              {!version ? (
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
              {shown !== currentVersion && dirty && <span className="mr-auto text-xs text-amber-700 dark:text-amber-400">Restoring replaces your unsaved edits.</span>}
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Close</Button>
              <Button disabled={busy || shown == null || shown === currentVersion || !version} onClick={restore}>
                {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                {shown === currentVersion ? "This version is in use" : `Restore version ${shown}`}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
