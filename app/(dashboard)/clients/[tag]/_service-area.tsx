"use client";

/**
 * Client page → "Service area changes": the client's removals (newest first),
 * the last edit of the Onboarding Form's service-area text, and "Remove places"
 * — enter the cities / states / ZIPs taken out and the date notice came in;
 * the check starts at once (read-only) and nothing is removed until someone
 * approves the review. Removal runs on the 6th day.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, CalendarClock, ChevronDown, History, Loader2, MapPinOff, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtDate } from "@/lib/onboarding/ui";
import { pacificToday, parsePlaces, removalDate, type Place, type PlaceType } from "@/lib/service-area-changes/places";
import { Card, Chip, type ChipTone } from "./_ui";

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

export function ServiceAreaCard({ tag }: { tag: string }) {
  const [data, setData] = useState<{ today: string; changes: (ChangeSummary & { counts: ChangeCounts })[]; textChange: { changedAt: string; before: string; after: string } | null } | null | "failed">(null);
  const [open, setOpen] = useState(false);
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/clients/${encodeURIComponent(tag)}/service-area`, { cache: "no-store" })
      .then(async (r) => { const j = await r.json().catch(() => null); if (live) setData(r.ok && j?.ok ? j : "failed"); })
      .catch(() => { if (live) setData("failed"); });
    return () => { live = false; };
  }, [tag]);

  const changes = data && data !== "failed" ? data.changes : [];
  const openChange = changes.find((c) => !["done", "partial", "cancelled"].includes(c.status));

  return (
    <Card icon={<MapPinOff className="size-4" />} title="Service area changes"
      sub="Places the client stopped serving — their leads leave every campaign and the queue on day 6, once approved"
      action={openChange
        ? <Button asChild size="sm" variant="outline" className="gap-1.5"><Link href={`/clients/${encodeURIComponent(tag)}/service-area/${openChange.id}`}>Open change #{openChange.id}<ArrowRight className="size-3.5" /></Link></Button>
        : <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)} disabled={data === null}><Plus className="size-3.5" />Remove places</Button>}>
      {data === null ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : data === "failed" ? (
        <p className="py-2 text-sm text-destructive">Couldn&apos;t load the service-area changes — reload to try again.</p>
      ) : (
        <div className="space-y-4">
          {data.textChange && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-amber-900 dark:text-amber-200"><History className="size-4 shrink-0" />
                  The Onboarding Form&apos;s service area changed on {new Date(data.textChange.changedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. If places were taken out, record them here.</span>
                <button type="button" onClick={() => setShowText((v) => !v)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  <ChevronDown className={cn("size-3.5 transition-transform", showText && "rotate-180")} />{showText ? "Hide" : "Before / after"}
                </button>
              </div>
              {showText && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {(["before", "after"] as const).map((k) => (
                    <div key={k} className="min-w-0 rounded-lg border bg-background px-3 py-2">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{k === "before" ? "Before" : "Now"}</div>
                      <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{data.textChange![k]}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {changes.length === 0 ? (
            <div className="rounded-xl border border-dashed px-5 py-6">
              <p className="text-sm font-medium">No service-area changes yet</p>
              <ol className="mt-3 grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
                {[
                  ["Enter the places", "Cities, states or ZIPs the client stopped serving, and the day you got the notice."],
                  ["Review the leads", "Leads in those places come pre-ticked. Untick any to keep; check the unclear ones."],
                  ["Removed on day 6", "Once approved, they leave every campaign and the nurture queue, and can't be re-added."],
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
      {open && data && data !== "failed" && <NewChangeDialog tag={tag} today={data.today} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function NewChangeDialog({ tag, today, onClose }: { tag: string; today: string; onClose: () => void }) {
  const router = useRouter();
  const [kind, setKind] = useState<PlaceType>("city");
  const [text, setText] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState(today || pacificToday());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  function add() {
    const r = parsePlaces(kind, text);
    setErrors(r.errors);
    if (r.places.length) {
      setPlaces((cur) => { const seen = new Set(cur.map((p) => p.key)); return [...cur, ...r.places.filter((p) => !seen.has(p.key))]; });
      if (!r.errors.length) setText("");
    }
  }
  const removeOn = useMemo(() => (/^\d{4}-\d{2}-\d{2}$/.test(notice) ? removalDate(notice) : null), [notice]);
  const pending = text.trim().length > 0;

  async function start() {
    if (pending) { add(); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/clients/${encodeURIComponent(tag)}/service-area`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: (["city", "state", "zip"] as PlaceType[]).map((t) => ({ type: t, text: places.filter((p) => p.type === t).map((p) => p.label).join("\n") })).filter((e) => e.text), noticeDate: notice, note }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { toast.error(j.error || `Couldn't start it (${r.status}).`); setBusy(false); return; }
      toast.success("Recorded — checking the leads now.");
      router.push(`/clients/${encodeURIComponent(tag)}/service-area/${j.id}`);
    } catch (e) { toast.error((e as Error).message); setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Remove places from {tag}&apos;s service area</DialogTitle>
          <DialogDescription>Leads in these places are found in every campaign and the nurture queue. Nothing is removed until someone approves the list.</DialogDescription>
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
              <span className="text-xs font-medium text-muted-foreground">Note <span className="font-normal">(optional)</span></span>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Email from Dave, Oct 21" className="h-9" maxLength={500} />
            </label>
          </div>

          {removeOn && (
            <div className="rounded-xl border bg-muted/30 px-4 py-3 text-sm leading-relaxed">
              Leads in these places carry on as normal (and still count as Quality Leads) through <b>{longDate(addDays(removeOn, -1))}</b>.
              Removal runs on <b>{longDate(removeOn)}</b> at 12:00 AM Pacific — only if the list has been approved by then (or as soon as it is, after that day).
              <span className="mt-1 block text-xs text-muted-foreground">Update the Onboarding Form on the removal day, not before — the location check reads it.</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={start} disabled={busy || (!places.length && !pending) || !removeOn}>
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
