"use client";

/**
 * Client page → "Service area changes": the client's removals (newest first),
 * the Onboarding Form alert (places added to / taken out of its service area,
 * found by the sheet sync), and "Remove places" — enter the cities / states /
 * ZIPs taken out, the date notice came in and the removal day (day 6 by
 * default); the check starts at once (read-only) and nothing is removed until
 * someone approves the review.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, CalendarClock, Check, ChevronDown, History, Loader2, MapPinOff, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtDate } from "@/lib/onboarding/ui";
import { daysBetween, pacificToday, parsePlaces, removalDate, removalDateProblem, type Place, type PlaceType } from "@/lib/service-area-changes/places";
import type { AreaItem } from "@/lib/service-area-changes/area-text";
import { Card, Chip, type ChipTone } from "./_ui";

export interface AreaAlert {
  id: number; clientTag: string; detectedAt: string; updatedAt: string; toVersion: number;
  removed: AreaItem[]; added: AreaItem[]; before: string; after: string;
  status: "open" | "dismissed" | "recorded" | "reverted";
  handledBy: string | null; handledAt: string | null; changeId: number | null;
}

export type ChangeStatus = "planning" | "scanning" | "review" | "approved" | "topup" | "removing" | "verifying" | "done" | "partial" | "cancelled";
export interface ChangeSummary {
  id: number; places: Place[]; noticeDate: string; removalDate: string; removalAt: string; note: string | null;
  status: ChangeStatus; createdBy: string | null; createdAt: string; approvedBy: string | null; approvedAt: string | null;
  quickDoneAt: string | null; scanDoneAt: string | null; removalStartedAt: string | null; removalFinishedAt: string | null;
  verifiedAt: string | null; recheckAt: string | null; recheckedAt: string | null; cameBack: number; error: string | null;
  campaigns: number; queueRows: number | null; updatedAt: string;
}
export interface ChangeCounts {
  byClass: Record<"match" | "check" | "noloc", { total: number; ticked: number }>;
  ticked: number;
  where: { main: number; nurture: number; queue: number; mainCampaigns: number; nurtureCampaigns: number };
  results: { removed: number; verified: number; failed: number; kept: number; letIn: number; pending: number };
}

export const STATUS: Record<ChangeStatus, { label: string; tone: ChipTone }> = {
  planning: { label: "Setting up", tone: "sky" },
  scanning: { label: "Checking leads", tone: "sky" },
  review: { label: "Ready for review", tone: "amber" },
  approved: { label: "Approved — waiting for the removal day", tone: "violet" },
  topup: { label: "Removal day — final check", tone: "sky" },
  removing: { label: "Removing", tone: "sky" },
  verifying: { label: "Removed — confirming", tone: "sky" },
  done: { label: "Done", tone: "green" },
  partial: { label: "Done with problems", tone: "red" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

const KIND_LABEL: Record<PlaceType, string> = { city: "City", state: "State", zip: "ZIP" };
const PLACEHOLDER: Record<PlaceType, string> = {
  city: "One per line, with its state:\nWheaton, IL\nNaperville, IL",
  state: "IL, Indiana",
  zip: "60187, 60188",
};

export function PlaceChips({ places, max = 99 }: { places: Place[]; max?: number }) {
  const shown = places.slice(0, max);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {shown.map((p) => (
        <span key={p.key} className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{KIND_LABEL[p.type]}</span>{p.label}
        </span>
      ))}
      {places.length > shown.length && <span className="text-xs text-muted-foreground">+{places.length - shown.length} more</span>}
    </span>
  );
}

/** "Mon, Oct 26" */
export const longDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
};

/** What a removed place from the Onboarding Form fills into "Remove places". */
function prefillFrom(items: AreaItem[]): { places: Place[]; cityText: string; notFilled: string[] } {
  const places: Place[] = [];
  const bare: string[] = [], notFilled: string[] = [];
  const push = (ps: Place[]) => { for (const p of ps) if (!places.some((x) => x.key === p.key)) places.push(p); };
  for (const it of items) {
    // A whole state is never filled in for removal — that's for a person to decide.
    if (it.kind === "zip") push(parsePlaces("zip", it.zip ?? it.label).places);
    else if (it.kind === "state") notFilled.push(`${it.label} (whole state)`);
    else if (it.kind === "city" && it.state) push(parsePlaces("city", it.label.replace(/\s*\((?:now excluded|no longer excluded)\)$/, "")).places);
    else if (it.kind === "city") bare.push(it.label.replace(/\s*\((?:now excluded|no longer excluded)\)$/, ""));
    else notFilled.push(it.label);
  }
  return { places, cityText: bare.join("\n"), notFilled };
}

const AREA_KIND: Record<AreaItem["kind"], string> = { zip: "ZIP", state: "State", city: "City", county: "County" };
function AreaChips({ items, tone, max = 40 }: { items: AreaItem[]; tone: "removed" | "added"; max?: number }) {
  const shown = items.slice(0, max);
  return (
    <span className="flex flex-wrap gap-1.5">
      {shown.map((x) => (
        <span key={x.key} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
          tone === "removed" ? "border-destructive/25 bg-destructive/[0.06] text-destructive line-through decoration-destructive/40" : "border-emerald-600/20 bg-emerald-500/[0.07] text-emerald-800 dark:text-emerald-300")}>
          <span className="text-[10px] font-semibold uppercase tracking-wide no-underline opacity-70">{AREA_KIND[x.kind]}</span>{x.label}
        </span>
      ))}
      {items.length > shown.length && <span className="self-center text-xs text-muted-foreground">+{items.length - shown.length} more</span>}
    </span>
  );
}

export function ServiceAreaCard({ tag }: { tag: string }) {
  const [data, setData] = useState<{ today: string; changes: (ChangeSummary & { counts: ChangeCounts })[]; alert: AreaAlert | null } | null | "failed">(null);
  const [open, setOpen] = useState<null | { alert: AreaAlert | null }>(null);
  const [showText, setShowText] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const load = useCallback(() => {
    let live = true;
    fetch(`/api/clients/${encodeURIComponent(tag)}/service-area`, { cache: "no-store" })
      .then(async (r) => { const j = await r.json().catch(() => null); if (live) setData(r.ok && j?.ok ? j : "failed"); })
      .catch(() => { if (live) setData("failed"); });
    return () => { live = false; };
  }, [tag]);
  useEffect(() => load(), [load]);

  const changes = data && data !== "failed" ? data.changes : [];
  const alert = data && data !== "failed" ? data.alert : null;
  const openChange = changes.find((c) => !["done", "partial", "cancelled"].includes(c.status));

  async function dismiss(a: AreaAlert) {
    setDismissing(true);
    try {
      const r = await fetch("/api/service-area/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss", id: a.id, tag, toVersion: a.toVersion }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) toast.error(j.error || "Couldn't mark it.");
      else { toast.success("Marked as looked at."); window.dispatchEvent(new Event("service-area-alerts-changed")); }
      load();
    } finally { setDismissing(false); }
  }

  return (
    <Card icon={<MapPinOff className="size-4" />} title="Service area changes"
      sub="Places the client stopped serving — their leads leave every campaign and the queue on the removal day, once approved"
      action={openChange
        ? <Button asChild size="sm" variant="outline" className="gap-1.5"><Link href={`/clients/${encodeURIComponent(tag)}/service-area/${openChange.id}`}>Open change #{openChange.id}<ArrowRight className="size-3.5" /></Link></Button>
        : <Button size="sm" className="gap-1.5" onClick={() => setOpen({ alert: null })} disabled={data === null}><Plus className="size-3.5" />Remove places</Button>}>
      {data === null ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : data === "failed" ? (
        <p className="py-2 text-sm text-destructive">Couldn&apos;t load the service-area changes — reload to try again.</p>
      ) : (
        <div className="space-y-4">
          {alert && (
            <div className={cn("rounded-xl border px-4 py-3 text-sm", alert.status === "open" ? "border-amber-500/30 bg-amber-500/[0.06]" : "bg-muted/20")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <span className={cn("inline-flex min-w-0 items-start gap-2", alert.status === "open" ? "text-amber-900 dark:text-amber-200" : "text-muted-foreground")}>
                  <History className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <span className="font-medium">The Onboarding Form&apos;s service area changed</span> — found {new Date(alert.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    {alert.removed.length > 0 && `: ${alert.removed.length} place${alert.removed.length === 1 ? "" : "s"} taken out`}
                    {alert.added.length > 0 && `${alert.removed.length ? "," : ":"} ${alert.added.length} added`}.
                    {alert.status !== "open" && <span className="block text-xs">
                      {alert.status === "recorded" ? <>Recorded as {alert.changeId ? <Link className="font-medium text-primary hover:underline" href={`/clients/${encodeURIComponent(tag)}/service-area/${alert.changeId}`}>change #{alert.changeId}</Link> : "a change"}</> : "Marked as looked at"}
                      {alert.handledBy ? ` by ${alert.handledBy}` : ""}{alert.handledAt ? ` on ${fmtDate(alert.handledAt.slice(0, 10))}` : ""}.
                    </span>}
                  </span>
                </span>
                {alert.status === "open" && (
                  <div className="flex shrink-0 items-center gap-2">
                    {alert.removed.length > 0 && !openChange && <Button size="sm" className="h-8 gap-1.5" onClick={() => setOpen({ alert })}><MapPinOff className="size-3.5" />Record the removals</Button>}
                    <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={dismissing} onClick={() => void dismiss(alert)}>{dismissing ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}{alert.removed.length ? "Nothing to remove" : "Got it"}</Button>
                  </div>
                )}
              </div>
              <div className="mt-3 space-y-2 pl-6">
                {alert.removed.length > 0 && <div className="flex gap-2"><span className="w-16 shrink-0 pt-0.5 text-xs font-medium text-muted-foreground">Removed</span><AreaChips items={alert.removed} tone="removed" /></div>}
                {alert.added.length > 0 && <div className="flex gap-2"><span className="w-16 shrink-0 pt-0.5 text-xs font-medium text-muted-foreground">Added</span><AreaChips items={alert.added} tone="added" /></div>}
                {alert.status === "open" && alert.removed.length > 0 && openChange && (
                  <p className="text-xs text-muted-foreground">Change #{openChange.id} is still open — finish or cancel it before recording these.</p>
                )}
                <button type="button" onClick={() => setShowText((v) => !v)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  <ChevronDown className={cn("size-3.5 transition-transform", showText && "rotate-180")} />{showText ? "Hide the text" : "Before / after text"}
                </button>
                {showText && (
                  <div className="grid gap-3 md:grid-cols-2">
                    {(["before", "after"] as const).map((k) => (
                      <div key={k} className="min-w-0 rounded-lg border bg-background px-3 py-2">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{k === "before" ? "Before" : "Now"}</div>
                        <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{alert[k]}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {changes.length === 0 ? (
            <div className="rounded-xl border border-dashed px-5 py-6">
              <p className="text-sm font-medium">No service-area changes yet</p>
              <ol className="mt-3 grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
                {[
                  ["Enter the places", "Cities, states or ZIPs the client stopped serving, the day you got the notice, and the removal day."],
                  ["Review the leads", "Leads in those places come pre-ticked. Untick any to keep; check the unclear ones."],
                  ["Removed on the removal day", "Day 6 after the notice unless you pick another. Once approved, they leave every campaign and the nurture queue, and can't be re-added."],
                ].map(([t, d], i) => (
                  <li key={t} className="flex gap-2.5">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-foreground/70">{i + 1}</span>
                    <span><span className="block font-medium text-foreground">{t}</span>{d}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="divide-y overflow-hidden rounded-xl border">
              {changes.map((c) => (
                <Link key={c.id} href={`/clients/${encodeURIComponent(tag)}/service-area/${c.id}`} className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-muted/30">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">#{c.id}</span>
                      <Chip tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Chip>
                    </div>
                    <PlaceChips places={c.places} max={5} />
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" />Notice {fmtDate(c.noticeDate)} · removal {fmtDate(c.removalDate)}</div>
                    <div className="mt-1 tabular-nums">
                      {c.status === "done" || c.status === "partial"
                        ? `${(c.counts.results.verified + c.counts.results.removed).toLocaleString()} removed${c.counts.results.failed ? ` · ${c.counts.results.failed} failed` : ""}`
                        : c.status === "cancelled" ? "Nothing removed"
                        : c.status === "removing" || c.status === "verifying" ? `${(c.counts.results.verified + c.counts.results.removed).toLocaleString()} of ${c.counts.ticked.toLocaleString()} removed`
                        : c.status === "approved" || c.status === "topup" ? `${c.counts.ticked.toLocaleString()} to remove`
                        : `${c.counts.ticked.toLocaleString()} ticked to remove${c.counts.byClass.check.total ? ` · ${c.counts.byClass.check.total.toLocaleString()} to check` : ""}`}
                    </div>
                  </div>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
      {open && data && data !== "failed" && <NewChangeDialog tag={tag} today={data.today} alert={open.alert} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function NewChangeDialog({ tag, today, alert, onClose }: { tag: string; today: string; alert: AreaAlert | null; onClose: () => void }) {
  const router = useRouter();
  const seed = useMemo(() => (alert ? prefillFrom(alert.removed) : null), [alert]);
  const [kind, setKind] = useState<PlaceType>("city");
  const [text, setText] = useState(seed?.cityText ?? "");
  const [places, setPlaces] = useState<Place[]>(seed?.places ?? []);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState(today || pacificToday());
  // The removal day follows the notice date (day 6) until someone picks one.
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState(alert ? `Service area edit on the Onboarding Form (found ${new Date(alert.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : "");
  const [busy, setBusy] = useState(false);

  function add() {
    const r = parsePlaces(kind, text);
    setErrors(r.errors);
    if (r.places.length) {
      setPlaces((cur) => { const seen = new Set(cur.map((p) => p.key)); return [...cur, ...r.places.filter((p) => !seen.has(p.key))]; });
      if (!r.errors.length) setText("");
    }
  }
  const noticeOk = /^\d{4}-\d{2}-\d{2}$/.test(notice);
  const defaultRemoval = noticeOk ? removalDate(notice) : null;
  const removeOn = picked ?? defaultRemoval;
  const removalProblem = removeOn ? removalDateProblem(removeOn, noticeOk ? notice : null, today) : "Pick the removal day.";
  const dayNo = removeOn && noticeOk ? daysBetween(notice, removeOn) + 1 : null;
  const pending = text.trim().length > 0;

  async function start() {
    if (pending) { add(); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/clients/${encodeURIComponent(tag)}/service-area`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: (["city", "state", "zip"] as PlaceType[]).map((t) => ({ type: t, text: places.filter((p) => p.type === t).map((p) => p.label).join("\n") })).filter((e) => e.text),
          noticeDate: notice, removalDate: removeOn, note, alertId: alert?.id, alertVersion: alert?.toVersion,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { toast.error(j.error || `Couldn't start it (${r.status}).`); setBusy(false); return; }
      toast.success("Recorded — checking the leads now.");
      if (alert) window.dispatchEvent(new Event("service-area-alerts-changed"));
      router.push(`/clients/${encodeURIComponent(tag)}/service-area/${j.id}`);
    } catch (e) { toast.error((e as Error).message); setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Remove places from {tag}&apos;s service area</DialogTitle>
          <DialogDescription>
            {alert ? "Filled in from the Onboarding Form edit — check the places before starting. " : ""}
            Leads in these places are found in every campaign and the nurture queue. Nothing is removed until someone approves the list.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">What&apos;s being removed</span>
              <div className="inline-flex rounded-lg border bg-muted/40 p-0.5" role="tablist">
                {(["city", "state", "zip"] as PlaceType[]).map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={kind === t} onClick={() => { setKind(t); setErrors([]); }}
                    className={cn("rounded-md px-3 py-1 text-xs font-medium transition-colors", kind === t ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground")}>
                    {t === "city" ? "Cities" : t === "state" ? "States" : "ZIPs"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={PLACEHOLDER[kind]} rows={3} className="min-h-[76px] flex-1 text-sm"
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } }} />
              <Button type="button" variant="outline" onClick={add} disabled={!text.trim()}>Add</Button>
            </div>
            {seed && seed.cityText && !errors.length && pending && (
              <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">These cities had no state on the Onboarding Form — add “, ST” to each, then Add.</p>
            )}
            {seed && seed.notFilled.length > 0 && (
              <p className="mt-1.5 text-xs text-muted-foreground">Not filled in (enter their cities or ZIPs if they go): {seed.notFilled.join(", ")}.</p>
            )}
            {errors.length > 0 && <ul className="mt-1.5 space-y-0.5 text-xs text-destructive">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            {places.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {places.map((p) => (
                  <span key={p.key} className="inline-flex items-center gap-1 rounded-md border bg-background py-0.5 pl-1.5 pr-1 text-xs">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{KIND_LABEL[p.type]}</span>{p.label}
                    <button type="button" aria-label={`Remove ${p.label}`} onClick={() => setPlaces((cur) => cur.filter((x) => x.key !== p.key))} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Notice received on</span>
              <Input type="date" value={notice} max={today} onChange={(e) => setNotice(e.target.value)} className="h-9" />
            </label>
            <label className="space-y-1.5">
              <span className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                <span>Removal day</span>
                {picked && picked !== defaultRemoval && defaultRemoval && (
                  <button type="button" className="font-normal text-primary hover:underline" onClick={() => setPicked(null)}>Use day 6 ({longDate(defaultRemoval)})</button>
                )}
              </span>
              <Input type="date" value={removeOn ?? ""} min={noticeOk && notice > today ? notice : today} onChange={(e) => setPicked(e.target.value || null)} className={cn("h-9", removalProblem && "border-destructive/60")} />
            </label>
          </div>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Note <span className="font-normal">(optional)</span></span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Email from Dave, Oct 21" className="h-9" maxLength={500} />
          </label>

          {removeOn && !removalProblem ? (
            <div className="rounded-xl border bg-muted/30 px-4 py-3 text-sm leading-relaxed">
              {removeOn <= today
                ? <>Removal runs <b>as soon as the list is approved</b> (the removal day is today).</>
                : <>Leads in these places carry on as normal (and still count as Quality Leads) through <b>{longDate(addDays(removeOn, -1))}</b>.
                    Removal runs on <b>{longDate(removeOn)}</b> at 12:00 AM Pacific{dayNo ? ` (day ${dayNo} counting the notice day as day 1)` : ""} — only if the list has been approved by then (or as soon as it is, after that day).</>}
              <span className="mt-1 block text-xs text-muted-foreground">The removal day can be changed until the removal starts. Update the Onboarding Form on the removal day, not before — the location check reads it.</span>
            </div>
          ) : (
            <p className="text-xs text-destructive">{removalProblem}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={start} disabled={busy || (!places.length && !pending) || !!removalProblem}>
            {busy && <Loader2 className="animate-spin" />}{pending ? "Add" : `Start the check${places.length ? ` (${places.length} place${places.length === 1 ? "" : "s"})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
