"use client";

/**
 * "What nurture produces" (leads delivered, by the stage they came from) and
 * "where contacts sit" (main campaigns, each nurture batch, the nurture queue).
 * Used on the Nurture overview and on each client's page.
 */
import { useEffect, useState } from "react";
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
  months: Array<{ month: string; main: number; nurture: number; unknown: number }>;
  tags: Array<{ tag: string; total: number; main: number; nurture: number }>;
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

export function ResultsCard({ tag, serverNow }: { tag?: string; serverNow: number }) {
  const now = useNow(serverNow);
  const [win, setWin] = useState("90");
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
  return (
    <div className="card cardpad">
      <div className="card-h">
        <h3>Leads delivered</h3><span className="hint">pushed to the client&apos;s lead sheet — by where they came from</span>
        <span className="r" style={{ marginLeft: "auto" }}>
          <div className="seg">{WINDOWS.map(([v, l]) => <button key={v} type="button" className={win === v ? "on" : ""} aria-pressed={win === v} onClick={() => setWin(v)}>{l}</button>)}</div>
        </span>
      </div>

      {!current ? (
        <div className="rtiles">{[0, 1, 2, 3].map((i) => <div key={i} className="rtile"><Skel w={70} /><div style={{ marginTop: 10 }}><Skel w={50} /></div></div>)}</div>
      ) : current.error ? (
        <div className="banner warn" style={{ margin: 0 }}>Couldn&apos;t load the results: {current.error}</div>
      ) : !d || d.total === 0 ? (
        <div className="empty" style={{ padding: "18px 0" }}>
          {d?.refreshedAt ? `No leads delivered ${winText}${tag ? ` for ${tag}` : ""}.` : "The results are worked out every 6 hours — the first count hasn't run yet."}
        </div>
      ) : (
        <>
          <div className="rtiles">
            <div className="rtile">
              <div className="k">Delivered</div>
              <div className="v">{fmt(d.total)}</div>
              <div className="s"><b style={{ color: "var(--violet-fg)" }}>{share(d.fromNurture, d.total)}</b> from nurture</div>
            </div>
            {d.stages.map((s) => (
              <div key={String(s.stage)} className="rtile">
                <div className="k"><i className="sw" style={{ width: 8, height: 8, borderRadius: 3, background: stageColor(s.stage), display: "inline-block" }} />{stageShort(s.stage)}</div>
                <div className="v">{fmt(s.leads)}</div>
                <div className="s">{share(s.leads, d.total)} of delivered{s.categories.meeting ? ` · ${fmt(s.categories.meeting)} meeting-ready` : ""}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}><StackBar parts={d.stages.map((s) => ({ key: String(s.stage), value: s.leads, color: stageColor(s.stage), title: `${stageLabel(s.stage)}: ${s.leads}` }))} /></div>

          <div style={{ overflowX: "auto", marginTop: 16 }}>
            <table className="mini">
              <thead>
                <tr>
                  <th>Came from</th><th className="num">Leads</th>
                  {CATS.map(([k, l]) => <th key={k} className="num">{l}</th>)}
                  {ESPS.map(([k, l]) => <th key={k} className="num">{l}</th>)}
                </tr>
              </thead>
              <tbody>
                {d.stages.map((s) => (
                  <tr key={String(s.stage)}>
                    <td><span className="camp"><span className="d" style={{ background: stageColor(s.stage) }} />{stageLabel(s.stage)}</span></td>
                    <td className="num"><b>{fmt(s.leads)}</b></td>
                    {CATS.map(([k]) => <td key={k} className="num">{s.categories[k] ? fmt(s.categories[k]) : <span className="muted">—</span>}</td>)}
                    {ESPS.map(([k]) => <td key={k} className="num">{s.esps[k] ? fmt(s.esps[k]) : <span className="muted">—</span>}</td>)}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td><td className="num">{fmt(d.total)}</td>
                  {CATS.map(([k]) => <td key={k} className="num">{fmt(d.stages.reduce((n, s) => n + s.categories[k], 0))}</td>)}
                  {ESPS.map(([k]) => <td key={k} className="num">{fmt(d.stages.reduce((n, s) => n + s.esps[k], 0))}</td>)}
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="rgrid">
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>By month</div>
              <MonthBars months={d.months} />
            </div>
            {!tag && d.tags.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>Most leads from nurture {winText}</div>
                {d.tags.filter((t) => t.nurture > 0).slice(0, 8).map((t) => (
                  <div key={t.tag} className="bar-row" style={{ marginTop: 7 }}>
                    <Link href={`/nurture/c/${encodeURIComponent(t.tag)}`} className="bl" style={{ width: 92, fontSize: 12, fontFamily: "var(--mono)", fontWeight: 600, color: "var(--foreground)" }}>{t.tag}</Link>
                    <span className="bar-track" title={`${t.nurture} from nurture, ${t.main} from main campaigns`}>
                      <span className="bar-fill" style={{ width: `${pct(t.nurture, Math.max(...d.tags.map((x) => x.nurture), 1))}%`, background: stageColor(1) }} />
                    </span>
                    <span className="bn" style={{ fontSize: 11.5, width: 92 }}>{t.nurture} <span className="muted">of {t.total}</span></span>
                  </div>
                ))}
                {!d.tags.some((t) => t.nurture > 0) && <div className="muted" style={{ fontSize: 12.5 }}>No leads from nurture {winText}.</div>}
              </div>
            )}
          </div>
        </>
      )}

      {d && (
        <div className="rnote">
          Each lead counts once, credited to the campaign of its first delivery.
          {d.trackedSince ? ` Deliveries to lead sheets are tracked since ${monthYear(d.trackedSince)}.` : ""}
          {d.stages.some((s) => s.stage == null) ? " “Not matched” = the reply didn't record its campaign." : ""}
          {d.refreshedAt ? ` Counted ${ago(d.refreshedAt, now)} — every 6 hours.` : ""}
        </div>
      )}
    </div>
  );
}

function MonthBars({ months }: { months: ResultsData["months"] }) {
  if (!months.length) return <div className="muted" style={{ fontSize: 12.5 }}>No deliveries yet.</div>;
  const max = Math.max(...months.map((m) => m.main + m.nurture + m.unknown), 1);
  return (
    <>
      <div className="months">
        {months.map((m) => {
          const t = m.main + m.nurture + m.unknown;
          return (
            <div key={m.month} className="mcol" title={`${monthName(m.month)}: ${t} delivered — ${m.main} main, ${m.nurture} nurture${m.unknown ? `, ${m.unknown} not matched` : ""}`}>
              <span style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", color: "var(--muted-foreground)" }}>{t}</span>
              <div className="mbar" style={{ height: `${Math.max(4, (t / max) * 86)}px` }}>
                {m.main > 0 && <i style={{ display: "block", height: `${(m.main / t) * 100}%`, background: stageColor(0) }} />}
                {m.nurture > 0 && <i style={{ display: "block", height: `${(m.nurture / t) * 100}%`, background: stageColor(1) }} />}
                {m.unknown > 0 && <i style={{ display: "block", height: `${(m.unknown / t) * 100}%`, background: stageColor(null) }} />}
              </div>
              <span className="mlab">{monthName(m.month)}</span>
            </div>
          );
        })}
      </div>
      <div className="lgd" style={{ fontSize: 11 }}>
        <span><i className="sw" style={{ background: stageColor(0) }} />Main</span>
        <span><i className="sw" style={{ background: stageColor(1) }} />Nurture</span>
      </div>
    </>
  );
}
