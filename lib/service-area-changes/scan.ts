/**
 * Service-area removals — the scan. Read-only everywhere: it only lists.
 *
 * Kinds of work, each a resumable task saved after every window:
 *   search — Bison's lead search for each removed place in each campaign (it
 *            matches custom variables, so "Wheaton" / "60187" find those leads in
 *            seconds). Fills the review list fast; a search Bison can't answer
 *            (common words are slow) is skipped — the full read covers it.
 *   queue  — the client's pending nurture-queue rows (replies, sequence-finished,
 *            legacy), read in index order.
 *   full   — every lead of every campaign (archived too), in the background.
 *            Catches what search can't (a state written "IL" rather than
 *            "Illinois") and lists leads with no location. Approval waits for it.
 *   enrich — after each pass, every listed lead's other rows in our database (the
 *            location it wrote in a reply, its nurture rows) join its signals; the
 *            final pass also reads its record in the client's other instances.
 *            A conflicting location turns "in" into "needs checking".
 * On the removal day a top-up (search + queue only) finds leads that arrived
 * in the removed places since. Every hit is re-decided exactly by places.ts.
 */
import supabase from "@/lib/supabase";
import { listCampaigns, sweepCampaignLeadsCursor, lookUpCampaign, getLeadCampaigns, type OutboundLead } from "@/lib/outboundhero-api";
import { BISON_INSTANCES } from "@/lib/bison-instances-shared";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { getCampaignMap } from "@/lib/nurture/campaign-map";
import { NURTURE_EXCLUDED_AI_CATEGORIES as EXCLUDED_AI_CATEGORIES } from "@/lib/nurture/excluded-categories";
import { inputFromCustomVars, searchTermFor, type LocationInput } from "@/lib/service-area-changes/places";
import {
  foldSightings, leadsPage, markXchecked, saveTaskWindow,
  type Change, type NewTask, type ScanCampaign, type Sighting, type Task,
} from "@/lib/service-area-changes/store";

const isNurtureName = (name: string) => /\[nurture(?:\s*\d+)?\]|\(nurture\)/i.test(name);

/**
 * Every campaign of the client in all four instances, every status (a client's
 * leads can sit in an old instance or an archived campaign): named "TAG: …"
 * (the same rule as the rest of Reply Router), plus any nurture campaign mapped
 * to it whose name carries no other client's tag (a mis-mapped campaign of
 * another client is never treated as this one's).
 */
export async function clientCampaigns(clientTag: string): Promise<ScanCampaign[]> {
  const tag = clientTag.toUpperCase();
  const mapped = new Set((await getCampaignMap(tag)).map((m) => `${m.bison_instance}:${m.campaign_id}`));
  const out: ScanCampaign[] = [];
  for (const inst of BISON_INSTANCES) {
    for (const c of await listCampaigns(inst.key, { strict: true })) {
      const nameTag = extractTagFromCampaignName(c.name).toUpperCase();
      const named = nameTag === tag;
      const isMapped = mapped.has(`${inst.key}:${c.id}`) && !nameTag;
      if (!named && !isMapped) continue;
      out.push({ instance: inst.key, id: c.id, name: c.name, status: String(c.status || "").toLowerCase(), kind: isMapped || isNurtureName(c.name) ? "nurture" : "main", leads: c.total_leads ?? 0 });
    }
  }
  return out;
}

/** Beyond this many (campaign × place) searches, skip the quick search — the full read does it all. */
const SEARCH_LIMIT = 600;

/**
 * The scan's tasks. Normal: search (per campaign × place term), queue (3 sources),
 * full read (per campaign). Top-up (removal day): search + queue only.
 */
export function scanTasks(change: Change, campaigns: ScanCampaign[], topup = false): NewTask[] {
  const live = campaigns.filter((c) => c.leads !== 0);
  const terms = [...new Set(change.places.map(searchTermFor))];
  const search = live.length * terms.length <= SEARCH_LIMIT;
  return [
    ...(search ? live.flatMap((c) => terms.map((term) => ({
      kind: "search" as const, instance: c.instance, campaignId: c.id, campaignName: c.name, campaignKind: c.kind, term, src: null, total: null,
    }))) : []),
    ...(["reply", "seq", "legacy"] as const).map((src) => ({
      kind: "queue" as const, instance: null, campaignId: null, campaignName: null, campaignKind: null, term: topup ? "topup" : null, src, total: null,
    })),
    ...(topup ? [] : live.map((c) => ({
      kind: "full" as const, instance: c.instance, campaignId: c.id, campaignName: c.name, campaignKind: c.kind, term: null, src: null, total: c.leads,
    }))),
  ];
}

/** This campaign's entry in a lead's lead_campaign_data (an array in listings; an object in some older answers). */
function campaignEntry(l: OutboundLead, campaignId: number): { status?: string; replies?: number } | null {
  const d = l.lead_campaign_data as unknown;
  if (Array.isArray(d)) return (d as Array<{ campaign_id?: number; status?: string; replies?: number }>).find((x) => x?.campaign_id === campaignId) ?? (d.length === 1 ? d[0] : null);
  return d && typeof d === "object" ? (d as { status?: string; replies?: number }) : null;
}

function bisonSighting(l: OutboundLead, task: Task): Sighting {
  const e = campaignEntry(l, task.campaignId!);
  const status = e?.status ?? null;
  return {
    email: l.email,
    name: [l.first_name, l.last_name].filter(Boolean).join(" ").trim() || null,
    company: l.company ?? null,
    input: inputFromCustomVars(l.custom_variables),
    replied: status === "replied" || (e?.replies ?? 0) > 0,
    member: {
      instance: task.instance!, campaignId: task.campaignId!, campaignName: task.campaignName ?? "", kind: task.campaignKind ?? "main",
      leadId: l.id, leadStatus: status,
    },
  };
}

export interface WindowResult { cursor: string | null; done: boolean; scanned: number; hits: number; error?: string }

/** One window of a search or full-read task. */
async function bisonWindow(change: Change, task: Task, windowMs: number, holder: string): Promise<WindowResult> {
  const r = await sweepCampaignLeadsCursor(task.instance!, task.campaignId!, task.cursor, {
    maxMs: windowMs, maxLeads: 4000, search: task.kind === "search" ? task.term ?? undefined : undefined,
  });
  const { hits } = await foldSightings(change.id, change.places, r.leads.map((l) => bisonSighting(l, task)), { holder });
  if (!r.done && r.leads.length === 0) {
    // No progress: Bison refused or the campaign is gone. A deleted campaign has nothing left to check.
    const look = await lookUpCampaign(task.instance!, task.campaignId!).catch(() => null);
    if (look === "gone") return { cursor: null, done: true, scanned: 0, hits: 0 };
    return { cursor: r.nextCursor, done: false, scanned: 0, hits: 0, error: "Email Bison didn't answer — will try again" };
  }
  return { cursor: r.nextCursor, done: r.done, scanned: r.leads.length, hits };
}

// ── the nurture queue (our database) ─────────────────────────────────────────

const QUEUE_PAGE = 1000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parseCursor = (raw: string | null): { ts: string; id: number } | null => {
  const i = (raw ?? "").lastIndexOf("|");
  if (i <= 0) return null;
  const ts = raw!.slice(0, i), id = Number(raw!.slice(i + 1));
  return ts && Number.isFinite(id) ? { ts, id } : null;
};
const after = (col: string, c: { ts: string; id: number }) => `${col}.gt."${c.ts}",and(${col}.eq."${c.ts}",id.gt.${c.id})`;
const excludedList = `(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`;
const legacyInput = (raw: unknown): LocationInput => {
  const f = (raw ?? {}) as Record<string, unknown>;
  const s = (k: string[]) => { for (const x of k) { const v = f[x]; if (typeof v === "string" && v.trim()) return v.trim(); } return null; };
  return { city: s(["City", "city"]), state: s(["State", "state"]), zip: s(["Zip", "ZIP", "zip", "Zip Code", "Postal Code"]), address: s(["Address", "address", "Street Address"]) };
};
const QUEUE_LABEL = { reply: "Nurture queue · replies", seq: "Nurture queue · finished sequences", legacy: "Nurture queue · legacy" } as const;

/** Read pending queue rows of one source until the window ends, in (time, id) order — the pending-queue indexes' order. */
async function queueWindow(change: Change, task: Task, deadline: number, holder: string): Promise<WindowResult> {
  const tag = change.clientTag;
  let cursor = task.cursor;
  let scanned = 0, hits = 0;
  while (Date.now() < deadline) {
    const c = parseCursor(cursor);
    let rows: Record<string, unknown>[] = [];
    let timeCol = "reply_time";
    if (task.src === "reply") {
      let q = supabase.from("replies")
        .select("id, lead_email, first_name, last_name, company_name, city, state, address, audit_city, audit_state, reply_time")
        .eq("client_tag", tag).is("nurture_added_at", null).not("nurture_skipped", "is", true).not("reply_time", "is", null)
        .not("reply_we_got", "is", null).neq("reply_we_got", "")
        .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.${excludedList}`);
      if (c) q = q.or(after("reply_time", c));
      const { data, error } = await q.order("reply_time", { ascending: true }).order("id", { ascending: true }).limit(QUEUE_PAGE);
      if (error) return { cursor, done: false, scanned, hits, error: `queue read failed: ${error.message}` };
      rows = data ?? [];
    } else if (task.src === "seq") {
      timeCol = "sequence_finished_at";
      let q = supabase.from("nurture_sequence_finished")
        .select("id, email, first_name, last_name, company, custom_variables, sequence_finished_at")
        .eq("client_tag", tag).is("added_at", null).not("skipped", "is", true).not("sequence_finished_at", "is", null);
      if (c) q = q.or(after("sequence_finished_at", c));
      const { data, error } = await q.order("sequence_finished_at", { ascending: true }).order("id", { ascending: true }).limit(QUEUE_PAGE);
      if (error) return { cursor, done: false, scanned, hits, error: `queue read failed: ${error.message}` };
      rows = data ?? [];
    } else {
      timeCol = "reply_at";
      let q = supabase.from("nurture_legacy_leads")
        .select("id, lead_email, first_name, last_name, company, raw_fields, reply_at")
        .eq("client_tag", tag).is("nurture_added_at", null).not("nurture_skipped", "is", true).not("reply_at", "is", null)
        .or(`original_ai_category.is.null,original_ai_category.not.in.${excludedList}`);
      if (c) q = q.or(after("reply_at", c));
      const { data, error } = await q.order("reply_at", { ascending: true }).order("id", { ascending: true }).limit(QUEUE_PAGE);
      if (error) return { cursor, done: false, scanned, hits, error: `queue read failed: ${error.message}` };
      rows = data ?? [];
    }
    if (!rows.length) return { cursor, done: true, scanned, hits };
    const sightings: Sighting[] = rows.map((r) => {
      const email = String(r.lead_email ?? r.email ?? "");
      const input: LocationInput = task.src === "reply"
        ? { city: r.city as string, state: r.state as string, address: r.address as string, replyCity: r.audit_city as string, replyState: r.audit_state as string }
        : task.src === "seq" ? inputFromCustomVars(r.custom_variables as Array<{ name: string; value: string }>) : legacyInput(r.raw_fields);
      return {
        email,
        name: [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || null,
        company: (r.company_name ?? r.company ?? null) as string | null,
        input,
        replied: task.src !== "seq", // a reply / legacy row is there because the lead replied
        member: { instance: "queue", campaignId: 0, campaignName: QUEUE_LABEL[task.src!], kind: "queue", leadId: Number(r.id), leadStatus: task.src },
      };
    });
    hits += (await foldSightings(change.id, change.places, sightings, { holder })).hits;
    scanned += rows.length;
    const last = rows[rows.length - 1];
    cursor = `${String(last[timeCol])}|${Number(last.id)}`;
    if (rows.length < QUEUE_PAGE) return { cursor, done: true, scanned, hits };
    await pause(150); // gentle on the shared database
  }
  return { cursor, done: false, scanned, hits };
}

// ── enrichment: our database, and the client's other instances ──────────────

const ENRICH_CHUNK = 50;
const ROW_CAP = 1000; // PostgREST's response cap: a full page means rows may be missing

/** Every row for these emails (any letter case seen) in one table — split until no answer is capped. */
async function rowsFor(table: "replies" | "nurture_sequence_finished" | "nurture_legacy_leads", col: string, select: string, tag: string, emails: string[]): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase.from(table).select(select).eq("client_tag", tag).in(col, emails).limit(ROW_CAP);
  if (error) throw new Error(`database read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  if (rows.length < ROW_CAP) return rows;
  if (emails.length === 1) throw new Error(`more than ${ROW_CAP} ${table} rows for one email`);
  const mid = Math.ceil(emails.length / 2);
  return [...await rowsFor(table, col, select, tag, emails.slice(0, mid)), ...await rowsFor(table, col, select, tag, emails.slice(mid))];
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/**
 * Add every listed lead's own rows in our database (reply location, nurture
 * rows) to its signals; the final pass (term "final") also reads the lead's
 * record in each of the client's other instances, so two records disagreeing
 * (Wheaton in one, Naperville in another) make it "needs checking".
 */
async function enrichWindow(change: Change, task: Task, deadline: number, holder: string): Promise<WindowResult> {
  const tag = change.clientTag;
  const crossCheck = task.term === "final";
  const clientCamps = new Map<string, Map<number, ScanCampaign>>();
  for (const c of change.campaigns) {
    if (!clientCamps.has(c.instance)) clientCamps.set(c.instance, new Map());
    clientCamps.get(c.instance)!.set(c.id, c);
  }
  let cursor = task.cursor ?? "";
  let scanned = 0;
  while (Date.now() < deadline) {
    const page = await leadsPage(change.id, cursor, ENRICH_CHUNK);
    if (!page.length) return { cursor, done: true, scanned, hits: 0 };
    const spellings = [...new Set(page.flatMap((p) => [p.email, ...p.raw]))];
    const [rep, seq, leg] = await Promise.all([
      rowsFor("replies", "lead_email", "lead_email, city, state, address, audit_city, audit_state", tag, spellings),
      rowsFor("nurture_sequence_finished", "email", "email, custom_variables", tag, spellings),
      rowsFor("nurture_legacy_leads", "lead_email", "lead_email, raw_fields", tag, spellings),
    ]);
    const sightings: Sighting[] = [
      ...rep.map((r) => ({ email: String(r.lead_email), name: null, company: null, input: { city: r.city as string, state: r.state as string, address: r.address as string, replyCity: r.audit_city as string, replyState: r.audit_state as string } })),
      ...seq.map((r) => ({ email: String(r.email), name: null, company: null, input: inputFromCustomVars(r.custom_variables as Array<{ name: string; value: string }>) })),
      ...leg.map((r) => ({ email: String(r.lead_email), name: null, company: null, input: legacyInput(r.raw_fields) })),
    ];
    if (crossCheck) {
      const todo = page.filter((p) => !p.xchecked);
      await pool(todo, 6, async (p) => {
        for (const [instance, camps] of clientCamps) {
          if (p.instances.includes(instance)) continue; // already read there by the full read
          const live = await getLeadCampaigns(instance, p.email); // throws on a bad answer → window retried
          if (!live) continue;
          const inClient = live.campaigns.filter((c) => camps.has(c.campaignId));
          if (!inClient.length) continue; // not this client's lead there
          for (const c of inClient) {
            const cp = camps.get(c.campaignId)!;
            sightings.push({
              email: p.email, name: null, company: null, input: inputFromCustomVars(live.customVariables),
              replied: c.status === "replied",
              member: { instance, campaignId: c.campaignId, campaignName: cp.name, kind: cp.kind, leadId: live.leadId, leadStatus: c.status },
            });
          }
        }
      });
    }
    await foldSightings(change.id, change.places, sightings, { onlyExisting: true, holder });
    if (crossCheck) await markXchecked(change.id, page.filter((p) => !p.xchecked).map((p) => p.email));
    scanned += page.length;
    cursor = page[page.length - 1].email;
    if (page.length < ENRICH_CHUNK) return { cursor, done: true, scanned, hits: 0 };
    await pause(100);
  }
  return { cursor, done: false, scanned, hits: 0 };
}

/** Run one window of a task and save it (persist-then-advance). A lost lease stops the run (no save). */
export async function runTaskWindow(change: Change, task: Task, windowMs: number, holder: string): Promise<void> {
  const deadline = Date.now() + windowMs;
  let r: WindowResult;
  try {
    r = task.kind === "queue" ? await queueWindow(change, task, deadline, holder)
      : task.kind === "enrich" ? await enrichWindow(change, task, deadline, holder)
      : await bisonWindow(change, task, windowMs, holder);
  } catch (e) {
    if ((e as Error)?.name === "LeaseLost" || /Lost the hold/.test((e as Error)?.message ?? "")) throw e;
    r = { cursor: task.cursor, done: false, scanned: 0, hits: 0, error: (e as Error).message || "failed" };
  }
  // A search that keeps timing out (Bison is slow on common words like
  // "Washington") gives up after two tries: the full read covers it anyway.
  await saveTaskWindow(task.id, r, task.kind === "search" ? { maxAttempts: 2, giveUp: "skipped" } : {});
}
