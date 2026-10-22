"use client";

/**
 * Client page → "Hard reset" button (admins, top of the page): start a stalled
 * client over on fresh campaigns. It opens a dialog that says what happens right
 * away, then fills in exactly what it would do for this client — the campaigns
 * archived, the 12 created (as a new client gets them), the inboxes attached and
 * the nurture switch-over. Typing the client tag starts it; it runs in the
 * background, and while it does (or when it stops) the button shows that and
 * opens its progress instead.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Archive, Ban, CheckCircle2, Circle, Inbox, Loader2, Mail, RefreshCw, RotateCcw, Sprout, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Status = "creating" | "attaching" | "repointing" | "archiving" | "done" | "failed" | "cancelling" | "cancelled";
interface ResetView {
  id: number; status: Status; failedStep: Status | null; error: string | null; attempts: number;
  createdBy: string | null; createdAt: string; updatedAt: string; finishedAt: string | null; canCancel: boolean;
  create: { done: number; total: number; lastFailed: { name: string; note: string } | null };
  created: { instance: string; label: string; name: string; id: number }[];
  attach: { instance: string; label: string; inboxes: number | null; verified: number; total: number; refused: number; notConnected: number; setAside: number }[];
  nurture: { done: boolean; batchesCleared: number };
  archive: { total: number; done: number; rows: { instance: string; label: string; id: number; name: string; leads: number; late: boolean; result: string | null; note: string | null }[] };
}
interface Input_ { key: string; label: string; type: "group" | "text" | "select" | "textarea" | "hidden"; value: number | string | null; hint?: string; placeholder?: string; options?: { value: string; label: string }[] }
interface Preview { tag: string; inputs: Input_[]; blockers: string[]; tables: { title: string; columns: string[]; rows: string[][] }[]; notes: { title: string; text: string }[] }

const WORKING: Status[] = ["creating", "attaching", "repointing", "archiving", "cancelling"];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

async function call(url: string, body?: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const r = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, data: j };
  } catch (e) { return { ok: false, data: { error: (e as Error).message } }; }
}

export function HardResetButton({ tag: raw }: { tag: string }) {
  const tag = raw.toUpperCase();
  const base = `/api/clients/${encodeURIComponent(tag)}/hard-reset`;
  const [reset, setReset] = useState<ResetView | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  // What the dialog shows: a running / stopped reset's progress (kept to the end), or the preview.
  const [view, setView] = useState<"progress" | "preview">("preview");
  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback((r: { ok: boolean; data: Record<string, unknown> }) => {
    if (r.ok) setReset((r.data.reset as ResetView | null) ?? null);
  }, []);
  const load = useCallback(async () => apply(await call(base)), [base, apply]);
  useEffect(() => {
    let live = true;
    call(base).then((r) => { if (live) apply(r); });
    return () => { live = false; };
  }, [base, apply]);
  const working = !!reset && WORKING.includes(reset.status);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [working, load]);

  async function act(action: "retry" | "cancel") {
    if (!reset) return;
    setBusy(action);
    const r = await call(base, { action, id: reset.id });
    setBusy(null);
    if (!r.ok) toast.error(String(r.data.error ?? "That didn't work."));
    else toast.success(action === "retry" ? "Carrying on." : "Cancelling — the new campaigns are being deleted.");
    void load();
  }

  const active = !!reset && (working || reset.status === "failed");
  const stopped = reset?.status === "failed";
  return (
    <>
      <Button variant="outline" disabled={reset === undefined} onClick={() => { setView(active ? "progress" : "preview"); setOpen(true); }}
        className={cn("gap-1.5",
          stopped ? "border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive"
            : active ? "border-sky-500/30 text-sky-700 hover:bg-sky-500/5 hover:text-sky-700 dark:text-sky-300"
            : "text-destructive hover:bg-destructive/5 hover:text-destructive")}>
        {stopped ? <AlertTriangle className="size-4" /> : active ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
        {stopped ? "Hard reset stopped" : reset?.status === "cancelling" ? "Cancelling hard reset" : active ? "Hard reset running" : "Hard reset"}
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <DialogContent className={cn("max-h-[90vh] overflow-y-auto", view === "progress" ? "sm:max-w-2xl" : "sm:max-w-4xl")}>
          {view === "progress" && reset ? (
            <>
              <DialogHeader>
                <DialogTitle>Hard reset {tag}</DialogTitle>
                <DialogDescription>{active ? "It runs in the background — you can close this and come back." : "It has finished."}</DialogDescription>
              </DialogHeader>
              {active ? <Progress r={reset} busy={busy} onRetry={() => void act("retry")} onCancel={() => void act("cancel")} tag={tag} />
                : <div className="space-y-4"><LastReset r={reset} /><div className="flex justify-end"><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button></div></div>}
            </>
          ) : open && (
            <ResetPreview tag={tag} base={base} last={reset ?? null} onClose={() => setOpen(false)} onStarted={async () => { await load(); setView("progress"); }} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── what happens (shown straight away) ─────────────────────────────────────

function Overview({ tag }: { tag: string }) {
  const items: [typeof Mail, string, string][] = [
    [Mail, "12 fresh campaigns", "Made exactly as a new client's are today — the current copy for its type, the standard settings and limits, Mon–Fri in its time zone. Drafts until they have leads."],
    [Inbox, "Its domains move over", `Every inbox tagged ${tag} goes on all 6 new campaigns in each of its two instances (any marked Reserve or Burnt are left out). Domains, redirects and whitelisting don't change.`],
    [Sprout, "Nurture starts again", "Nurture sends to the 6 new nurture campaigns and its batch count restarts. The 45-day wait stays, and leads nurtured before aren't nurtured again."],
    [Archive, "Old campaigns archived", `Last, once everything new is ready — ${tag} keeps sending until then. Leads still in their sequences stop. Email Bison can't un-archive.`],
  ];
  return (
    <section className="space-y-3">
      <ol className="grid gap-3 sm:grid-cols-2">
        {items.map(([I, t, d], i) => (
          <li key={t} className="flex gap-3 rounded-xl border bg-muted/20 p-3.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background text-foreground/70 ring-1 ring-border"><I className="size-4" /></span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium"><span className="mr-1.5 text-muted-foreground">{i + 1}.</span>{t}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{d}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">Then load leads into the new campaigns as usual — they start once they have leads and inboxes (the Go Live Date still applies).</p>
    </section>
  );
}

function LastReset({ r }: { r: ResetView }) {
  const archived = r.archive.rows.filter((x) => x.result === "archived").length;
  const left = r.archive.rows.filter((x) => x.result === "skipped" && x.note && !/made by this reset/.test(x.note));
  const done = r.status === "done";
  return (
    <div className={cn("rounded-xl border px-4 py-2.5 text-xs", done ? "border-emerald-600/20 bg-emerald-500/[0.05]" : "bg-muted/20")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {done ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-muted-foreground" />}
        <span className="font-medium text-foreground">Last reset #{r.id} — {done ? "done" : "cancelled"} {when(r.finishedAt ?? r.updatedAt)}</span>
        <span className="text-muted-foreground">by {r.createdBy ?? "—"}{done ? ` · ${r.create.done} campaigns made · ${archived} archived` : ""}</span>
      </div>
      {!done && r.error && <p className="mt-1.5 text-muted-foreground">{r.error}</p>}
      {done && left.length > 0 && <p className="mt-1.5 text-muted-foreground">Not archived: {left.map((x) => `#${x.id} “${x.name}” (${x.note})`).join("; ")}.</p>}
      {done && r.created.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">The {r.created.length} new campaigns it made</summary>
          <ul className="mt-1.5 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {r.created.map((c) => <li key={`${c.instance}:${c.id}`} className="truncate" title={`#${c.id} ${c.name}`}><span className="text-muted-foreground">{c.label} · #{c.id}</span> {c.name}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

// ── progress ───────────────────────────────────────────────────────────────

type StepState = "done" | "now" | "todo" | "failed";
function stepState(r: ResetView, step: Status): StepState {
  const order: Status[] = ["creating", "attaching", "repointing", "archiving"];
  const cur = r.status === "failed" ? r.failedStep : r.status === "done" ? null : r.status;
  if (r.status === "done") return "done";
  if (!cur || cur === "cancelling") return "todo";
  const i = order.indexOf(step), c = order.indexOf(cur);
  if (i < c) return "done";
  if (i > c) return "todo";
  return r.status === "failed" ? "failed" : "now";
}

function Progress({ r, busy, onRetry, onCancel, tag }: { r: ResetView; busy: string | null; onRetry: () => void; onCancel: () => void; tag: string }) {
  const [asking, setAsking] = useState(false);
  const archivePct = r.archive.total ? Math.round((r.archive.done / r.archive.total) * 100) : 100;
  // Waiting on Email Bison (its background deletes, or a few minutes for an unanswered create) isn't a problem.
  const waiting = r.status !== "failed" && /^Waiting|can run again in about/.test(r.error ?? "");
  const steps: { key: Status; title: string; detail: React.ReactNode }[] = [
    { key: "creating", title: "Make the 12 new campaigns", detail: `${r.create.done} of ${r.create.total} made${r.create.lastFailed ? ` — stopped at “${r.create.lastFailed.name}”` : ""}` },
    { key: "attaching", title: "Attach the inboxes", detail: (
      <span className="block space-y-0.5">
        {r.attach.map((a) => (
          <span key={a.instance} className="block">
            {a.label}: {a.inboxes == null ? "reading its inboxes…" : `${a.inboxes.toLocaleString()} inboxes · on ${a.verified} of ${a.total} campaigns`}
            {a.notConnected ? ` · ${a.notConnected} not connected` : ""}
            {a.refused ? ` · ${a.refused} refused by Email Bison` : ""}
            {a.setAside ? ` · ${a.setAside} marked Reserve / Burnt left out` : ""}
          </span>
        ))}
      </span>
    ) },
    { key: "repointing", title: "Switch nurture to the new campaigns", detail: r.nurture.done ? `Done${r.nurture.batchesCleared ? ` — ${r.nurture.batchesCleared} batch record${r.nurture.batchesCleared === 1 ? "" : "s"} cleared` : ""}` : "Nurture map → the 6 new nurture campaigns; batch count restarts" },
    { key: "archiving", title: "Archive the old campaigns", detail: (
      <span className="block space-y-1.5">
        <span className="block">{r.archive.done} of {r.archive.total} done{r.archive.rows.some((x) => x.late) ? ` (incl. ${r.archive.rows.filter((x) => x.late).length} made after the reset started)` : ""}</span>
        {r.archive.total > 0 && <span className="block h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-sky-500 transition-all" style={{ width: `${archivePct}%` }} /></span>}
      </span>
    ) },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {r.status === "failed" ? <AlertTriangle className="size-4 text-destructive" /> : <Loader2 className="size-4 animate-spin text-sky-600" />}
          {r.status === "failed" ? `Hard reset #${r.id} stopped` : r.status === "cancelling" ? `Cancelling hard reset #${r.id} — deleting the new campaigns` : `Hard reset #${r.id} is running`}
        </div>
        <span className="text-xs text-muted-foreground">Started {when(r.createdAt)} by {r.createdBy ?? "—"}</span>
      </div>
      {r.status !== "cancelling" && (
        <ol className="divide-y rounded-xl border">
          {steps.map((s) => {
            const st = stepState(r, s.key);
            return (
              <li key={s.key} className={cn("flex gap-3 px-4 py-3", st === "now" && "bg-sky-500/[0.04]", st === "failed" && "bg-destructive/[0.04]")}>
                <span className="mt-0.5 shrink-0">
                  {st === "done" ? <CheckCircle2 className="size-4 text-emerald-600" /> : st === "now" ? <Loader2 className="size-4 animate-spin text-sky-600" /> : st === "failed" ? <XCircle className="size-4 text-destructive" /> : <Circle className="size-4 text-muted-foreground/40" />}
                </span>
                <span className="min-w-0 text-sm">
                  <span className={cn("block font-medium", st === "todo" && "text-muted-foreground")}>{s.title}</span>
                  {st !== "todo" && <span className="mt-0.5 block text-xs text-muted-foreground">{s.detail}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {r.error && (
        <div className={cn("rounded-xl border px-4 py-3 text-sm",
          r.status === "failed" ? "border-destructive/30 bg-destructive/[0.05] text-destructive"
            : waiting ? "border-sky-500/25 bg-sky-500/[0.05] text-sky-900 dark:text-sky-200"
            : "border-amber-500/25 bg-amber-500/[0.06] text-amber-900 dark:text-amber-200")}>
          {r.status === "failed" ? "Stopped: " : waiting ? "" : "Last problem: "}{r.error}
          {r.status === "failed" && r.failedStep === "archiving" && <span className="mt-1 block text-xs text-muted-foreground">The new campaigns are ready and nurture already uses them. If an old campaign won&apos;t archive, archive it by hand in Email Bison, then Try again.</span>}
        </div>
      )}
      {asking ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/[0.04] px-4 py-3 text-sm">
          <p className="font-medium">Cancel the hard reset?</p>
          <p className="mt-0.5 text-xs text-muted-foreground">The new campaigns it has made so far are deleted (never one with leads in it). {tag}&apos;s current campaigns, their inboxes and nurture stay exactly as they are — nothing of them has been changed yet.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" className="gap-1.5" disabled={!!busy} onClick={() => { onCancel(); setAsking(false); }}>{busy === "cancel" ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />}Cancel the reset</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setAsking(false)}>Keep going</Button>
          </div>
        </div>
      ) : (r.status === "failed" || r.canCancel) && (
        <div className="flex flex-wrap items-center gap-2">
          {r.status === "failed" && <Button size="sm" className="gap-1.5" disabled={!!busy} onClick={onRetry}>{busy === "retry" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Try again</Button>}
          {r.canCancel && <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" disabled={!!busy} onClick={() => setAsking(true)}><Ban className="size-3.5" />Cancel the reset</Button>}
          {!r.canCancel && r.status === "failed" && <span className="text-xs text-muted-foreground">It can&apos;t be cancelled now — nurture already uses the new campaigns, so Try again finishes it.</span>}
        </div>
      )}
    </div>
  );
}

// ── the preview + confirm ──────────────────────────────────────────────────

function ResetPreview({ tag, base, last, onClose, onStarted }: { tag: string; base: string; last: ResetView | null; onClose: () => void; onStarted: () => Promise<void> }) {
  const [pv, setPv] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState("");
  // Email Bison limits how many requests a minute it answers; when something else is using that up, this waits.
  const [slow, setSlow] = useState(false);
  const waitingFirst = !pv && loading;
  useEffect(() => {
    if (!waitingFirst) return;
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, [waitingFirst]);

  const show = useCallback((r: { ok: boolean; data: Record<string, unknown> }) => {
    setLoading(false);
    if (!r.ok) { setError(String(r.data.error ?? "Couldn't build the preview.")); return; }
    const p = r.data.preview as Preview;
    setPv(p); setError(null);
    const v = Object.fromEntries(p.inputs.map((i) => [i.key, String(i.value ?? "")]));
    setValues(v); setShown(v);
  }, []);
  const preview = useCallback(async (params: Record<string, string>) => {
    setLoading(true);
    show(await call(base, { action: "preview", params }));
  }, [base, show]);
  useEffect(() => {
    let live = true;
    call(base, { action: "preview", params: {} }).then((r) => { if (live) show(r); });
    return () => { live = false; };
  }, [base, show]);

  const dirty = useMemo(() => Object.keys(values).some((k) => values[k] !== shown[k]), [values, shown]);
  const canStart = !!pv && !loading && !dirty && !pv.blockers.length && confirm.trim().toUpperCase() === tag;

  async function start() {
    setStarting(true);
    const r = await call(base, { action: "start", params: values, confirm });
    setStarting(false);
    if (!r.ok) { toast.error(String(r.data.error ?? "It didn't start.")); void preview(values); return; }
    toast.success(`Hard reset of ${tag} started — it runs in the background.`);
    await onStarted();
  }

  const visible = pv?.inputs.filter((i) => i.type !== "hidden" && i.type !== "group") ?? [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>Hard reset {tag}?</DialogTitle>
        <DialogDescription>Starts {tag} over on fresh campaigns — for a client that has stalled. Nothing changes until you confirm below.</DialogDescription>
      </DialogHeader>

      <div className="space-y-5 text-sm">
        <Overview tag={tag} />
        {last && (last.status === "done" || last.status === "cancelled") && <LastReset r={last} />}

        {!pv && loading ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
            <span>
              Reading {tag}&apos;s campaigns, inboxes and details in Email Bison…
              {slow && <span className="mt-1 block text-xs">Email Bison is answering slowly right now — it limits how many requests it takes a minute, and something else (a Lead Mover job, say) may be using them up. This can take up to a minute.</span>}
            </span>
          </div>
        ) : error && !pv ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div>
        ) : pv && (
          <div className={cn("space-y-5", loading && "pointer-events-none opacity-60")}>
            {pv.blockers.length > 0 && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/[0.05] px-4 py-3">
                <div className="mb-1 flex items-center gap-1.5 font-medium text-destructive"><AlertTriangle className="size-4" />It can&apos;t run yet</div>
                <ul className="list-disc space-y-0.5 pl-5 text-destructive">{pv.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              </div>
            )}

            {visible.length > 0 && (
              <section className="rounded-xl border">
                <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
                  <span className="font-medium">What the new campaigns are built with</span>
                  {dirty && <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => void preview(values)}><RefreshCw className="size-3.5" />Update the preview</Button>}
                </div>
                <div className="grid gap-3 p-4 sm:grid-cols-2">
                  {visible.map((i) => (
                    <label key={i.key} className={cn("space-y-1", i.type === "textarea" && "sm:col-span-2")}>
                      <span className="text-xs font-medium text-muted-foreground">{i.label}</span>
                      {i.type === "select" ? (
                        <Select value={values[i.key] ?? ""} onValueChange={(v) => setValues((cur) => ({ ...cur, [i.key]: v }))}>
                          <SelectTrigger className="h-9 w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
                          <SelectContent>{(i.options ?? []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                        </Select>
                      ) : i.type === "textarea" ? (
                        <Textarea rows={3} value={values[i.key] ?? ""} placeholder={i.placeholder} onChange={(e) => setValues((cur) => ({ ...cur, [i.key]: e.target.value }))} className="font-mono text-xs" />
                      ) : (
                        <Input className="h-9" value={values[i.key] ?? ""} placeholder={i.placeholder} onChange={(e) => setValues((cur) => ({ ...cur, [i.key]: e.target.value }))} />
                      )}
                      {i.hint && <span className="block text-[11px] text-muted-foreground">{i.hint}</span>}
                    </label>
                  ))}
                </div>
              </section>
            )}

            {pv.tables.map((t) => (
              <section key={t.title} className="overflow-hidden rounded-xl border">
                <div className="border-b bg-muted/20 px-4 py-2.5 font-medium">{t.title}</div>
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card"><tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">{t.columns.map((c) => <th key={c} className="px-3 py-2 font-semibold">{c}</th>)}</tr></thead>
                    <tbody className="divide-y">{t.rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} className={cn("px-3 py-2 align-top", ci === 1 && "font-medium")}>{cell}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              </section>
            ))}

            {pv.notes.map((n) => (
              <details key={n.title} className="rounded-xl border px-4 py-2.5">
                <summary className="cursor-pointer font-medium">{n.title}</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">{n.text}</pre>
              </details>
            ))}
          </div>
        )}
      </div>

      <DialogFooter className="flex-col items-stretch gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex flex-1 items-center gap-2 text-sm">
          <span className="shrink-0 text-muted-foreground">Type <b className="text-foreground">{tag}</b> to start</span>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-9 max-w-[12rem]" disabled={!pv || !!pv.blockers.length || dirty} />
        </label>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} disabled={starting}>Close</Button>
          <Button variant="destructive" onClick={() => void start()} disabled={!canStart || starting} title={dirty ? "Update the preview first" : undefined}>
            {starting ? <Loader2 className="animate-spin" /> : <RotateCcw className="size-3.5" />}Start the hard reset
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
