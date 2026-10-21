"use client";

/**
 * One service-area change: every lead found in the removed places, across all
 * of the client's campaigns and its nurture queue, in one list.
 *
 *   In removed area — every location signal puts it there; pre-ticked to remove
 *   Needs checking  — partial or contradictory location; kept unless ticked
 *   No location     — no city, state or ZIP; kept unless ticked
 *
 * Tick = remove. Click a tick, shift-click for a range, or press and drag down
 * the ticks. Approve once the check has finished; removal runs on the 6th day.
 * After it runs, the list shows what happened to each lead.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowLeft, Ban, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp,
  Layers, Loader2, MapPinOff, RefreshCw, Search, ShieldCheck, Undo2, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getInstanceLabel } from "@/lib/bison-instances-shared";
import { Chip } from "../../_ui";
import { PlaceChips, STATUS, longDate, type ChangeCounts, type ChangeSummary } from "../../_service-area";

type Tab = "match" | "check" | "noloc" | "ticked";
type Where = { instance: string; campaignId: number; campaignName: string | null; kind: "main" | "nurture" | "queue"; leadStatus: string | null };
type Lead = {
  email: string; name: string | null; company: string | null;
  city: string | null; state: string | null; zip: string | null; address: string | null;
  cls: "match" | "check" | "noloc"; placeKey: string | null; reason: string | null; remove: boolean; decidedBy: string | null; replied: boolean;
  result: "removed" | "verified" | "failed" | "kept" | "let_in" | null; resultDetail: string | null; foundOnDay: boolean; where: Where[];
};
type Progress = { kind: "search" | "queue" | "full" | "enrich"; pending: number; done: number; skipped: number; failed: number; scanned: number; total: number };
type Campaign = { instance: string; id: number; name: string; status: string; kind: "main" | "nurture"; leads: number };
type Detail = {
  change: ChangeSummary & { campaignList: Campaign[]; verifyAfter: string | null; cancelledBy: string | null; cancelledAt: string | null };
  counts: ChangeCounts; progress: Progress[]; failed: { kind: string; label: string; error: string }[];
  canApprove: boolean; blockers: string[]; now: string;
};

const PAGE = 200;
const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "match", label: "In removed area", hint: "Every location detail on these leads puts them in a removed place. Ticked to remove." },
  { key: "check", label: "Needs checking", hint: "Part of the location points to a removed place, but it's incomplete or contradicts itself. Kept unless you tick them." },
  { key: "noloc", label: "No location", hint: "No city, state or ZIP anywhere — they can't be placed. Kept unless you tick them." },
  { key: "ticked", label: "Ticked to remove", hint: "Everything that will be removed, from all three lists." },
];
const LIVE: ChangeSummary["status"][] = ["planning", "scanning", "topup", "removing", "verifying"];
const shortName = (n: string | null) => String(n ?? "").replace(/^[A-Z0-9&._-]+:\s*/i, "").replace(/\s*\((?:[^)]*client|internal)\)\s*$/i, "").trim() || "campaign";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const pl = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { window.location.href = "/login"; return { ok: false }; }
    const j = await r.json().catch(() => ({}));
    return r.ok && j.ok !== false ? { ok: true, data: j } : { ok: false, error: j.error || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export default function ServiceAreaChangePage() {
  const params = useParams();
  const tag = decodeURIComponent(String(params.tag || "")).toUpperCase();
  const id = Number(params.id);
  const base = `/api/clients/${encodeURIComponent(tag)}/service-area/${id}`;

  const [d, setD] = useState<Detail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("match");
  const [q, setQ] = useState("");
  const [qLive, setQLive] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  // Pages by position: the cursors of the pages before this one (empty = first page).
  const [stack, setStack] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [rows, setRows] = useState<Lead[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingRows, setLoadingRows] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "approve" | "cancel" | { bulk: boolean } | { letIn: string[] }>(null);
  const [confirmText, setConfirmText] = useState("");
  const [showCampaigns, setShowCampaigns] = useState(false);
  const lastIdx = useRef<number | null>(null); // the shift-click anchor (reset whenever the list reloads)

  const loadDetail = useCallback(async () => {
    try {
      const r = await fetch(base, { cache: "no-store" });
      if (r.status === 401) { window.location.href = "/login"; return; }
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) { setFailed(j?.error || `Couldn't load it (${r.status}).`); return; }
      setD(j); setFailed(null);
    } catch (e) { setFailed((e as Error).message); }
  }, [base]);

  const after = stack.length ? stack[stack.length - 1] : null;
  const loadRows = useCallback(async () => {
    setLoadingRows(true);
    try {
      const sp = new URLSearchParams({ tab, size: String(PAGE) });
      if (after) sp.set("after", after);
      if (qLive) sp.set("q", qLive);
      if (tab === "ticked" && onlyFailed) sp.set("result", "failed");
      const r = await fetch(`${base}/leads?${sp}`, { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.ok) { setRows(j.rows); setTotal(j.total); setNext(j.next ? JSON.stringify(j.next) : null); lastIdx.current = null; }
      else toast.error(j?.error || "Couldn't load the leads.");
    } finally { setLoadingRows(false); }
  }, [base, tab, after, qLive, onlyFailed]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);
  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => { const t = setTimeout(() => { setQLive(q.trim()); setStack([]); }, 300); return () => clearTimeout(t); }, [q]);

  // Live while something is running.
  const status = d?.change.status;
  useEffect(() => {
    if (!status) return;
    const ms = LIVE.includes(status) ? 4000 : status === "approved" ? 30000 : 0;
    if (!ms) return;
    const t = setInterval(() => { void loadDetail(); }, ms);
    return () => clearInterval(t);
  }, [status, loadDetail]);
  // While removing, the results column changes too.
  useEffect(() => {
    if (status !== "removing" && status !== "verifying") return;
    const t = setInterval(() => { void loadRows(); }, 8000);
    return () => clearInterval(t);
  }, [status, loadRows]);

  const editable = status === "scanning" || status === "review";
  const afterRemoval = status === "removing" || status === "verifying" || status === "done" || status === "partial";
  const tabTotal = useCallback((t: Tab) => (!d ? 0 : t === "ticked" ? d.counts.ticked : d.counts.byClass[t].total), [d]);
  const newRows = !!d && !qLive && !onlyFailed && rows !== null && tabTotal(tab) !== total;

  // ── ticking: click · shift-click range · press and drag ──
  const drag = useRef<{ value: boolean; changed: Set<string> } | null>(null);
  const send = useCallback(async (emails: string[], remove: boolean) => {
    if (!emails.length) return;
    const r = await post(`${base}/mutate`, { action: "decide", emails, remove });
    if (!r.ok) { toast.error(r.error || "Couldn't save the ticks."); void loadRows(); }
    void loadDetail();
  }, [base, loadDetail, loadRows]);
  const setLocal = useCallback((emails: Set<string>, remove: boolean) => {
    setRows((cur) => cur?.map((r) => (emails.has(r.email) ? { ...r, remove, decidedBy: r.decidedBy ?? "you" } : r)) ?? cur);
  }, []);
  const endDrag = useCallback(() => {
    const g = drag.current;
    drag.current = null;
    if (g && g.changed.size) void send([...g.changed], g.value);
  }, [send]);
  useEffect(() => {
    // Let go anywhere — or leave the window — and the drag ends and saves.
    window.addEventListener("mouseup", endDrag);
    window.addEventListener("blur", endDrag);
    return () => { window.removeEventListener("mouseup", endDrag); window.removeEventListener("blur", endDrag); };
  }, [endDrag]);

  function onTickDown(e: React.MouseEvent, idx: number) {
    if (!editable || !rows) return;
    e.preventDefault();
    const row = rows[idx];
    const value = !row.remove;
    if (e.shiftKey && lastIdx.current != null) {
      const [lo, hi] = lastIdx.current < idx ? [lastIdx.current, idx] : [idx, lastIdx.current];
      const emails = new Set(rows.slice(lo, hi + 1).map((r) => r.email));
      setLocal(emails, value);
      void send([...emails], value);
      lastIdx.current = idx;
      return;
    }
    lastIdx.current = idx;
    drag.current = { value, changed: new Set([row.email]) };
    setLocal(new Set([row.email]), value);
  }
  function onRowEnter(e: React.MouseEvent, idx: number) {
    const g = drag.current;
    if (!g || !rows) return;
    // The button was let go outside the window: the drag is over.
    if (e.buttons === 0) { endDrag(); return; }
    const row = rows[idx];
    if (row.remove === g.value) return;
    g.changed.add(row.email);
    setLocal(new Set([row.email]), g.value);
  }

  async function act(action: string, extra: Record<string, unknown> = {}, ok?: string) {
    setBusy(action);
    const r = await post(`${base}/mutate`, { action, ...extra });
    setBusy(null);
    if (!r.ok) { toast.error(r.error || "That didn't work."); return false; }
    if (ok) toast.success(ok);
    await Promise.all([loadDetail(), loadRows()]);
    return true;
  }

  if (failed && !d) {
    return <Shell tag={tag}><div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center text-sm text-destructive">{failed}</div></Shell>;
  }
  if (!d) {
    return <Shell tag={tag}><div className="h-40 animate-pulse rounded-2xl border bg-muted/30" /><div className="h-96 animate-pulse rounded-2xl border bg-muted/30" /></Shell>;
  }

  const c = d.change, n = d.counts;
  const removalStarted = Date.parse(c.removalAt) <= Date.parse(d.now);
  const daysLeft = Math.max(0, Math.ceil((Date.parse(c.removalAt) - Date.parse(d.now)) / 86_400_000));
  const tabInfo = TABS.find((t) => t.key === tab)!;
  const tickedInView = rows?.filter((r) => r.remove).length ?? 0;

  return (
    <Shell tag={tag}>
      {/* ── header ── */}
      <section className="overflow-hidden rounded-2xl border bg-card shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-5">
          <div className="min-w-0 flex-1 basis-[28rem] space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="grid size-9 place-items-center rounded-xl bg-muted text-foreground/70"><MapPinOff className="size-4.5" /></div>
              <h1 className="text-xl font-semibold tracking-tight">{tag} · service area change #{c.id}</h1>
              <Chip tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Chip>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">Removing</span><PlaceChips places={c.places} /></div>
            {c.note && <p className="text-sm text-muted-foreground">“{c.note}”</p>}
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <Meta label="Notice received">{longDate(c.noticeDate)}</Meta>
            <Meta label="Removal day">
              {longDate(c.removalDate)}
              {!afterRemoval && c.status !== "cancelled" && <span className="ml-1.5 text-xs text-muted-foreground">{!removalStarted ? `(in ${daysLeft} day${daysLeft === 1 ? "" : "s"})` : c.status === "approved" || c.status === "topup" ? "(now)" : "(reached — runs once approved)"}</span>}
            </Meta>
            <Meta label="Recorded">{c.createdBy ?? "—"} · {when(c.createdAt)}</Meta>
            <Meta label={c.status === "cancelled" ? "Cancelled" : "Approved"}>
              {c.status === "cancelled" ? `${c.cancelledBy ?? "—"} · ${when(c.cancelledAt)}` : c.approvedBy ? `${c.approvedBy} · ${when(c.approvedAt)}` : <span className="text-muted-foreground">Not yet</span>}
            </Meta>
          </div>
        </div>
        <StatusBanner d={d} busy={busy} act={act} openApprove={() => { setConfirmText(""); setDialog("approve"); }} openCancel={() => setDialog("cancel")} />
      </section>

      {/* ── numbers ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="In removed area" value={n.byClass.match.total} sub={`${n.byClass.match.ticked.toLocaleString()} ticked`} tone="red" />
        <Stat label="Needs checking" value={n.byClass.check.total} sub={`${n.byClass.check.ticked.toLocaleString()} ticked`} tone="amber" />
        <Stat label="No location" value={n.byClass.noloc.total} sub={`${n.byClass.noloc.ticked.toLocaleString()} ticked`} tone="muted" />
        {afterRemoval
          ? <Stat label="Removed" value={n.results.verified + n.results.removed} sub={[
              n.results.failed ? `${n.results.failed} failed` : "", n.results.pending ? `${n.results.pending} waiting` : "",
              n.results.removed ? `${n.results.removed} being confirmed` : "", n.results.kept ? `${n.results.kept} kept on the day` : "",
              n.results.letIn ? `${n.results.letIn} let back in` : "",
            ].filter(Boolean).join(" · ") || "all confirmed"} tone={n.results.failed ? "red" : "green"} />
          : c.status === "cancelled"
          ? <Stat label="Removed" value={0} sub={`Cancelled — ${pl(n.ticked, "lead")} had been ticked`} tone="muted" />
          : <Stat label="Will be removed" value={n.ticked}
              sub={`${pl(n.where.mainCampaigns, "main campaign")} · ${pl(n.where.nurtureCampaigns, "nurture campaign")}${n.where.queue ? ` · ${n.where.queue.toLocaleString()} in queue` : ""}`} tone="violet" />}
      </div>

      {/* ── the list ── */}
      <section className="overflow-hidden rounded-2xl border bg-card shadow-xs">
        <div className="flex flex-wrap items-center gap-1 border-b px-3 pt-2">
          {TABS.map((t) => (
            <button key={t.key} type="button" onClick={() => { setTab(t.key); setStack([]); setOnlyFailed(false); }}
              className={cn("relative -mb-px rounded-t-lg px-3.5 py-2.5 text-sm font-medium transition-colors",
                tab === t.key ? "border-x border-t bg-card text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {t.label} <span className="ml-1 rounded-full bg-muted px-1.5 py-px text-[11px] tabular-nums text-muted-foreground">{tabTotal(t.key).toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b bg-muted/20 px-5 py-3">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{afterRemoval && tab === "ticked" ? "Every lead that was ticked to remove, and what happened to it." : tabInfo.hint}{editable && <> · <b className="font-medium text-foreground/80">Click</b> a tick, <b className="font-medium text-foreground/80">shift-click</b> for a range, or <b className="font-medium text-foreground/80">press and drag</b> down the ticks.</>}</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, city, ZIP" className="h-8 w-64 pl-8 text-sm" />
          </div>
          {tab === "ticked" && afterRemoval && n.results.failed > 0 && (
            <Button size="sm" variant={onlyFailed ? "default" : "outline"} className="h-8" onClick={() => { setOnlyFailed((v) => !v); setStack([]); }}>Only failed ({n.results.failed})</Button>
          )}
          {editable && total > 0 && (
            // While the check runs the list keeps growing, so a bulk tick waits for it to finish.
            <div className="flex items-center gap-1.5" title={status === "scanning" ? "Available when the check finishes" : undefined}>
              <Button size="sm" variant="outline" className="h-8" disabled={!!busy || status === "scanning"} onClick={() => setDialog({ bulk: true })}>Tick all {total.toLocaleString()}</Button>
              <Button size="sm" variant="outline" className="h-8" disabled={!!busy || status === "scanning"} onClick={() => setDialog({ bulk: false })}>Untick all</Button>
            </div>
          )}
        </div>
        {newRows && (
          <button type="button" onClick={() => void loadRows()} className="flex w-full items-center justify-center gap-1.5 border-b bg-sky-500/[0.06] py-2 text-xs font-medium text-sky-700 hover:bg-sky-500/10 dark:text-sky-300">
            <RefreshCw className="size-3.5" /> The list has changed ({tabTotal(tab).toLocaleString()} now) — show it
          </button>
        )}

        <div className="relative overflow-x-auto">
          {loadingRows && rows && <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary/60" />}
          {rows === null ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading leads…</div>
          ) : rows.length === 0 ? (
            <Empty tab={tab} q={qLive} scanning={status === "scanning"} notStarted={status === "planning"} />
          ) : (
            <table className="w-full select-none text-[13px]">
              <thead>
                <tr className="border-b text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className={cn("py-2 pl-5 pr-2", afterRemoval ? "w-32" : "w-[4.5rem]")}>{afterRemoval ? "Result" : "Remove"}</th>
                  <th className="px-3 py-2">Lead</th>
                  <th className="px-3 py-2">Location</th>
                  <th className="px-3 py-2">Why</th>
                  <th className="px-3 py-2">Where it is</th>
                  {afterRemoval && <th className="w-28 px-3 py-2" />}
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r, i) => (
                  <tr key={r.email} onMouseEnter={(e) => onRowEnter(e, i)} className={cn("align-top transition-colors hover:bg-muted/30", r.remove && !afterRemoval && "bg-destructive/[0.025]")}>
                    <td className="py-2.5 pl-5 pr-2">
                      {afterRemoval ? <ResultCell r={r} /> : (
                        <button type="button" role="checkbox" aria-checked={r.remove} aria-label={`Remove ${r.email}`} disabled={!editable}
                          onMouseDown={(e) => onTickDown(e, i)}
                          onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); const v = !r.remove; setLocal(new Set([r.email]), v); void send([r.email], v); } }}
                          className={cn("-m-1 grid size-6 place-items-center rounded p-1", editable ? "cursor-pointer" : "cursor-not-allowed opacity-60")}>
                          <span className={cn("grid size-4 place-items-center rounded border transition-colors", r.remove ? "border-destructive bg-destructive text-white" : "border-muted-foreground/40 bg-background")}>
                            {r.remove && <Check className="size-3" strokeWidth={3} />}
                          </span>
                        </button>
                      )}
                    </td>
                    <td className="max-w-[16rem] px-3 py-2.5">
                      <div className="truncate font-medium">{r.name || r.email}</div>
                      {r.name && <div className="truncate text-xs text-muted-foreground">{r.email}</div>}
                      {r.company && <div className="truncate text-xs text-muted-foreground">{r.company}</div>}
                    </td>
                    <td className="max-w-[15rem] px-3 py-2.5">
                      {r.city || r.state || r.zip ? <div>{[r.city, [r.state, r.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</div> : <span className="text-muted-foreground">—</span>}
                      {r.address && <div className="truncate text-xs text-muted-foreground" title={r.address}>{r.address}</div>}
                    </td>
                    <td className="max-w-[18rem] px-3 py-2.5 text-xs text-muted-foreground">
                      {r.reason}
                      {r.foundOnDay && <div className="mt-1"><Chip tone="sky">Found on the removal day</Chip></div>}
                      {r.decidedBy && !afterRemoval && <div className="mt-0.5 text-[11px] text-foreground/60">Set by hand</div>}
                      {afterRemoval && r.remove && r.resultDetail && (r.result === "failed" || r.result === "kept" || r.result === "let_in") && (
                        <div className={cn("mt-1 text-[11px]", RESULT[r.result].cls)}>{r.resultDetail}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5"><WhereChips where={r.where} replied={r.replied} /></td>
                    {afterRemoval && (
                      <td className="px-3 py-2.5 text-right">
                        {r.remove && (r.result === "verified" || r.result === "removed") && (
                          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setDialog({ letIn: [r.email] })}><Undo2 className="size-3" />Let back in</Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {rows && total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2.5 text-xs text-muted-foreground">
            <span>Page {stack.length + 1} of {Math.max(1, Math.ceil(total / PAGE))} · {total.toLocaleString()} leads{!afterRemoval && ` · ${tickedInView} ticked on this page`}</span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" className="h-7 gap-1" disabled={!stack.length} onClick={() => setStack((st) => st.slice(0, -1))}><ChevronLeft className="size-3.5" />Previous</Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1" disabled={!next} onClick={() => { if (next) setStack((st) => [...st, next]); }}>Next<ChevronRight className="size-3.5" /></Button>
            </div>
          </div>
        )}
      </section>

      {/* ── what was checked ── */}
      <section className="rounded-2xl border bg-card px-5 py-4 shadow-xs">
        <button type="button" onClick={() => setShowCampaigns((v) => !v)} className="flex w-full items-center justify-between gap-3 text-left">
          <span className="inline-flex items-center gap-2 text-sm font-medium"><Layers className="size-4 text-muted-foreground" />What&apos;s checked: {pl(c.campaignList.length, "campaign")} in Email Bison and the nurture queue</span>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", showCampaigns && "rotate-180")} />
        </button>
        {showCampaigns && (
          <div className="mt-3 overflow-hidden rounded-xl border">
            <table className="w-full text-[13px]">
              <tbody className="divide-y">
                {[...c.campaignList].sort((a, b) => a.instance.localeCompare(b.instance) || a.name.localeCompare(b.name)).map((cp) => (
                  <tr key={`${cp.instance}:${cp.id}`} className={cn(cp.status === "archived" && "text-muted-foreground")}>
                    <td className="px-3.5 py-2">{cp.name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{getInstanceLabel(cp.instance)}</td>
                    <td className="px-3 py-2"><Chip tone={cp.kind === "nurture" ? "violet" : "sky"}>{cp.kind}</Chip></td>
                    <td className="px-3 py-2 text-xs">{cp.status}</td>
                    <td className="px-3.5 py-2 text-right tabular-nums text-muted-foreground">{cp.leads.toLocaleString()} leads</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── dialogs ── */}
      <Dialog open={dialog === "approve"} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Approve removing {pl(n.ticked, "lead")}?</DialogTitle>
            <DialogDescription>{removalStarted ? "The removal day has come, so this starts right away." : `Nothing happens before ${longDate(c.removalDate)} at 12:00 AM Pacific. You can reopen the review until then.`}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <ul className="space-y-1.5">
              <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />Take them out of every one of {tag}&apos;s campaigns they&apos;re in — now {pl(n.where.mainCampaigns, "main campaign")} and {pl(n.where.nurtureCampaigns, "nurture campaign")} (checked again on the day)</li>
              {n.where.queue > 0 && <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />Take {pl(n.where.queue, "lead")} out of the nurture queue</li>}
              <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />Block them so no automation puts them back into {tag}&apos;s campaigns</li>
              <li className="flex gap-2"><RefreshCw className="mt-0.5 size-4 shrink-0 text-sky-600" />On the day it first looks again for leads that arrived in these places since this check — those every detail puts there are removed too (listed as found on the removal day); unclear ones are left alone. This list itself doesn&apos;t change</li>
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-sky-600" />Each lead is read again on the day: one ticked by default whose details no longer put it in a removed place is kept (the ones you ticked by hand go as you chose)</li>
            </ul>
            <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Not touched: {tag}&apos;s lead sheet, other clients&apos; campaigns, and the leads themselves (they stay in Email Bison and the lead database). Leads that aren&apos;t ticked stay where they are.
            </div>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Type <b className="text-foreground">{tag}</b> to approve</span>
              <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus className="h-9" />
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={!!busy}>Not yet</Button>
            <Button disabled={!!busy || confirmText.trim().toUpperCase() !== tag}
              onClick={async () => { if (await act("approve", { confirm: confirmText }, removalStarted ? "Approved — removing now." : `Approved — removal runs ${longDate(c.removalDate)}.`)) setDialog(null); }}>
              {busy === "approve" && <Loader2 className="animate-spin" />}Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "cancel"} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this change?</DialogTitle>
            <DialogDescription>Nothing has been removed, and nothing will be. The list and its ticks are kept here for reference.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={!!busy}>Keep it</Button>
            <Button variant="destructive" disabled={!!busy} onClick={async () => { if (await act("cancel", {}, "Cancelled.")) setDialog(null); }}>{busy === "cancel" && <Loader2 className="animate-spin" />}Cancel the change</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dialog && typeof dialog === "object" && "bulk" in dialog} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          {dialog && typeof dialog === "object" && "bulk" in dialog && (
            <>
              <DialogHeader>
                <DialogTitle>{dialog.bulk ? "Tick" : "Untick"} all {total.toLocaleString()} in “{tabInfo.label}”{qLive ? ` matching “${qLive}”` : ""}?</DialogTitle>
                <DialogDescription>{dialog.bulk ? "They'll all be removed when the change runs." : "They'll all stay where they are."} You can still change single leads afterwards.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDialog(null)} disabled={!!busy}>Cancel</Button>
                <Button disabled={!!busy} onClick={async () => { if (await act("decide-all", { tab, q: qLive || undefined, remove: dialog.bulk, expected: total }, `${dialog.bulk ? "Ticked" : "Unticked"} ${total.toLocaleString()}.`)) setDialog(null); }}>
                  {busy === "decide-all" && <Loader2 className="animate-spin" />}{dialog.bulk ? "Tick" : "Untick"} all {total.toLocaleString()}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!dialog && typeof dialog === "object" && "letIn" in dialog} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          {dialog && typeof dialog === "object" && "letIn" in dialog && (
            <>
              <DialogHeader>
                <DialogTitle>Let {dialog.letIn.length === 1 ? dialog.letIn[0] : pl(dialog.letIn.length, "lead")} back in?</DialogTitle>
                <DialogDescription>Takes it off {tag}&apos;s block list, so automations (nurture, the Lead Mover) may add it to {tag}&apos;s campaigns again. It isn&apos;t put back anywhere by this.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDialog(null)} disabled={!!busy}>Cancel</Button>
                <Button disabled={!!busy} onClick={async () => { if (await act("let-back-in", { emails: dialog.letIn }, "Let back in.")) setDialog(null); }}>{busy === "let-back-in" && <Loader2 className="animate-spin" />}Let back in</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

// ─────────────────────────── pieces ───────────────────────────

function Shell({ tag, children }: { tag: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 2xl:max-w-[1600px]">
      <Link href={`/clients/${encodeURIComponent(tag)}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="size-3.5" /> {tag}</Link>
      {children}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div><div className="truncate">{children}</div></div>;
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub: string; tone: "red" | "amber" | "muted" | "violet" | "green" }) {
  const bar = { red: "bg-destructive", amber: "bg-amber-500", muted: "bg-muted-foreground/40", violet: "bg-violet-500", green: "bg-emerald-500" }[tone];
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card px-4 py-3.5 shadow-xs">
      <span className={cn("absolute inset-y-0 left-0 w-1", bar)} />
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value.toLocaleString()}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function WhereChips({ where, replied }: { where: Where[]; replied: boolean }) {
  const chips = where.slice(0, 3);
  return (
    <div className="flex max-w-[22rem] flex-wrap gap-1">
      {replied && <Chip tone="amber">Replied</Chip>}
      {chips.map((w) => (
        <span key={`${w.instance}:${w.campaignId}:${w.kind}`} title={w.kind === "queue" ? w.campaignName ?? "" : `${w.campaignName} · ${getInstanceLabel(w.instance)}${w.leadStatus ? ` · ${w.leadStatus.replace(/_/g, " ")}` : ""}`}
          className={cn("inline-flex max-w-[11rem] items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[11px] ring-1 ring-inset",
            w.kind === "queue" ? "bg-emerald-500/10 text-emerald-800 ring-emerald-600/15 dark:text-emerald-300" : w.kind === "nurture" ? "bg-violet-500/10 text-violet-800 ring-violet-600/15 dark:text-violet-300" : "bg-sky-500/10 text-sky-800 ring-sky-600/15 dark:text-sky-300")}>
          <span className="font-semibold">{w.kind === "queue" ? "Queue" : w.kind === "nurture" ? "Nurture" : "Main"}</span>
          <span className="truncate">{w.kind === "queue" ? (w.campaignName ?? "").replace(/^Nurture queue · /, "") : shortName(w.campaignName)}</span>
        </span>
      ))}
      {where.length > chips.length && <span className="text-[11px] text-muted-foreground" title={where.slice(3).map((w) => w.campaignName).join("\n")}>+{where.length - chips.length}</span>}
      {!where.length && <span className="text-xs text-muted-foreground">—</span>}
    </div>
  );
}

const RESULT = {
  verified: { icon: <CheckCircle2 className="size-3.5 text-emerald-600" />, label: "Removed", cls: "text-emerald-700 dark:text-emerald-400" },
  removed: { icon: <Loader2 className="size-3.5 animate-spin text-sky-600" />, label: "Confirming", cls: "text-sky-700 dark:text-sky-300" },
  failed: { icon: <AlertTriangle className="size-3.5 text-destructive" />, label: "Failed", cls: "text-destructive" },
  kept: { icon: <ShieldCheck className="size-3.5 text-amber-600" />, label: "Kept", cls: "text-amber-700 dark:text-amber-400" },
  let_in: { icon: <Undo2 className="size-3.5 text-muted-foreground" />, label: "Let back in", cls: "text-muted-foreground" },
} as const;

function ResultCell({ r }: { r: Lead }) {
  if (!r.remove) return <span className="text-xs text-muted-foreground">Not ticked</span>;
  const m = r.result ? RESULT[r.result] : { icon: <CircleHelp className="size-3.5 text-muted-foreground" />, label: "Waiting", cls: "text-muted-foreground" };
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium", m.cls)}>{m.icon}{m.label}</span>;
}

function Empty({ tab, q, scanning, notStarted }: { tab: Tab; q: string; scanning: boolean; notStarted: boolean }) {
  const msg = notStarted ? "The check hasn't started yet — leads show up here as it reads them."
    : q ? `Nothing matches “${q}”.`
    : tab === "match" ? (scanning ? "No leads found in the removed places yet — still looking." : "No leads are in the removed places.")
    : tab === "check" ? (scanning ? "No leads with an unclear location yet — still looking." : "No leads with an unclear location.")
    : tab === "noloc" ? (scanning ? "Leads without a location show up as every lead is read." : "Every lead found has a location.")
    : "Nothing is ticked to remove.";
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div className="grid size-11 place-items-center rounded-2xl border bg-background text-muted-foreground">{scanning ? <Loader2 className="size-5 animate-spin" /> : <ShieldCheck className="size-5" />}</div>
      <p className="text-sm text-muted-foreground">{msg}</p>
    </div>
  );
}

function StatusBanner({ d, busy, act, openApprove, openCancel }: {
  d: Detail; busy: string | null; act: (a: string, extra?: Record<string, unknown>, ok?: string) => Promise<boolean>; openApprove: () => void; openCancel: () => void;
}) {
  const c = d.change, n = d.counts;
  const prog = (k: Progress["kind"]) => d.progress.find((p) => p.kind === k);
  const search = prog("search"), queue = prog("queue"), full = prog("full");
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);

  let body: ReactNode = null;
  // Set-up normally takes seconds; one still "setting up" after 3 minutes stopped part-way.
  const stuck = c.status === "planning" && Date.parse(d.now) - Date.parse(c.updatedAt) > 180_000;
  const incomplete = (!!c.error && /isn't complete|Setting up the check failed/.test(c.error)) || stuck;
  const problem = c.error ?? "Setting up the check stopped part-way. Use “Check again”.";
  if (c.status === "planning" || (c.status === "scanning" && incomplete)) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-sm">{incomplete ? <AlertTriangle className="size-4 text-amber-600" /> : <Loader2 className="size-4 animate-spin text-sky-600" />}{incomplete ? problem : "Setting up the check…"}</span>
        {incomplete && <div className="flex items-center gap-2">
          <Button size="sm" className="gap-1.5" disabled={!!busy} onClick={() => void act("rescan", {}, "Checking again — your ticks are kept.")}><RefreshCw className="size-3.5" />Check again</Button>
          <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" disabled={!!busy} onClick={openCancel}><Ban className="size-3.5" />Cancel</Button>
        </div>}
      </div>
    );
  } else if (c.status === "topup") {
    body = <span className="inline-flex items-center gap-2 text-sm font-medium"><Loader2 className="size-4 animate-spin text-sky-600" />Removal day — first looking for leads that arrived in these places since the check, then removing.</span>;
  } else if (c.status === "scanning") {
    const fullPct = full ? pct(full.scanned, full.total) : 0;
    body = (
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-2 font-medium"><Loader2 className="size-4 animate-spin text-sky-600" />{c.quickDoneAt ? "Leads found so far are below — reading every lead to finish the check" : "Looking for leads in the removed places"}</span>
          {search && <span className="text-muted-foreground">Searches {search.done + search.failed} of {search.done + search.failed + search.pending}{search.skipped ? ` (${search.skipped} too slow — left to the full read)` : ""}</span>}
          {queue && <span className="text-muted-foreground">Nurture queue {queue.pending ? `${queue.scanned.toLocaleString()} read` : "done"}</span>}
        </div>
        {full && full.total > 0 && (
          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Every lead: {full.scanned.toLocaleString()} of {full.total.toLocaleString()} read</span><span className="tabular-nums">{fullPct}%</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${fullPct}%` }} /></div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Read-only — nothing is changed while checking. You can tick and untick as leads appear; approval opens when the check finishes.</p>
      </div>
    );
  } else if (c.status === "review") {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          {d.canApprove
            ? <span className="inline-flex items-center gap-2 font-medium"><CheckCircle2 className="size-4 text-emerald-600" />Check finished — {pl(n.ticked, "lead")} ticked to remove. Approve to have them removed on {longDate(c.removalDate)}.</span>
            : <span className="inline-flex items-center gap-2"><AlertTriangle className="size-4 text-amber-600" />{d.blockers.join(" ")}</span>}
        </div>
        <div className="flex items-center gap-2">
          {d.failed.length > 0 && <Button size="sm" variant="outline" className="gap-1.5" disabled={!!busy} onClick={() => void act("retry-scan", {}, "Retrying.")}><RefreshCw className="size-3.5" />Retry {d.failed.length === 1 ? "it" : "them"}</Button>}
          <Button size="sm" variant="ghost" className="gap-1.5" disabled={!!busy} onClick={() => void act("rescan", {}, "Checking again — your ticks are kept.")}><RefreshCw className="size-3.5" />Check again</Button>
          <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" disabled={!!busy} onClick={openCancel}><Ban className="size-3.5" />Cancel</Button>
          <Button size="sm" className="gap-1.5" disabled={!d.canApprove || !!busy} onClick={openApprove}><ShieldCheck className="size-3.5" />Approve removal</Button>
        </div>
      </div>
    );
  } else if (c.status === "approved") {
    const due = Date.parse(c.removalAt) <= Date.parse(d.now);
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-sm"><CalendarClock className="size-4 text-violet-600" />
          {due
            ? `Approved by ${c.approvedBy}. The removal day has come — starting the removal of ${pl(n.ticked, "lead")}…`
            : `Approved by ${c.approvedBy}. ${pl(n.ticked, "lead")} will be removed on ${longDate(c.removalDate)} at 12:00 AM Pacific.`}</span>
        {!due && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" disabled={!!busy} onClick={() => void act("unapprove", {}, "Back in review.")}><Undo2 className="size-3.5" />Reopen the review</Button>
            <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" disabled={!!busy} onClick={openCancel}><Ban className="size-3.5" />Cancel</Button>
          </div>
        )}
      </div>
    );
  } else if (c.status === "removing" || c.status === "verifying") {
    const done = n.results.verified + n.results.removed + n.results.failed;
    const p = pct(done, n.ticked);
    body = (
      <div className="space-y-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium"><Loader2 className="size-4 animate-spin text-sky-600" />
          {c.status === "removing" ? `Removing — ${done.toLocaleString()} of ${n.ticked.toLocaleString()} done` : `Removed — confirming with Email Bison${c.verifyAfter ? ` (next check ${when(c.verifyAfter)})` : ""}`}</span>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${c.status === "removing" ? p : 100}%` }} /></div>
      </div>
    );
  } else if (c.status === "done" || c.status === "partial") {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5 text-sm">
          {c.status === "done"
            ? <span className="inline-flex items-center gap-2 font-medium"><CheckCircle2 className="size-4 text-emerald-600" />{pl(n.results.verified, "lead")} removed and confirmed{c.queueRows ? ` · ${pl(c.queueRows, "nurture-queue row")} taken out` : ""}.</span>
            : <span className="inline-flex items-center gap-2 font-medium text-destructive"><AlertTriangle className="size-4" />{pl(n.results.failed, "lead")} couldn&apos;t be removed — see “Ticked to remove” → Only failed.</span>}
          <div className="text-xs text-muted-foreground">
            {[
              c.recheckedAt ? `Re-checked ${when(c.recheckedAt)}${c.cameBack ? ` — ${pl(c.cameBack, "lead")} had been added back and ${c.cameBack === 1 ? "was" : "were"} removed again` : " — none had come back"}.` : "",
              c.recheckAt ? `${c.recheckedAt ? "Checks once more" : "Checks again"} on ${when(c.recheckAt)} in case any were added back.` : "",
            ].filter(Boolean).join(" ")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {c.status === "partial" && <Button size="sm" className="gap-1.5" disabled={!!busy} onClick={() => void act("retry-removal", {}, "Trying again.")}><RefreshCw className="size-3.5" />Try the failed ones again</Button>}
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!!busy} onClick={() => void act("recheck-now", {}, "Checking now.")}><RefreshCw className="size-3.5" />Check for re-added leads now</Button>
        </div>
      </div>
    );
  } else if (c.status === "cancelled") {
    body = <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><X className="size-4" />Cancelled — nothing was removed.</span>;
  }
  return (
    <div className={cn("border-t px-6 py-4", c.status === "partial" ? "bg-destructive/[0.04]" : c.status === "review" && d.canApprove ? "bg-emerald-500/[0.04]" : "bg-muted/20")}>
      {body}
      {c.error && !incomplete && c.status !== "cancelled" && <p className="mt-2 text-xs text-destructive">Last problem: {c.error} — it keeps trying.</p>}
    </div>
  );
}
