"use client";

/**
 * Nurture System — overview (the client-approved redesign; markup + classes
 * mirror mockups/nurture-system-mockup.html). The server page hands in the
 * precomputed snapshot, so it paints with data on the first frame; it then
 * re-polls /api/nurture/overview. The previous hub lives at /nurture/classic.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type OverviewTag, fmt, ago, ptTime, lastContactText, useNow, Ico, TypeBadge, Avatar, MappingPill, Batches,
  StatusCell, Skel, BarRow, ESP_ROWS, sourceValues, useToast, Toast, ActionsMenu,
} from "./shared";

interface CronInfo { at?: string; churned?: number; active?: number; manual?: boolean; checked?: number; newlyMapped?: number; remapped?: number }
export interface OverviewResp {
  automation: { churnSync: CronInfo | null; refresh: CronInfo | null; mappedTags: number };
  tiles: { activeClients: number; inNurture: number; contactsInQueues: number; statsCoverage: number; mappingOk: number; mappingBad: number; tagsWithErrors: number };
  tags: OverviewTag[];
  campaignsSyncedAt: string | null;
  builtAt: string;
}

// "Ends with" filters are answered instantly from per-tag catalogs computed
// with the stats (no query): domain endings — a last label (".in") or a public
// second level (".co.uk"), same rule as nurture_domain_endings in SQL — and
// personal mailbox domains ("gmail.com", same list as nurture_personal_domains).
// Anything else needs a scan of every queue, so it only runs when the user
// presses Enter (never while typing).
const CATALOG_RE = /^\.(?:[a-z0-9-]+|(?:co|com|org|net|gov|govt|edu|ac|ltd|plc|nic|mil|sch|nhs)\.[a-z0-9-]+)$/;
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ca", "ymail.com", "rocketmail.com",
  "aol.com", "aim.com", "outlook.com", "hotmail.com", "hotmail.ca", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "att.net", "comcast.net", "xfinity.com", "verizon.net",
  "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "spectrum.net",
  "protonmail.com", "proton.me", "fastmail.com", "zoho.com", "gmx.com", "mail.com",
]);
/** "in" → ".in", "co.uk" → ".co.uk", "@gmail.com" → "gmail.com". */
function normEnding(v: string, kind: "email" | "web"): string {
  let s = v.trim().toLowerCase();
  s = kind === "email" ? s.replace(/^@/, "") : s.replace(/^(https?:\/\/)?(www\.)?/, "");
  if (kind === "email" && PERSONAL_DOMAINS.has(s)) return s;
  return s && !s.startsWith(".") && CATALOG_RE.test("." + s) ? "." + s : s;
}

export default function NurtureOverview({ initial, initialError, serverNow }: { initial: OverviewResp | null; initialError: string | null; serverNow: number }) {
  const router = useRouter();
  const now = useNow(serverNow);
  const [data, setData] = useState<OverviewResp | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const { toast, show, hide } = useToast();

  // Polls send the builtAt we have; the server answers { unchanged } unless a
  // newer snapshot exists, so an idle open tab costs one tiny read a minute.
  // Returns whether it succeeded (failures show a Retry note, never silently).
  const builtAtRef = useRef<string | null>(initial?.builtAt ?? null);
  const load = useCallback(async (fresh = false): Promise<boolean> => {
    try {
      const qs = fresh ? "?fresh=1" : builtAtRef.current ? `?since=${encodeURIComponent(builtAtRef.current)}` : "";
      const r = await fetch(`/api/nurture/overview${qs}`, { cache: "no-store" });
      if (r.redirected || r.status === 401) { window.location.href = "/login"; return false; }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (!d.unchanged) { setData(d); builtAtRef.current = d.builtAt ?? null; }
      setError(null);
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  }, []);
  // Painted from the server snapshot; keep it current while the tab is open.
  const hadInitial = useRef(!!initial);
  useEffect(() => {
    if (!hadInitial.current) void load();
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  // ── filters
  const [search, setSearch] = useState("");
  const [type, setType] = useState<"all" | "Cleaning" | "Non-Cleaning" | "OS">("all");
  const [emailEnd, setEmailEnd] = useState("");
  const [webEnd, setWebEnd] = useState("");
  const [state, setState] = useState<"all" | "err" | "clean" | "map">("all");
  const clearAll = () => { setSearch(""); setType("all"); setEmailEnd(""); setWebEnd(""); setState("all"); };

  // How each "ends with" value is answered (see the note at the top).
  const emailKey = normEnding(emailEnd, "email"), webKey = normEnding(webEnd, "web");
  const domainsReady = (data?.tags ?? []).every((t) => !t.stats || t.stats.email_domains !== undefined);
  const emailMode = !emailKey ? null
    : PERSONAL_DOMAINS.has(emailKey) ? (domainsReady ? "domains" : "remote")
    : CATALOG_RE.test(emailKey) ? "catalog" : "remote";
  const webMode = !webKey ? null : CATALOG_RE.test(webKey) ? "catalog" : "remote";
  const remoteQuery = emailMode === "remote" || webMode === "remote"
    ? `email=${encodeURIComponent(emailMode === "remote" ? emailKey : "")}&web=${encodeURIComponent(webMode === "remote" ? webKey : "")}`
    : "";
  const [remote, setRemote] = useState<{ q: string; tags: Record<string, number> | null; error?: string } | null>(null);
  const remoteSeq = useRef(0);
  async function runRemoteSearch() {
    if (!remoteQuery || (remote?.q === remoteQuery && !remote.error)) return;
    const q = remoteQuery, seq = ++remoteSeq.current;
    setRemote({ q, tags: null });
    try {
      const r = await fetch(`/api/nurture/tags-matching?${q}`);
      const d = await r.json();
      if (seq !== remoteSeq.current) return;
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setRemote({ q, tags: d.tags || {} });
    } catch (e) {
      if (seq === remoteSeq.current) setRemote({ q, tags: {}, error: (e as Error).message });
    }
  }
  const remoteState: "none" | "needs-enter" | "loading" | "ready" | "error" =
    !remoteQuery ? "none"
    : remote?.q !== remoteQuery ? "needs-enter"
    : remote.error ? "error"
    : remote.tags === null ? "loading" : "ready";
  const onEndingKey = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") void runRemoteSearch(); };

  const rows = useMemo(() => {
    if (remoteState === "needs-enter" || remoteState === "loading") return [];
    const list = (data?.tags ?? []).filter((c) => {
      if (search && !c.tag.toLowerCase().includes(search.trim().toLowerCase())) return false;
      if (type !== "all" && c.type !== type) return false;
      if (state === "err" && !c.errors.length) return false;
      if (state === "clean" && c.errors.length) return false;
      if (state === "map" && c.mapping !== "bad") return false;
      if (emailMode === "catalog" && !((c.stats?.email_endings?.[emailKey] ?? 0) > 0)) return false;
      if (emailMode === "domains" && !((c.stats?.email_domains?.[emailKey] ?? 0) > 0)) return false;
      if (webMode === "catalog" && !((c.stats?.site_endings?.[webKey] ?? 0) > 0)) return false;
      if (remoteState === "ready" || remoteState === "error") {
        if (!((remote?.tags?.[c.tag] ?? remote?.tags?.[c.tag.toUpperCase()] ?? 0) > 0)) return false;
      }
      return true;
    });
    return list.sort((a, b) => (b.stats?.queue ?? -1) - (a.stats?.queue ?? -1) || a.tag.localeCompare(b.tag));
  }, [data, search, type, state, emailKey, webKey, emailMode, webMode, remoteState, remote]);

  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  // Expanding a row warms that client's page (its first queue page is served
  // from the server-side cache, so no queue query is spent here).
  const toggleRow = (tag: string) => {
    if (!openRows.has(tag)) router.prefetch(`/nurture/c/${encodeURIComponent(tag)}`);
    setOpenRows((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; });
  };
  const openClient = (tag: string) => router.push(`/nurture/c/${encodeURIComponent(tag)}`);
  // Hover intent (250ms) on a row warms the same.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRow = (tag: string | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (tag) hoverTimer.current = setTimeout(() => router.prefetch(`/nurture/c/${encodeURIComponent(tag)}`), 250);
  };
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  // ── actions
  const [churnBusy, setChurnBusy] = useState(false);
  async function syncChurnNow() {
    setChurnBusy(true);
    try {
      const r = await fetch("/api/nurture/churn-sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await load(); // the route already rebuilt the overview
      show(`Churn synced — ${d.churned} churned client${d.churned === 1 ? "" : "s"}`);
    } catch (e) { show(`Churn sync failed: ${(e as Error).message}`, { bad: true }); }
    setChurnBusy(false);
  }

  const a = data?.automation, tiles = data?.tiles;
  // Amber once a run is overdue: churn sync runs at 8 AM + 12 PM PT (gap ≤ 20h),
  // the nurture refresh (auto-map) every 3h.
  const stale = (iso: string | undefined, hours: number) => !!iso && now - new Date(iso).getTime() > hours * 3_600_000;
  async function rebuildNow() {
    show("Rebuilding the overview…", { ms: 120_000 });
    const ok = await load(true);
    show(ok ? "Overview up to date" : "Rebuild failed — try again in a minute", { bad: !ok });
  }
  const oldestStats = useMemo(() => {
    const at = (data?.tags ?? []).map((t) => t.stats?.computed_at).filter(Boolean) as string[];
    return at.length ? at.sort()[0] : null;
  }, [data]);
  const filtersOn = !!(search || type !== "all" || emailEnd || webEnd || state !== "all");

  return (
    <div className="nx -m-6">
      <div className="hd">
        <div>
          <h2>Nurture System</h2>
          <div className="sub">Re-engage soft-negative, out-of-office and sequence-finished leads across every client.</div>
        </div>
        <ActionsMenu>
          {(close) => (
            <>
              <button type="button" role="menuitem" disabled={churnBusy} onClick={() => { close(); void syncChurnNow(); }}>
                {Ico.sync}<span>Sync churned now<span className="mi-sub">Re-read the Client Tracker&apos;s churned list</span></span>
              </button>
              <button type="button" role="menuitem" onClick={() => { close(); void rebuildNow(); }}>
                {Ico.refresh}<span>Rebuild overview now<span className="mi-sub">Re-merge campaigns, mapping + cached numbers</span></span>
              </button>
              <hr />
              <Link href="/nurture/classic" role="menuitem" onClick={close}>
                {Ico.grid}<span>Open classic view<span className="mi-sub">Automation, bulk enable, auto-map &amp; campaign expansion</span></span>
              </Link>
            </>
          )}
        </ActionsMenu>
      </div>

      <div className="content">
        {error && (
          <div className="banner bad" style={{ marginTop: 0, marginBottom: 14 }}>{Ico.warnTri}{data ? "Couldn’t refresh the overview — showing the last numbers loaded." : `Couldn’t load the Nurture overview: ${error}`}<button type="button" className="linkish" style={{ marginLeft: "auto", color: "inherit" }} onClick={() => void load()}>Retry</button></div>
        )}

        <div className="auto-row">
          <div className="card auto">
            <div className="ic">{Ico.sync}</div>
            <div>
              <div className="lab">Sync Churned</div>
              <div className="val">Daily · 8:00 AM &amp; 12:00 PM PT</div>
              <div className="meta">
                {!data ? <Skel w={180} /> : a?.churnSync?.at ? (
                  <><span className={stale(a.churnSync.at, 26) ? "dot-warn" : "dot-live"} />Last run {ptTime(a.churnSync.at, now)} · {fmt(a.churnSync.active ?? tiles?.activeClients)} clients · {a.churnSync.manual ? "manual" : "automatic"}</>
                ) : (<><span className="dot-idle" />Waiting for the first scheduled run</>)}
              </div>
            </div>
          </div>
          <div className="card auto">
            <div className="ic">{Ico.refresh}</div>
            <div>
              <div className="lab">Nurture Refresh</div>
              <div className="val">~10 min after each sync</div>
              <div className="meta">
                {!data ? <Skel w={180} /> : a?.refresh?.at ? (
                  <><span className={stale(a.refresh.at, 4) ? "dot-warn" : "dot-live"} />Last run {ptTime(a.refresh.at, now)} · {fmt(a.mappedTags)} tags mapped · automatic</>
                ) : (<><span className="dot-idle" />{fmt(a?.mappedTags)} tags mapped · first run pending</>)}
              </div>
            </div>
          </div>
          <div className="card auto">
            <div className="ic">{Ico.tick}</div>
            <div>
              <div className="lab">Mapping</div>
              <div className="val">Auto-confirmed</div>
              <div className="meta">No manual confirm step — new campaigns map themselves</div>
            </div>
          </div>
        </div>

        <div className="stats">
          <div className="stat card"><div className="k">Clients in nurture</div><div className="v tnum">{tiles ? fmt(tiles.inNurture) : <Skel />}{tiles && <small>of {fmt(tiles.activeClients)} active</small>}</div></div>
          <div className="stat card"><div className="k">Contacts in queues</div><div className="v tnum">{tiles ? fmt(tiles.contactsInQueues) : <Skel w={90} />}{tiles && tiles.statsCoverage < tiles.activeClients && <small>· {tiles.statsCoverage} of {tiles.activeClients} tags counted</small>}</div></div>
          <div className="stat card"><div className="k">Mapping correct</div><div className="v tnum">{tiles ? fmt(tiles.mappingOk) : <Skel />}{tiles && <small>· {fmt(tiles.mappingBad)} need{tiles.mappingBad === 1 ? "s" : ""} attention</small>}</div></div>
          <div className="stat card"><div className="k">Tags with errors</div><div className="v tnum" style={{ color: "var(--amber-fg)" }}>{tiles ? fmt(tiles.tagsWithErrors) : <Skel />}</div></div>
        </div>

        <div className="sec">
          <h3>Client tag overview</h3>
          <div className="d">Campaigns, mapping, nurture batches, queue and health for every tag. <b style={{ color: "var(--foreground)" }}>Click a row to expand its nurture overview inline</b> — campaigns, pipeline and analytics — then open the full view + queue from there.</div>
        </div>

        <div className="card filters">
          <div className="field">{Ico.search}<input type="text" aria-label="Search client tag" placeholder="Search client tag…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <span className="lbl">Type</span>
          <div className="seg">
            {([["all", "All"], ["Cleaning", "Cleaning"], ["Non-Cleaning", "Non-cleaning"], ["OS", "OS"]] as const).map(([v, l]) => (
              <button key={v} type="button" className={type === v ? "on" : ""} aria-pressed={type === v} onClick={() => setType(v)}>{l}</button>
            ))}
          </div>
          <div className="field"><input type="text" aria-label="Email ends with" placeholder="Email ends with…" style={{ minWidth: 150 }} value={emailEnd} onChange={(e) => setEmailEnd(e.target.value)} onKeyDown={onEndingKey} /></div>
          <div className="field"><input type="text" aria-label="Website ends with" placeholder="Website ends with…" style={{ minWidth: 150 }} value={webEnd} onChange={(e) => setWebEnd(e.target.value)} onKeyDown={onEndingKey} /></div>
          <select aria-label="State" value={state} onChange={(e) => setState(e.target.value as typeof state)}>
            <option value="all">All states</option>
            <option value="err">Has errors</option>
            <option value="clean">Healthy</option>
            <option value="map">Mapping issue</option>
          </select>
          {remoteState === "loading" && <span className="searching">{Ico.spinner}Searching every queue…</span>}
          <button type="button" className="clear" onClick={clearAll}>Clear</button>
        </div>

        <div className="card tbl">
          <div className="tbl-scroll">
            <table>
              <thead>
                <tr>
                  <th>Client tag</th><th>Campaigns</th><th>Mapping</th><th>Nurture batches</th><th>Last contact</th><th className="num">Queue</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {!data ? (
                  Array.from({ length: 8 }, (_, i) => (
                    <tr key={i}>{Array.from({ length: 8 }, (_, j) => <td key={j}>{j < 7 ? <Skel w={j === 0 ? 110 : 60} /> : null}</td>)}</tr>
                  ))
                ) : remoteState === "needs-enter" ? (
                  <tr><td colSpan={8}><div className="empty">Press <b>Enter</b> to search every client&apos;s queue for contacts ending in “{emailMode === "remote" ? emailKey : webKey}”. Endings like <b>.in</b>, <b>.co.uk</b> or <b>gmail.com</b> filter instantly.</div></td></tr>
                ) : remoteState === "loading" ? (
                  <tr><td colSpan={8}><div className="empty">Searching every client&apos;s queue… this can take up to a minute.</div></td></tr>
                ) : remoteState === "error" ? (
                  <tr><td colSpan={8}><div className="empty">The search didn&apos;t finish ({remote?.error}). Press <b>Enter</b> in the filter to try again.</div></td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8}><div className="empty">{filtersOn ? "No client tags match these filters." : "No active client tags."}</div></td></tr>
                ) : rows.map((c) => {
                  const isOpen = openRows.has(c.tag);
                  return (
                    <Fragment key={c.tag}>
                      <tr className={`link${isOpen ? " open" : ""}`} onClick={() => toggleRow(c.tag)} onMouseEnter={() => hoverRow(c.tag)} onMouseLeave={() => hoverRow(null)}
                        tabIndex={0} aria-expanded={isOpen}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRow(c.tag); } }}>
                        <td>
                          <div className="tagcell">
                            <Avatar tag={c.tag} />
                            <div><div className="tagname">{c.tag}</div><TypeBadge type={c.type} /></div>
                          </div>
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <span className="camp"><span className="d" style={{ background: c.mainActive ? "var(--emerald-fg)" : "#d0d0d6" }} />{c.mainActive} main</span>
                          {" "}&nbsp;{" "}
                          <span className="camp"><span className="d" style={{ background: c.nurtureActive ? "var(--violet-fg)" : "#d0d0d6" }} />{c.nurtureActive} nurture</span>
                        </td>
                        <td><MappingPill mapping={c.mapping} issues={c.mapIssues} /></td>
                        <td><Batches b={c.batches} extra={c.extraLiveBatches} /></td>
                        <td className="muted" style={{ fontSize: 12.5 }}>{lastContactText(c, now)}</td>
                        <td className="num mono">{c.stats ? fmt(c.stats.queue) : <span className="muted" title="Queue numbers haven’t been computed yet">…</span>}</td>
                        <td><StatusCell errors={c.errors} /></td>
                        <td style={{ textAlign: "right" }}>{Ico.chevron}</td>
                      </tr>
                      {isOpen && (
                        <tr className="exprow"><td colSpan={8}><ExpandInner c={c} now={now} onOpen={() => openClient(c.tag)} /></td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="foot">
          <b>Nurture batches</b> N1·N2·N3: <span className="batch b-on">live</span> <span className="batch b-wait">waiting</span> <span className="batch b-off">not in use</span>. &nbsp;<b>Mapping</b> auto-confirms — <span className="pill p-ok" style={{ fontSize: 10 }}>Mapped</span> / <span className="pill p-bad" style={{ fontSize: 10 }}>Needs attention</span>. &nbsp;<b>Last contact</b> is per tag. Hover a <b>Status</b> badge for the fix.
          {data && (
            <><br />Queue numbers are recomputed every few hours{oldestStats ? ` (oldest ${ago(oldestStats, now)})` : ""} · campaigns synced {ago(data.campaignsSyncedAt, now)}.</>
          )}
        </div>
      </div>
      <Toast toast={toast} onHide={hide} />
    </div>
  );
}

/* inline expandable row → quick nurture overview for the client, in place */
function ExpandInner({ c, now, onOpen }: { c: OverviewTag; now: number; onOpen: () => void }) {
  const s = c.stats;
  const queue = s?.queue ?? 0, added = c.added ?? 0;
  const pipe: Array<[string, number | null]> = [
    ["Synced", s ? queue + added : null],
    ["Ready", s ? s.ready : null],
    ["Routed", c.added],
    ["Sending", c.sendingLeads],
  ];
  const src = sourceValues(s, c.stoppedRecovered);
  const srcTotal = src.reduce((t, r) => t + r.value, 0);
  const espTotal = ESP_ROWS.reduce((t, r) => t + Number(s?.esps?.[r.key] ?? 0), 0);
  return (
    <div className="expand-inner" onClick={(e) => e.stopPropagation()}>
      <div className="exp-col">
        <div className="eh">Campaigns &amp; mapping</div>
        <div className="exp-camp">
          <div><span className="camp"><span className="d" style={{ background: c.mainActive ? "var(--emerald-fg)" : "#d0d0d6" }} />{c.mainActive} main active</span></div>
          <div><span className="camp"><span className="d" style={{ background: c.nurtureActive ? "var(--violet-fg)" : "#d0d0d6" }} />{c.nurtureActive} nurture active</span></div>
          <div style={{ marginTop: 3 }}><MappingPill mapping={c.mapping} issues={c.mapIssues} /></div>
          <div style={{ marginTop: 4 }}><Batches b={c.batches} extra={c.extraLiveBatches} /></div>
          <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={onOpen}>Open full view &amp; queue →</button>
        </div>
      </div>
      <div className="exp-col">
        <div className="eh">Nurture pipeline</div>
        <div className="exp-pipe">
          {pipe.map(([l, v]) => (
            <div key={l} className="ps"><div className="pl">{l}</div><div className="pn tnum">{v == null ? "—" : fmt(v)}</div></div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 9 }}>
          <b style={{ color: "var(--foreground)", fontWeight: 600 }} className="tnum">{s ? fmt(queue) : "—"}</b> in queue · last contact {lastContactText(c, now).toLowerCase()}
        </div>
      </div>
      <div className="exp-col">
        <div className="eh">Source breakdown</div>
        {s ? src.map((r) => <BarRow key={r.key} compact label={r.label} value={r.value} total={srcTotal} color={r.color} />)
          : <div className="muted" style={{ fontSize: 12 }}>Numbers are being computed…</div>}
      </div>
      <div className="exp-col">
        <div className="eh">ESP routing</div>
        {s ? ESP_ROWS.map((r) => (
          <div key={r.key} className="bar-row" style={{ marginTop: 7 }}>
            <span className="bl" style={{ width: 58, fontSize: 11 }}>{r.label}</span>
            <span className="bar-track"><span className="bar-fill" style={{ width: `${espTotal ? Math.round((Number(s.esps?.[r.key] ?? 0) / espTotal) * 100) : 0}%`, background: r.color }} /></span>
            <span className="bn" style={{ fontSize: 11 }}>{fmt(Number(s.esps?.[r.key] ?? 0))}</span>
          </div>
        )) : <div className="muted" style={{ fontSize: 12 }}>Numbers are being computed…</div>}
      </div>
    </div>
  );
}
