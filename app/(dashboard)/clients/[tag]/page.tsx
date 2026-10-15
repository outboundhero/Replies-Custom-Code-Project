"use client";

/**
 * One client, everything in one place: how Reply Router handles its replies
 * (section, CC / BCC, reply template, Bison instance), its campaign setup
 * (group, time zone, email copy), what the sheets say about it, its campaigns
 * in Email Bison, its qualification rules and its onboarding progress.
 * Everything editable here saves through the same endpoints as before.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft, Building2, CalendarDays, Check, ExternalLink, FileText, Globe, Loader2, Mail, MapPin, Megaphone,
  Phone, RotateCcw, Route, Save, ShieldCheck, Sparkles, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BISON_INSTANCES, DEFAULT_INSTANCE } from "@/lib/bison-instances-shared";
import { CAMPAIGN_TIMEZONES, timezoneLabel } from "@/lib/onboarding/campaign-plan";
import { clientTypeLabel, type ClientTypeKey } from "@/lib/onboarding/copy-model";
import { GROUP_META, fmtDate } from "@/lib/onboarding/ui";

type Person = { name: string; email: string };
type Profile = {
  ok: true; tag: string; admin: boolean; exists: boolean; storedTag: string | null;
  section: { id: number; name: string } | null; sections: { id: number; name: string }[];
  config: { cc: Person[]; bcc: Person[]; reply_template: string; updated_at: string | null };
  instance: string | null;
  details: {
    company: string | null; plan: string | null; startDate: string | null; goLive: string | null; notLiveYet: boolean; status: string | null; churnDate: string | null;
    clientType: string | null; website: string | null; office: string | null; address: string | null; area: string | null; phones: string | null;
    formEmail: string | null; contacts: string[] | null;
  };
  group: { sheet: 1 | 2 | null; app: 1 | 2 | null };
  onboarding: { tag: string; name: string | null; start: string; plan: string | null; group: 1 | 2 | null; timezone: string | null; status: string; done: number; total: number; next: string | null } | null;
  copy: { own: { version: number; mode: "custom" | "shared"; clientType: ClientTypeKey; basedOn: number | null } | null; shared: Record<string, number | null> } | null;
  qualification: { inclusion: string | null; exclusion: string | null; hq: string | null } | null;
  readErrors: string[];
};
type CampaignsData = { instances: { key: string; label: string; campaigns: { id: number; name: string; status: string; leads: number | null; sent: number | null }[]; schedule: { timezone: string; start: string; end: string } | null; error: string | null }[] };

/** "10/23/2026" (the sheets) → "Oct 23", like the app's other dates; anything else as it is. */
const sheetDate = (v: string | null | undefined) => {
  const m = v?.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!m) return v || null;
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  return fmtDate(`${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
};
const safeDecode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
const isEmail = (v: string) => /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v.trim());
const NO_GROUP = "none", NO_TZ = "none";

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
      <div className="mx-auto w-full max-w-7xl space-y-4">
        <BackLink />
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-6 text-center text-sm text-destructive">{failed}</div>
      </div>
    );
  }
  if (!p) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <BackLink />
        <div className="h-36 animate-pulse rounded-2xl border bg-muted/30" />
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">{[0, 1].map((i) => <div key={i} className="h-72 animate-pulse rounded-2xl border bg-muted/30" />)}</div>
          <div className="space-y-5">{[0, 1].map((i) => <div key={i} className="h-56 animate-pulse rounded-2xl border bg-muted/30" />)}</div>
        </div>
      </div>
    );
  }

  const d = p.details;
  const company = d.company || p.onboarding?.name || null;
  const group = p.onboarding?.group ?? p.group.app ?? p.group.sheet;
  // Not in Reply Router, onboarding, any sheet or Email Bison — say so instead of showing an
  // empty profile (a tag can have live campaigns without being anywhere else, e.g. LRL).
  const nothingKnown = !p.exists && !p.onboarding && !company && !d.goLive && !p.qualification && !p.group.sheet && !p.group.app;
  if (nothingKnown && camps === null) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <BackLink />
        <div className="flex items-center justify-center gap-2 rounded-2xl border bg-card px-6 py-14 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Looking for {p.tag} in Email Bison…</div>
      </div>
    );
  }
  if (nothingKnown && (camps === "failed" || !!camps?.instances.every((i) => !i.campaigns.length))) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-4">
        <BackLink />
        <div className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center">
          <div className="mx-auto grid size-11 place-items-center rounded-xl border bg-background text-muted-foreground"><Building2 className="size-5" /></div>
          <p className="mt-3 text-sm font-medium">There&apos;s no client called {p.tag}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">It isn&apos;t in Reply Router, in onboarding, on the client sheets or in Email Bison{camps === "failed" ? " (Email Bison couldn't be read just now)" : ""}. Check the tag, or add it from the Clients page.</p>
          <Button asChild variant="outline" className="mt-5"><Link href="/clients">All clients</Link></Button>
        </div>
      </div>
    );
  }
  const churned = /churn/i.test(d.status ?? "");
  const notLive = d.notLiveYet && !churned;
  const liveTz = camps && camps !== "failed" ? camps.instances.find((i) => i.schedule)?.schedule?.timezone ?? null : null;
  const timezone = p.onboarding?.timezone ?? liveTz;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      <BackLink />

      {/* Header */}
      <div className="rounded-2xl border bg-card px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Building2 className="size-5" /></div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border bg-background px-2 py-0.5 font-mono text-sm font-bold">{p.tag}</span>
                <h2 className="truncate text-xl font-semibold tracking-tight">{company || "—"}</h2>
                {churned ? <Chip tone="red">Churned{d.churnDate ? ` · ${d.churnDate}` : ""}</Chip>
                  : notLive ? <Chip tone="amber">Goes live {sheetDate(d.goLive)}</Chip>
                  : d.status ? <Chip tone={/active|live/i.test(d.status) ? "green" : "muted"}>{d.status}</Chip> : null}
                {!p.exists && <Chip tone="amber">Not set up in Reply Router</Chip>}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{p.admin ? "Everything about this client in one place — its Reply Router settings, campaign setup, details and onboarding." : "This client's Reply Router settings and details."}</p>
            </div>
          </div>
          {p.admin && p.onboarding && (
            <div className="flex shrink-0 items-center gap-2">
              <Button asChild variant="outline"><Link href={`/onboarding/${encodeURIComponent(p.onboarding.tag)}`}>Checklist</Link></Button>
              <Button asChild className="gap-1.5"><Link href={`/onboarding/${encodeURIComponent(p.onboarding.tag)}/run`}><Sparkles className="h-4 w-4" /> Guided onboarding</Link></Button>
            </div>
          )}
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 text-sm sm:grid-cols-5">
          <Fact label="Section" value={p.section?.name ?? "—"} warn={!p.section} />
          <Fact label="Group" value={group ? `${GROUP_META[group].label}` : "—"} warn={!group} />
          <Fact label="Time zone" value={timezone ? timezoneLabel(timezone) : "—"} />
          <Fact label="Plan" value={d.plan || p.onboarding?.plan || "—"} />
          <Fact label="Go-live" value={sheetDate(d.goLive) || "—"} />
        </dl>
      </div>

      {p.readErrors.length > 0 && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          Some sheet data couldn&apos;t be read just now ({[...new Set(p.readErrors.map((e) => e.split(":")[0]))].join(", ")}) — those fields may be empty. Reload to try again.
        </div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <ReplyRouterCard key={JSON.stringify(p.config)} p={p} onSaved={load} />
          <CampaignsCard data={camps} />
          <QualificationCard q={p.qualification} />
        </div>
        <div className="space-y-5">
          {p.admin && <CampaignSetupCard p={p} liveTz={liveTz} onSaved={load} />}
          <DetailsCard d={{ ...p.details, company, plan: d.plan || p.onboarding?.plan || null, startDate: d.startDate || p.onboarding?.start || null }} />
          {p.admin && <OnboardingCard p={p} />}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── small pieces ───────────────────────────

function BackLink() {
  return <Link href="/clients" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" /> All clients</Link>;
}
function Chip({ tone, children }: { tone: "green" | "amber" | "red" | "muted" | "violet"; children: ReactNode }) {
  const cls = {
    green: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    amber: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    red: "bg-destructive/10 text-destructive",
    muted: "bg-muted text-muted-foreground",
    violet: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  }[tone];
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cls)}>{children}</span>;
}
function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 truncate", warn && "text-amber-700 dark:text-amber-400")} title={value}>{value}</dd>
    </div>
  );
}
function Card({ icon, title, sub, action, children, className }: { icon: ReactNode; title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-2xl border bg-card", className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border bg-background text-muted-foreground">{icon}</div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{title}</h3>
            {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
          </div>
        </div>
        {action}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-start gap-3 py-1.5 text-sm">
      <div className="pt-0.5 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
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
  const [busy, setBusy] = useState<"save" | "section" | "instance" | "apply" | "remove" | null>(null);
  const [applyCount, setApplyCount] = useState<number | null>(null);
  const [ask, setAsk] = useState<{ kind: "section" | "instance" | "remove" | "leave"; value: string; label: string } | null>(null);
  const router = useRouter();
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const bad = [...form.cc, ...form.bcc].some((x) => (x.email && !isEmail(x.email)) || (x.name && !x.email));
  const setPerson = (kind: "cc" | "bcc", i: number, k: keyof Person, v: string) =>
    setForm((f) => ({ ...f, [kind]: f[kind].map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  // Filled CC rows plus one empty one to add the next (at least two, at most six).
  const lastCc = form.cc.reduce((n, x, i) => (x.email || x.name ? i + 1 : n), 0);
  const shownCc = Math.min(6, Math.max(2, lastCc + 1));

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
  async function remove() {
    setBusy("remove");
    const r = await post("/api/config/clients/mutate", { action: "delete", tag });
    setBusy(null);
    if (r.ok) { toast.success(`${tag} removed from Reply Router.`); router.push("/clients"); } else toast.error(r.error || "Couldn't remove it.");
  }
  async function confirmAsk() {
    const a = ask;
    if (!a) return;
    if (a.kind === "leave") { setAsk(null); setForm(saved); router.push(a.value); return; }
    if (a.kind === "section") await move(a.value);
    else if (a.kind === "instance") await setInstance(a.value);
    else await remove();
    setAsk(null);
  }
  function insertVar(v: string) {
    const ta = document.getElementById("rr-template") as HTMLTextAreaElement | null;
    const at = ta ? ta.selectionStart : form.template.length, to = ta ? ta.selectionEnd : form.template.length;
    setForm((f) => ({ ...f, template: f.template.slice(0, at) + v + f.template.slice(to) }));
    requestAnimationFrame(() => { if (ta) { ta.focus(); ta.setSelectionRange(at + v.length, at + v.length); } });
  }

  return (
    <Card icon={<Route className="size-3.5" />} title="Reply Router"
      sub="Where this client's leads go, and who's copied when one is handed over"
      action={p.exists ? (
        <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-destructive" disabled={!!busy}
          onClick={() => setAsk({ kind: "remove", value: "", label: "" })}>Remove from Reply Router</Button>
      ) : null}>
      {!p.exists ? (
        <div className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {p.tag} isn&apos;t in Reply Router yet, so its replies aren&apos;t routed. {p.admin && p.onboarding
            ? <>Run <Link className="font-medium text-foreground underline underline-offset-2" href={`/onboarding/${encodeURIComponent(p.onboarding.tag)}/run`}>Set up in Reply Router</Link> in its onboarding.</>
            : <>Add it on the <Link className="font-medium text-foreground underline underline-offset-2" href="/clients">Clients</Link> page.</>}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
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

          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">CC — copied when a lead is handed over</div>
              {form.cc.slice(0, shownCc).map((x, i) => (
                <PersonRow key={`cc${i}`} label={`CC ${i + 1}`} p={x} onChange={(k, v) => setPerson("cc", i, k, v)} />
              ))}
              {shownCc < 6 && <p className="pl-[4rem] text-[11px] text-muted-foreground">Fill the last row to add another (up to 6).</p>}
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">BCC — blind copy</div>
              {form.bcc.map((x, i) => <PersonRow key={`bcc${i}`} label={`BCC ${i + 1}`} p={x} onChange={(k, v) => setPerson("bcc", i, k, v)} />)}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="rr-template">Reply template — “Our Reply” on its positive leads</label>
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-muted-foreground">Insert:</span>
                {TEMPLATE_VARS.map((v) => (
                  <button key={v.value} type="button" onClick={() => insertVar(v.value)} title={`Insert ${v.value} at the cursor`}
                    className={cn("rounded-md border px-1.5 py-0.5 text-[11px] transition-colors hover:bg-muted", form.template.includes(v.value) && "border-primary/40 bg-primary/5 text-primary")}>
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <Textarea id="rr-template" value={form.template} onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
              className="min-h-56 font-mono text-[12.5px] leading-relaxed" placeholder="Hi {FIRST_NAME}, …" />
            <p className="text-[11px] text-muted-foreground">The variables are replaced with the lead&apos;s details when the lead reaches Airtable.</p>
          </div>

          <div className="-mx-5 -mb-4 flex flex-wrap items-center gap-2 border-t bg-muted/30 px-5 py-3">
            <span className="mr-auto text-xs text-muted-foreground">
              {bad ? <span className="text-destructive">Fix the highlighted email addresses to save.</span>
                : dirty ? <span className="font-medium text-amber-700 dark:text-amber-400">Unsaved changes</span>
                : p.config.updated_at ? `Saved ${fmtStamp(p.config.updated_at)}` : "Nothing saved yet"}
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
        </div>
      )}

      <Dialog open={!!ask} onOpenChange={(o) => { if (!o && !busy) setAsk(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {ask?.kind === "section" ? `Move ${tag} to ${ask.label}?` : ask?.kind === "instance" ? `Read ${tag}'s replies from ${ask?.label}?`
                : ask?.kind === "leave" ? "Leave without saving?" : `Remove ${tag} from Reply Router?`}
            </DialogTitle>
            <DialogDescription>
              {ask?.kind === "section" ? <>From <b>{p.section?.name}</b> to <b>{ask.label}</b>. Its CC / BCC and reply template move with it. New leads go to the new section&apos;s Airtable base; leads already there stay where they are.</>
                : ask?.kind === "instance" ? <>New replies for {tag} will be read from <b>{ask?.label}</b>. Replies already in the inbox keep the instance they came from.</>
                : ask?.kind === "leave" ? <>Your changes to {tag}&apos;s CC / BCC or reply template haven&apos;t been saved.</>
                : <>Its replies stop being routed, and its CC / BCC and reply template are deleted. Its campaigns, onboarding and email copy aren&apos;t touched.</>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsk(null)} disabled={!!busy}>{ask?.kind === "leave" ? "Stay" : "Cancel"}</Button>
            <Button variant={ask?.kind === "remove" || ask?.kind === "leave" ? "destructive" : "default"} onClick={confirmAsk} disabled={!!busy}>
              {busy && <Loader2 className="animate-spin" />}
              {ask?.kind === "section" ? "Move it" : ask?.kind === "instance" ? "Change instance" : ask?.kind === "leave" ? "Leave without saving" : "Remove"}
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
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1.6fr)] items-center gap-2">
      <span className="text-[11px] tabular-nums text-muted-foreground">{label}</span>
      <Input aria-label={`${label} name`} value={p.name} placeholder="Name" onChange={(e) => onChange("name", e.target.value)} className="h-8 text-sm" />
      <Input aria-label={`${label} email`} value={p.email} placeholder="email@company.com" onChange={(e) => onChange("email", e.target.value)}
        className={cn("h-8 text-sm", (badEmail || noEmail) && "border-destructive/60 focus-visible:ring-destructive/20")}
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
  return (
    <Card icon={<Megaphone className="size-3.5" />} title="Campaign setup" sub="What its Email Bison campaigns are built with">
      <div className="divide-y">
        <Row label="Group">
          {ob ? (<>
            <Select value={ob.group ? String(ob.group) : NO_GROUP} disabled={busy}
              onValueChange={(v) => set({ action: "set-client-group", client_tag: ob.tag, group_num: v === NO_GROUP ? null : Number(v) }, "Group saved.")}>
              <SelectTrigger className="h-8 w-full text-xs" aria-label="Group"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>No group yet</SelectItem>
                {([1, 2] as const).map((g) => <SelectItem key={g} value={String(g)}>{GROUP_META[g].label}</SelectItem>)}
              </SelectContent>
            </Select>
            {ob.group && <p className="mt-1 text-[11px] text-muted-foreground">{GROUP_META[ob.group].b2b} + {GROUP_META[ob.group].b2c}</p>}
          </>) : (
            <span>{p.group.sheet ? `${GROUP_META[p.group.sheet].label} (Groups tab)` : p.group.app ? GROUP_META[p.group.app].label : "—"}</span>
          )}
          {ob && p.group.sheet && ob.group && p.group.sheet !== ob.group && (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">The Groups tab says {GROUP_META[p.group.sheet].label}.</p>
          )}
        </Row>
        <Row label="Time zone">
          {ob ? (
            <Select value={ob.timezone ?? NO_TZ} disabled={busy}
              onValueChange={(v) => set({ action: "set-client-timezone", client_tag: ob.tag, timezone: v === NO_TZ ? null : v }, "Time zone saved.")}>
              <SelectTrigger className="h-8 w-full text-xs" aria-label="Time zone"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TZ}>Not chosen yet</SelectItem>
                {CAMPAIGN_TIMEZONES.map((z) => <SelectItem key={z} value={z}>{timezoneLabel(z)}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <span>{liveTz ? <>{timezoneLabel(liveTz)} <span className="text-muted-foreground">· from its live campaigns</span></> : <span className="text-muted-foreground">Set when its campaigns are built (onboarding)</span>}</span>
          )}
        </Row>
        <Row label="Email copy">
          <div className="flex flex-wrap items-center gap-2">
            {own ? <Chip tone="violet">Own copy · v{own.version}</Chip> : <span>Shared copy for its type</span>}
            <Link href={`/onboarding?copy=${encodeURIComponent(p.tag)}`} className="text-xs font-medium text-primary underline-offset-4 hover:underline">{own ? "Open" : "Give it its own"} →</Link>
          </div>
          {moved && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">The shared {clientTypeLabel(own!.clientType)} copy changed since (v{own!.basedOn} → v{sharedNow}).</p>}
        </Row>
      </div>
    </Card>
  );
}

// ─────────────────────────── the sheets ───────────────────────────

function DetailsCard({ d }: { d: Profile["details"] }) {
  const site = d.website ? (/^https?:\/\//i.test(d.website) ? d.website : `https://${d.website}`) : null;
  return (
    <Card icon={<FileText className="size-3.5" />} title="Client details" sub="From the Client Tracker, New Client Information and the Onboarding Form">
      <div className="divide-y">
        <Row label="Company"><span>{d.company || "—"}</span></Row>
        <Row label="Client type"><span>{d.clientType || <span className="text-amber-700 dark:text-amber-400">Not filled in on the form</span>}</span></Row>
        <Row label="Plan"><span>{d.plan || "—"}</span></Row>
        <Row label="Dates"><span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3.5 text-muted-foreground" />Starts {d.startDate ? fmtDate(d.startDate) : "—"} · goes live {sheetDate(d.goLive) || "—"}</span></Row>
        <Row label="Website">{site ? <a href={site} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-primary underline-offset-4 hover:underline"><Globe className="size-3.5 shrink-0" />{d.website}<ExternalLink className="size-3 shrink-0" /></a> : <span>—</span>}</Row>
        <Row label="Office"><span className="inline-flex items-start gap-1.5"><MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{d.address || d.office || "—"}</span></Row>
        {d.area && <Row label="Area"><span>{d.area}</span></Row>}
        <Row label="Phones"><span className="inline-flex items-start gap-1.5"><Phone className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{d.phones || "—"}</span></Row>
        <Row label="Contact"><span className="inline-flex items-start gap-1.5 break-all"><Mail className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{d.formEmail || d.contacts?.join(", ") || "—"}</span></Row>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">These come from the sheets — change them there.</p>
    </Card>
  );
}

function QualificationCard({ q }: { q: Profile["qualification"] }) {
  const [open, setOpen] = useState(false);
  const long = (q?.inclusion?.length ?? 0) > 420;
  return (
    <Card icon={<ShieldCheck className="size-3.5" />} title="Qualification rules" sub="Who counts as a lead for this client — from the Onboarding Form, synced every hour">
      {!q ? (
        <p className="text-sm text-muted-foreground">No rules yet — they appear once the Onboarding Form has this client and the hourly sync has run.</p>
      ) : (
        <div className="divide-y">
          <Row label="Office (anchor)"><span>{q.hq || "—"}</span></Row>
          <Row label="Service area">
            <p className={cn("whitespace-pre-wrap break-words", !open && long && "line-clamp-6")}>{q.inclusion || "—"}</p>
            {long && <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-xs font-medium text-primary hover:underline">{open ? "Show less" : "Show all"}</button>}
          </Row>
          <Row label="Excluded"><p className="whitespace-pre-wrap break-words">{q.exclusion || "—"}</p></Row>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────── Email Bison ───────────────────────────

function CampaignsCard({ data }: { data: CampaignsData | null | "failed" }) {
  return (
    <Card icon={<Mail className="size-3.5" />} title="Campaigns in Email Bison" sub="Read live from Email Bison">
      {data === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading Email Bison…</div>
      ) : data === "failed" ? (
        <p className="py-2 text-sm text-destructive">Couldn&apos;t read Email Bison just now — reload to try again.</p>
      ) : data.instances.every((i) => !i.campaigns.length && !i.error) ? (
        <p className="py-2 text-sm text-muted-foreground">No campaigns yet — they&apos;re created in onboarding (Create the 12 campaigns).</p>
      ) : (
        <div className="space-y-4">
          {data.instances.filter((i) => i.campaigns.length || i.error).map((inst) => (
            <div key={inst.key}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-xs font-semibold">{inst.label}</div>
                {inst.schedule && <div className="text-[11px] text-muted-foreground">Sends Mon–Fri {inst.schedule.start}–{inst.schedule.end} · {timezoneLabel(inst.schedule.timezone)}</div>}
              </div>
              {inst.error ? <p className="text-xs text-destructive">Couldn&apos;t read it: {inst.error}</p> : (
                <div className="overflow-hidden rounded-lg border">
                  <table className="w-full text-xs">
                    <tbody className="divide-y">
                      {inst.campaigns.map((c) => (
                        <tr key={c.id}>
                          <td className="px-3 py-1.5 font-medium">{c.name}</td>
                          <td className="px-3 py-1.5 text-right"><Chip tone={/active|launch|running/i.test(c.status) ? "green" : /pause/i.test(c.status) ? "amber" : "muted"}>{c.status}</Chip></td>
                          <td className="w-28 px-3 py-1.5 text-right tabular-nums text-muted-foreground">{c.leads != null ? `${c.leads.toLocaleString()} leads` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────── onboarding ───────────────────────────

function OnboardingCard({ p }: { p: Profile }) {
  const ob = p.onboarding;
  const pct = ob && ob.total ? Math.round((ob.done / ob.total) * 100) : 0;
  return (
    <Card icon={<Users className="size-3.5" />} title="Onboarding" sub={ob ? `Started ${fmtDate(ob.start)}` : undefined}>
      {!ob ? (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>Not in onboarding.</p>
          <Button asChild size="sm" variant="outline"><Link href="/onboarding">Onboarding</Link></Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="flex items-baseline justify-between text-sm"><span className="font-medium">{ob.done} of {ob.total} tasks done</span><span className="tabular-nums text-muted-foreground">{pct}%</span></div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
          </div>
          {ob.next ? <p className="text-sm"><span className="text-muted-foreground">Next:</span> {ob.next}</p> : <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"><Check className="size-4" /> All done</p>}
        </div>
      )}
    </Card>
  );
}
