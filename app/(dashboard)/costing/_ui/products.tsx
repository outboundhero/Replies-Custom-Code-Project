"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, CircleDashed, History, KeyRound, Link2, Loader2, Pause, Pencil, Play, Plug, Plus, RefreshCw, Trash2, XCircle,
} from "lucide-react";
import type { ProductCard } from "@/lib/costing/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { money, ago, dateLabel } from "./format";
import { Chip } from "./parts";

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

function Health({ p, now }: { p: ProductCard; now: number }) {
  if (p.health === "manual") return <Chip tone="violet">Added by hand</Chip>;
  if (p.health === "paused") return <Chip><Pause className="size-3" />Paused</Chip>;
  if (p.health === "error") return <Chip tone="red"><XCircle className="size-3" />Last pull failed</Chip>;
  if (p.health === "never") return <Chip tone="amber"><CircleDashed className="size-3" />Not pulled yet</Chip>;
  return <Chip tone="green"><CheckCircle2 className="size-3" />Updated {ago(p.last_ok_at, now)}</Chip>;
}

export function ProductGrid({ products, currency, refreshing, now, onRefresh, onChanged, onAddManual, onConnect }: {
  products: ProductCard[]; currency: string | null; refreshing: string | null; now: number;
  onRefresh: (pid: string) => void; onChanged: () => void; onAddManual: () => void; onConnect: () => void;
}) {
  const [edit, setEdit] = useState<ProductCard | null>(null);
  const [history, setHistory] = useState<ProductCard | null>(null);
  const [remove, setRemove] = useState<ProductCard | null>(null);
  const feeds = products.filter((p) => p.kind === "feed");
  const manual = products.find((p) => p.kind === "manual");

  async function toggle(p: ProductCard) {
    const r = await post("/api/costing/products", { action: p.enabled ? "pause" : "resume", pid: p.pid });
    if (r.ok) { toast.success(p.enabled ? `${p.name} paused — it won't be pulled until resumed.` : `${p.name} resumed.`); onChanged(); }
    else toast.error(String(r.error ?? "Couldn't change it."));
  }

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {feeds.map((p) => (
          <article key={p.pid} className={cn("flex min-w-0 flex-col rounded-2xl border bg-card shadow-xs transition-shadow hover:shadow-sm", p.health === "error" && "border-destructive/30")}>
            <div className="flex items-start justify-between gap-3 px-5 pt-4">
              <div className="min-w-0">
                <h4 className="truncate text-[15px] font-semibold">{p.name}</h4>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{p.slug ?? "id set on first pull"}{p.environment && p.environment !== "production" ? ` · ${p.environment}` : ""}</p>
              </div>
              <Health p={p} now={now} />
            </div>
            <div className="px-5 pt-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">This range</div>
              <div className="mt-0.5 text-xl font-semibold tabular-nums">{currency ? money(p.range_units, currency) : <span className="text-base font-medium text-muted-foreground">Nothing yet</span>}</div>
              <div className="text-xs text-muted-foreground">{p.range_items} item{p.range_items === 1 ? "" : "s"}{p.stored_items ? ` · ${p.stored_items.toLocaleString()} stored, ${dateLabel(p.first_date!, true)} – ${dateLabel(p.last_date!, true)}` : ""}</div>
            </div>
            {p.health === "error" && p.last_error && (
              <p className="mx-5 mt-3 line-clamp-3 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive" title={p.last_error}>{p.last_error}</p>
            )}
            {p.notes && <p className="mx-5 mt-3 line-clamp-2 text-xs text-muted-foreground" title={p.notes}>{p.notes}</p>}
            <dl className="mt-auto grid gap-1 px-5 pb-1 pt-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 truncate"><Link2 className="size-3 shrink-0" /><span className="truncate" title={`${p.base_url}/api/costing`}>{p.base_url?.replace(/^https?:\/\//, "")}/api/costing</span></div>
              <div className="flex items-center gap-1.5"><KeyRound className="size-3 shrink-0" />Key {p.key_hint ?? "not set"}</div>
            </dl>
            <div className="mt-3 flex items-center justify-between gap-2 border-t px-3 py-2">
              <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" disabled={!p.enabled || !!refreshing} onClick={() => onRefresh(p.pid)}>
                {refreshing === p.pid || refreshing === "all" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Refresh
              </Button>
              <div className="flex items-center gap-0.5">
                <Button size="icon" variant="ghost" className="size-8" title="Changes and pulls" aria-label={`History for ${p.name}`} onClick={() => setHistory(p)}><History className="size-3.5" /></Button>
                <Button size="icon" variant="ghost" className="size-8" title="Edit URL or key" aria-label={`Edit ${p.name}`} onClick={() => setEdit(p)}><Pencil className="size-3.5" /></Button>
                <Button size="icon" variant="ghost" className="size-8" title={p.enabled ? "Pause pulling" : "Resume pulling"} aria-label={p.enabled ? `Pause ${p.name}` : `Resume ${p.name}`} onClick={() => toggle(p)}>{p.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}</Button>
                {p.stored_items === 0 && <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" title="Remove (it has no stored figures)" aria-label={`Remove ${p.name}`} onClick={() => setRemove(p)}><Trash2 className="size-3.5" /></Button>}
              </div>
            </div>
          </article>
        ))}

        <button type="button" onClick={onConnect}
          className="group flex min-h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-card/50 px-5 py-6 text-center transition-colors hover:border-primary/40 hover:bg-primary/[0.03]">
          <span className="grid size-10 place-items-center rounded-xl border bg-background text-muted-foreground shadow-xs transition-colors group-hover:text-primary"><Plug className="size-4" /></span>
          <span className="text-sm font-semibold">Connect a product</span>
          <span className="max-w-60 text-xs text-muted-foreground">Its base URL and costing key — Reply Router pulls its <span className="font-mono">/api/costing</span> feed every day.</span>
        </button>

        {manual && (
          <article className="flex min-w-0 flex-col rounded-2xl border bg-card shadow-xs">
            <div className="flex items-start justify-between gap-3 px-5 pt-4">
              <div className="min-w-0">
                <h4 className="text-[15px] font-semibold">Added by hand</h4>
                <p className="mt-0.5 text-xs text-muted-foreground">Tools no product reports — a license, domains, a one-off bill.</p>
              </div>
              <Health p={manual} now={now} />
            </div>
            <div className="px-5 pt-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">This range</div>
              <div className="mt-0.5 text-xl font-semibold tabular-nums">{currency ? money(manual.range_units, currency) : <span className="text-base font-medium text-muted-foreground">Nothing yet</span>}</div>
              <div className="text-xs text-muted-foreground">{manual.range_items} item{manual.range_items === 1 ? "" : "s"}{manual.stored_items ? ` · ${manual.stored_items} in total` : ""}</div>
            </div>
            <div className="mt-auto flex items-center border-t px-3 py-2">
              <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" onClick={onAddManual}><Plus className="size-3.5" />Add a cost</Button>
              <Button size="sm" variant="ghost" className="ml-auto h-8 gap-1.5 text-xs" onClick={() => setHistory(manual)}><History className="size-3.5" />History</Button>
            </div>
          </article>
        )}
      </div>

      {edit && <EditProductDialog p={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
      {history && <HistoryDialog p={history} onClose={() => setHistory(null)} />}
      <Dialog open={!!remove} onOpenChange={(o) => !o && setRemove(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {remove?.name}?</DialogTitle>
            <DialogDescription>It has no stored figures, so nothing is lost. You can connect it again any time.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemove(null)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => {
              const r = await post("/api/costing/products", { action: "delete", pid: remove!.pid });
              if (r.ok) { toast.success(`${remove!.name} removed.`); setRemove(null); onChanged(); } else toast.error(String(r.error ?? "Couldn't remove it."));
            }}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Connect / edit ───────────────────────────────────────────────────────────

type TestResult = { ok: true; slug: string; name: string; items: number; from: string; to: string } | { ok: false; error: string };

function TestBox({ t }: { t: TestResult }) {
  return t.ok ? (
    <div className="flex items-start gap-2.5 rounded-xl border border-emerald-600/20 bg-emerald-500/[0.06] px-3.5 py-3 text-sm">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
      <div>
        <div className="font-medium">The feed works — {t.name} <span className="font-mono text-xs text-muted-foreground">({t.slug})</span></div>
        <div className="mt-0.5 text-xs text-muted-foreground">{t.items} line item{t.items === 1 ? "" : "s"} for {dateLabel(t.from, true)} – {dateLabel(t.to, true)}, all checks passed.</div>
      </div>
    </div>
  ) : (
    <div className="flex items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/[0.04] px-3.5 py-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 break-words text-xs text-destructive">{t.error}</div>
    </div>
  );
}

export function ConnectDialog({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"test" | "add" | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const reset = () => { setName(""); setUrl(""); setKey(""); setTest(null); setBusy(null); };

  async function runTest() {
    setBusy("test"); setTest(null);
    const r = await post("/api/costing/products", { action: "test", baseUrl: url, apiKey: key });
    setBusy(null);
    setTest(r.ok ? (r as unknown as TestResult) : { ok: false, error: String(r.error ?? "The test failed.") });
  }
  async function connect() {
    setBusy("add");
    const r = await post("/api/costing/products", { action: "add", name, baseUrl: url, apiKey: key });
    setBusy(null);
    if (!r.ok) { toast.error(String(r.error ?? "Couldn't connect it.")); return; }
    const pull = r.pull as { ok?: boolean; added?: number; error?: string } | undefined;
    if (pull?.ok) toast.success(`Connected — ${pull.added ?? 0} line item${pull.added === 1 ? "" : "s"} stored.`);
    else toast.warning(`Connected, but the first pull failed: ${pull?.error ?? "unknown error"}. It'll retry daily.`);
    reset(); onConnected();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect a product</DialogTitle>
          <DialogDescription>Reply Router calls <span className="font-mono">{(url || "https://…").replace(/\/+$/, "")}/api/costing</span> every day with this key, checks every figure, and stores it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="cp-url">Base URL</Label>
            <Input id="cp-url" value={url} onChange={(e) => { setUrl(e.target.value); setTest(null); }} placeholder="https://leadsync.example.com" autoComplete="off" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cp-key">Costing key</Label>
            <Input id="cp-key" type="password" value={key} onChange={(e) => { setKey(e.target.value); setTest(null); }} placeholder="The product's COSTING_API_KEY" autoComplete="new-password" />
            <p className="text-xs text-muted-foreground">Stored encrypted. Only its last four characters are ever shown again.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cp-name">Name <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Taken from its feed once it's pulled" />
          </div>
          {test && <TestBox t={test} />}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={runTest} disabled={!url.trim() || !key.trim() || !!busy}>
            {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}Test connection
          </Button>
          <Button onClick={connect} disabled={!url.trim() || !key.trim() || !!busy} variant={test && !test.ok ? "secondary" : "default"}>
            {busy === "add" && <Loader2 className="size-4 animate-spin" />}{test && !test.ok ? "Connect anyway" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProductDialog({ p, onClose, onSaved }: { p: ProductCard; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(p.name);
  const [url, setUrl] = useState(p.base_url ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {p.name}</DialogTitle>
          <DialogDescription>Its product id <span className="font-mono">{p.slug ?? "(not pulled yet)"}</span> stays the same.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5"><Label htmlFor="ep-name">Name</Label><Input id="ep-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="ep-url">Base URL</Label><Input id="ep-url" value={url} onChange={(e) => { setUrl(e.target.value); setTest(null); }} /></div>
          <div className="grid gap-1.5">
            <Label htmlFor="ep-key">New costing key</Label>
            <Input id="ep-key" type="password" value={key} onChange={(e) => { setKey(e.target.value); setTest(null); }} placeholder={`Leave blank to keep ${p.key_hint ?? "the current key"}`} autoComplete="new-password" />
          </div>
          {test && <TestBox t={test} />}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" disabled={!url.trim() || !!busy} onClick={async () => {
            setBusy("test"); setTest(null);
            const r = await post("/api/costing/products", { action: "test", pid: p.pid, baseUrl: url, apiKey: key });
            setBusy(null);
            setTest(r.ok ? (r as unknown as TestResult) : { ok: false, error: String(r.error ?? "The test failed.") });
          }}>{busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}Test</Button>
          <Button disabled={!url.trim() || !name.trim() || !!busy} onClick={async () => {
            setBusy("save");
            const r = await post("/api/costing/products", { action: "update", pid: p.pid, name, baseUrl: url, apiKey: key || undefined });
            setBusy(null);
            if (r.ok) { toast.success("Saved."); onSaved(); } else toast.error(String(r.error ?? "Couldn't save."));
          }}>{busy === "save" && <Loader2 className="size-4 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── History ─────────────────────────────────────────────────────────────────

type Change = { pid: string; item_id: string; at: string; kind: string; before: Record<string, string> | null; after: Record<string, string> | null };
type Pull = { started_at: string; ok: number; range_from: string; range_to: string; added: number; changed: number; removed: number; unchanged: number; error: string | null; trigger: string };

function HistoryDialog({ p, onClose }: { p: ProductCard; onClose: () => void }) {
  const [data, setData] = useState<{ changes: Change[]; pulls: Pull[] } | null>(null);
  const [tab, setTab] = useState<"changes" | "pulls">("changes");
  useEffect(() => {
    let live = true;
    fetch(`/api/costing/history?pid=${encodeURIComponent(p.pid)}`).then((r) => r.json()).then((j) => { if (live) setData(j); }).catch(() => { if (live) setData({ changes: [], pulls: [] }); });
    return () => { live = false; };
  }, [p.pid]);
  const when = (iso: string) => `${dateLabel(iso.slice(0, 10), true)}, ${iso.slice(11, 16)} UTC`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{p.name} — history</DialogTitle>
          <DialogDescription>Every figure a re-pull changed or removed, kept permanently, and each pull&apos;s result.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 border-b">
          {(["changes", "pulls"] as const).filter((t) => t === "changes" || p.kind === "feed").map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors", tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t === "changes" ? `Changes${data ? ` (${data.changes.length})` : ""}` : `Pulls${data ? ` (${data.pulls.length})` : ""}`}
            </button>
          ))}
        </div>
        <div className="-mx-6 max-h-[55vh] overflow-y-auto px-6">
          {!data ? <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            : tab === "changes" ? (
              data.changes.length ? (
                <ul className="divide-y text-sm">
                  {data.changes.map((c, i) => (
                    <li key={i} className="py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip tone={c.kind === "removed" ? "red" : c.kind === "added" ? "green" : "sky"}>{c.kind === "removed" ? "No longer reported" : c.kind === "added" ? "Added" : "Changed"}</Chip>
                        <span className="truncate font-mono text-xs">{c.item_id}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{when(c.at)}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {c.kind === "changed" && c.before && c.after ? Object.keys(c.after).filter((k) => c.before![k] !== c.after![k] || k === "amount").map((k) => (
                          k === "extra"
                            ? <span key={k} className="mr-3 inline-block">Usage or split details changed</span>
                            : <span key={k} className="mr-3 inline-block">{k.replace(/_/g, " ")}: <span className="font-mono">{String(c.before![k] ?? "—")}</span> → <span className="font-mono text-foreground">{String(c.after![k] ?? "—")}</span></span>
                        )) : c.before ? <span>was <span className="font-mono">{c.before.amount} {c.before.currency}</span> ({c.before.status}) on {c.before.date}</span> : c.after ? <span><span className="font-mono">{c.after.amount} {c.after.currency}</span> on {c.after.date}</span> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="py-10 text-center text-sm text-muted-foreground">No figure has changed since it was first stored.</p>
            ) : data.pulls.length ? (
              <ul className="divide-y text-sm">
                {data.pulls.map((x, i) => (
                  <li key={i} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                    {x.ok ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 text-destructive" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-muted-foreground">{when(x.started_at)} · {dateLabel(x.range_from, true)} – {dateLabel(x.range_to, true)} · {x.trigger.startsWith("refresh:") ? `Refresh by ${x.trigger.slice(8)}` : x.trigger === "cron" ? "Daily pull" : x.trigger === "added" ? "First pull" : x.trigger}</div>
                      {x.ok ? <div className="mt-0.5">{x.added} added · {x.changed} changed · {x.removed} no longer reported · {x.unchanged} unchanged</div>
                        : <div className="mt-0.5 break-words text-xs text-destructive">{x.error}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="py-10 text-center text-sm text-muted-foreground">Not pulled yet.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

