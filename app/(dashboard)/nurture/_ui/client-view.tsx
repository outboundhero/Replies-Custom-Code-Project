"use client";

/**
 * Nurture System — one client tag (the client-approved redesign; markup +
 * classes mirror the mockup's client view). Two tabs:
 *   • Nurture overview — pipeline, target campaigns, batches, analytics.
 *   • Queue — the tag's pending contacts, paged + filtered in the database,
 *     with remove (single / selected / all matching / by domain) + Undo.
 * Everything the previous page did (sync, route-all, per-lead push/skip…) is
 * still one click away under Actions → Open classic view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import TargetCampaigns from "../_components/TargetCampaigns";
import {
  type OverviewTag, type BatchState, fmt, ago, lastContactText, Ico, TypeBadge, Avatar, MappingPill, StatusCell, HoverTip,
  Skel, BarRow, ESP_ROWS, SOURCE_ROWS, sourceValues, useToast, Toast, ConfirmDialog, ActionsMenu,
} from "./shared";
import { type QueueResult, type QueueContact, QUEUE_PAGE, queueQuery, getCachedQueue, isFresh, fetchQueue, prefetchQueuePage, dropQueueCache } from "./queue-cache";

interface Slot {
  lane: "b2b" | "b2c"; instance: string; instanceLabel: string; esp: "google" | "outlook" | "segs";
  campaignId: number | null; campaignName: string | null; status: string | null;
  issue: "unmapped" | "missing" | "archived" | "draft" | null;
}
interface BatchCampaign { id: number; instance: string; instanceLabel: string; name: string; status: string; esp: string | null; totalLeads: number }
export interface ClientResp {
  client: OverviewTag;
  slots: Slot[];
  batches: Array<{ batch: number; state: BatchState; campaigns: BatchCampaign[] }>;
  builtAt: string;
}
interface QueueFilters { search: string; email: string; web: string; source: string; tld: string; overlap: boolean }
const NO_FILTERS: QueueFilters = { search: "", email: "", web: "", source: "", tld: "", overlap: false };
const PAGE = QUEUE_PAGE;
const PREFETCH_MAX = 5000;
const PAGE1_FRESH_MS = 30 * 60_000;
const ESP_LABEL: Record<string, string> = { google: "Google", outlook: "Outlook", segs: "SEGs" };
const SRC = Object.fromEntries(SOURCE_ROWS.map((r) => [r.key, r]));
const QUICK_TLDS = [".in", ".ca", ".nz"];
// Country-code endings worth flagging (the team prunes non-US contacts).
const isFlagTld = (t: string | null) => !!t && /^\.[a-z]{2}$/.test(t) && ![".us", ".co", ".io", ".ai", ".me", ".tv"].includes(t);

function statusPill(status: string | null) {
  const s = (status || "").toLowerCase();
  if (s === "active" || s === "queued") return <span className="pill p-ok" style={{ fontSize: 10 }}>Active</span>;
  if (s === "paused") return <span className="pill p-mute" style={{ fontSize: 10 }}>Paused</span>;
  if (s === "draft") return <span className="pill p-info" style={{ fontSize: 10 }}>Draft</span>;
  if (s === "archived") return <span className="pill p-warn" style={{ fontSize: 10 }}>Archived</span>;
  if (s === "completed") return <span className="pill p-mute" style={{ fontSize: 10 }}>Completed</span>;
  return s ? <span className="pill p-mute" style={{ fontSize: 10 }}>{s}</span> : null;
}

function describeFilters(f: Record<string, unknown> | null): string {
  if (!f) return "all matching";
  const parts: string[] = [];
  if (f.tld) parts.push(`domain ${f.tld}`);
  if (f.emailSuffix) parts.push(`email ends ${f.emailSuffix}`);
  if (f.webSuffix) parts.push(`website ends ${f.webSuffix}`);
  if (f.source) parts.push(`source ${f.source}`);
  if (f.search) parts.push(`"${f.search}"`);
  if (f.overlapOnly) parts.push("overlapping");
  return parts.length ? `all matching ${parts.join(", ")}` : "entire queue";
}
const filtersActive = (f: QueueFilters) => !!(f.search.trim() || f.email.trim() || f.web.trim() || f.source || f.tld || f.overlap);

export default function NurtureClientView({ tag, initial, initialError, initialQueue }: {
  tag: string; initial: ClientResp | null; initialError: string | null;
  initialQueue: QueueResult | null;   // first page cached by the stats refresh (painted, then refreshed live)
}) {
  const router = useRouter();
  const { toast, show, hide } = useToast();

  // ── client data (painted from the server snapshot; re-read after actions)
  const [data, setData] = useState<ClientResp | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const loadClient = useCallback(async (fresh = false) => {
    try {
      const r = await fetch(`/api/nurture/client/${encodeURIComponent(tag)}${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      if (r.redirected || r.status === 401) { window.location.href = "/login"; return null; }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d); setError(null);
      return d as ClientResp;
    } catch (e) { setError((e as Error).message); return null; }
  }, [tag]);
  const hadInitial = useRef(!!initial);
  useEffect(() => { if (!hadInitial.current) void loadClient(); }, [loadClient]);

  const c = data?.client ?? null;
  const s = c?.stats ?? null;

  // Panel numbers come from the cached stats. After a queue change the stats
  // job recomputes this client first (≤10 min — it's a heavy query, never run
  // per click). Until then removals / undos adjust the panels right here.
  type Delta = { ready: number; eligible: number; cooldown: number };
  const ZERO: Delta = { ready: 0, eligible: 0, cooldown: 0 };
  const [delta, setDelta] = useState<{ at: string | null; d: Delta }>({ at: null, d: ZERO });
  const statsAt = s?.computed_at ?? null;
  const dNow: Delta = delta.at === statsAt ? delta.d : ZERO; // new stats → deltas no longer apply
  const applyDelta = (d: Delta, sign: 1 | -1) => setDelta((prev) => {
    const base = prev.at === statsAt ? prev.d : ZERO;
    return { at: statsAt, d: { ready: base.ready + sign * d.ready, eligible: base.eligible + sign * d.eligible, cooldown: base.cooldown + sign * d.cooldown } };
  });
  const undoDeltas = useRef<Map<number, Delta>>(new Map());
  const deltaOf = (rows: QueueContact[]): Delta => rows.reduce((t, x) => ({
    ready: t.ready + (x.isReady ? 1 : 0), eligible: t.eligible + (x.isEligible ? 1 : 0), cooldown: t.cooldown + (x.isEligible ? 0 : 1),
  }), ZERO);

  // ── tabs
  const [tab, setTab] = useState<"ov" | "q">("ov");

  // ── queue
  const [f, setF] = useState<QueueFilters>(NO_FILTERS);
  const [fApplied, setFApplied] = useState<QueueFilters>(NO_FILTERS); // debounced text
  const [offset, setOffset] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  // Apply filter edits after a short pause; a new filter set starts on page 1
  // with nothing selected (a selection never carries across filters).
  useEffect(() => {
    if (JSON.stringify(f) === JSON.stringify(fApplied)) return;
    const t = setTimeout(() => { setFApplied(f); setOffset(0); setSel(new Set()); setAllMatching(false); }, 350);
    return () => clearTimeout(t);
  }, [f, fApplied]);
  // Queue pages come from a browser cache first (instant when this page/filter
  // was seen or prefetched), then refresh from the server unless very fresh.
  // Page 1 loads in the background as soon as the client page opens.
  const firstPage = (): QueueResult | null => {
    const c = getCachedQueue(queueQuery(tag, NO_FILTERS, 0));
    if (c && (!initialQueue || c.at >= initialQueue.at)) return c;
    return initialQueue;
  };
  const [q, setQ] = useState<(QueueResult & { key: string; fkey: string }) | null>(() => {
    const c = firstPage();
    return c ? { ...c, key: queueQuery(tag, NO_FILTERS, 0), fkey: JSON.stringify(NO_FILTERS) } : null;
  });
  const [qLoading, setQLoading] = useState(false);
  const [qError, setQError] = useState<string | null>(null);
  const [unfilteredTotal, setUnfilteredTotal] = useState<number | null>(() => firstPage()?.total ?? null);
  const qSeq = useRef(0);
  const loadQueue = useCallback(async (force = false) => {
    const seq = ++qSeq.current;
    const key = queueQuery(tag, fApplied, offset);
    const cached = force ? null : getCachedQueue(key);
    const fkey = JSON.stringify(fApplied);
    // Unfiltered first page: the server's cached copy (refreshed with the
    // client's stats) is used as-is while under 30 min old — on big clients
    // the live query is heavy (up to ~30s), so it only runs on Refresh, a
    // filter / page change, or after a removal.
    if (!force && !cached && initialQueue && key === queueQuery(tag, NO_FILTERS, 0) && Date.now() - initialQueue.at < PAGE1_FRESH_MS) {
      setQ({ ...initialQueue, key, fkey });
      setUnfilteredTotal(initialQueue.total);
      setQLoading(false);
      return;
    }
    if (cached) {
      setQ({ ...cached, key, fkey });
      if (!filtersActive(fApplied)) setUnfilteredTotal(cached.total);
      if (isFresh(cached)) {
        setQLoading(false);
        if (cached.total > offset + PAGE && cached.total <= PREFETCH_MAX) prefetchQueuePage(tag, fApplied, offset + PAGE);
        return;
      }
    }
    setQLoading(true);
    try {
      const res = await fetchQueue(key);
      if (seq !== qSeq.current) return;
      if (res.contacts.length === 0 && offset > 0 && res.total > 0) { setOffset(Math.max(0, Math.floor((res.total - 1) / PAGE) * PAGE)); return; }
      setQ({ ...res, key, fkey });
      if (!filtersActive(fApplied)) setUnfilteredTotal(res.total);
      setQError(null);
      // Next page in the background — only for smaller queues, where it's a
      // cheap query (every page query scans the whole queue in the database).
      if (res.total > offset + PAGE && res.total <= PREFETCH_MAX) prefetchQueuePage(tag, fApplied, offset + PAGE);
    } catch (e) { if (seq === qSeq.current) setQError((e as Error).message); }
    finally { if (seq === qSeq.current) setQLoading(false); }
  }, [tag, fApplied, offset, initialQueue]);
  // The live queue is only queried once the Queue tab is opened (each query
  // scans this client's whole queue); until then the cached first page shows.
  useEffect(() => { if (tab === "q") void loadQueue(); }, [tab, loadQueue]);

  // Recent removals (Undo lives here too, not only in the toast).
  interface RemovalRow { id: number; removedAt: string; removedBy: string | null; mode: string; contacts: number; rows: number; status: string; filters: Record<string, unknown> | null; restoredAt: string | null; undoable: boolean }
  const [removals, setRemovals] = useState<RemovalRow[] | null>(null);
  const loadRemovals = useCallback(async () => {
    try {
      const r = await fetch(`/api/nurture/queue/removals?tag=${encodeURIComponent(tag)}`, { cache: "no-store" });
      const d = await r.json();
      if (r.ok) setRemovals(d.removals || []);
    } catch { /* non-critical */ }
  }, [tag]);
  useEffect(() => { if (tab === "q" && removals === null) void loadRemovals(); }, [tab, removals, loadRemovals]);
  // Rows of the current selection (it can span pages) — for the panel deltas.
  const selRows = useRef<Map<string, QueueContact>>(new Map());

  const setFilter = <K extends keyof QueueFilters>(k: K, v: QueueFilters[K]) => setF((x) => ({ ...x, [k]: v }));

  // The live queue size (from the queue endpoint) beats the ~10-min cached stat.
  const queueCount = unfilteredTotal ?? s?.queue ?? null;

  // ── remove / undo
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; body: React.ReactNode; label: string; run: () => Promise<void> }>(null);

  async function doRemove(body: Record<string, unknown>, describe: (n: number) => string, removedRows?: QueueContact[]) {
    setBusy(true);
    try {
      const r = await fetch("/api/nurture/queue/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag, ...body }) });
      const d = await r.json();
      if (!r.ok) {
        if (r.status === 409) { dropQueueCache(tag); void loadQueue(true); } // the set changed — show the fresh one
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      setSel(new Set()); setAllMatching(false); selRows.current.clear();
      if (unfilteredTotal != null) setUnfilteredTotal(Math.max(0, unfilteredTotal - (d.contacts || 0)));
      if (removedRows?.length && d.contacts) {
        const dd = deltaOf(removedRows);
        applyDelta(dd, -1);
        if (d.removalId) undoDeltas.current.set(d.removalId, dd);
      }
      dropQueueCache(tag);
      await loadQueue(true);
      void loadRemovals();
      const removalId = d.removalId as number | null;
      show(d.contacts ? describe(d.contacts) : "Nothing to remove — those contacts already left the queue", {
        undo: d.undoable && removalId ? () => void doUndo(removalId) : undefined,
      });
    } catch (e) { show(`Remove failed: ${(e as Error).message}`, { bad: true }); }
    setBusy(false);
  }
  async function doUndo(removalId: number) {
    try {
      const r = await fetch("/api/nurture/queue/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ removalId }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setUnfilteredTotal(null);
      const dd = undoDeltas.current.get(removalId);
      if (dd) { applyDelta(dd, 1); undoDeltas.current.delete(removalId); }
      dropQueueCache(tag);
      await loadQueue(true);
      void loadRemovals();
      show(`Restored — ${fmt(d.rows)} queue row${d.rows === 1 ? "" : "s"} back`);
    } catch (e) { show(`Undo failed: ${(e as Error).message}`, { bad: true }); }
  }
  const plural = (n: number) => (n === 1 ? "1 contact removed from queue" : `${fmt(n)} contacts removed from queue`);

  function removeOne(x: QueueContact) { void doRemove({ emails: [x.email] }, plural, [x]); }
  function removeSelected() {
    if (allMatching) {
      if (!q || q.fkey !== JSON.stringify(fApplied)) return; // results still loading for these filters
      const total = q.total;
      setConfirm({
        title: `Remove ${fmt(total)} contact${total === 1 ? "" : "s"}?`,
        body: <>Every contact matching the current filters will leave <b>{tag}</b>&apos;s nurture queue, so they won&apos;t be routed to nurture campaigns. Nothing changes in Bison, and you can undo it.</>,
        label: `Remove ${fmt(total)}`,
        run: () => doRemove({ all: true, ...fApplied, expected: total }, plural),
      });
      return;
    }
    const emails = [...sel];
    if (emails.length === 0) return;
    const rows = emails.map((e) => selRows.current.get(e)).filter(Boolean) as QueueContact[];
    if (emails.length > 25) {
      setConfirm({
        title: `Remove ${fmt(emails.length)} selected contacts?`,
        body: <>They&apos;ll leave <b>{tag}</b>&apos;s nurture queue. Nothing changes in Bison, and you can undo it.</>,
        label: `Remove ${fmt(emails.length)}`,
        run: () => doRemove({ emails }, plural, rows),
      });
    } else void doRemove({ emails }, plural, rows);
  }
  async function quickRemoveDomain(tld: string) {
    // Live count first, so the confirmation shows the exact number.
    setBusy(true);
    let n = 0;
    try { n = (await fetchQueue(queueQuery(tag, { tld }, 0))).total; }
    catch (e) { setBusy(false); show(`Couldn't count ${tld} contacts: ${(e as Error).message}`, { bad: true }); return; }
    setBusy(false);
    if (!n) { show(`No ${tld} contacts in this queue`); return; }
    setConfirm({
      title: `Remove every ${tld} contact?`,
      body: <><b>{fmt(n)}</b> contact{n === 1 ? "" : "s"} with a <b>{tld}</b> email will leave <b>{tag}</b>&apos;s nurture queue (ignores the filters above). Nothing changes in Bison, and you can undo it.</>,
      label: `Remove ${fmt(n)} ${tld}`,
      run: () => doRemove({ all: true, tld, expected: n }, (k) => `${fmt(k)} ${tld} contact${k === 1 ? "" : "s"} removed from queue`),
    });
  }

  // ── actions
  const [mapOpen, setMapOpen] = useState(false);
  const [mapCampaigns, setMapCampaigns] = useState<Array<{ id: number; name: string; status: string; client_tag: string | null; bison_instance: string; total_leads?: number }> | null>(null);
  function openMapEditor() {
    setMapOpen(true);
    if (!mapCampaigns) {
      fetch(`/api/nurture/campaigns?clientTag=${encodeURIComponent(tag)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setMapCampaigns(d?.campaigns ?? []))
        .catch(() => setMapCampaigns([]));
    }
  }
  const [actBusy, setActBusy] = useState(false);
  async function setAuto(enabled: boolean) {
    setActBusy(true);
    try {
      const r = await fetch("/api/clients/auto-nurture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientTag: tag, enabled }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      show(enabled ? `Auto-nurture on for ${tag}` : `Auto-nurture off for ${tag}`);
      await loadClient(true);
    } catch (e) { show(`Couldn't change auto-nurture: ${(e as Error).message}`, { bad: true }); }
    setActBusy(false);
  }
  async function refreshNumbers() {
    setActBusy(true);
    show("Recomputing this client's numbers…", { ms: 20000 });
    try {
      const r = await fetch("/api/nurture/refresh-stats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      dropQueueCache(tag);
      await Promise.all([loadClient(), tab === "q" ? loadQueue(true) : Promise.resolve()]);
      show(d.stats === "refreshed" ? "Numbers refreshed"
        : d.stats === "recent" ? "Numbers were refreshed under a minute ago — showing the latest"
        : d.stats === "queued" ? "Another recompute is running — this client is next (within ~10 min)"
        : `Couldn't recompute right now (${d.statsError || "error"}) — it's queued for the next run`);
    } catch (e) { show(`Refresh failed: ${(e as Error).message}`, { bad: true }); }
    setActBusy(false);
  }

  // ── derived
  const added = c?.added ?? 0;
  const lanes = useMemo(() => {
    const out: Array<{ lane: "b2b" | "b2c"; label: string; inst: string; rows: Slot[] }> = [];
    for (const lane of ["b2b", "b2c"] as const) {
      const rows = (data?.slots ?? []).filter((x) => x.lane === lane);
      if (rows.length) out.push({ lane, label: lane === "b2b" ? "Business · B2B" : "Personal · B2C", inst: rows[0].instanceLabel, rows });
    }
    return out;
  }, [data]);
  const forecast = s?.forecast ?? [];
  const fmax = Math.max(1, ...forecast);
  const src = sourceValues(s, c?.stoppedRecovered ?? 0);
  const srcTotal = src.reduce((t, r) => t + r.value, 0);
  const espTotal = ESP_ROWS.reduce((t, r) => t + Number(s?.esps?.[r.key] ?? 0), 0);
  const tldOptions = useMemo(() => Object.entries(s?.tlds ?? {}).filter(([k]) => k !== "?").sort((a, b) => b[1] - a[1]).slice(0, 40), [s]);
  const pageRows = q?.contacts ?? [];
  const allOnPage = pageRows.length > 0 && pageRows.every((x) => sel.has(x.email));
  const selCount = allMatching ? (q?.total ?? 0) : sel.size;

  if (error && !data) {
    return (
      <div className="nx -m-6">
        <div className="hd"><div><h2>Nurture System</h2><div className="sub">Re-engage soft-negative, out-of-office and sequence-finished leads across every client.</div></div></div>
        <div className="content">
          <Link className="back" href="/nurture">{Ico.back} All client tags</Link>
          <div className="banner bad">{Ico.warnTri}{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="nx -m-6">
      <div className="hd">
        <div><h2>Nurture System</h2><div className="sub">Re-engage soft-negative, out-of-office and sequence-finished leads across every client.</div></div>
        <ActionsMenu>
          {(close) => (
            <>
              <button type="button" role="menuitem" disabled={!c || actBusy} onClick={() => { close(); if (c) void setAuto(!c.autoOn); }}>
                {Ico.sync}<span>Auto-nurture: {c ? (c.autoOn ? "On" : "Off") : "…"}<span className="mi-sub">{c?.autoOn ? "Turn off automatic routing of ready leads" : "Turn on automatic routing of ready leads"}</span></span>
              </button>
              <button type="button" role="menuitem" onClick={() => { close(); openMapEditor(); }}>
                {Ico.tick}<span>Edit target campaigns<span className="mi-sub">Pick the nurture campaign per lane + ESP</span></span>
              </button>
              <button type="button" role="menuitem" disabled={actBusy} onClick={() => { close(); void refreshNumbers(); }}>
                {Ico.refresh}<span>Refresh numbers<span className="mi-sub">Recompute queue stats + last contact now</span></span>
              </button>
              <hr />
              <Link href={`/nurture/classic/c/${encodeURIComponent(tag)}`} role="menuitem" onClick={close}>
                {Ico.grid}<span>Open classic view<span className="mi-sub">Sync sequence-finished, route ready leads, per-lead push / skip</span></span>
              </Link>
            </>
          )}
        </ActionsMenu>
      </div>

      <div className="content">
        <Link className="back" href="/nurture">{Ico.back} All client tags</Link>

        <div className="qhd">
          <Avatar tag={tag} />
          <div>
            <h2>{tag}</h2>
            <div className="sub">
              {c ? (<><TypeBadge type={c.type} style={{ margin: 0 }} /> &nbsp;·&nbsp; {c.group ? `Group ${c.group}` : "No group"} &nbsp;·&nbsp; {c.mainActive} main + {c.nurtureActive} nurture campaigns</>) : <Skel w={260} />}
            </div>
          </div>
          <div className="right">
            <div className="lastc">Last contact<br /><b>{c ? lastContactText(c) : "…"}</b></div>
            <div>{c ? <StatusCell errors={c.errors} /> : null}</div>
          </div>
        </div>

        {c && (c.prelaunch ? (
          <div className="banner info">{Ico.info}Pre-launch — go-live is in the future. Campaigns are paused and nurture is held until launch (per the go-live gate).</div>
        ) : c.errors.length ? (
          <div className={`banner ${c.errors.some((e) => e.k === "noleads" || e.k === "map") ? "bad" : "warn"}`}>{Ico.warnTri}{c.errors.map((e) => e.lab).join(" · ")} — see Status for the fix.</div>
        ) : null)}
        {c && !c.prelaunch && !c.autoOn && (
          <div className="banner info">{Ico.info}Auto-nurture is off for {tag} — ready leads aren&apos;t routed automatically. Turn it back on from Actions.</div>
        )}

        <div className="panels5">
          <div className="card panel"><div className="k">In queue</div><div className="v tnum">{queueCount != null ? fmt(queueCount) : <Skel />}</div><div className="mm">contacts pending</div></div>
          <div className="card panel"><div className="k">Ready to send</div><div className="v tnum" style={{ color: "var(--emerald-fg)" }}>{s ? fmt(Math.max(0, s.ready - dNow.ready)) : <Skel />}</div><div className="mm">{s && s.eligible - dNow.eligible > s.ready - dNow.ready ? <>past 45-day cooldown · <span title="Past the cooldown but not routable yet — not marked safe, or its ESP isn't confirmed — so auto-push holds them">{fmt(Math.max(0, (s.eligible - dNow.eligible) - (s.ready - dNow.ready)))} held</span></> : "past 45-day cooldown"}</div></div>
          <div className="card panel"><div className="k">In cooldown</div><div className="v tnum">{s ? fmt(Math.max(0, s.cooldown - dNow.cooldown)) : <Skel />}</div><div className="mm">waiting to become eligible</div></div>
          <div className="card panel"><div className="k">Added to campaigns</div><div className="v tnum">{c ? fmt(c.added) : <Skel />}</div><div className="mm">already pushed</div></div>
          <div className="card panel"><div className="k">Overlapping</div><div className="v tnum" style={{ color: "var(--amber-fg)" }}>{s ? fmt(s.overlap) : <Skel />}</div><div className="mm">also in other tags</div></div>
        </div>

        <div className="tabs">
          <button type="button" className={tab === "ov" ? "on" : ""} onClick={() => setTab("ov")}>{Ico.grid}Nurture overview</button>
          <button type="button" className={tab === "q" ? "on" : ""} onClick={() => setTab("q")}>{Ico.lines}Queue <span className="cnt">{queueCount != null ? fmt(queueCount) : "…"}</span></button>
        </div>

        {/* TAB: overview */}
        <div className={tab === "ov" ? "" : "hidden"}>
          <div className="card cardpad">
            <div className="card-h"><h3>Nurture pipeline</h3><span className="hint">how leads flow from finished → sending</span></div>
            <div className="pipe">
              {([
                ["Synced", s ? (s.queue + added) : null, "queued + already added", "var(--muted-foreground)"],
                ["Ready", s ? Math.max(0, s.ready - dNow.ready) : null, "eligible + safe + ESP confirmed", "var(--emerald-fg)"],
                ["Routed", c ? c.added : null, "added to campaigns", "var(--violet-fg)"],
                ["Sending", c ? c.sendingLeads : null, c?.sendingLeads ? "in active nurture campaigns" : "not yet", "var(--blue-fg)"],
              ] as Array<[string, number | null, string, string]>).map(([label, v, sub, color], i) => (
                <div key={label} style={{ display: "contents" }}>
                  <div className="pstage">
                    <div className="pk"><span className="stagedot" style={{ background: color }} />{i + 1}. {label}</div>
                    <div className="pv tnum">{v == null ? <Skel w={70} /> : fmt(v)}</div>
                    <div className="psub">{sub}</div>
                  </div>
                  {i < 3 && <div className="parrow">{Ico.arrow}</div>}
                </div>
              ))}
            </div>
          </div>

          <div className="grid2" style={{ marginTop: 16 }}>
            <div className="card cardpad">
              <div className="card-h">
                <h3>Target campaigns</h3><span className="hint">leads route by lane → instance → ESP</span>
                <span className="r">{c && <MappingPill mapping={c.mapping} issues={c.mapIssues} />}<button type="button" className="btn btn-sm" onClick={openMapEditor}>Edit</button></span>
              </div>
              {!data ? <Skel w={240} /> : lanes.length === 0 ? (
                <div className="muted" style={{ fontSize: 13 }}>No client group (Group 1 / 2) is set for {tag}, so there are no target instances. Set the group in the client sheet.</div>
              ) : lanes.map((l) => (
                <div key={l.lane} className="lane">
                  <div className="lane-h">{l.label}<span className="inst">{l.inst}</span></div>
                  {l.rows.map((r) => (
                    <div key={r.esp} className="maprow">
                      <span className="esp">{ESP_LABEL[r.esp]}</span>
                      {r.issue === "unmapped" ? (
                        <span className="mapname none">no campaign — create in Bison</span>
                      ) : (
                        <span className="mapname" title={r.campaignName ?? undefined}>{r.campaignName ?? `#${r.campaignId}`}</span>
                      )}
                      {r.issue === "missing" ? <span className="pill p-bad" style={{ fontSize: 10 }}>Missing in Bison</span> : statusPill(r.status)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="card cardpad">
              <div className="card-h"><h3>Nurture batches</h3><span className="hint">capacity batches N1 / N2 / N3</span></div>
              {!data ? <Skel w={200} /> : data.batches.map((b) => {
                const [txt, cls] = b.state === "on" ? ["Live", "p-ok"] : b.state === "wait" ? ["Waiting to activate", "p-warn"] : ["Not needed yet", "p-mute"];
                const leads = b.campaigns.reduce((t, x) => t + x.totalLeads, 0);
                return (
                  <div key={b.batch} className="maprow" title={b.campaigns.map((x) => `${x.name} (${x.status}, ${fmt(x.totalLeads)} leads)`).join("\n") || undefined}>
                    <span style={{ fontFamily: "var(--mono)", fontWeight: 600, fontSize: 12, width: 100 }}>N{b.batch} · Batch {b.batch}</span>
                    <span className={`pill ${cls}`} style={{ fontSize: 10.5 }}>{txt}</span>
                    <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted-foreground)" }} className="tnum">{leads ? `${fmt(leads)} leads` : "—"}</span>
                  </div>
                );
              })}
              {c?.readyToExpand && <div className="mm" style={{ fontSize: 11.5, color: "var(--muted-foreground)", marginTop: 10 }}>Batch threshold reached — the next expansion run sets up the next batch.</div>}
            </div>
          </div>

          <div className="analytics">
            <div className="card cardpad">
              <div className="card-h"><h3>Source breakdown</h3></div>
              {s ? src.map((r) => <BarRow key={r.key} label={r.label} value={r.value} total={srcTotal} color={r.color} />) : <Skel w={200} />}
              {s && (c?.stoppedRecovered ?? 0) > 0 && <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 10 }}>Stopped-recovered leads go straight into campaigns (never queued).</div>}
            </div>
            <div className="card cardpad">
              <div className="card-h"><h3>ESP routing</h3><span className="hint">Outlook vs everything else</span></div>
              {s ? ESP_ROWS.map((r) => <BarRow key={r.key} label={r.label} value={Number(s.esps?.[r.key] ?? 0)} total={espTotal} color={r.color} />) : <Skel w={200} />}
              {s && s.esp_unresolved > 0 && <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 10 }}>{fmt(s.esp_unresolved)} still awaiting ESP detection (held until confirmed).</div>}
            </div>
            <div className="card cardpad">
              <div className="card-h"><h3>Eligibility forecast</h3><span className="hint">next 30 days</span></div>
              <div className="foremini">
                {s ? forecast.map((n, i) => (
                  <i key={i} className={n > 0 && n >= fmax * 0.7 ? "hot" : ""} style={{ height: `${Math.max(3, (n / fmax) * 100)}%` }} title={`${i === 0 ? "Today" : i === 1 ? "Tomorrow" : `In ${i} days`}: ${fmt(n)} contact${n === 1 ? "" : "s"}`} />
                )) : null}
              </div>
              <div className="mm" style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 8 }}>Leads crossing the 45-day cooldown, by day.{s ? ` ${fmt(forecast.reduce((t, n) => t + n, 0))} in the next 30 days.` : ""}</div>
            </div>
          </div>
        </div>

        {/* TAB: queue */}
        <div className={tab === "q" ? "" : "hidden"}>
          <div className="qfilters">
            <div className="field">{Ico.search}<input type="text" aria-label="Search name or email" placeholder="Search name or email…" value={f.search} onChange={(e) => setFilter("search", e.target.value)} /></div>
            <div className="field"><input type="text" aria-label="Email ends with" placeholder="Email ends with…" style={{ minWidth: 145 }} value={f.email} onChange={(e) => setFilter("email", e.target.value)} /></div>
            <div className="field"><input type="text" aria-label="Website ends with" placeholder="Website ends with…" style={{ minWidth: 145 }} value={f.web} onChange={(e) => setFilter("web", e.target.value)} /></div>
            <select aria-label="Source" value={f.source} onChange={(e) => setFilter("source", e.target.value)}>
              <option value="">All sources</option>
              <option value="seq">Sequence-finished</option>
              <option value="soft">Soft-negative</option>
              <option value="ooo">Out of office</option>
              <option value="other">Other replies</option>
              <option value="legacy">Legacy</option>
            </select>
            <select aria-label="Email domain" value={f.tld} onChange={(e) => setFilter("tld", e.target.value)}>
              <option value="">All domains</option>
              {tldOptions.map(([t, n]) => <option key={t} value={t}>{t} ({fmt(n)})</option>)}
            </select>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--muted-foreground)", fontWeight: 500 }}>
              <input type="checkbox" checked={f.overlap} onChange={(e) => setFilter("overlap", e.target.checked)} /> Overlapping only
            </label>
            {filtersActive(f) && <button type="button" className="clear" style={{ marginLeft: 0 }} onClick={() => setF(NO_FILTERS)}>Clear</button>}
            {qLoading && <span className="searching">{Ico.spinner}{q && q.key === queueQuery(tag, fApplied, offset) ? "Refreshing…" : "Loading…"}</span>}
          </div>

          {selCount > 0 && (
            <div className="bulk">
              <span>{allMatching ? `All ${fmt(selCount)} matching selected` : `${fmt(selCount)} selected`}</span>
              <div className="r">
                {!allMatching && (q?.total ?? 0) > sel.size && (
                  <button type="button" className="btn btn-sm" onClick={() => setAllMatching(true)}>Select all {fmt(q?.total)} matching</button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => { setSel(new Set()); setAllMatching(false); selRows.current.clear(); }}>Clear</button>
                <button type="button" className="btn btn-danger btn-sm" disabled={busy || (allMatching && (!q || q.fkey !== JSON.stringify(fApplied)))} onClick={removeSelected}>Remove selected</button>
              </div>
            </div>
          )}

          <div className="card tbl" style={{ marginTop: 14 }}>
            <div className="qbar">
              <span className="cnt">{q ? fmt(q.total) : "…"}</span> {filtersActive(fApplied) ? "contacts match" : "contacts in queue"}
              {q && Date.now() - q.at > 120_000 && !qLoading && (
                <span style={{ fontSize: 11.5 }}>· as of {ago(new Date(q.at).toISOString())} · <button type="button" className="linkish" style={{ fontWeight: 500, fontSize: 11.5 }} onClick={() => { dropQueueCache(tag); void loadQueue(true); }}>Refresh</button></span>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 7, alignItems: "center" }}>
                <span style={{ fontSize: 11.5 }}>Quick remove by domain:</span>
                {QUICK_TLDS.map((t) => <button key={t} type="button" className="btn btn-sm" disabled={busy} onClick={() => quickRemoveDomain(t)}>{t}</button>)}
              </div>
            </div>
            <div className="tbl-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="chk">
                      <input type="checkbox" aria-label="Select this page" checked={allMatching || allOnPage} disabled={!pageRows.length}
                        onChange={(e) => {
                          setAllMatching(false);
                          for (const x of pageRows) { if (e.target.checked) selRows.current.set(x.email, x); else selRows.current.delete(x.email); }
                          setSel((cur) => { const n = new Set(cur); for (const x of pageRows) { if (e.target.checked) n.add(x.email); else n.delete(x.email); } return n; });
                        }} />
                    </th>
                    <th>Contact</th><th>Website</th><th className="ctr">Domain</th><th>Source</th><th className="ctr">ESP</th><th>Eligible</th><th className="ctr">Overlap</th><th></th>
                  </tr>
                </thead>
                <tbody style={{ opacity: q && q.key !== queueQuery(tag, fApplied, offset) ? 0.55 : 1, transition: "opacity .12s" }}>
                  {qError && !q ? (
                    <tr><td colSpan={9}><div className="empty">Couldn&apos;t load the queue: {qError} <button type="button" className="linkish" onClick={() => void loadQueue()}>Retry</button></div></td></tr>
                  ) : !q ? (
                    Array.from({ length: 6 }, (_, i) => <tr key={i}>{Array.from({ length: 9 }, (_, j) => <td key={j}>{j > 0 && j < 8 ? <Skel w={j === 1 ? 160 : 60} /> : null}</td>)}</tr>)
                  ) : pageRows.length === 0 ? (
                    <tr><td colSpan={9}><div className="empty">{filtersActive(fApplied) ? "No contacts match these filters." : "This queue is empty — nothing waiting to be nurtured."}</div></td></tr>
                  ) : pageRows.map((x) => {
                    const days = Math.max(0, Math.ceil((new Date(x.eligibleAt).getTime() - Date.now()) / 86_400_000));
                    const srcRow = SRC[x.source] ?? SRC.other;
                    return (
                      <tr key={x.email}>
                        <td className="chk">
                          <input type="checkbox" aria-label={`Select ${x.email}`} checked={allMatching || sel.has(x.email)}
                            onChange={(e) => {
                              if (allMatching) {
                                setAllMatching(false);
                                const keep = pageRows.filter((p) => p.email !== x.email);
                                selRows.current = new Map(keep.map((p) => [p.email, p]));
                                setSel(new Set(keep.map((p) => p.email)));
                                return;
                              }
                              if (e.target.checked) selRows.current.set(x.email, x); else selRows.current.delete(x.email);
                              setSel((cur) => { const n = new Set(cur); if (e.target.checked) n.add(x.email); else n.delete(x.email); return n; });
                            }} />
                        </td>
                        <td>
                          <div className="cname">{x.name || x.company || "—"}</div>
                          <div className="cmail">{x.email}</div>
                        </td>
                        <td className="mono" style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>{x.website || "—"}</td>
                        <td className="ctr">{x.tld ? <span className={`dom${isFlagTld(x.tld) ? " flag" : ""}`}>{x.tld}</span> : <span className="muted">—</span>}</td>
                        <td><span className={`src ${srcRow.cls}`}>{srcRow.label}</span></td>
                        <td className="ctr mono" style={{ fontSize: 11, color: "var(--muted-foreground)" }} title={x.espResolved ? undefined : "ESP not confirmed yet — held until the ESP check stamps it"}>{ESP_LABEL[x.esp] ?? x.esp}{x.espResolved ? "" : "?"}</td>
                        <td style={{ fontSize: 12.5, color: x.isReady ? "var(--emerald-fg)" : "var(--muted-foreground)", fontWeight: x.isReady ? 600 : 400 }}
                          title={x.isEligible && !x.isReady ? "Past the cooldown but not routable yet — not marked safe, or its ESP isn't confirmed — so auto-push holds it" : `Eligible ${new Date(x.eligibleAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}>
                          {x.isReady ? "Ready" : x.isEligible ? "Held" : `in ${days}d`}
                        </td>
                        <td className="ctr">
                          {x.overlapTags.length ? (
                            <HoverTip className="err p-warn ovl" tip={<><b>Also in:</b> {x.overlapTags.join(", ")}</>}><span className="mono">{x.overlapTags.length}×</span></HoverTip>
                          ) : <span className="muted">—</span>}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button type="button" className="rm" title="Remove from queue" aria-label={`Remove ${x.email} from queue`} disabled={busy} onClick={() => removeOne(x)}>{Ico.trash}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {q && q.total > PAGE && (
              <div className="qbar bottom">
                Showing <span className="cnt">{fmt(offset + 1)}–{fmt(Math.min(offset + PAGE, q.total))}</span> of {fmt(q.total)}
                <div style={{ marginLeft: "auto", display: "flex", gap: 7 }}>
                  <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Prev</button>
                  <button type="button" className="btn btn-sm" disabled={offset + PAGE >= q.total} onClick={() => setOffset(offset + PAGE)}>Next →</button>
                </div>
              </div>
            )}
          </div>
          {removals && removals.length > 0 && (
            <div className="card tbl" style={{ marginTop: 14 }}>
              <div className="qbar"><span className="cnt">Recent removals</span><span style={{ marginLeft: "auto", fontSize: 11.5 }}>Undo puts exactly those contacts back in the queue</span></div>
              {removals.slice(0, 6).map((r) => (
                <div key={r.id} className="maprow" style={{ padding: "9px 16px" }}>
                  <span className="tnum" style={{ fontWeight: 600, minWidth: 110 }}>{fmt(r.contacts)} contact{r.contacts === 1 ? "" : "s"}</span>
                  <span className="muted" style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.mode === "all-matching" ? describeFilters(r.filters) : "selected"} · {ago(r.removedAt)}{r.removedBy ? ` · ${r.removedBy}` : ""}
                  </span>
                  {r.status === "failed" ? <span className="pill p-bad" style={{ fontSize: 10 }}>Failed</span>
                    : r.restoredAt ? <span className="pill p-mute" style={{ fontSize: 10 }}>Undone</span>
                    : r.undoable ? <button type="button" className="btn btn-sm" onClick={() => void doUndo(r.id)}>Undo</button>
                    : <span className="pill p-mute" style={{ fontSize: 10 }} title="Made before the database update, so the exact rows weren't recorded">No undo</span>}
                </div>
              ))}
            </div>
          )}
          <div className="foot">
            <b>Overlap</b> flags a contact whose email is also waiting in another active client&apos;s queue — hover to see which. &nbsp;·&nbsp; <b>Remove</b> works one at a time, in bulk by selection, or by domain (.in / .ca / .nz) in one click — it only takes contacts out of this nurture queue (nothing changes in Bison) and can be undone.
            {s && <><br />Panel numbers come from the last recompute ({ago(s.computed_at)}; refreshed every few hours, and within ~10 min after a change); the queue list is live.</>}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        body={confirm?.body}
        confirmLabel={confirm?.label ?? "Remove"}
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={async () => { const run = confirm?.run; if (!run) return; await run(); setConfirm(null); }}
      />

      <Dialog open={mapOpen} onOpenChange={(o) => { setMapOpen(o); if (!o) void loadClient(true); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogTitle>Target campaigns · {tag}</DialogTitle>
          {mapCampaigns == null ? (
            <div className="rounded-lg border bg-card p-4 h-28 animate-pulse" />
          ) : (
            <TargetCampaigns
              clientTag={tag}
              campaigns={mapCampaigns}
              onSendingEnabled={() => {
                // One-time handoff: the classic page only starts the enable flow if
                // this token (same tag, < 2 min old) is present — a bare ?enable=1
                // link from history / a share does nothing.
                try { sessionStorage.setItem("nurture-enable-handoff", JSON.stringify({ tag: tag.toUpperCase(), at: Date.now() })); } catch { /* storage off → no auto-run */ }
                setMapOpen(false);
                router.push(`/nurture/classic/c/${encodeURIComponent(tag)}?enable=1`);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Toast toast={toast} onHide={hide} />
    </div>
  );
}
