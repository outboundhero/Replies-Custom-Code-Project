"use client";

/**
 * One client, everything in one place: how Reply Router handles its replies
 * (section, CC / BCC, reply template, Bison instance), its campaign setup
 * (group, time zone, email copy), what the sheets say about it (the Client
 * Tracker first), its campaigns in Email Bison, its qualification rules and its
 * onboarding progress. Everything editable here saves through the same
 * endpoints as the rest of the app.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft, Building2, CalendarClock, Check, ChevronDown, Clock3, Copy, ExternalLink, FileText, Globe, Layers, Loader2, Mail, MapPin, Megaphone,
  Phone, RotateCcw, Route, Save, ShieldCheck, Sparkles, Tag, Trash2, UserRound, Users, Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BISON_INSTANCES, DEFAULT_INSTANCE, getInstanceBaseUrl } from "@/lib/bison-instances-shared";
import { CAMPAIGN_TIMEZONES, timezoneLabel } from "@/lib/onboarding/campaign-plan";
import { clientTypeLabel, type ClientTypeKey } from "@/lib/onboarding/copy-model";
import { GROUP_META, fmtDate } from "@/lib/onboarding/ui";
import { Card, Chip, type ChipTone } from "./_ui";
import { ServiceAreaCard } from "./_service-area";
import { HardResetButton } from "./_hard-reset";

type Person = { name: string; email: string };
type Profile = {
  ok: true; tag: string; admin: boolean; exists: boolean; storedTag: string | null;
  section: { id: number; name: string } | null; sections: { id: number; name: string }[];
  config: { cc: Person[]; bcc: Person[]; reply_template: string; updated_at: string | null };
  instance: string | null;
  details: {
    company: string | null; plan: string | null; startDate: string | null; goLive: string | null; notLiveYet: boolean; status: string | null; churnDate: string | null;
    clientType: string | null; website: string | null; location: string | null; contactPerson: string | null; contactEmail: string | null;
    office: string | null; address: string | null; area: string | null; phones: string | null;
    formEmail: string | null; contacts: string[] | null;
  };
  group: { sheet: 1 | 2 | null; app: 1 | 2 | null };
  onboarding: { tag: string; name: string | null; start: string; plan: string | null; group: 1 | 2 | null; timezone: string | null; status: string; done: number; total: number; next: string | null } | null;
  copy: { own: { version: number; mode: "custom" | "shared"; clientType: ClientTypeKey; basedOn: number | null } | null; shared: Record<string, number | null> } | null;
  business: { mrr: string | null; health: string | null; healthNotes: string | null; dealSource: string | null; leadSource: string | null; testimonial: string | null } | null;
  qualification: { inclusion: string | null; exclusion: string | null; hq: string | null } | null;
  readErrors: string[];
};
type Campaign = { id: number; uuid: string | null; name: string; status: string; leads: number | null; sent: number | null };
type CampaignsData = { instances: { key: string; label: string; role: string; current: boolean | null; campaigns: Campaign[]; schedule: { timezone: string; start: string; end: string } | null; error: string | null }[] };

/** A date from the API (YYYY-MM-DD, or a sheet's raw text) for display. */
const showDate = (v: string | null | undefined) => (v ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : v) : null);
const safeDecode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
const isEmail = (v: string) => /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v.trim());
const siteUrl = (v: string | null) => (v ? (/^https?:\/\//i.test(v) ? v : `https://${v}`) : null);
const siteHost = (v: string) => v.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
const NO_GROUP = "none", NO_TZ = "none";

// Campaign statuses, in the order they're listed.
const STATUS_ORDER = ["active", "launching", "running", "paused", "draft", "queued", "completed", "stopped", "archived"];
const statusRank = (s: string) => { const i = STATUS_ORDER.indexOf(s.toLowerCase()); return i === -1 ? STATUS_ORDER.length : i; };
const statusTone = (s: string): ChipTone => (/active|launch|running/i.test(s) ? "green" : /pause/i.test(s) ? "amber" : /draft|queued/i.test(s) ? "sky" : "muted");

async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) { window.location.href = "/login"; return { ok: false }; }
  const j = await r.json().catch(() => ({}));
  return r.ok && j.ok !== false ? { ok: true } : { ok: false, error: j.error || `HTTP ${r.status}` };
}

export default function ClientProfilePage() {
  const params = useParams();
  const tag = safeDecode(String(params.tag || "")).toUpperCase();
  const [p, setP] = useState<Profile | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [camps, setCamps] = useState<CampaignsData | null | "failed">(null);

  // Reads the profile; after a save the page calls it again to show what was stored.
  const fetchProfile = useCallback(async (): Promise<{ p?: Profile; error?: string }> => {
    try {
      const r = await fetch(`/api/clients/${encodeURIComponent(tag)}/profile`, { cache: "no-store" });
      if (r.status === 401) { window.location.href = "/login"; return {}; }
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) return { error: r.status === 403 ? "Only admins and inbox managers can open client pages."
        : r.status === 400 ? `“${tag}” isn't a client tag — tags are letters, numbers and & . _ - (no spaces).`
        : j?.error || `Couldn't load ${tag} (${r.status}). Reload to try again.` };
      return { p: j as Profile };
    } catch (e) { return { error: `Couldn't load ${tag} (${(e as Error).message}). Reload to try again.` }; }
  }, [tag]);
  const load = useCallback(async () => {
    const r = await fetchProfile();
    if (r.p) { setP(r.p); setFailed(null); } else if (r.error) setFailed(r.error);
  }, [fetchProfile]);
  useEffect(() => {
    let live = true;
    fetchProfile().then((r) => { if (!live) return; if (r.p) { setP(r.p); setFailed(null); } else if (r.error) setFailed(r.error); });
    return () => { live = false; };
  }, [fetchProfile]);
  useEffect(() => {
    let live = true;
    fetch(`/api/clients/${encodeURIComponent(tag)}/campaigns`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setCamps(j?.ok ? j : "failed"); })
      .catch(() => { if (live) setCamps("failed"); });
    return () => { live = false; };
  }, [tag]);

  if (failed && !p) {
    return (
      <Page>
        <BackLink />
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center text-sm text-destructive">{failed}</div>
      </Page>
    );
  }
  if (!p) {
    return (
      <Page>
        <BackLink />
        <div className="h-48 animate-pulse rounded-2xl border bg-muted/30" />
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="space-y-6">{[0, 1].map((i) => <div key={i} className="h-80 animate-pulse rounded-2xl border bg-muted/30" />)}</div>
          <div className="space-y-6">{[0, 1].map((i) => <div key={i} className="h-60 animate-pulse rounded-2xl border bg-muted/30" />)}</div>
        </div>
      </Page>
    );
  }

  const d = p.details;
  const company = d.company || p.onboarding?.name || null;
  // Not in Reply Router, onboarding, any sheet or Email Bison — say so instead of showing an
  // empty profile (a tag can have live campaigns without being anywhere else, e.g. LRL).
  const nothingKnown = !p.exists && !p.onboarding && !company && !d.goLive && !p.qualification && !p.group.sheet && !p.group.app;
  if (nothingKnown && camps === null) {
    return (
      <Page>
        <BackLink />
        <div className="flex items-center justify-center gap-2 rounded-2xl border bg-card px-6 py-16 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Looking for {p.tag} in Email Bison…</div>
      </Page>
    );
  }
  if (nothingKnown && (camps === "failed" || !!camps?.instances.every((i) => !i.campaigns.length))) {
    return (
      <Page>
        <BackLink />
        <div className="rounded-2xl border border-dashed bg-card px-6 py-16 text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-2xl border bg-background text-muted-foreground"><Building2 className="size-5" /></div>
          <p className="mt-4 text-base font-semibold">There&apos;s no client called {p.tag}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">It isn&apos;t in Reply Router, in onboarding, on the client sheets or in Email Bison{camps === "failed" ? " (Email Bison couldn't be read just now)" : ""}. Check the tag, or add it from the Clients page.</p>
          <Button asChild variant="outline" className="mt-6"><Link href="/clients">All clients</Link></Button>
        </div>
      </Page>
    );
  }

  const liveTz = camps && camps !== "failed" ? camps.instances.find((i) => i.schedule)?.schedule?.timezone ?? null : null;

  return (
    <Page>
      <BackLink />
      <Hero p={p} company={company} camps={camps} liveTz={liveTz} />

      {p.readErrors.length > 0 && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          Some sheet data couldn&apos;t be read just now ({[...new Set(p.readErrors.map((e) => e.split(":")[0]))].join(", ")}) — those fields may be empty. Reload to try again.
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-6">
          <ReplyRouterCard key={JSON.stringify(p.config)} p={p} onSaved={load} />
          <CampaignsCard data={camps} />
          <QualificationCard q={p.qualification} />
          <ServiceAreaCard tag={p.storedTag ?? p.tag} />
        </div>
        <aside className="min-w-0 space-y-6">
          {p.admin && <CampaignSetupCard p={p} liveTz={liveTz} onSaved={load} />}
          <DetailsCard p={p} company={company} />
          {p.admin && p.exists && <FirstLeadCard tag={p.storedTag ?? p.tag} />}
          {p.admin && p.onboarding && <OnboardingCard p={p} />}
          {p.exists && <RemoveCard p={p} />}
        </aside>
      </div>
    </Page>
  );
}

// ─────────────────────────── layout pieces ───────────────────────────

function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1400px] space-y-6 2xl:max-w-[1600px]">{children}</div>;
}
function BackLink() {
  return <Link href="/clients" className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="size-3.5" /> All clients</Link>;
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 py-2.5 text-sm">
      <div className="pt-px text-xs font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
function Muted({ children }: { children: ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}

// ─────────────────────────── header ───────────────────────────

const AVATAR = [
  "from-sky-600 to-indigo-600", "from-violet-600 to-fuchsia-600", "from-emerald-600 to-teal-600",
  "from-amber-500 to-orange-600", "from-rose-500 to-pink-600", "from-slate-700 to-slate-900",
];
function Hero({ p, company, camps, liveTz }: { p: Profile; company: string | null; camps: CampaignsData | null | "failed"; liveTz: string | null }) {
  const d = p.details;
  const churned = /churn/i.test(d.status ?? "") || !!d.churnDate;
  const notLive = d.notLiveYet && !churned;
  const group = p.onboarding?.group ?? p.group.app ?? p.group.sheet;
  const tz = p.onboarding?.timezone ?? liveTz;
  const name = company || p.tag;
  const initials = (company ? company.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !/^(of|the|and|llc|inc)$/i.test(w)).slice(0, 2).map((w) => w[0]).join("") : p.tag.slice(0, 2)).toUpperCase();
  const hue = AVATAR[[...p.tag].reduce((n, ch) => n + ch.charCodeAt(0), 0) % AVATAR.length];
  const site = siteUrl(d.website);
  const tzSub = p.onboarding?.timezone ? "Set in onboarding" : liveTz ? "From its live campaigns" : camps === null ? "Checking its campaigns…" : "Set when campaigns are built";
  const status = churned ? <Chip tone="red">Churned{d.churnDate ? ` · ${showDate(d.churnDate)}` : ""}</Chip>
    : notLive ? <Chip tone="amber"><CalendarClock className="size-3" /> Goes live {showDate(d.goLive)}</Chip>
    : d.status ? <Chip tone={/active|live/i.test(d.status) ? "green" : "muted"}>{d.status}</Chip> : null;

  return (
    <section className="relative overflow-hidden rounded-2xl border bg-card shadow-xs">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-br from-sky-500/[0.07] via-violet-500/[0.04] to-transparent" />
      <div className="relative flex flex-wrap items-start justify-between gap-5 px-6 pb-6 pt-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className={cn("grid size-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br text-lg font-semibold tracking-wide text-white shadow-sm ring-1 ring-black/5", hue)}>{initials}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-2xl font-semibold tracking-tight">{name}</h2>
              {company && <span className="rounded-md border bg-background px-1.5 py-0.5 font-mono text-xs font-semibold">{p.tag}</span>}
              {status}
              {!p.exists && <Chip tone="amber">Not in Reply Router</Chip>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
              {d.clientType && <span className="inline-flex items-center gap-1.5"><Tag className="size-3.5" />{d.clientType}</span>}
              {d.location && <span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5" />{d.location}</span>}
              {site && <a href={site} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"><Globe className="size-3.5" />{siteHost(d.website!)}</a>}
              {d.contactPerson && <span className="inline-flex items-center gap-1.5"><UserRound className="size-3.5" />{d.contactPerson}</span>}
              {!d.clientType && !d.location && !site && !d.contactPerson && <span>{p.admin ? "Its Reply Router settings, campaign setup, details and onboarding." : "Its Reply Router settings and details."}</span>}
            </div>
          </div>
        </div>
        {p.admin && (p.exists || p.onboarding) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {p.exists && <HardResetButton tag={p.storedTag ?? p.tag} />}
            {p.onboarding && <>
              <Button asChild variant="outline"><Link href={`/onboarding/${encodeURIComponent(p.onboarding.tag)}`}>Checklist</Link></Button>
              <Button asChild className="gap-1.5"><Link href={`/onboarding/${encodeURIComponent(p.onboarding.tag)}/run`}><Sparkles className="h-4 w-4" /> Guided onboarding</Link></Button>
            </>}
          </div>
        )}
      </div>
      <dl className="relative grid grid-cols-2 gap-px border-t bg-border xl:grid-cols-5">
        <Stat icon={<Route className="size-3.5" />} label="Section" value={p.section?.name} sub={p.exists ? "Where its leads go" : "Not in Reply Router"} />
        <Stat icon={<Layers className="size-3.5" />} label="Group" value={group ? GROUP_META[group].label : null} sub={group ? `${GROUP_META[group].b2b} + ${GROUP_META[group].b2c}` : "Not chosen yet"} />
        <Stat icon={<Clock3 className="size-3.5" />} label="Time zone" value={tz ? timezoneLabel(tz) : null} sub={tzSub} />
        <Stat icon={<Wallet className="size-3.5" />} label="Plan" value={d.plan || p.onboarding?.plan} sub={p.business?.mrr ? `${p.business.mrr} a month` : undefined} />
        <Stat icon={<CalendarClock className="size-3.5" />} label={notLive ? "Goes live" : "Go-live"} value={showDate(d.goLive)} className="col-span-2 xl:col-span-1"
          sub={churned ? `Churned${d.churnDate ? ` ${showDate(d.churnDate)}` : ""}` : d.startDate ? `Started ${showDate(d.startDate)}` : undefined} />
      </dl>
    </section>
  );
}
function Stat({ icon, label, value, sub, className }: { icon: ReactNode; label: string; value: string | null | undefined; sub?: string; className?: string }) {
  return (
    <div className={cn("min-w-0 bg-card px-6 py-4", className)}>
      <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{icon}{label}</dt>
      <dd className="mt-1.5 truncate text-[15px] font-semibold" title={value ?? undefined}>{value || <Muted>Not set</Muted>}</dd>
      {sub && <p className="mt-0.5 truncate text-xs text-muted-foreground" title={sub}>{sub}</p>}
    </div>
  );
}

// ─────────────────────────── Reply Router ───────────────────────────

const TEMPLATE_VARS = [
  { label: "First name", value: "{FIRST_NAME}" },
  { label: "Phone", value: "{PHONE}" },
  { label: "Company", value: "{COMPANY}" },
  { label: "Context", value: "{CONTEXT}" },
  { label: "Sender name", value: "{SENDER_NAME}" },
];

function ReplyRouterCard({ p, onSaved }: { p: Profile; onSaved: () => void }) {
  // The save endpoints match the tag exactly as Reply Router stores it.
  const tag = p.storedTag ?? p.tag;
  const saved = useMemo(() => ({ cc: p.config.cc, bcc: p.config.bcc, template: p.config.reply_template }), [p.config]);
  const [form, setForm] = useState(saved);
  const [busy, setBusy] = useState<"save" | "section" | "instance" | "apply" | null>(null);
  const [applyCount, setApplyCount] = useState<number | null>(null);
  const [ask, setAsk] = useState<{ kind: "section" | "instance" | "leave"; value: string; label: string } | null>(null);
  const router = useRouter();
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const bad = [...form.cc, ...form.bcc].some((x) => (x.email && !isEmail(x.email)) || (x.name && !x.email));
  const setPerson = (kind: "cc" | "bcc", i: number, k: keyof Person, v: string) =>
    setForm((f) => ({ ...f, [kind]: f[kind].map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  // Filled CC rows plus one empty one to add the next (at least two, at most six).
  const lastCc = form.cc.reduce((n, x, i) => (x.email || x.name ? i + 1 : n), 0);
  const shownCc = Math.min(6, Math.max(2, lastCc + 1));
  const ccCount = form.cc.filter((x) => x.email).length, bccCount = form.bcc.filter((x) => x.email).length;

  const formBody = () => {
    const body: Record<string, unknown> = { tag, reply_template: form.template };
    form.cc.forEach((x, i) => { body[`cc_name_${i + 1}`] = x.name; body[`cc_email_${i + 1}`] = x.email; });
    form.bcc.forEach((x, i) => { body[`bcc_name_${i + 1}`] = x.name; body[`bcc_email_${i + 1}`] = x.email; });
    return body;
  };
  async function save(note = "Saved — new leads get these from now on.") {
    setBusy("save");
    const r = await post("/api/config/clients/mutate", { action: "update", ...formBody() });
    setBusy(null);
    if (r.ok) { toast.success(note); onSaved(); } else toast.error(r.error || "Couldn't save.");
  }

  // Unsaved edits: warn on reload / close, and ask before following a link in the app.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank") return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      e.preventDefault(); e.stopPropagation();
      setAsk({ kind: "leave", value: url.pathname + url.search, label: "" });
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", onClick, true); };
  }, [dirty]);
  async function previewApply() {
    setBusy("apply");
    const r = await fetch("/api/config/clients/mutate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "force-upsert-template", tag, preview: true }) })
      .then(async (x) => ({ ok: x.ok, j: await x.json().catch(() => ({})) })).catch((e) => ({ ok: false, j: { error: (e as Error).message } }));
    setBusy(null);
    if (!r.ok || r.j.error) { toast.error(r.j.error || "Couldn't count the leads."); return; }
    if (!r.j.count) {
      // Nothing to apply to — still save what's in the form.
      if (dirty) await save(`Saved. ${tag} has no open leads with a positive category, so there was nothing else to update.`);
      else toast.info(`${tag} has no open leads with a positive category to update.`);
      return;
    }
    setApplyCount(r.j.count);
  }
  async function apply() {
    setBusy("apply");
    const r = await fetch("/api/config/clients/mutate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "force-upsert-template", ...formBody() }) })
      .then(async (x) => ({ ok: x.ok, j: await x.json().catch(() => ({})) })).catch((e) => ({ ok: false, j: { error: (e as Error).message } }));
    setBusy(null);
    setApplyCount(null);
    if (!r.ok || r.j.error) { toast.error(r.j.error || "Couldn't apply it."); return; }
    toast.success(`Saved, and applied to ${r.j.updated} open lead${r.j.updated === 1 ? "" : "s"}.`);
    onSaved();
  }
  async function move(sectionId: string) {
    setBusy("section");
    const r = await post("/api/config/clients/mutate", { action: "move", tag, section_id: Number(sectionId) });
    setBusy(null);
    if (r.ok) { toast.success(`Moved to ${p.sections.find((x) => String(x.id) === sectionId)?.name ?? "the new section"} — new leads go there from now on.`); onSaved(); }
    else toast.error(r.error || "Couldn't move it.");
  }
  async function setInstance(key: string) {
    setBusy("instance");
    const r = await post("/api/clients/instance", { client_tag: tag, instance_key: key });
    setBusy(null);
    if (r.ok) { toast.success("Instance saved — new replies are read from it."); onSaved(); } else toast.error(r.error || "Couldn't save the instance.");
  }
  async function confirmAsk() {
    const a = ask;
    if (!a) return;
    if (a.kind === "leave") { setAsk(null); setForm(saved); router.push(a.value); return; }
    if (a.kind === "section") await move(a.value);
    else await setInstance(a.value);
    setAsk(null);
  }
  function insertVar(v: string) {
    const ta = document.getElementById("rr-template") as HTMLTextAreaElement | null;
    const at = ta ? ta.selectionStart : form.template.length, to = ta ? ta.selectionEnd : form.template.length;
    setForm((f) => ({ ...f, template: f.template.slice(0, at) + v + f.template.slice(to) }));
    requestAnimationFrame(() => { if (ta) { ta.focus(); ta.setSelectionRange(at + v.length, at + v.length); } });
  }

  return (
    <Card icon={<Route className="size-4" />} title="Reply Router"
      sub="Where this client's leads go, and who's copied when one is handed over"
      action={p.exists ? (
        <div className="flex items-center gap-1.5">
          <Chip tone={ccCount ? "muted" : "amber"}>{ccCount ? `${ccCount} CC` : "No CC"}{bccCount ? ` · ${bccCount} BCC` : ""}</Chip>
          <Chip tone={saved.template ? "green" : "amber"}>{saved.template ? "Template set" : "No template"}</Chip>
        </div>
      ) : null}
      bodyClassName={p.exists ? "p-0" : undefined}>
      {!p.exists ? (
        <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {p.tag} isn&apos;t in Reply Router yet, so its replies aren&apos;t routed. {p.admin && p.onboarding
            ? <>Run <Link className="font-medium text-foreground underline underline-offset-2" href={`/onboarding/${encodeURIComponent(p.onboarding.tag)}/run`}>Set up in Reply Router</Link> in its onboarding.</>
            : <>Add it on the <Link className="font-medium text-foreground underline underline-offset-2" href="/clients">Clients</Link> page.</>}
        </div>
      ) : (
        <>
          <div className="space-y-6 px-5 py-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="rr-section">Section (Airtable base)</label>
                <Select value={p.section ? String(p.section.id) : undefined} disabled={!!busy}
                  onValueChange={(v) => { if (Number(v) !== p.section?.id) setAsk({ kind: "section", value: v, label: p.sections.find((x) => String(x.id) === v)?.name ?? v }); }}>
                  <SelectTrigger id="rr-section" className="h-9 w-full">{busy === "section" ? <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Moving…</span> : <SelectValue placeholder="Choose a section" />}</SelectTrigger>
                  <SelectContent>{p.sections.map((x) => <SelectItem key={x.id} value={String(x.id)}>{x.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="rr-instance">Email Bison instance for its replies</label>
                <Select value={p.instance ?? DEFAULT_INSTANCE} disabled={!p.admin || !!busy}
                  onValueChange={(v) => { if (v !== (p.instance ?? DEFAULT_INSTANCE)) setAsk({ kind: "instance", value: v, label: BISON_INSTANCES.find((i) => i.key === v)?.label ?? v }); }}>
                  <SelectTrigger id="rr-instance" className="h-9 w-full" title={p.admin ? undefined : "Only admins can change this"}>{busy === "instance" ? <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Saving…</span> : <SelectValue />}</SelectTrigger>
                  <SelectContent>{BISON_INSTANCES.map((i) => <SelectItem key={i.key} value={i.key}>{i.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-5 2xl:grid-cols-2">
              <fieldset className="space-y-2">
                <legend className="mb-2 text-xs font-medium text-muted-foreground">CC — copied when a lead is handed over</legend>
                {form.cc.slice(0, shownCc).map((x, i) => (
                  <PersonRow key={`cc${i}`} label={`CC ${i + 1}`} p={x} onChange={(k, v) => setPerson("cc", i, k, v)} />
                ))}
                {shownCc < 6 && <p className="pl-[3.5rem] text-[11px] text-muted-foreground">Fill the last row to add another (up to 6).</p>}
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-xs font-medium text-muted-foreground">BCC — blind copy</legend>
                {form.bcc.map((x, i) => <PersonRow key={`bcc${i}`} label={`BCC ${i + 1}`} p={x} onChange={(k, v) => setPerson("bcc", i, k, v)} />)}
              </fieldset>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="rr-template">Reply template — “Our Reply” on its positive leads</label>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-0.5 text-[11px] text-muted-foreground">Insert</span>
                  {TEMPLATE_VARS.map((v) => (
                    <button key={v.value} type="button" onClick={() => insertVar(v.value)} title={`Insert ${v.value} at the cursor`}
                      className={cn("rounded-md border bg-background px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-muted", form.template.includes(v.value) && "border-primary/30 bg-primary/5 text-primary")}>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
              <Textarea id="rr-template" value={form.template} onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
                className="min-h-60 rounded-xl bg-muted/20 font-mono text-[12.5px] leading-relaxed" placeholder="Hi {FIRST_NAME}, …" />
              <p className="text-[11px] text-muted-foreground">The variables are replaced with the lead&apos;s details when the lead reaches Airtable.</p>
            </div>
          </div>

          <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-card/95 px-5 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80">
            <span className="mr-auto text-xs text-muted-foreground">
              {bad ? <span className="text-destructive">Fix the highlighted email addresses to save.</span>
                : dirty ? <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400"><span className="size-1.5 rounded-full bg-amber-500" />Unsaved changes</span>
                : p.config.updated_at ? <span className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-emerald-600" />Saved {fmtStamp(p.config.updated_at)}</span> : "Nothing saved yet"}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setForm(saved)} disabled={!dirty || !!busy}><RotateCcw /> Discard</Button>
            <Button size="sm" variant="outline" onClick={previewApply} disabled={!!busy || bad}
              title="Save, and also put this template + CC/BCC on its open leads that already came in with a positive category">
              {busy === "apply" ? <Loader2 className="animate-spin" /> : null} Save & apply to open leads
            </Button>
            <Button size="sm" onClick={() => save()} disabled={!dirty || !!busy || bad}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
          </div>
        </>
      )}

      <Dialog open={!!ask} onOpenChange={(o) => { if (!o && !busy) setAsk(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {ask?.kind === "section" ? `Move ${tag} to ${ask.label}?` : ask?.kind === "instance" ? `Read ${tag}'s replies from ${ask?.label}?` : "Leave without saving?"}
            </DialogTitle>
            <DialogDescription>
              {ask?.kind === "section" ? <>From <b>{p.section?.name}</b> to <b>{ask.label}</b>. Its CC / BCC and reply template move with it. New leads go to the new section&apos;s Airtable base; leads already there stay where they are.</>
                : ask?.kind === "instance" ? <>New replies for {tag} will be read from <b>{ask?.label}</b>. Replies already in the inbox keep the instance they came from.</>
                : <>Your changes to {tag}&apos;s CC / BCC or reply template haven&apos;t been saved.</>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsk(null)} disabled={!!busy}>{ask?.kind === "leave" ? "Stay" : "Cancel"}</Button>
            <Button variant={ask?.kind === "leave" ? "destructive" : "default"} onClick={confirmAsk} disabled={!!busy}>
              {busy && <Loader2 className="animate-spin" />}
              {ask?.kind === "section" ? "Move it" : ask?.kind === "instance" ? "Change instance" : "Leave without saving"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={applyCount != null} onOpenChange={(o) => { if (!o && busy !== "apply") setApplyCount(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply to {applyCount} open lead{applyCount === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>
              Saves these settings, then puts this reply template and CC / BCC on {tag}&apos;s {applyCount} “Open Response” lead{applyCount === 1 ? "" : "s"} with a positive
              category (Interested, Meeting Request, Follow Up, Referral Given, Unrecognizable), replacing what they have now.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApplyCount(null)} disabled={busy === "apply"}>Cancel</Button>
            <Button onClick={apply} disabled={busy === "apply"}>{busy === "apply" && <Loader2 className="animate-spin" />} Save & apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** "2026-10-15 09:41:00" (UTC, from SQLite) → "15 Oct, 3:11 pm" local. */
function fmtStamp(v: string): string {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function PersonRow({ label, p, onChange }: { label: string; p: Person; onChange: (k: keyof Person, v: string) => void }) {
  const badEmail = !!p.email && !isEmail(p.email);
  const noEmail = !!p.name && !p.email;
  return (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)_minmax(0,1.5fr)] items-center gap-2">
      <span className="text-[11px] font-medium tabular-nums text-muted-foreground">{label}</span>
      <Input aria-label={`${label} name`} value={p.name} placeholder="Name" onChange={(e) => onChange("name", e.target.value)} className="h-9 text-sm" />
      <Input aria-label={`${label} email`} value={p.email} placeholder="email@company.com" onChange={(e) => onChange("email", e.target.value)}
        className={cn("h-9 text-sm", (badEmail || noEmail) && "border-destructive/60 focus-visible:ring-destructive/20")}
        title={badEmail ? "This isn't an email address" : noEmail ? "Add the email address" : undefined} />
    </div>
  );
}

// ─────────────────────────── campaign setup ───────────────────────────

function CampaignSetupCard({ p, liveTz, onSaved }: { p: Profile; liveTz: string | null; onSaved: () => void }) {
  const ob = p.onboarding;
  const [busy, setBusy] = useState(false);
  async function set(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    const r = await post("/api/onboarding/mutate", body);
    setBusy(false);
    if (r.ok) { toast.success(ok); onSaved(); } else toast.error(r.error || "Couldn't save.");
  }
  const own = p.copy?.own?.mode === "custom" ? p.copy.own : null;
  const sharedNow = own && p.copy ? p.copy.shared[own.clientType] ?? null : null;
  const moved = !!own && own.basedOn != null && sharedNow != null && sharedNow > own.basedOn;
  const sheetGroup = p.group.sheet ?? p.group.app;
  return (
    <Card icon={<Megaphone className="size-4" />} title="Campaign setup" sub="What its Email Bison campaigns are built with">
      <div className="-my-2.5 divide-y">
        <Row label="Group">
          {ob ? (<>
            <Select value={ob.group ? String(ob.group) : NO_GROUP} disabled={busy}
              onValueChange={(v) => set({ action: "set-client-group", client_tag: ob.tag, group_num: v === NO_GROUP ? null : Number(v) }, "Group saved.")}>
              <SelectTrigger className="h-9 w-full text-sm" aria-label="Group"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>No group yet</SelectItem>
                {([1, 2] as const).map((g) => <SelectItem key={g} value={String(g)}>{GROUP_META[g].label}</SelectItem>)}
              </SelectContent>
            </Select>
            {ob.group && <p className="mt-1.5 text-[11px] text-muted-foreground">{GROUP_META[ob.group].b2b} + {GROUP_META[ob.group].b2c}</p>}
          </>) : sheetGroup ? (
            <div>
              <div className="font-medium">{GROUP_META[sheetGroup].label}</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{GROUP_META[sheetGroup].b2b} + {GROUP_META[sheetGroup].b2c} · from the Groups tab</p>
            </div>
          ) : <Muted>Not on the Groups tab</Muted>}
          {ob && p.group.sheet && ob.group && p.group.sheet !== ob.group && (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">The Groups tab says {GROUP_META[p.group.sheet].label}.</p>
          )}
        </Row>
        <Row label="Time zone">
          {ob ? (
            <Select value={ob.timezone ?? NO_TZ} disabled={busy}
              onValueChange={(v) => set({ action: "set-client-timezone", client_tag: ob.tag, timezone: v === NO_TZ ? null : v }, "Time zone saved.")}>
              <SelectTrigger className="h-9 w-full text-sm" aria-label="Time zone"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TZ}>Not chosen yet</SelectItem>
                {CAMPAIGN_TIMEZONES.map((z) => <SelectItem key={z} value={z}>{timezoneLabel(z)}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : liveTz ? (
            <div>
              <div className="font-medium">{timezoneLabel(liveTz)}</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">From its live campaigns — change it in Email Bison</p>
            </div>
          ) : <Muted>Set when its campaigns are built</Muted>}
        </Row>
        <Row label="Email copy">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {own ? <Chip tone="violet">Own copy · v{own.version}</Chip> : <span className="font-medium">Shared copy for its type</span>}
            <Link href={`/onboarding?copy=${encodeURIComponent(p.tag)}`} className="inline-flex items-center gap-0.5 text-xs font-medium text-primary underline-offset-4 hover:underline">{own ? "Open" : "Give it its own"} →</Link>
          </div>
          {moved && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">The shared {clientTypeLabel(own!.clientType)} copy changed since (v{own!.basedOn} → v{sharedNow}).</p>}
        </Row>
      </div>
    </Card>
  );
}

// ─────────────────────────── the sheets ───────────────────────────

function DetailsCard({ p, company }: { p: Profile; company: string | null }) {
  const d = p.details, b = p.business;
  const site = siteUrl(d.website);
  const contactEmail = d.contactEmail || d.formEmail || d.contacts?.[0] || null;
  const office = d.address || d.office;
  const plan = d.plan || p.onboarding?.plan || null;
  const start = d.startDate || p.onboarding?.start || null;
  const rows: { label: string; node: ReactNode }[] = [];
  if (company) rows.push({ label: "Company", node: <span className="font-medium">{company}</span> });
  if (d.contactPerson || contactEmail) rows.push({
    label: "Contact", node: (
      <div className="min-w-0">
        {d.contactPerson && <div className="font-medium">{d.contactPerson}</div>}
        {contactEmail && <a href={`mailto:${contactEmail}`} className="inline-flex max-w-full items-center gap-1.5 break-all text-muted-foreground hover:text-foreground"><Mail className="size-3.5 shrink-0" />{contactEmail}</a>}
      </div>
    ),
  });
  if (d.phones) rows.push({ label: "Phones", node: <span className="inline-flex items-start gap-1.5"><Phone className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{d.phones}</span> });
  if (office) rows.push({ label: "Office", node: <span className="inline-flex items-start gap-1.5"><MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{office}</span> });
  if (d.location || d.area) rows.push({ label: "Area", node: <span>{d.location || d.area}</span> });
  if (site) rows.push({ label: "Website", node: <a href={site} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 text-primary underline-offset-4 hover:underline"><Globe className="size-3.5 shrink-0" /><span className="truncate">{siteHost(d.website!)}</span><ExternalLink className="size-3 shrink-0" /></a> });
  if (d.clientType) rows.push({ label: "Client type", node: <span>{d.clientType}</span> });
  if (plan) rows.push({ label: "Plan", node: <span>{plan}{b?.mrr ? <Muted> · {b.mrr} a month</Muted> : null}</span> });
  if (start || d.goLive) rows.push({ label: "Dates", node: <span>{start ? `Started ${showDate(start)}` : ""}{start && d.goLive ? " · " : ""}{d.goLive ? `${d.notLiveYet ? "goes" : "went"} live ${showDate(d.goLive)}` : ""}</span> });
  const missing = [!company && "company", !(d.contactPerson || contactEmail) && "contact", !d.phones && "phones", !office && "office", !site && "website", !d.clientType && "client type", !plan && "plan"].filter(Boolean) as string[];

  return (
    <Card icon={<FileText className="size-4" />} title="Client details" sub="From the Client Tracker and the onboarding sheets">
      {rows.length ? <div className="-my-2.5 divide-y">{rows.map((r) => <Row key={r.label} label={r.label}>{r.node}</Row>)}</div>
        : <p className="py-2 text-sm text-muted-foreground">The sheets don&apos;t have anything for {p.tag} yet.</p>}
      {b && (b.health || b.healthNotes || b.dealSource || b.leadSource || b.testimonial) && (
        <div className="mt-4 space-y-2 rounded-xl border bg-muted/30 px-3.5 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            {b.health && <Chip tone={/good/i.test(b.health) ? "green" : /risk|bad|poor/i.test(b.health) ? "red" : "amber"}>{b.health}</Chip>}
            {b.testimonial && <Chip tone={/yes/i.test(b.testimonial) ? "violet" : "muted"}>Testimonial: {b.testimonial}</Chip>}
          </div>
          {b.healthNotes && <p className="text-[13px] leading-relaxed text-foreground/80">{b.healthNotes}</p>}
          {(b.dealSource || b.leadSource) && (
            <p className="text-xs text-muted-foreground">{b.dealSource && <>Deal: {b.dealSource}</>}{b.dealSource && b.leadSource && " · "}{b.leadSource && <>Lead source: {b.leadSource}</>}</p>
          )}
        </div>
      )}
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        {missing.length ? <>Not on the sheets yet: {missing.join(", ")}. </> : null}These come from the sheets — change them there.
      </p>
    </Card>
  );
}

function QualificationCard({ q }: { q: Profile["qualification"] }) {
  const [open, setOpen] = useState(false);
  const long = (q?.inclusion?.length ?? 0) > 420;
  return (
    <Card icon={<ShieldCheck className="size-4" />} title="Qualification rules" sub="Who counts as a lead for this client — from the Onboarding Form, synced every 6 hours">
      {!q ? (
        <p className="py-1 text-sm text-muted-foreground">No rules yet — they appear once the Onboarding Form has this client and the hourly sync has run.</p>
      ) : (
        <div className="-my-2.5 divide-y">
          <Row label="Office">{q.hq ? <span className="inline-flex items-start gap-1.5"><MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{q.hq}</span> : <Muted>Not set</Muted>}</Row>
          <Row label="Service area">
            <p className={cn("whitespace-pre-wrap break-words leading-relaxed", !open && long && "line-clamp-5")}>{q.inclusion || <Muted>Not set</Muted>}</p>
            {long && <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-xs font-medium text-primary hover:underline">{open ? "Show less" : "Show all"}</button>}
          </Row>
          <Row label="Excluded"><p className="whitespace-pre-wrap break-words">{q.exclusion || <Muted>Nothing</Muted>}</p></Row>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────── Email Bison ───────────────────────────

function CampaignsCard({ data }: { data: CampaignsData | null | "failed" }) {
  const [showArchived, setShowArchived] = useState(false);
  const all = data && data !== "failed" ? data.instances.flatMap((i) => i.campaigns) : [];
  const counts = all.reduce<Record<string, number>>((m, c) => { const k = c.status.toLowerCase(); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const archived = counts.archived ?? 0;
  const summary = Object.entries(counts).filter(([k]) => k !== "archived").sort((a, b) => statusRank(a[0]) - statusRank(b[0]));
  const leads = all.filter((c) => c.status.toLowerCase() !== "archived").reduce((n, c) => n + (c.leads ?? 0), 0);
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast.success(`Copied ${what}`); }
    catch { toast.error("Couldn't copy — select it instead."); }
  };

  return (
    <Card icon={<Mail className="size-4" />} title="Campaigns in Email Bison"
      sub={data && data !== "failed" && all.length ? `${all.length - archived} current${archived ? ` · ${archived} archived` : ""} · ${leads.toLocaleString()} leads in current campaigns · click an ID to copy it` : "Read live from Email Bison"}
      action={summary.length ? <div className="flex flex-wrap items-center gap-1.5">{summary.map(([k, n]) => <Chip key={k} tone={statusTone(k)}>{n} {k}</Chip>)}</div> : null}>
      {data === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading Email Bison…</div>
      ) : data === "failed" ? (
        <p className="py-2 text-sm text-destructive">Couldn&apos;t read Email Bison just now — reload to try again.</p>
      ) : data.instances.every((i) => !i.campaigns.length && !i.error) ? (
        <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No campaigns yet — they&apos;re created in onboarding (Create the 12 campaigns).</div>
      ) : (
        <div className="space-y-5">
          {data.instances.filter((i) => i.campaigns.length || i.error).map((inst) => {
            const rows = inst.campaigns.filter((c) => showArchived || c.status.toLowerCase() !== "archived")
              .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));
            const base = getInstanceBaseUrl(inst.key);
            return (
              <div key={inst.key}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{inst.role}</span>
                    <span className="text-sm text-muted-foreground">{inst.label}</span>
                    {inst.current === true ? <Chip tone="green">Current group</Chip> : inst.current === false ? <Chip tone="muted">Not its group now</Chip> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {inst.schedule && <span className="text-xs text-muted-foreground">Sends Mon–Fri {inst.schedule.start}–{inst.schedule.end} · {timezoneLabel(inst.schedule.timezone)}</span>}
                    {rows.length > 0 && (
                      <button type="button" onClick={() => void copy(rows.map((c) => `${c.name}\t${c.id}`).join("\n"), `${inst.role} campaign IDs`)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"><Copy className="size-3.5" />Copy all IDs</button>
                    )}
                  </div>
                </div>
                {inst.error ? <p className="text-xs text-destructive">Couldn&apos;t read it: {inst.error}</p> : (
                  <div className="overflow-hidden rounded-xl border">
                    {rows.length ? (
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b bg-muted/30 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            <th className="px-3.5 py-1.5 font-medium">Campaign</th>
                            <th className="w-32 px-3 py-1.5 font-medium">ID</th>
                            <th className="w-24 px-3 py-1.5 text-right font-medium">Status</th>
                            <th className="w-32 px-3.5 py-1.5 text-right font-medium">Leads</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {rows.map((c) => (
                            <tr key={c.id} className={cn("transition-colors hover:bg-muted/30", c.status.toLowerCase() === "archived" && "text-muted-foreground")}>
                              <td className="px-3.5 py-2 font-medium">{c.name}</td>
                              <td className="px-3 py-2">
                                <span className="inline-flex items-center gap-1.5">
                                  <button type="button" onClick={() => void copy(String(c.id), `ID ${c.id}`)} title="Copy the ID"
                                    className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 font-mono text-xs tabular-nums transition-colors hover:border-primary/40 hover:text-primary">
                                    {c.id}<Copy className="size-3 opacity-60" />
                                  </button>
                                  <a href={c.uuid ? `${base}/campaigns/${c.uuid}` : `${base}/campaigns/${c.id}/leads`} target="_blank" rel="noreferrer"
                                    title="Open in Email Bison" className="text-muted-foreground transition-colors hover:text-primary"><ExternalLink className="size-3.5" /></a>
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right"><Chip tone={statusTone(c.status)}>{c.status}</Chip></td>
                              <td className="px-3.5 py-2 text-right tabular-nums text-muted-foreground">{c.leads != null ? `${c.leads.toLocaleString()} leads` : ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : <p className="px-3.5 py-3 text-xs text-muted-foreground">Only archived campaigns here.</p>}
                  </div>
                )}
              </div>
            );
          })}
          {archived > 0 && (
            <button type="button" onClick={() => setShowArchived((v) => !v)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              <ChevronDown className={cn("size-3.5 transition-transform", showArchived && "rotate-180")} />{showArchived ? "Hide archived campaigns" : `Show ${archived} archived campaign${archived === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────── first lead email ───────────────────────────

type FirstLead = {
  status: string; reason: string | null; lead_email: string | null; first_name: string | null; sheet_url: string | null;
  to: string[]; bcc: string[]; sent_at: string | null; sent_by: string | null; attempts: number; detected_at: string; updated_at: string;
} | null;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");

/** "Important: First Set of Leads - Instructions" — sent from madison@ when the client's first lead reaches its sheet. */
function FirstLeadCard({ tag }: { tag: string }) {
  const [d, setD] = useState<{ record: FirstLead; hadLeads: boolean | null; switchedOn: boolean; testRecipients: string[] } | null>(null);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<"test" | "send" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => {
    fetch(`/api/first-lead-email?tag=${encodeURIComponent(tag)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j.ok) { setD(j); setTestTo((t) => t || j.testRecipients[0] || ""); } })
      .catch(() => {});
  }, [tag]);
  useEffect(() => { load(); }, [load]);

  async function sendTest() {
    setBusy("test");
    const r = await fetch("/api/first-lead-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test", tag, to: testTo }) });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (j.ok) toast.success(`Test sent to ${testTo}. The real one goes to ${j.to?.length ? j.to.join(", ") : "nobody yet — no CC contacts"}.`);
    else toast.error(j.error || "The test didn't send.");
  }
  async function sendNow() {
    setBusy("send");
    const r = await post("/api/first-lead-email", { action: "send", tag });
    setBusy(null); setConfirm(false);
    if (r.ok) toast.success(`Sent to ${tag}.`); else toast.error(r.error || "It didn't send.");
    load();
  }

  const rec = d?.record ?? null;
  const st = rec?.status ?? (d?.hadLeads ? "existing" : "waiting");
  const head: Record<string, { tone: ChipTone; label: string }> = {
    waiting: { tone: "muted", label: "Waiting for the first lead" },
    checking: { tone: "sky", label: "Checking…" },
    existing: { tone: "muted", label: "Not needed — already had leads" },
    dry: { tone: "amber", label: "Would have sent — sending is off" },
    sending: { tone: "sky", label: "Sending…" },
    sent: { tone: "green", label: `Sent ${when(rec?.sent_at ?? null)}` },
    failed: { tone: "red", label: `Didn't send — retrying (${rec?.attempts ?? 0} of 3 tries)` },
    unsure: { tone: "amber", label: "Unclear whether it went out" },
    skipped: { tone: "amber", label: "Not sent" },
  };
  const h = head[st] ?? head.waiting;
  const canSendNow = !!d?.switchedOn && ["dry", "skipped", "failed", "unsure"].includes(st);

  return (
    <Card icon={<Mail className="size-4" />} title="First lead email" sub="Sent from madison@ the moment the first lead reaches its sheet">
      {!d ? <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading…</div> : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Chip tone={h.tone}>{h.label}</Chip></div>
          {st === "waiting" && <p className="text-xs text-muted-foreground">“Important: First Set of Leads - Instructions” goes to the client automatically when their first lead is pushed to their lead tracking sheet.</p>}
          {st === "existing" && !rec && <p className="text-xs text-muted-foreground">{tag} already has leads in its sheet, so it never gets this email — it&apos;s only for a client&apos;s very first lead.</p>}
          {rec?.lead_email && <Row label="First lead">{rec.lead_email}</Row>}
          {rec && rec.to.length > 0 && <Row label={st === "sent" ? "Sent to" : "Goes to"}><span className="break-words">{rec.to.join(", ")}</span>{rec.bcc.length > 0 && <div className="text-xs text-muted-foreground">BCC {rec.bcc.join(", ")}</div>}</Row>}
          {st === "sent" && rec?.sent_by && rec.sent_by !== "auto" && <Row label="Sent by">{rec.sent_by === "retry" ? "Automatic retry" : rec.sent_by}</Row>}
          {rec?.reason && <p className={cn("rounded-lg px-3 py-2 text-xs", st === "failed" ? "bg-destructive/5 text-destructive" : "bg-muted/60 text-muted-foreground")}>{rec.reason}</p>}
          {!d.switchedOn && st !== "existing" && st !== "sent" && <p className="text-xs text-muted-foreground">Sending to clients is switched off until <span className="font-mono">FIRST_LEAD_EMAIL_SEND=1</span> is set in Vercel. Tests still work.</p>}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Select value={testTo} onValueChange={setTestTo}>
              <SelectTrigger className="h-8 w-auto min-w-0 text-xs" aria-label="Test address"><SelectValue /></SelectTrigger>
              <SelectContent>{d.testRecipients.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={!testTo || !!busy} onClick={sendTest}>{busy === "test" ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}Send me a test</Button>
            {canSendNow && <Button size="sm" className="ml-auto h-8 text-xs" disabled={!!busy} onClick={() => setConfirm(true)}>Send now</Button>}
          </div>
        </div>
      )}
      <Dialog open={confirm} onOpenChange={(o) => { if (!busy) setConfirm(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send the first lead email to {tag}?</DialogTitle>
            <DialogDescription>
              “Important: First Set of Leads - Instructions” goes from madison@outboundhero.co to {tag}&apos;s CC contacts{rec?.to.length ? ` (${rec.to.join(", ")})` : ""}{rec?.bcc.length ? `, BCC ${rec.bcc.join(", ")}` : ""}. It can only be sent once.
              {st === "unsure" ? " Check Madison's Sent folder first — it may already have gone out." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={!!busy}>Cancel</Button>
            <Button onClick={sendNow} disabled={!!busy}>{busy === "send" && <Loader2 className="animate-spin" />}Send it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─────────────────────────── onboarding + remove ───────────────────────────

function OnboardingCard({ p }: { p: Profile }) {
  const ob = p.onboarding!;
  const pct = ob.total ? Math.round((ob.done / ob.total) * 100) : 0;
  return (
    <Card icon={<Users className="size-4" />} title="Onboarding" sub={`Started ${fmtDate(ob.start)}`}>
      <div className="space-y-3">
        <div>
          <div className="flex items-baseline justify-between text-sm"><span className="font-medium">{ob.done} of {ob.total} tasks done</span><span className="tabular-nums text-muted-foreground">{pct}%</span></div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
        </div>
        {ob.next ? <p className="text-sm"><span className="text-muted-foreground">Next:</span> {ob.next}</p> : <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"><Check className="size-4" /> All done</p>}
      </div>
    </Card>
  );
}

function RemoveCard({ p }: { p: Profile }) {
  const tag = p.storedTag ?? p.tag;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    const r = await post("/api/config/clients/mutate", { action: "delete", tag });
    setBusy(false);
    if (r.ok) { setOpen(false); toast.success(`${tag} removed from Reply Router.`); router.push("/clients"); } else toast.error(r.error || "Couldn't remove it.");
  }
  return (
    <section className="rounded-2xl border border-dashed px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Stop routing its replies</div>
          <p className="mt-0.5 text-xs text-muted-foreground">Removes {tag} and its CC / BCC and template from Reply Router.</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:bg-destructive/5 hover:text-destructive" onClick={() => setOpen(true)}>
          <Trash2 className="size-3.5" />Remove from Reply Router
        </Button>
      </div>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {tag} from Reply Router?</DialogTitle>
            <DialogDescription>Its replies stop being routed, and its CC / BCC and reply template are deleted. Its campaigns, onboarding and email copy aren&apos;t touched.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" onClick={remove} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
