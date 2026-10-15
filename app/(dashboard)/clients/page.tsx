"use client";

/**
 * All clients in Reply Router, by section. Each row opens the client's page
 * (/clients/[tag]) — the one place to see and change everything about it.
 */
import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Plus, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEFAULT_INSTANCE, getInstanceLabel } from "@/lib/bison-instances-shared";
import { normClientTag } from "@/lib/onboarding/copy-model";

interface Client {
  id: number;
  tag: string;
  section_id: number;
  section_name: string;
  airtable_base_id: string;
  cc_email_1: string | null; cc_email_2: string | null; cc_email_3: string | null;
  cc_email_4: string | null; cc_email_5: string | null; cc_email_6: string | null;
  bcc_email_1: string | null; bcc_email_2: string | null;
  reply_template: string | null;
  /** null = no mapping row yet → the default instance. */
  bison_instance: string | null;
  churned?: boolean;
  churnDate?: string | null;
  group?: number | null;
}

interface Section {
  id: number;
  name: string;
  airtable_base_id: string;
}

const ccCount = (c: Client) => [c.cc_email_1, c.cc_email_2, c.cc_email_3, c.cc_email_4, c.cc_email_5, c.cc_email_6].filter(Boolean).length;
const bccCount = (c: Client) => [c.bcc_email_1, c.bcc_email_2].filter(Boolean).length;

export default function ClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[] | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [newSectionId, setNewSectionId] = useState("");
  const [adding, setAdding] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Record<string, string>>({});

  const loadClients = useCallback(async () => {
    try {
      const res = await fetch("/api/config/clients");
      if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
      if (res.ok) { setClients(await res.json()); setFetchError(null); }
      else setFetchError(`Couldn't load the clients (${res.status}). Reload to try again.`);
    } catch (err) {
      setFetchError(`Couldn't load the clients (${(err as Error).message}). Reload to try again.`);
    }
  }, []);

  const loadSections = useCallback(async () => {
    try {
      const res = await fetch("/api/config/sections");
      if (res.ok) setSections(await res.json());
    } catch { /* sections load is secondary */ }
  }, []);

  useEffect(() => {
    loadClients();
    loadSections();
  }, [loadClients, loadSections]);
  // Company names from the Client Tracker (a sheet read — after the list, best effort).
  useEffect(() => {
    let live = true;
    fetch("/api/clients/companies").then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && j?.companies) setCompanies(j.companies); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const tagTaken = !!newTag.trim() && !!clients?.some((c) => c.tag.toUpperCase() === newTag.trim().toUpperCase());
  const tagBad = !!newTag.trim() && !normClientTag(newTag);

  async function addClient() {
    const tag = newTag.trim();
    if (!tag || !newSectionId || tagTaken || tagBad) return;
    setAdding(true);
    try {
      const res = await fetch("/api/config/clients/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", tag, section_id: Number(newSectionId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        toast.error(`Couldn't add ${tag}: ${data.error || res.statusText}`);
        return;
      }
      toast.success(`${tag} added — set its CC and reply template next.`);
      setAddOpen(false);
      setNewTag("");
      setNewSectionId("");
      router.push(`/clients/${encodeURIComponent(tag)}`);
    } catch (err) {
      toast.error(`Couldn't add ${tag}: ${(err as Error).message}`);
    } finally {
      setAdding(false);
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => (clients ?? []).filter((c) =>
    !q || c.tag.toLowerCase().includes(q) || c.section_name.toLowerCase().includes(q) || (companies[c.tag.toUpperCase()] ?? "").toLowerCase().includes(q),
  ), [clients, q, companies]);
  const bySection = useMemo(() => {
    const m = new Map<string, Client[]>();
    for (const c of filtered) m.set(c.section_name, [...(m.get(c.section_name) ?? []), c]);
    return [...m.entries()];
  }, [filtered]);
  const all = clients ?? [];
  const live = all.filter((c) => !c.churned);
  const stats = [
    { label: "Clients", value: live.length, hint: all.length - live.length ? `${all.length - live.length} churned` : undefined },
    { label: "Sections", value: new Set(all.map((c) => c.section_id)).size },
    { label: "No reply template", value: live.filter((c) => !c.reply_template).length, warn: true },
    { label: "No CC", value: live.filter((c) => !ccCount(c)).length, warn: true },
  ];

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 2xl:max-w-[1600px]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Clients</h2>
          <p className="text-sm text-muted-foreground">Every client in Reply Router. Open one to see and change everything about it — section, CC / BCC, reply template, group, time zone and more.</p>
        </div>
        <Button onClick={() => setAddOpen(true)} className="gap-1.5"><Plus className="size-4" /> Add to Reply Router</Button>
      </div>

      {fetchError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{fetchError}</div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border bg-card px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{s.label}</div>
            <div className={cn("mt-0.5 text-2xl font-semibold tabular-nums", s.warn && s.value > 0 && "text-amber-700 dark:text-amber-400")}>
              {clients ? s.value : <span className="inline-block h-7 w-10 animate-pulse rounded bg-muted align-middle" />}
            </div>
            {s.hint && <div className="text-[11px] text-muted-foreground">{s.hint}</div>}
          </div>
        ))}
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search by tag, company or section…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
      </div>

      {!clients && !fetchError ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-56 animate-pulse rounded-2xl border bg-muted/30" />)}
        </div>
      ) : clients && filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed px-6 py-14 text-center">
          <div className="mx-auto grid size-11 place-items-center rounded-xl border bg-background text-muted-foreground"><Users className="size-5" /></div>
          <p className="mt-3 text-sm font-medium">{q ? `No client matches “${search.trim()}”` : "No clients yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">{q ? "Try the tag (e.g. JPSCAL) or a section name." : "Add one to start routing its replies."}</p>
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {bySection.map(([sectionName, rows]) => (
            <section key={sectionName} className="overflow-hidden rounded-2xl border bg-card">
              <header className="flex items-center gap-2 border-b px-4 py-3">
                <h3 className="text-sm font-semibold">{sectionName}</h3>
                <span className="font-mono text-[11px] text-muted-foreground">{rows[0].airtable_base_id}</span>
                <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{rows.length} client{rows.length === 1 ? "" : "s"}</span>
              </header>
              <ul className="divide-y">
                {rows.map((c) => {
                  const cc = ccCount(c), bcc = bccCount(c);
                  return (
                    <li key={c.tag}>
                      <Link href={`/clients/${encodeURIComponent(c.tag)}`}
                        className="group flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none">
                        <span className="w-48 min-w-0 shrink-0">
                          <span className={cn("block truncate font-mono text-[13px] font-semibold", c.churned && "text-muted-foreground line-through decoration-muted-foreground/50")}>{c.tag}</span>
                          {companies[c.tag.toUpperCase()] && <span className="block truncate text-xs text-muted-foreground" title={companies[c.tag.toUpperCase()]}>{companies[c.tag.toUpperCase()]}</span>}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                          {c.churned ? <Pill tone="red">Churned{c.churnDate ? ` ${c.churnDate}` : ""}</Pill> : (
                            <>
                              {c.reply_template ? <Pill tone="green">Template</Pill> : <Pill tone="amber">No template</Pill>}
                              {cc ? <Pill>CC {cc}</Pill> : <Pill tone="amber">No CC</Pill>}
                              {bcc > 0 && <Pill>BCC {bcc}</Pill>}
                              {c.group ? <Pill>Group {c.group}</Pill> : null}
                            </>
                          )}
                        </div>
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{getInstanceLabel(c.bison_instance ?? DEFAULT_INSTANCE)}</span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={(o) => { if (!adding) setAddOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a client to Reply Router</DialogTitle>
            <DialogDescription>
              Its replies start routing to the section&apos;s Airtable base. For a new client, the guided onboarding does this for you (Set up in Reply Router).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="add-tag">Client tag</Label>
              <Input id="add-tag" placeholder="e.g. ACME" value={newTag} onChange={(e) => setNewTag(e.target.value.toUpperCase())}
                className={cn((tagTaken || tagBad) && "border-destructive/60")} />
              <p className={cn("text-xs", tagTaken || tagBad ? "text-destructive" : "text-muted-foreground")}>
                {tagBad ? "Letters, numbers and & . _ - only — no spaces, up to 32 characters."
                  : tagTaken ? `${newTag.trim()} is already in Reply Router.`
                  : "The prefix before the colon in its campaign names."}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-section">Section</Label>
              <Select value={newSectionId} onValueChange={setNewSectionId}>
                <SelectTrigger id="add-section" className="w-full"><SelectValue placeholder="Choose a section" /></SelectTrigger>
                <SelectContent>
                  {sections.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name} — {s.airtable_base_id}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={adding}>Cancel</Button>
            <Button onClick={addClient} disabled={!newTag.trim() || !newSectionId || tagTaken || tagBad || adding}>
              {adding && <Loader2 className="animate-spin" />} Add client
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Pill({ tone, children }: { tone?: "green" | "amber" | "red"; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
      tone === "green" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : tone === "amber" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : tone === "red" ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground")}>
      {children}
    </span>
  );
}
