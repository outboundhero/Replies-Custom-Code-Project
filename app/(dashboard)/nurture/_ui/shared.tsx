"use client";

/**
 * Shared pieces of the Nurture System pages (overview + client), rendering the
 * approved mockup's markup/classes 1:1 (styles in ../nurture-system.css).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

// ── API shapes ───────────────────────────────────────────────────────────────
export type BatchState = "on" | "wait" | "off";
export type ClientType = "Cleaning" | "Non-Cleaning" | "OS";
export interface StatusBadge { k: "prelaunch" | "map" | "draft" | "archived" | "noleads"; lab: string; tip: string }
export interface TagStats {
  queue: number; ready: number;
  // client page only (the overview payload leaves these out)
  eligible?: number; cooldown?: number; esp_unresolved?: number; overlap?: number | null;
  sources: Record<string, number>; esps: Record<string, number>; tlds?: Record<string, number>;
  email_endings?: Record<string, number>; site_endings?: Record<string, number>; email_domains?: Record<string, number>;
  forecast?: number[]; last_new_at?: string | null; computed_at: string; overlap_at?: string | null;
}
export interface OverviewTag {
  tag: string; type: ClientType; prelaunch: boolean;
  mainActive: number; nurtureActive: number; sendingLeads: number;
  mapping: "ok" | "bad"; mapIssues: string[];
  batches: [BatchState, BatchState, BatchState]; extraLiveBatches: number;
  // client page only (the overview payload leaves these out)
  group?: number | null; autoOn?: boolean; readyToExpand?: boolean;
  lastContactDay: string | null; lastContactCheckedAt: string | null;
  stats: TagStats | null; added: number | null; stoppedRecovered: number;
  errors: StatusBadge[];
}

// ── formatting ───────────────────────────────────────────────────────────────
export const fmt = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

const AV = ["#5b5b64", "#2e6cd4", "#059061", "#b8720c", "#d13c37", "#6d3fd6", "#0e8f8f", "#a5468f"];
export function avatarColor(tag: string): string {
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV[h % AV.length];
}
export const initials = (tag: string) => tag.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "?";

// ── one clock for every relative time on the page ───────────────────────────
// During hydration the server's render time is used (so server and browser
// render identical text), then the browser's, refreshed every 30s.
let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
function subscribeClock(cb: () => void) {
  clockListeners.add(cb);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => { clockNow = Date.now(); clockListeners.forEach((l) => l()); }, 30_000);
  }
  return () => {
    clockListeners.delete(cb);
    if (!clockListeners.size && clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  };
}
export function useNow(serverNow: number): number {
  return useSyncExternalStore(subscribeClock, () => clockNow, () => serverNow);
}

const PT = "America/Los_Angeles";
const PT_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" });
/** A date in Pacific time, YYYY-MM-DD (the team's working day). */
function pacificDay(ms: number): string {
  return PT_DAY.format(new Date(ms));
}

/** "Today" / "Yesterday" / "N days ago" from the tag's newest nurture send day. */
export function lastContactText(t: Pick<OverviewTag, "lastContactDay" | "lastContactCheckedAt" | "nurtureActive">, now: number): string {
  if (t.lastContactDay) {
    const days = Math.round((Date.parse(pacificDay(now)) - Date.parse(t.lastContactDay)) / 86_400_000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    return `${days} days ago`;
  }
  if (t.nurtureActive > 0 && t.lastContactCheckedAt) return "Not in 14 days";
  return "—";
}

/** "8:02 AM" (Pacific) or "Oct 8, 8:02 AM" when not today. */
export function ptTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const sameDay = pacificDay(d.getTime()) === pacificDay(now);
  return d.toLocaleString("en-US", sameDay
    ? { timeZone: PT, hour: "numeric", minute: "2-digit" }
    : { timeZone: PT, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "Oct 8, 2026" in Pacific time. */
export function ptDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: PT, month: "short", day: "numeric", year: "numeric" });
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const m = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ── icons (same paths as the mockup) ─────────────────────────────────────────
export const Ico = {
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="9" /><path d="M12 8v5m0 3h.01" /></svg>,
  alertThin: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><circle cx="12" cy="12" r="9" /><path d="M12 8v5m0 3h.01" /></svg>,
  healthy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.2 2.2 4.8-4.8" /></svg>,
  chevron: <svg className="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>,
  back: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>,
  trash: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" /></svg>,
  arrow: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>,
  warnTri: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>,
  info: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8v5m0 3h.01" /></svg>,
  sync: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 12a9 9 0 1 0 9-9" /><path d="M3 4v5h5" /></svg>,
  refresh: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></svg>,
  tick: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 6 9 17l-5-5" /></svg>,
  grid: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  lines: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>,
  dots: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></svg>,
  spinner: <svg className="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>,
};

// ── small renderers ──────────────────────────────────────────────────────────
export function TypeBadge({ type, style }: { type: ClientType; style?: React.CSSProperties }) {
  const cls = type === "Cleaning" ? "t-clean" : type === "OS" ? "t-os" : "t-non";
  return <span className={`type ${cls}`} style={style}>{type}</span>;
}

export function Avatar({ tag }: { tag: string }) {
  return <div className="av" style={{ background: avatarColor(tag) }}>{initials(tag)}</div>;
}

export function MappingPill({ mapping, issues }: { mapping: "ok" | "bad"; issues?: string[] }) {
  if (mapping === "ok") return <span className="pill p-ok">{Ico.check}Mapped</span>;
  const content = <>{Ico.alert}Needs attention</>;
  return issues?.length
    ? <HoverTip className="pill p-bad" tip={<><b>Mapping.</b> {issues.join(" ")}</>}>{content}</HoverTip>
    : <span className="pill p-bad">{content}</span>;
}

const BATCH_TITLE: Record<BatchState, string> = { on: "live", wait: "waiting to activate", off: "not in use" };
export function Batches({ b, extra = 0 }: { b: BatchState[]; extra?: number }) {
  return (
    <span className="batches">
      {b.map((s, i) => (
        <span key={i} className={`batch ${s === "on" ? "b-on" : s === "wait" ? "b-wait" : "b-off"}`} title={`Nurture batch ${i + 1} — ${BATCH_TITLE[s]}`}>N{i + 1}</span>
      ))}
      {extra > 0 && <span className="batch b-on" title={`${extra} more live batch${extra > 1 ? "es" : ""} beyond N3`}>+{extra}</span>}
    </span>
  );
}

/**
 * The mockup's dark hover tip, rendered in a fixed-position portal so it is
 * never clipped by the scrolling table (flips below near the top of the
 * viewport and right-aligns near the right edge). Also shows on keyboard focus.
 */
export function HoverTip({ className, tip, children }: { className: string; tip: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean; right: boolean } | null>(null);
  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const below = r.top < 150, right = r.left + 260 > window.innerWidth;
    setPos({ x: right ? r.right : r.left, y: below ? r.bottom : r.top, below, right });
  };
  const close = () => setPos(null);
  return (
    <span ref={ref} className={className} tabIndex={0} onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}>
      {children}
      {pos && typeof document !== "undefined" && createPortal(
        <span
          role="tooltip"
          className={`nx-tipfloat${pos.below ? " below" : ""}${pos.right ? " right" : ""}`}
          style={{
            left: pos.right ? undefined : pos.x,
            right: pos.right ? window.innerWidth - pos.x : undefined,
            top: pos.below ? pos.y + 10 : undefined,
            bottom: pos.below ? undefined : window.innerHeight - pos.y + 10,
          }}
        >{tip}</span>,
        document.body,
      )}
    </span>
  );
}

const BADGE_CLS: Record<StatusBadge["k"], string> = { archived: "p-warn", noleads: "p-bad", draft: "p-info", map: "p-bad", prelaunch: "p-info" };
export function StatusCell({ errors }: { errors: StatusBadge[] }) {
  if (!errors.length) return <span className="pill p-ok">{Ico.healthy}Healthy</span>;
  return (
    <div className="errs">
      {errors.map((e) => (
        <HoverTip key={e.k} className={`err ${BADGE_CLS[e.k]}`} tip={<><b>{e.lab}.</b> {e.tip}</>}>
          {Ico.alertThin}{e.lab}
        </HoverTip>
      ))}
    </div>
  );
}

export function Skel({ w }: { w?: number }) {
  return <span className="skel" style={w ? { width: w } : undefined} />;
}

/** One horizontal bar (analytics + inline expand). */
export function BarRow({ label, value, total, color, compact = false }: { label: string; value: number; total: number; color: string; compact?: boolean }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="bar-row" style={compact ? { marginTop: 7 } : undefined}>
      <span className="bl" style={compact ? { width: 98, fontSize: 11 } : undefined}>{label}</span>
      <span className="bar-track"><span className="bar-fill" style={{ width: `${pct}%`, background: color }} /></span>
      <span className="bn" style={compact ? { fontSize: 11 } : undefined}>{fmt(value)}</span>
    </div>
  );
}

// Queue sources (stopped-recovered leads skip the queue — they're added straight
// to campaigns — so their count comes from the recovery ledger).
export const SOURCE_ROWS: Array<{ key: string; label: string; color: string; cls: string }> = [
  { key: "seq", label: "Sequence-finished", color: "var(--blue-fg)", cls: "p-info" },
  { key: "soft", label: "Soft-negative", color: "var(--violet-fg)", cls: "p-vio" },
  { key: "ooo", label: "Out of office", color: "var(--muted-foreground)", cls: "p-mute" },
  { key: "stop", label: "Stopped-recovered", color: "var(--amber-fg)", cls: "p-warn" },
  { key: "other", label: "Other replies", color: "#a1a1aa", cls: "p-mute" },
  { key: "legacy", label: "Legacy", color: "#c4c4cc", cls: "p-mute" },
];
export const ESP_ROWS: Array<{ key: string; label: string; color: string }> = [
  { key: "google", label: "Google", color: "var(--emerald-fg)" },
  { key: "outlook", label: "Outlook", color: "var(--blue-fg)" },
  { key: "segs", label: "SEGs", color: "var(--violet-fg)" },
];

/** Source rows to show: the three main sources + stopped-recovered always, other/legacy only when present. */
export function sourceValues(stats: TagStats | null, stoppedRecovered: number) {
  const s = stats?.sources ?? {};
  return SOURCE_ROWS
    .map((r) => ({ ...r, value: r.key === "stop" ? stoppedRecovered : Number(s[r.key] ?? 0) }))
    .filter((r) => ["seq", "soft", "ooo", "stop"].includes(r.key) || r.value > 0);
}

// ── toast (the mockup's dark pill, with an optional Undo) ────────────────────
export interface ToastState { msg: string; undo?: () => void; bad?: boolean }
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((msg: string, opts: { undo?: () => void; bad?: boolean; ms?: number } = {}) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ msg, undo: opts.undo, bad: opts.bad });
    timer.current = setTimeout(() => setToast(null), opts.ms ?? (opts.undo ? 8000 : opts.bad ? 5000 : 2600));
  }, []);
  const hide = useCallback(() => { if (timer.current) clearTimeout(timer.current); setToast(null); }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { toast, show, hide };
}

export function Toast({ toast, onHide }: { toast: ToastState | null; onHide: () => void }) {
  return (
    <div className={`toast${toast ? " show" : ""}${toast?.bad ? " bad" : ""}`} role="status" aria-live="polite">
      {toast?.msg}
      {toast?.undo && (
        <button type="button" className="undo" onClick={() => { const u = toast.undo; onHide(); u?.(); }}>Undo</button>
      )}
    </div>
  );
}

// ── confirm dialog (bulk removes) ────────────────────────────────────────────
export function ConfirmDialog({
  open, title, body, confirmLabel, danger = true, busy = false, onConfirm, onClose,
}: {
  open: boolean; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="nx-dialog sm:max-w-[440px]" showCloseButton={false}>
        <DialogTitle className="nx-dlg-h">{title}</DialogTitle>
        <DialogDescription asChild><div className="nx-dlg-p">{body}</div></DialogDescription>
        <div className="nx-dlg-f">
          <button type="button" className="nx-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`nx-btn${danger ? " danger" : ""}`} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── actions menu (keeps the classic controls one click away) ────────────────
export function ActionsMenu({ children, label = "Actions" }: { children: (close: () => void) => ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(".menu [role=menuitem]:not([disabled])") ?? [])];
    // Focus the first item so the menu is usable from the keyboard.
    items()[0]?.focus();
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" ref={triggerRef} className="btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {label} {Ico.dots}
      </button>
      {open && <div className="menu" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}
