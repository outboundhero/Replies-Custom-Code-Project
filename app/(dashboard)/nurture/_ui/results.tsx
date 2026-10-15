"use client";

/**
 * "What nurture produces" (leads delivered, by the stage they came from) and
 * "where contacts sit" (main campaigns, each nurture batch, the nurture queue).
 * Used on the Nurture overview and on each client's page.
 */
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { fmt, Skel, ago, useNow } from "./shared";

// ── shapes (match lib/nurture/overview.ts + lib/nurture/results.ts) ──────────
export interface StageRow { stage: number; campaigns: number; live: number; leads: number; contacted: number | null; replied: number | null; completion: number | null }
export interface Delivered90 { main: number; nurture: number; unknown: number }
type Cat = "meeting" | "interested" | "followup" | "referral" | "other";
type Esp = "google" | "outlook" | "segs" | "other";
interface StageResult { stage: number | null; leads: number; categories: Record<Cat, number>; esps: Record<Esp, number> }
interface ResultsData {
  days: number | null; total: number; fromNurture: number; stages: StageResult[];
  tags: Array<{ tag: string; total: number; main: number; nurture: number }>;
  trend: { by: "week" | "month"; points: Array<{ key: string; main: number; nurture: number; unknown: number }> };
  trackedSince: string | null; refreshedAt: string | null;
}

// ── stage names + colours ────────────────────────────────────────────────────
const COLORS = ["var(--emerald-fg)", "var(--violet-fg)", "var(--blue-fg)", "var(--amber-fg)", "#a5468f", "#0e8f8f"];
export const stageColor = (s: number | null) => (s == null ? "#d4d4d8" : COLORS[Math.min(s, COLORS.length - 1)]);
export const stageLabel = (s: number | null) => (s == null ? "Not matched" : s === 0 ? "Main campaigns" : `Nurture ${s}`);
const stageShort = (s: number | null) => (s == null ? "Not matched" : s === 0 ? "Main" : `Nurture ${s}`);
const WAITING = "#c4c4cc";
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
/** "12%", or "<1%" for a share too small to round to 1. */
const share = (n: number, of: number) => (n > 0 && of > 0 && pct(n, of) === 0 ? "<1%" : `${pct(n, of)}%`);
const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
const monthYear = (iso: string) => new Date(`${iso.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** A horizontal bar split into coloured parts. */
export function StackBar({ parts, thin }: { parts: Array<{ key: string; value: number; color: string; title: string }>; thin?: boolean }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  return (
    <div className={`stk${thin ? " thin" : ""}`} role="img" aria-label={parts.map((p) => p.title).join(", ")}>
      {total > 0 && parts.filter((p) => p.value > 0).map((p) => (
        <i key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={p.title} />
      ))}
    </div>
  );
}

// ── overview table cell: delivered in the last 90 days ───────────────────────
export function DeliveredCell({ d }: { d: Delivered90 | null | undefined }) {
  if (d == null) return <span className="muted" title="Not counted yet — it's worked out every 6 hours">…</span>;
  const total = d.main + d.nurture + d.unknown;
  if (!total) return <span className="muted" title="No leads delivered in the last 90 days">—</span>;
  const title = `${total} lead${total === 1 ? "" : "s"} delivered in the last 90 days: ${d.main} from main campaigns, ${d.nurture} from nurture (${pct(d.nurture, total)}%)${d.unknown ? `, ${d.unknown} not matched to a campaign` : ""}`;
  return (
    <div className="dcell" title={title}>
      <div className="nums"><b>{d.main}</b> <span className="muted">main</span> · <b style={{ color: "var(--violet-fg)" }}>{d.nurture}</b> <span className="muted">nurture</span></div>
      <StackBar thin parts={[
        { key: "m", value: d.main, color: stageColor(0), title: `${d.main} main` },
        { key: "n", value: d.nurture, color: stageColor(1), title: `${d.nurture} nurture` },
        { key: "u", value: d.unknown, color: stageColor(null), title: `${d.unknown} not matched` },
      ]} />
    </div>
  );
}

// ── where contacts sit ───────────────────────────────────────────────────────
export function stageParts(stages: StageRow[], waiting: number | null) {
  return [
    ...stages.filter((s) => s.leads > 0).map((s) => ({ key: `s${s.stage}`, value: s.leads, color: stageColor(s.stage), title: `${stageLabel(s.stage)}: ${fmt(s.leads)} contacts` })),
    ...(waiting ? [{ key: "w", value: waiting, color: WAITING, title: `Waiting for nurture: ${fmt(waiting)}` }] : []),
  ];
}

/** One line for the overview's expanded row. */
export function StageSummary({ stages, waiting }: { stages: StageRow[]; waiting: number | null }) {
  const parts = stageParts(stages, waiting);
  if (!parts.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 6 }}>Where contacts sit</div>
      <StackBar thin parts={parts} />
      <div className="lgd" style={{ fontSize: 11, gap: "4px 12px", marginTop: 7 }}>
        {stages.filter((s) => s.leads > 0).map((s) => <span key={s.stage}><i className="sw" style={{ background: stageColor(s.stage) }} />{stageShort(s.stage)} <b>{compact(s.leads)}</b></span>)}
        {waiting ? <span><i className="sw" style={{ background: WAITING }} />Waiting <b>{compact(waiting)}</b></span> : null}
      </div>
    </div>
  );
}

export function WhereContactsCard({ stages, waiting, loading }: { stages: StageRow[] | undefined; waiting: number | null; loading: boolean }) {
  const rows = (stages ?? []).filter((s) => s.campaigns > 0);
  const total = rows.reduce((n, s) => n + s.leads, 0) + (waiting ?? 0);
  const progressKnown = rows.some((s) => s.contacted != null);
  return (
    <div className="card cardpad">
      <div className="card-h"><h3>Where contacts sit</h3><span className="hint">main campaigns, each nurture batch, and the nurture queue</span></div>
      {loading ? <Skel w={320} /> : !rows.length && !waiting ? (
        <div className="empty" style={{ padding: "14px 0" }}>No current campaigns yet, and nothing waiting for nurture.</div>
      ) : (
        <>
          <StackBar parts={stageParts(rows, waiting)} />
          <div className="lgd">
            {rows.filter((s) => s.leads > 0).map((s) => <span key={s.stage}><i className="sw" style={{ background: stageColor(s.stage) }} />{stageLabel(s.stage)} <b>{fmt(s.leads)}</b> · {share(s.leads, total)}</span>)}
            {waiting ? <span><i className="sw" style={{ background: WAITING }} />Waiting for nurture <b>{fmt(waiting)}</b> · {share(waiting, total)}</span> : null}
          </div>
          <div style={{ overflowX: "auto", marginTop: 16 }}>
            <table className="mini">
              <thead>
                <tr><th>Stage</th><th className="num">Campaigns</th><th className="num">Contacts</th><th className="num">Contacted</th><th className="num">Not started</th><th style={{ width: 150 }}>Progress</th><th className="num">Replied</th></tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const notStarted = s.contacted != null ? Math.max(0, s.leads - s.contacted) : null;
                  return (
                    <tr key={s.stage}>
                      <td><span className="camp"><span className="d" style={{ background: stageColor(s.stage) }} />{stageLabel(s.stage)}</span></td>
                      <td className="num" title={`${s.live} active, ${s.campaigns - s.live} paused / draft`}>{s.campaigns ? <>{s.live}<span className="muted"> / {s.campaigns}</span></> : <span className="muted">—</span>}</td>
                      <td className="num">{fmt(s.leads)}</td>
                      <td className="num">{s.contacted != null ? fmt(s.contacted) : <span className="muted">—</span>}</td>
                      <td className="num">{notStarted != null ? fmt(notStarted) : <span className="muted">—</span>}</td>
                      <td>{s.completion != null ? (
                        <span className="bar-row" style={{ margin: 0 }}>
                          <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.min(100, s.completion)}%`, background: stageColor(s.stage) }} /></span>
                          <span className="bn" style={{ width: 44 }}>{Math.round(s.completion)}%</span>
                        </span>
                      ) : <span className="muted">—</span>}</td>
                      <td className="num">{s.replied != null ? fmt(s.replied) : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
                {waiting != null && (
                  <tr>
                    <td><span className="camp"><span className="d" style={{ background: WAITING }} />Waiting for nurture</span></td>
                    <td className="num"><span className="muted">—</span></td>
                    <td className="num">{fmt(waiting)}</td>
                    <td colSpan={4} className="muted" style={{ fontSize: 12 }}>In the queue — the 45-day cooldown, then routed to Nurture every 2 hours</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="rnote">
            Current campaigns only (archived and completed ones are left out). <b>Campaigns</b> = active / all current. <b>Not started</b> = in a campaign but not emailed yet.
            {!progressKnown && " Contacted, progress and replies appear after the next campaign refresh (every 10 minutes)."}
          </div>
        </>
      )}
    </div>
  );
}

// ── leads delivered ──────────────────────────────────────────────────────────
const WINDOWS: Array<[string, string]> = [["30", "30 days"], ["90", "90 days"], ["all", "All time"]];
const CATS: Array<[Cat, string]> = [["meeting", "Meeting-ready"], ["interested", "Interested"], ["followup", "Follow up"], ["referral", "Referral"]];
const ESPS: Array<[Esp, string]> = [["google", "Google"], ["outlook", "Outlook"], ["segs", "SEGs"]];

/** Stages for display: Main, Nurture 1, Nurture 2, "Nurture 3+" (later batches together), Not matched. */
interface Group { key: string; label: string; color: string; leads: number; categories: Record<Cat, number>; esps: Record<Esp, number>; detail?: string }
function groupStages(stages: StageResult[]): Group[] {
  const blank = (): Pick<Group, "leads" | "categories" | "esps"> => ({ leads: 0, categories: { meeting: 0, interested: 0, followup: 0, referral: 0, other: 0 }, esps: { google: 0, outlook: 0, segs: 0, other: 0 } });
  const add = (g: Pick<Group, "leads" | "categories" | "esps">, s: StageResult) => {
    g.leads += s.leads;
    for (const k of Object.keys(g.categories) as Cat[]) g.categories[k] += s.categories[k];
    for (const k of Object.keys(g.esps) as Esp[]) g.esps[k] += s.esps[k];
  };
  const out: Group[] = [];
  for (const s of stages.filter((x) => x.stage != null && x.stage <= 2)) {
    const g = { key: `s${s.stage}`, label: stageLabel(s.stage), color: stageColor(s.stage), ...blank() };
    add(g, s); out.push(g);
  }
  const later = stages.filter((x) => x.stage != null && x.stage >= 3);
  if (later.length) {
    const g = { key: "s3", label: "Nurture 3+", color: stageColor(3), ...blank(), detail: later.map((x) => `Nurture ${x.stage}: ${x.leads}`).join(", ") };
    for (const s of later) add(g, s);
    out.push(g);
  }
  const unk = stages.find((x) => x.stage == null);
  if (unk) { const g = { key: "u", label: "Not matched", color: stageColor(null), ...blank() }; add(g, unk); out.push(g); }
  return out;
}

// Open / closed, remembered in this browser (a convenience — safe to lose).
const openListeners = new Set<() => void>();
function readOpen(key: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v === "1"; } catch { return fallback; }
}
function usePersistedOpen(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const subscribe = useCallback((cb: () => void) => {
    openListeners.add(cb);
    window.addEventListener("storage", cb);
    return () => { openListeners.delete(cb); window.removeEventListener("storage", cb); };
  }, []);
  const open = useSyncExternalStore(subscribe, () => readOpen(key, fallback), () => fallback);
  const set = useCallback((v: boolean) => {
    try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* storage off — stays as is this visit */ }
    openListeners.forEach((l) => l());
  }, [key]);
  return [open, set];
}

export function ResultsCard({ tag, serverNow, defaultOpen = true }: { tag?: string; serverNow: number; defaultOpen?: boolean }) {
  const now = useNow(serverNow);
  const [open, setOpen] = usePersistedOpen(`nurture:results-open:${tag ? "client" : "overview"}`, defaultOpen);
  const bodyId = useId();
  const [win, setWin] = useState("90");
  const [view, setView] = useState<"result" | "inbox">("result");
  const [state, setState] = useState<{ key: string; data?: ResultsData; error?: string } | null>(null);
  const key = `${tag ?? ""}|${win}`;
  useEffect(() => {
    let live = true;
    fetch(`/api/nurture/results?days=${win}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`, { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) { window.location.href = "/login"; return; }
        const j = await r.json().catch(() => null);
        if (!live) return;
        setState(r.ok && j?.ok ? { key, data: j as ResultsData } : { key, error: j?.error || `Couldn't load the results (${r.status}).` });
      })
      .catch((e) => { if (live) setState({ key, error: (e as Error).message }); });
    return () => { live = false; };
  }, [key, tag, win]);

  const current = state?.key === key ? state : null;
  const d = current?.data;
  const winText = win === "all" ? "so far" : `in the last ${win} days`;
  const groups = d ? groupStages(d.stages) : [];
  const main = groups.find((g) => g.key === "s0");
  const nurture = groups.filter((g) => g.key.startsWith("s") && g.key !== "s0");
  const nurtureLeads = nurture.reduce((n, g) => n + g.leads, 0);
  const nurtureMeetings = nurture.reduce((n, g) => n + g.categories.meeting, 0);
  const unmatched = groups.find((g) => g.key === "u");
  const meetings = groups.reduce((n, g) => n + g.categories.meeting, 0);
  const toggle = () => setOpen(!open);

  return (
    <div className="card rcard">
      {/* The whole header opens and closes it; the button inside is what keyboards and screen readers use. */}
      <div className={`rhd${open ? " open" : ""}`} onClick={toggle}>
        <span className="chev" aria-hidden>{Chevron}</span>
        <div className="rt">
          <h3>
            <button type="button" className="rtog" aria-expanded={open} aria-controls={bodyId}>Leads delivered</button>
            {d && d.total > 0 && <span className="pill p-vio" style={{ fontSize: 11 }}>{share(d.fromNurture, d.total)} from nurture</span>}
          </h3>
          <div className="rsum">
            {!current ? <Skel w={260} /> : current.error ? <span style={{ color: "var(--red-fg)" }}>Couldn&apos;t load the results</span>
              : !d || !d.total ? <span>{d?.refreshedAt ? `No leads delivered ${winText}` : "Counted every 6 hours — the first count hasn't run yet"}</span>
              : (<>
                  <span><b>{fmt(d.total)}</b> delivered {winText}</span>
                  <span><i className="sw" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 3, background: stageColor(0), marginRight: 5 }} /><b>{fmt(main?.leads ?? 0)}</b> main</span>
                  <span><i className="sw" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 3, background: stageColor(1), marginRight: 5 }} /><b>{fmt(nurtureLeads)}</b> nurture</span>
                </>)}
          </div>
        </div>
        {d && d.total > 0 && <div className="rbar"><StackBar thin parts={groups.map((g) => ({ key: g.key, value: g.leads, color: g.color, title: `${g.label}: ${fmt(g.leads)}` }))} /></div>}
        <div className="seg" onClick={(e) => e.stopPropagation()}>
          {WINDOWS.map(([v, l]) => <button key={v} type="button" className={win === v ? "on" : ""} aria-pressed={win === v} onClick={() => setWin(v)}>{l}</button>)}
        </div>
      </div>

      {open && (
        <div className="rbody" id={bodyId}>
          {!current ? (
            <div className="kpis">{[0, 1, 2].map((i) => <div key={i} className="kpi"><Skel w={90} /><div style={{ marginTop: 12 }}><Skel w={60} /></div></div>)}</div>
          ) : current.error ? (
            <div className="banner warn" style={{ margin: 0 }}>Couldn&apos;t load the results: {current.error}</div>
          ) : !d || d.total === 0 ? (
            <div className="empty" style={{ padding: "10px 0" }}>{d?.refreshedAt ? `No leads delivered ${winText}${tag ? ` for ${tag}` : ""}.` : "The results are counted every 6 hours — the first count hasn't run yet."}</div>
          ) : (
            <>
              <div className="kpis">
                <div className="kpi">
                  <div className="kh"><i className="sw" style={{ width: 8, height: 8, borderRadius: 3, background: stageColor(0), display: "inline-block" }} />From main campaigns</div>
                  <div className="kv"><b>{fmt(main?.leads ?? 0)}</b><span>{share(main?.leads ?? 0, d.total)} of delivered</span></div>
                  <div className="kf">{fmt(main?.categories.meeting ?? 0)} meeting-ready</div>
                </div>
                <div className="kpi">
                  <div className="kh"><i className="sw" style={{ width: 8, height: 8, borderRadius: 3, background: stageColor(1), display: "inline-block" }} />From nurture</div>
                  <div className="kv"><b>{fmt(nurtureLeads)}</b><span>{share(nurtureLeads, d.total)} of delivered</span></div>
                  <div className="kf">{fmt(nurtureMeetings)} meeting-ready</div>
                  {nurture.length > 0 && (
                    <div className="chips">
                      {nurture.map((g) => <span key={g.key} className="chip" title={g.detail}><i style={{ background: g.color }} />{g.label} <b>{fmt(g.leads)}</b></span>)}
                    </div>
                  )}
                </div>
                <div className="kpi">
                  <div className="kh">Meeting-ready</div>
                  <div className="kv"><b>{fmt(meetings)}</b><span>{share(meetings, d.total)} of delivered</span></div>
                  <div className="kf">
                    {unmatched ? <>{fmt(unmatched.leads)} lead{unmatched.leads === 1 ? "" : "s"} couldn&apos;t be matched to a campaign (the reply didn&apos;t record it).</> : "Every lead was matched to its campaign."}
                  </div>
                </div>
              </div>

              <div className="rsplit">
                <div className="rpanel">
                  <div className="ph"><h4>{d.trend.by === "week" ? "By week" : "By month"}</h4><span className="hint">{d.trend.by === "week" ? `weeks starting Monday, ${winText}` : "since tracking began"}</span></div>
                  <Trend points={d.trend.points} by={d.trend.by} />
                  <div className="lgd" style={{ fontSize: 11 }}>
                    <span><i className="sw" style={{ background: stageColor(0) }} />Main</span>
                    <span><i className="sw" style={{ background: stageColor(1) }} />Nurture</span>
                    {unmatched && <span><i className="sw" style={{ background: stageColor(null) }} />Not matched</span>}
                  </div>
                </div>
                {!tag ? (
                  <div className="rpanel">
                    <div className="ph"><h4>Most leads from nurture</h4><span className="hint">{winText}</span></div>
                    <TopClients tags={d.tags} />
                  </div>
                ) : (
                  <div className="rpanel">
                    <div className="ph"><h4>By inbox type</h4><span className="hint">the campaign it came from</span></div>
                    {ESPS.map(([k, l]) => {
                      const m = main?.esps[k] ?? 0, n = nurture.reduce((x, g) => x + g.esps[k], 0);
                      return (
                        <div key={k} style={{ marginTop: 10 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}><span>{l}</span><span className="tnum muted">{fmt(m)} main · <b style={{ color: "var(--violet-fg)" }}>{fmt(n)}</b> nurture</span></div>
                          <StackBar thin parts={[{ key: "m", value: m, color: stageColor(0), title: `${m} main` }, { key: "n", value: n, color: stageColor(1), title: `${n} nurture` }]} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="rpanel" style={{ marginTop: 16 }}>
                <div className="ph">
                  <h4>Breakdown</h4><span className="hint">where each delivered lead came from</span>
                  <div className="seg">
                    <button type="button" className={view === "result" ? "on" : ""} aria-pressed={view === "result"} onClick={() => setView("result")}>By result</button>
                    <button type="button" className={view === "inbox" ? "on" : ""} aria-pressed={view === "inbox"} onClick={() => setView("inbox")}>By inbox type</button>
                  </div>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="mini">
                    <thead>
                      <tr>
                        <th>Came from</th><th className="num">Leads</th><th className="num">Share</th>
                        {(view === "result" ? CATS : ESPS).map(([k, l]) => <th key={k} className="num">{l}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <tr key={g.key} title={g.detail}>
                          <td><span className="camp"><span className="d" style={{ background: g.color }} />{g.label}</span></td>
                          <td className="num"><b>{fmt(g.leads)}</b></td>
                          <td className="num muted">{share(g.leads, d.total)}</td>
                          {view === "result"
                            ? CATS.map(([k]) => <td key={k} className="num">{g.categories[k] ? fmt(g.categories[k]) : <span className="muted">—</span>}</td>)
                            : ESPS.map(([k]) => <td key={k} className="num">{g.esps[k] ? fmt(g.esps[k]) : <span className="muted">—</span>}</td>)}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>Total</td><td className="num">{fmt(d.total)}</td><td className="num muted">100%</td>
                        {view === "result"
                          ? CATS.map(([k]) => <td key={k} className="num">{fmt(groups.reduce((n, g) => n + g.categories[k], 0))}</td>)
                          : ESPS.map(([k]) => <td key={k} className="num">{fmt(groups.reduce((n, g) => n + g.esps[k], 0))}</td>)}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              <div className="rnote">
                Each lead counts once, credited to the campaign of its first delivery.
                {d.trackedSince ? ` Deliveries to lead sheets are tracked since ${monthYear(d.trackedSince)}.` : ""}
                {d.refreshedAt ? ` Counted ${ago(d.refreshedAt, now)} — every 6 hours.` : ""}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const Chevron = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m9 18 6-6-6-6" /></svg>;

const weekLabel = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function Trend({ points, by }: { points: ResultsData["trend"]["points"]; by: "week" | "month" }) {
  if (!points.length) return <div className="muted" style={{ fontSize: 12.5, padding: "40px 0", textAlign: "center" }}>No deliveries in this window.</div>;
  const max = Math.max(...points.map((p) => p.main + p.nurture + p.unknown), 1);
  const every = points.length > 9 ? 2 : 1; // thin the labels when there are many weeks
  const label = (k: string) => (by === "week" ? weekLabel(k) : monthName(k));
  return (
    <>
      <div className="tchart">
        {points.map((p, i) => {
          const t = p.main + p.nurture + p.unknown;
          const when = `${by === "week" ? `Week of ${weekLabel(p.key)}` : monthName(p.key)}${i === points.length - 1 ? " (so far)" : ""}`; // the last one is the current week / month
          return (
            <div key={p.key} className="tcol" title={`${when}: ${t} delivered — ${p.main} main, ${p.nurture} nurture${p.unknown ? `, ${p.unknown} not matched` : ""}`}>
              <span className="tv">{t ? fmt(t) : ""}</span>
              <div className="tbar" style={{ height: `${Math.max(3, (t / max) * 100)}%` }}>
                {p.main > 0 && <i style={{ height: `${(p.main / t) * 100}%`, background: stageColor(0) }} />}
                {p.nurture > 0 && <i style={{ height: `${(p.nurture / t) * 100}%`, background: stageColor(1) }} />}
                {p.unknown > 0 && <i style={{ height: `${(p.unknown / t) * 100}%`, background: stageColor(null) }} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="tlabels">{points.map((p, i) => <span key={p.key}>{i % every === 0 ? label(p.key) : ""}</span>)}</div>
    </>
  );
}

function TopClients({ tags }: { tags: ResultsData["tags"] }) {
  const top = tags.filter((t) => t.nurture > 0).slice(0, 8);
  if (!top.length) return <div className="muted" style={{ fontSize: 12.5 }}>No leads from nurture in this window.</div>;
  const max = Math.max(...top.map((t) => t.total), 1);
  return (
    <div className="rank">
      {top.map((t, i) => (
        <Link key={t.tag} href={`/nurture/c/${encodeURIComponent(t.tag)}`} title={`${t.tag}: ${t.nurture} from nurture, ${t.main} from main campaigns (${share(t.nurture, t.total)} nurture)`}>
          <span className="rn">{i + 1}</span>
          <span className="rtag">{t.tag}</span>
          <span style={{ width: `${Math.max(8, (t.total / max) * 100)}%` }}>
            <StackBar thin parts={[{ key: "n", value: t.nurture, color: stageColor(1), title: `${t.nurture} nurture` }, { key: "m", value: t.main, color: stageColor(0), title: `${t.main} main` }, { key: "u", value: Math.max(0, t.total - t.main - t.nurture), color: stageColor(null), title: "not matched" }]} />
          </span>
          <span className="rv"><b style={{ color: "var(--violet-fg)" }}>{fmt(t.nurture)}</b> <span className="muted">of {fmt(t.total)}</span></span>
        </Link>
      ))}
    </div>
  );
}
