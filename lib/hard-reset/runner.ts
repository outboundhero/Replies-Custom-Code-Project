/**
 * Hard Reset — the background runner. Leases one reset at a time and works it in
 * small, saved steps until the ~285s budget, then re-triggers itself; the
 * every-2-minutes cron picks up anything left. Order (archiving last, because
 * Email Bison can't undo it and the client keeps sending on its old campaigns
 * until then):
 *
 *   creating    the 12 new campaigns, one at a time, each read back (onboarding's builder)
 *   attaching   every inbox tagged with the client's tag (less Reserve / Burnt ones) → all 6 new campaigns per instance, verified by count
 *   repointing  the nurture map → the 6 new nurture campaigns; batch records cleared
 *   requeueing  (Nurture reset) every "already nurtured" mark of the client cleared, in chunks — each backed up first
 *   archiving   a last check that everything new is in place (and campaigns made since the start are added),
 *               then each old campaign — checked by id and name, paused, archived, verified
 *   cancelling  (before nurture is switched only) the new campaigns are deleted — never one with leads
 *
 * A step that keeps failing (5 tries in a row) stops the reset as "failed"; "Try
 * again" resumes it at that step (a campaign build it stopped at is cleaned up and
 * made again). When Email Bison's per-minute request allowance is used up (another
 * job, say a big Lead Mover move), writes wait as long as it asks and the reset
 * waits for the next round rather than counting that as a failure.
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import {
  archiveCampaignOnce, attachSendersOnce, countCampaignSenders, createTag, deleteCampaign, getCampaignRaw,
  listCampaigns, listCampaignSenders, listSenderEmailsByTag, listTags, lookUpCampaign, pauseCampaign,
} from "@/lib/outboundhero-api";
import { buildCampaign, BUILD_PREFIX, CHECK_PREFIX } from "@/lib/onboarding/build-campaigns";
import { realBisonOps } from "@/lib/onboarding/bison-ops";
import { getCampaignMap } from "@/lib/nurture/campaign-map";
import { detectCampaignEsp } from "@/lib/nurture/esp";
import { markTagStatsDirty } from "@/lib/nurture/overview";
import { dropFirstPageCache } from "@/lib/nurture/queue-removals";
import { acquireHeavyLease, renewHeavyLease, releaseHeavyLease } from "@/lib/nurture/heavy-lease";
import { rebuildOverviewSnapshot } from "@/lib/nurture/overview-snapshot";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { logActivity, logError } from "@/lib/errors";
import { planNewCampaigns, instanceName, clientInboxes, oldCampaignInboxes, currentCampaigns, isNurtureCampaign } from "@/lib/hard-reset/plan";
import {
  getReset, heartbeat, leaseReset, patchReset, releaseLease, LeaseLost,
  type ArchiveRecord, type AttachState, type BuildRecord, type HardReset, type RequeueState, type ResetStatus,
} from "@/lib/hard-reset/store";

/** A Nurture reset makes only the 6 nurture campaigns (3 per instance); a Hard Reset all 12. */
const isNurtureReset = (r: HardReset) => r.kind === "nurture";
const newCount = (r: HardReset) => (isNurtureReset(r) ? 6 : 12);

const MAX_ATTEMPTS = 5;
const ATTACH_BATCH = 50;
/** A build takes seconds — or a few minutes when Email Bison makes it wait (rate limit); one isn't started with less time than this left. */
const BUILD_MIN_MS = 180_000;
/** No step is started with less time than this left. */
const STEP_MIN_MS = 35_000;
/** Cron rounds (~2 min apart) a cancel waits for Email Bison's background deletes. */
const CANCEL_ROUNDS = 10;
const gone = (status: string) => /archiv|delet/i.test(status);
const nowIso = () => new Date().toISOString();

function baseUrl(): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}

/** Fire-and-forget kick of the runner (continue one reset, or pick the next). */
export function triggerHardResetRunner(id?: number): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  fetch(`${baseUrl()}/api/cron/hard-reset-jobs${id ? `?id=${id}` : ""}`, { headers: { "x-cron-secret": secret }, signal: AbortSignal.timeout(3000) }).catch(() => {});
}

/** A problem that retrying won't fix: the reset stops here until someone looks. */
class Stop extends Error { constructor(msg: string) { super(msg); this.name = "Stop"; } }
/** Nothing wrong, just not now (Email Bison's rate limit): carried on next round, not counted as a failure. */
class Wait extends Error { constructor(msg: string) { super(msg); this.name = "Wait"; } }

const log = (r: HardReset, what: string, details: Record<string, unknown> = {}) =>
  logActivity("hard-reset", what, { client_tag: r.clientTag, details: { reset_id: r.id, ...details } }).catch(() => {});

async function save(r: HardReset, holder: string, fields: Record<string, unknown>): Promise<void> {
  if (!(await patchReset(r.id, fields, { holder }))) throw new LeaseLost(r.id);
}
async function moveTo(r: HardReset, holder: string, from: ResetStatus, to: ResetStatus, extra: Record<string, unknown> = {}): Promise<void> {
  if (!(await patchReset(r.id, { status: to, attempts: 0, error: null, ...extra }, { from: [from], holder }))) throw new LeaseLost(r.id);
  await log(r, `step-${to}`);
}

// ── creating ────────────────────────────────────────────────────────────────

/** Plan problems that pass by themselves (a sheet or Email Bison didn't answer): retried. */
const PASSING = /^Couldn't (read|check) /;
/** An unanswered create gets 10 minutes to show up in Email Bison: waited out, not counted as a failure. */
const WAITING = /can run again in about/;

/**
 * A build cut off part-way (the function ended mid-build) leaves a "building" record. If the
 * campaign got all the way to its real name, it's the one campaign with that name that isn't
 * an old one, made after the build started — it's taken as made. Otherwise the record becomes
 * an unanswered try, and onboarding's planner holds the slot until its draft is dealt with.
 */
async function settleCutOff(r: HardReset, holder: string): Promise<void> {
  const cut = r.built.filter((b) => b.state === "building").length;
  if (!cut) return;
  const old = new Set(r.archive.map((c) => `${c.instance}:${c.id}`));
  const ours = new Set(r.built.filter((b) => b.campaignId != null).map((b) => `${b.instance}:${b.campaignId}`));
  const settled: BuildRecord[] = [];
  for (const b of r.built) {
    if (b.state !== "building") { settled.push(b); continue; }
    const named = (await listCampaigns(b.instance, { search: r.clientTag, strict: true }))
      .filter((c) => c.name === b.name && !gone(String(c.status ?? "")) && !old.has(`${b.instance}:${c.id}`) && !ours.has(`${b.instance}:${c.id}`));
    if (named.length === 1) {
      const raw = await getCampaignRaw(b.instance, named[0].id);
      if (!raw) throw new Error(`Couldn't read #${named[0].id} in ${instanceName(b.instance)}`);
      const made = Date.parse(String(raw.created_at ?? ""));
      if (Number.isFinite(made) && made >= Date.parse(b.at) - 60_000) {
        settled.push({ ...b, state: "created", campaignId: named[0].id, unsure: false, note: "Made by this reset (found after its run was cut off).", at: nowIso() });
        ours.add(`${b.instance}:${named[0].id}`);
        continue;
      }
    }
    settled.push({ ...b, state: "failed", unsure: true, note: `The run was cut off while making it — it may be in Email Bison as “${BUILD_PREFIX}${b.name}” or “${CHECK_PREFIX}${b.name}”.` });
  }
  r.built = settled;
  await save(r, holder, { built_json: r.built });
  await log(r, "build-cut-off", { records: cut });
}

/**
 * After "Try again": a draft an earlier try left in Email Bison — parked as "BUILDING — …" /
 * "CHECK COPY — …", or made by a create that never answered — is this reset's own, so it's
 * deleted (only under exactly that name, only with no leads) and its campaign built again.
 * Email Bison deletes in the background; until the draft is gone this says to wait (true).
 * A draft that isn't plainly ours is left, and onboarding's planner stops on it.
 */
async function clearOwnDrafts(r: HardReset, holder: string): Promise<boolean> {
  let waiting = false, changed = false;
  const built: BuildRecord[] = [];
  for (const b of r.built) {
    if (b.state !== "failed" || b.cleared) { built.push(b); continue; }
    const names = [`${BUILD_PREFIX}${b.name}`, `${CHECK_PREFIX}${b.name}`];
    let ids: number[] = [];
    if (b.campaignId != null) ids = [b.campaignId];
    else if (b.unsure) {
      // Email Bison's list lags a new campaign by a minute or two: onboarding's planner waits 10 minutes for these.
      if (Date.now() - Date.parse(b.at) < 10 * 60_000) { built.push(b); continue; }
      ids = (await listCampaigns(b.instance, { search: r.clientTag, strict: true }))
        .filter((c) => names.includes(c.name) && Date.parse(String(c.created_at ?? "")) >= Date.parse(b.at) - 5 * 60_000)
        .map((c) => c.id);
    }
    let left = 0;
    for (const id of ids) {
      const c = await lookUpCampaign(b.instance, id);
      if (c === null) throw new Error(`Couldn't check #${id} in ${instanceName(b.instance)}`);
      if (c === "gone") continue;
      if (/delet/i.test(c.status)) { left++; waiting = true; continue; }
      if (!names.includes(c.name)) { left++; continue; }
      const raw = await getCampaignRaw(b.instance, id);
      if (!raw) throw new Error(`Couldn't read #${id} in ${instanceName(b.instance)}`);
      if (Number(raw.total_leads ?? 0) > 0) { left++; continue; }
      const d = await deleteCampaign(b.instance, id);
      if (!d.ok && d.status !== 404) throw new Error(`The unfinished draft #${id} “${c.name}” wasn't deleted (${d.status})`);
      await log(r, "draft-deleted", { instance: b.instance, campaign_id: id, name: c.name });
      left++; waiting = true;
    }
    if (!left) { built.push({ ...b, cleared: true, note: `${b.note} (Its draft was deleted on “Try again”.)` }); changed = true; }
    else built.push(b);
  }
  if (changed) { r.built = built; await save(r, holder, { built_json: r.built }); }
  return waiting;
}

async function createStep(r: HardReset, holder: string, deadline: number): Promise<boolean> {
  if (Date.now() > deadline - BUILD_MIN_MS) return false;
  await settleCutOff(r, holder);
  if (await clearOwnDrafts(r, holder)) {
    await save(r, holder, { error: "Waiting for Email Bison to delete the unfinished draft from the earlier try (it deletes in the background) — then that campaign is built again." });
    return false;
  }
  const plan = await planNewCampaigns(r.clientTag, r.client, r.params, r.archive, r.built, r.createdBy, true);
  if (plan.blockers.length) {
    if (plan.blockers.some((b) => /email copy changed/i.test(b))) {
      throw new Stop(`The email copy changed while this reset was making the campaigns — cancel it and start a new one, so all ${newCount(r)} have the same emails.`);
    }
    const lasting = plan.blockers.filter((b) => !PASSING.test(b) && !WAITING.test(b));
    if (lasting.length) throw new Stop(lasting.join(" "));
    if (plan.blockers.every((b) => WAITING.test(b))) {
      await save(r, holder, { error: plan.blockers.join(" ") });
      return false;
    }
    throw new Error(plan.blockers.join(" "));
  }
  if (plan.items.length !== 12 || !plan.steps.length) throw new Stop(`The plan for the ${newCount(r)} campaigns isn't complete — open the preview to see why.`);
  // A Nurture reset builds only the nurture slots; the main campaigns stay as they are.
  const items = isNurtureReset(r) ? plan.items.filter((i) => i.slot.nurture) : plan.items;
  const mine = (inst: string, id: number) => r.built.some((b) => b.instance === inst && b.campaignId === id);
  const made = new Map(r.built.filter((b) => b.state === "created" && b.campaignId != null).map((b) => [`${b.instance}|${b.name}`, b.campaignId!]));
  let next: (typeof plan.items)[number] | null = null;
  for (const item of items) {
    if (item.existingIds.length) {
      // Only campaigns this reset made may already carry a new campaign's name.
      const strangers = item.existingIds.filter((id) => !mine(item.instance, id));
      if (strangers.length) throw new Stop(`“${item.name}” (${strangers.map((x) => `#${x}`).join(", ")}) appeared in ${instanceName(item.instance)} and wasn't made by this reset — sort it out in Email Bison, then try again.`);
      continue;
    }
    const id = made.get(`${item.instance}|${item.name}`);
    if (id != null) {
      // Asked by id: Email Bison's search can lag behind a campaign made a moment ago.
      const c = await lookUpCampaign(item.instance, id);
      if (c === null) throw new Error(`Couldn't check #${id} in Email Bison`);
      if (c !== "gone" && !gone(c.status) && c.name === item.name) continue;
    }
    next ??= item;
  }
  if (!next) {
    await moveTo(r, holder, "creating", "attaching");
    return true;
  }
  let clientTagId = plan.clientTagId[next.instance] ?? null;
  if (clientTagId == null) {
    await createTag(next.instance, r.clientTag);
    const again = (await listTags(next.instance)).find((t) => t.name.trim().toUpperCase() === r.clientTag);
    if (!again) throw new Error(`Couldn't create the tag ${r.clientTag} in ${instanceName(next.instance)}`);
    clientTagId = again.id;
  }
  if (!next.modeTag) throw new Stop(`${instanceName(next.instance)}: the ${next.slot.nurture ? "Nurture" : "New"} tag is missing in Email Bison.`);
  // Saved first, so a run cut off mid-build is known about (settleCutOff).
  const building: BuildRecord = { instance: next.instance, name: next.name, state: "building", campaignId: null, note: "", unsure: true, at: nowIso(), lines: plan.pinned };
  r.built = [...r.built, building];
  await save(r, holder, { built_json: r.built });
  const res = await buildCampaign({
    instance: next.instance, name: next.name, limits: next.limits, steps: plan.steps, schedule: next.schedule,
    tags: [next.modeTag, { id: clientTagId, name: r.clientTag }],
  }, realBisonOps);
  const record: BuildRecord = { instance: next.instance, name: res.name, state: res.state, campaignId: res.campaignId, note: res.note, unsure: !!res.unsure, at: nowIso(), lines: plan.pinned };
  r.built = [...r.built.slice(0, -1), record];
  await save(r, holder, { built_json: r.built });
  if (res.state === "failed") {
    const advice = res.unsure
      ? "“Try again” waits up to 10 minutes for Email Bison to list a draft it may have made, deletes it, and builds this campaign again."
      : res.campaignId != null ? "“Try again” deletes that draft and builds this campaign again." : "“Try again” builds it again.";
    throw new Stop(`Stopped at “${res.name}” (${instanceName(next.instance)}): ${res.why ?? res.note} ${advice}`);
  }
  await log(r, "campaign-created", { instance: next.instance, name: res.name, campaign_id: res.campaignId });
  return true;
}

// ── attaching ───────────────────────────────────────────────────────────────

/**
 * Attach inboxes. Rate limits / server errors are retried (then left for the next
 * round); a batch Bison refuses for good is split until the refused inboxes
 * (usually disconnected ones) are found — the rest still attach.
 */
async function attachIds(instance: string, campaignId: number, ids: number[], deadline: number): Promise<{ refused: number[] }> {
  if (!ids.length) return { refused: [] };
  let res = await attachSendersOnce(instance, campaignId, ids);
  for (let attempt = 0; attempt < 4 && (res.status === 0 || res.status === 429 || res.status >= 500); attempt++) {
    // Rate limited: wait as long as Email Bison asks — or, if that would run past this round, carry on next round.
    const wait = res.status === 429 ? (res.retryAfterMs ?? 30_000) : 800 * 2 ** attempt;
    if (Date.now() + wait > deadline - 20_000) throw new Wait(`Waiting for Email Bison — ${instanceName(instance)}'s request allowance is used up right now (another job is using it); carrying on in a moment.`);
    await new Promise((x) => setTimeout(x, wait));
    res = await attachSendersOnce(instance, campaignId, ids);
  }
  if (res.ok) return { refused: [] };
  if (res.status === 0 || res.status === 429 || res.status >= 500) throw new Error(`Email Bison didn't take the inboxes (${res.status || "no answer"}: ${res.message})`);
  if (res.campaignMissing) throw new Stop(`Campaign #${campaignId} is gone from ${instanceName(instance)}.`);
  if (ids.length === 1) return { refused: ids };
  const mid = ids.length >> 1;
  const a = await attachIds(instance, campaignId, ids.slice(0, mid), deadline);
  const b = await attachIds(instance, campaignId, ids.slice(mid), deadline);
  return { refused: [...a.refused, ...b.refused] };
}

async function attachStep(r: HardReset, holder: string, deadline: number): Promise<boolean> {
  const T = r.clientTag;
  const attach: Record<string, AttachState> = { ...r.attach };
  const persist = () => save(r, holder, { attach_json: attach });
  for (const inst of [r.client.b2b, r.client.b2c]) {
    const st: AttachState = attach[inst] ?? { tagId: null, senders: null, campaigns: {} };
    attach[inst] = st;
    if (st.senders == null) {
      // Read once and kept (unless it stops here, so "Try again" reads afresh).
      const got = await clientInboxes(inst, T);
      const approved = r.client.inboxes?.[inst];
      if (approved && got.ids.length < approved / 2) {
        throw new Stop(`Only ${got.ids.length.toLocaleString()} inboxes carry the ${T} tag in ${instanceName(inst)} now, against ${approved.toLocaleString()} when this reset was started — check ${T}'s domains (LeadSync), then try again.`);
      }
      if (!got.ids.length) {
        const had = await oldCampaignInboxes(inst, r.archive);
        if (had) throw new Stop(`No inbox in ${instanceName(inst)} carries the ${T} tag now, but ${T}'s current campaigns there send from ${had.toLocaleString()} — the new ones would have none. Tag ${T}'s inboxes there (LeadSync), then try again.`);
      }
      Object.assign(st, { tagId: got.tagId, senders: got.ids, offline: got.offline, setAside: got.setAside });
      await persist();
      await log(r, "inboxes-read", { instance: inst, inboxes: got.ids.length, not_connected: got.offline.length, reserve_or_burnt: got.setAside });
      return true;
    }
    const senders = st.senders;
    const camps = r.built.filter((b) => b.state === "created" && b.instance === inst && b.campaignId != null);
    const want = newCount(r) / 2;
    if (camps.length !== want) throw new Stop(`${instanceName(inst)} has ${camps.length} new campaigns on record instead of ${want}.`);
    for (const c of camps) {
      const id = c.campaignId!;
      const cs = st.campaigns[String(id)] ?? { attached: 0, refused: [], verified: false, total: null };
      st.campaigns[String(id)] = cs;
      if (cs.verified) continue;
      if (Date.now() > deadline - 30_000) { await persist(); return true; }
      const on = new Set((await listCampaignSenders(inst, id)).map((s) => s.id));
      const refused = new Set(cs.refused);
      const missing = senders.filter((x) => !on.has(x) && !refused.has(x));
      for (let i = 0; i < missing.length; i += ATTACH_BATCH) {
        const batch = missing.slice(i, i + ATTACH_BATCH);
        const out = await attachIds(inst, id, batch, deadline);
        cs.refused.push(...out.refused);
        cs.attached += batch.length - out.refused.length;
        if ((i / ATTACH_BATCH) % 4 === 3) { await persist(); await heartbeat(r.id, holder); }
        if (Date.now() > deadline - 15_000) { await persist(); return true; }
      }
      // A few refusals happen (an inbox mid-reconnect); many mean something's wrong — stop and show them.
      const offline = new Set(st.offline ?? []);
      const hard = cs.refused.filter((x) => !offline.has(x));
      if (hard.length > Math.max(3, Math.ceil(senders.length * 0.05))) {
        const emails = new Map((st.tagId ? await listSenderEmailsByTag(inst, st.tagId).catch(() => []) : []).map((x) => [x.id, x.email]));
        const shown = hard.slice(0, 5).map((x) => emails.get(x) ?? `inbox #${x}`).join(", ");
        // "Try again" reads the inboxes afresh (fixed, untagged or now shown as disconnected) and offers them all again.
        cs.refused = [];
        st.senders = null;
        await persist();
        throw new Stop(`Email Bison refused ${hard.length} of ${senders.length.toLocaleString()} connected inboxes for “${c.name}” (#${id}) in ${instanceName(inst)} — e.g. ${shown}. Check them in Email Bison, then try again.`);
      }
      // Every tagged inbox Bison accepted must be on the campaign now.
      const total = await countCampaignSenders(inst, id);
      const expected = senders.length - cs.refused.length;
      cs.total = total;
      if (total < expected) { await persist(); throw new Error(`#${id} shows ${total} of ${expected} inboxes`); }
      cs.verified = true;
      await persist();
      await log(r, "inboxes-attached", { instance: inst, campaign_id: id, inboxes: expected, refused: cs.refused.length });
      return true;
    }
  }
  await moveTo(r, holder, "attaching", "repointing");
  return true;
}

// ── repointing ──────────────────────────────────────────────────────────────

const LANE: Record<"google" | "outlook" | "segs", string> = { google: "Google + Custom", outlook: "Outlook", segs: "SEGs" };

async function repointStep(r: HardReset, holder: string): Promise<boolean> {
  const T = r.clientTag;
  // What it was, saved before anything changes (kept on a re-run).
  if (!r.nurture) {
    const before = await getCampaignMap(T);
    const batches = (await db.execute({ sql: "SELECT * FROM nurture_campaign_expansions WHERE UPPER(client_tag) = ?", args: [T] })).rows.map((x) => ({ ...x }));
    r.nurture = { before, batches, after: [] };
    await save(r, holder, { nurture_json: r.nurture });
  }
  const after: Array<{ bison_instance: string; esp: string; campaign_id: number; campaign_name: string; lane: string }> = [];
  for (const [inst, lane] of [[r.client.b2b, "b2b"], [r.client.b2c, "b2c"]] as const) {
    for (const esp of ["google", "outlook", "segs"] as const) {
      const found = r.built.filter((b) => b.state === "created" && b.instance === inst && b.campaignId != null && /\[Nurture\]/i.test(b.name) && detectCampaignEsp(b.name) === esp);
      if (found.length !== 1) throw new Stop(`Couldn't find the one new ${LANE[esp]} nurture campaign in ${instanceName(inst)} (${found.length} on record).`);
      after.push({ bison_instance: inst, esp, campaign_id: found[0].campaignId!, campaign_name: found[0].name, lane });
    }
  }
  await heartbeat(r.id, holder);
  // The whole map is replaced at once, confirmed, and the batch count starts again.
  await db.batch([
    { sql: "DELETE FROM nurture_campaign_map WHERE UPPER(client_tag) = ?", args: [T] },
    ...after.map((a) => ({
      sql: `INSERT INTO nurture_campaign_map (client_tag, bison_instance, esp, campaign_id, campaign_name, lane, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [T, a.bison_instance, a.esp, a.campaign_id, a.campaign_name, a.lane],
    })),
    { sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)", args: [T] },
    { sql: "UPDATE client_config SET nurture_map_confirmed_at = datetime('now'), updated_at = datetime('now') WHERE UPPER(client_tag) = ?", args: [T] },
    { sql: "DELETE FROM nurture_campaign_expansions WHERE UPPER(client_tag) = ?", args: [T] },
    { sql: "DELETE FROM nurture_routing_health WHERE UPPER(client_tag) = ?", args: [T] },
  ], "write");
  r.nurture = { ...r.nurture, after };
  await moveTo(r, holder, "repointing", isNurtureReset(r) ? "requeueing" : "archiving", { nurture_json: r.nurture });
  await markTagStatsDirty(T).catch(() => {});
  await rebuildOverviewSnapshot({ force: true }).catch(() => {});
  return true;
}

// ── requeueing (Nurture reset) ──────────────────────────────────────────────

// (Smaller chunks can be set for a test run, to walk several pages over a few rows.)
// (Never above 1000: Supabase answers at most 1000 rows, and a "short" page means the walk is done.)
const REQUEUE_PAGE = Math.min(1000, Number(process.env.HARD_RESET_REQUEUE_PAGE) || 1000);
const REQUEUE_UPDATE = Math.min(500, Number(process.env.HARD_RESET_REQUEUE_UPDATE) || 500);
/**
 * Replies and legacy leads have no index for "this client's nurtured rows": they're walked by id range instead (the
 * primary key). Each range reads every row in it, which is slow when those rows aren't in the database's memory —
 * a range that runs out of time is halved (down to 1,000 ids) and tried again, not counted as a failure.
 */
const REQUEUE_RANGE = Number(process.env.HARD_RESET_REQUEUE_RANGE) || 20_000;
/** Turso's stopped-lead ledger, a page at a time (one client can have ~100k rows). */
const LEDGER_PAGE = Number(process.env.HARD_RESET_LEDGER_PAGE) || 2000;
// Every marked row is cleared — including the "(stopped-recovery)" copies of recovered stopped leads and rows
// from old nurture campaigns: for many leads those are their only row (the sync never adds a second row for a
// lead it knows; on JPC 36k leads had no other). A lead with two rows is simply attached twice — Email Bison
// keeps one. Leads finishing the new nurture campaigns don't come back (the sync skips "[Nurture]" campaigns).
const pgQuote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Keep each cleared "already nurtured" mark (when, which campaign) before clearing it — one round trip. */
async function backupMarks(resetId: number, source: string, rows: Array<{ id: number; at: string | null; campaign: number | null }>): Promise<void> {
  if (!rows.length) return;
  const stmts = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    stmts.push({
      sql: `INSERT OR IGNORE INTO hard_reset_requeue_rows (reset_id, source, row_id, added_at, campaign_id) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      args: chunk.flatMap((x) => [resetId, source, x.id, x.at, x.campaign]),
    });
  }
  await db.batch(stmts, "write");
}

/** Clear the mark on exactly these rows; every row must come back changed. */
async function clearMarks(table: string, column: string, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += REQUEUE_UPDATE) {
    const chunk = ids.slice(i, i + REQUEUE_UPDATE);
    const { data, error } = await supabase.from(table).update({ [column]: null, nurture_campaign_id: null }).in("id", chunk).select("id");
    if (error) throw new Error(`Couldn't update ${table} (${error.message})`);
    if ((data?.length ?? 0) !== chunk.length) throw new Error(`${table}: ${data?.length ?? 0} of ${chunk.length} rows changed`);
  }
}

/**
 * Every lead of the client may be nurtured again: the "already nurtured" mark is cleared on its
 * sequence-finished leads, replies and legacy leads, and the stopped-lead recovery's ledger is
 * reset. Skips (removed, unsafe) and service-area removals stay. Works in chunks under the
 * system-wide heavy-query lease, saving where it got to; each mark is backed up first.
 */
async function requeueStep(r: HardReset, holder: string, deadline: number): Promise<boolean> {
  const T = r.clientTag;
  const st: RequeueState = r.requeue ?? {
    seq: { after: null, scanned: 0, cleared: 0, done: false },
    replies: { after: 0, cleared: 0, done: false },
    legacy: { after: 0, cleared: 0, done: false },
    ledgers: null,
  };
  const lease = `hard-reset:${r.id}`;
  if (!(await acquireHeavyLease(lease, 120_000))) throw new Wait("Waiting for another heavy Nurture job on the database to finish (one runs at a time) — carrying on in a moment.");
  let renewedAt = Date.now();
  const persist = async () => {
    r.requeue = st;
    // Where it got to + the runner's heartbeat, in one write; the heavy-query lease renewed every 30s (it lasts 120s).
    await save(r, holder, { requeue_json: st, heartbeat_at: nowIso() });
    if (Date.now() - renewedAt > 30_000) {
      if (!(await renewHeavyLease(lease, 120_000))) throw new Wait("The database's heavy-job turn moved on — carrying on in a moment.");
      renewedAt = Date.now();
    }
  };
  try {
    // Same limit as the runner's own loop, so running out of time here ends the round (no idle spins).
    while (Date.now() < deadline - STEP_MIN_MS) {
      if (!st.seq.done) {
        // Walked in (email, id) order on the (client_tag, email) index — one pass over the client's rows. The
        // plain "email >= …" lets the index start each page where the last ended (the OR alone can't);
        // rows with no email can't be nurtured and are left out.
        let q = supabase.from("nurture_sequence_finished").select("id, email, added_at, nurture_campaign_id")
          .eq("client_tag", T).not("email", "is", null).order("email").order("id").limit(REQUEUE_PAGE);
        if (st.seq.after) {
          q = q.gte("email", st.seq.after.email)
            .or(`email.gt.${pgQuote(st.seq.after.email)},and(email.eq.${pgQuote(st.seq.after.email)},id.gt.${st.seq.after.id})`);
        }
        const { data, error } = await q;
        if (error) throw new Error(`Couldn't read ${T}'s sequence-finished leads (${error.message})`);
        const rows = (data ?? []) as Array<{ id: number; email: string; added_at: string | null; nurture_campaign_id: number | null }>;
        const clear = rows.filter((x) => x.added_at != null);
        await backupMarks(r.id, "seq", clear.map((x) => ({ id: x.id, at: x.added_at, campaign: x.nurture_campaign_id })));
        await clearMarks("nurture_sequence_finished", "added_at", clear.map((x) => x.id));
        st.seq.scanned += rows.length;
        st.seq.cleared += clear.length;
        if (rows.length) st.seq.after = { email: rows[rows.length - 1].email, id: rows[rows.length - 1].id };
        if (rows.length < REQUEUE_PAGE) st.seq.done = true;
        await persist();
        continue;
      }
      const other = !st.replies.done ? { key: "replies" as const, table: "replies" } : !st.legacy.done ? { key: "legacy" as const, table: "nurture_legacy_leads" } : null;
      if (other) {
        const o = st[other.key];
        if (o.max == null) {
          // Walked by id up to the table's newest row now (rows added later aren't anyone's "already nurtured").
          const { data, error } = await supabase.from(other.table).select("id").order("id", { ascending: false }).limit(1);
          if (error) throw new Error(`Couldn't read ${other.table} (${error.message})`);
          o.max = Number(data?.[0]?.id) || 0;
          await persist();
          continue;
        }
        const hi = Math.min(o.after + (o.range ?? REQUEUE_RANGE), o.max);
        const { data, error } = await supabase.from(other.table).select("id, nurture_added_at, nurture_campaign_id")
          .eq("client_tag", T).not("nurture_added_at", "is", null).gt("id", o.after).lte("id", hi).order("id").limit(REQUEUE_PAGE);
        if (error && /statement timeout/i.test(error.message) && (o.range ?? REQUEUE_RANGE) > 1000) {
          o.range = Math.max(1000, Math.floor((o.range ?? REQUEUE_RANGE) / 2));
          await persist();
          throw new Wait(`The database is slow right now — reading ${other.key === "replies" ? "replies" : "legacy leads"} in smaller pieces (${o.range.toLocaleString()} at a time); carrying on in a moment.`);
        }
        if (error) throw new Error(`Couldn't read ${T}'s ${other.key} (${error.message})`);
        const rows = (data ?? []) as Array<{ id: number; nurture_added_at: string | null; nurture_campaign_id: number | null }>;
        await backupMarks(r.id, other.key, rows.map((x) => ({ id: x.id, at: x.nurture_added_at, campaign: x.nurture_campaign_id })));
        await clearMarks(other.table, "nurture_added_at", rows.map((x) => x.id));
        o.cleared += rows.length;
        // A full page may not be the whole range: carry on from its last row; otherwise the range is done.
        o.after = rows.length === REQUEUE_PAGE ? rows[rows.length - 1].id : hi;
        if (o.after >= o.max) o.done = true;
        await persist();
        continue;
      }
      // (A Turso table that was never made has nothing in it; any other error is retried.)
      const none = (e: unknown) => { if (/no such table/i.test((e as Error).message)) return null; throw e; };
      const rec = st.recovered ?? { cleared: 0, done: false };
      if (!rec.done) {
        // Stopped leads recovered into nurture (up to ~100k a client): their ledger marks cleared a page at a time — the
        // recovery may pick them up again from the main campaigns too. Cleared rows drop out of the next page's read.
        const page = (await db.execute({
          sql: "SELECT rowid AS id, added_at, nurture_campaign_id FROM nurture_stopped_recovered WHERE client_tag = ? AND added_at IS NOT NULL ORDER BY rowid LIMIT ?",
          args: [T, LEDGER_PAGE],
        }).catch(none)) ?? { rows: [] as Record<string, unknown>[] };
        const rows = page.rows.map((x) => ({ id: Number(x.id), at: (x.added_at as string) ?? null, campaign: x.nurture_campaign_id == null ? null : Number(x.nurture_campaign_id) }));
        await backupMarks(r.id, "recovered", rows);
        if (rows.length) {
          const stmts = [];
          for (let i = 0; i < rows.length; i += 500) {
            const chunk = rows.slice(i, i + 500);
            stmts.push({ sql: `UPDATE nurture_stopped_recovered SET added_at = NULL WHERE client_tag = ? AND rowid IN (${chunk.map(() => "?").join(",")})`, args: [T, ...chunk.map((x) => x.id)] });
          }
          await db.batch(stmts, "write");
        }
        rec.cleared += rows.length;
        if (rows.length < LEDGER_PAGE) rec.done = true;
        st.recovered = rec;
        await persist();
        continue;
      }
      if (!st.ledgers) {
        // The "already routed from this campaign" counts start over too.
        const routed = (await db.execute({ sql: "DELETE FROM nurture_source_routed WHERE UPPER(client_tag) = ?", args: [T] }).catch(none)) ?? { rowsAffected: 0 };
        st.ledgers = { recovered: rec.cleared, routed: routed.rowsAffected ?? 0 };
        await persist();
        continue;
      }
      await markTagStatsDirty(T).catch(() => {});
      await dropFirstPageCache(T).catch(() => {});
      await moveTo(r, holder, "requeueing", "archiving", { requeue_json: st });
      await log(r, "requeued", { seq: st.seq.cleared, replies: st.replies.cleared, legacy: st.legacy.cleared, ...st.ledgers });
      return true;
    }
    return true; // out of time this round — the runner re-triggers itself and carries on
  } finally {
    await releaseHeavyLease(lease).catch(() => {});
  }
}

// ── archiving ───────────────────────────────────────────────────────────────

/**
 * The last check before anything is archived (once): all 12 new campaigns are there under their
 * names, each still has inboxes, nurture still points at the new ones — and any campaign of the
 * client's made since the reset started (a nurture batch, one made by hand) joins the list.
 */
async function precheck(r: HardReset, holder: string): Promise<void> {
  const T = r.clientTag;
  const made = r.built.filter((b) => b.state === "created" && b.campaignId != null);
  if (made.length !== newCount(r)) throw new Stop(`${made.length} new campaigns are on record instead of ${newCount(r)} — nothing old has been archived.`);
  for (const b of made) {
    const id = b.campaignId!;
    const c = await lookUpCampaign(b.instance, id);
    if (c === null) throw new Error(`Couldn't check new campaign #${id} in ${instanceName(b.instance)}`);
    if (c === "gone" || gone(c.status)) throw new Stop(`New campaign “${b.name}” (#${id}) is ${c === "gone" ? "gone" : c.status} in ${instanceName(b.instance)} — nothing old has been archived. Look at it in Email Bison.`);
    if (c.name !== b.name) throw new Stop(`New campaign #${id} in ${instanceName(b.instance)} is now called “${c.name}” instead of “${b.name}” — nothing old has been archived. Put its name back, then try again.`);
    const st = r.attach[b.instance];
    const expected = (st?.senders?.length ?? 0) - (st?.campaigns[String(id)]?.refused.length ?? 0);
    if (expected > 0 && (await countCampaignSenders(b.instance, id)) === 0) {
      throw new Stop(`New campaign “${b.name}” (#${id}) has no inboxes any more (it had ${expected.toLocaleString()}) — nothing old has been archived. Attach ${T}'s inboxes to it in Email Bison, then try again.`);
    }
  }
  const key = (x: { bison_instance: string; esp: string; campaign_id: number }) => `${x.bison_instance}|${x.esp}|${x.campaign_id}`;
  const want = ((r.nurture?.after ?? []) as Array<{ bison_instance: string; esp: string; campaign_id: number }>).map(key);
  const have = (await getCampaignMap(T)).map(key);
  if (want.length !== 6 || have.length !== want.length || want.some((k) => !have.includes(k))) {
    throw new Stop(`${T}'s nurture map changed after it was switched to the new campaigns — nothing old has been archived. Point Target Campaigns at the 6 new nurture campaigns, then try again.`);
  }
  const known = new Set([...r.archive, ...r.built.filter((b) => b.campaignId != null).map((b) => ({ instance: b.instance, id: b.campaignId! }))].map((c) => `${c.instance}:${c.id}`));
  // (A Nurture reset only ever archives nurture campaigns.)
  const late = (await currentCampaigns(T)).filter((c) => !known.has(`${c.instance}:${c.id}`) && (!isNurtureReset(r) || isNurtureCampaign(c.name))).map((c) => ({ ...c, late: true }));
  r.archive = [...r.archive, ...late];
  r.precheckedAt = nowIso();
  await save(r, holder, { archive_json: r.archive, prechecked_at: r.precheckedAt });
  await log(r, "prechecked", { late: late.map((c) => ({ instance: c.instance, id: c.id, name: c.name })) });
}

async function archiveStep(r: HardReset, holder: string, deadline: number): Promise<boolean> {
  if (!r.precheckedAt) { await precheck(r, holder); return true; }
  const done = new Set(r.archived.map((a) => `${a.instance}:${a.id}`));
  const ours = new Set(r.built.filter((b) => b.campaignId != null).map((b) => `${b.instance}:${b.campaignId}`));
  const add = async (rec: ArchiveRecord) => { r.archived = [...r.archived, rec]; await save(r, holder, { archived_json: r.archived }); };
  for (const old of r.archive) {
    const key = `${old.instance}:${old.id}`;
    if (done.has(key)) continue;
    if (Date.now() > deadline - 15_000) return true;
    if (ours.has(key)) { await add({ instance: old.instance, id: old.id, name: old.name, result: "skipped", note: "made by this reset", at: nowIso() }); continue; }
    const c = await lookUpCampaign(old.instance, old.id);
    if (c === null) throw new Error(`Couldn't read #${old.id} in ${instanceName(old.instance)}`);
    if (c === "gone") { await add({ instance: old.instance, id: old.id, name: old.name, result: "gone", at: nowIso() }); continue; }
    if (/archiv/i.test(c.status)) { await add({ instance: old.instance, id: old.id, name: old.name, result: "already", at: nowIso() }); continue; }
    // Only the client's own campaign: one renamed to another tag since is left alone.
    if (extractTagFromCampaignName(c.name).toUpperCase() !== r.clientTag) {
      await add({ instance: old.instance, id: old.id, name: old.name, result: "skipped", note: `renamed to “${c.name}” since — left alone`, at: nowIso() });
      continue;
    }
    // Paused first, the way LeadSync takes a campaign out (best effort — the archive is what's checked).
    if (!/^(draft|paused)$/i.test(c.status.trim())) await pauseCampaign(old.instance, old.id).catch(() => null);
    const a = await archiveCampaignOnce(old.instance, old.id);
    const v = await lookUpCampaign(old.instance, old.id);
    if (v && v !== "gone" && /archiv/i.test(v.status)) {
      await add({ instance: old.instance, id: old.id, name: c.name, result: "archived", at: nowIso() });
      await log(r, "campaign-archived", { instance: old.instance, campaign_id: old.id, name: c.name });
      continue;
    }
    throw new Error(`#${old.id} “${c.name}” wasn't archived (${a.status}${a.message ? `: ${a.message}` : ""})`);
  }
  await moveTo(r, holder, "archiving", "done", { finished_at: nowIso() });
  await log(r, "done", { created: r.built.filter((b) => b.state === "created").length, archived: r.archived.filter((a) => a.result === "archived").length });
  return false;
}

// ── cancelling ──────────────────────────────────────────────────────────────

async function cancelStep(r: HardReset, holder: string, deadline: number): Promise<boolean> {
  // Once nurture points at the new campaigns, finishing is the way forward — not cancelling.
  if ((r.nurture?.after ?? []).length) {
    await patchReset(r.id, { status: "failed", failed_step: "archiving", attempts: 0, error: "Nurture already points at the new campaigns, so this reset can't be cancelled now — “Try again” finishes it." }, { from: ["cancelling"], holder });
    return false;
  }
  let waiting = 0, settling = 0;
  const kept: string[] = [];
  // A build cut off, or a create Email Bison never answered, may have left a draft nobody has the id of: found by its
  // exact working name. Email Bison's list can take a few minutes to show a new campaign, so a recent try is given
  // 10 minutes (as onboarding's planner does) before the cancel counts it as having made nothing.
  const unsure = r.built.filter((b) => b.campaignId == null && (b.unsure || b.state === "building"));
  const found: BuildRecord[] = [];
  for (const b of unsure) {
    const want = [`${BUILD_PREFIX}${b.name}`, `${CHECK_PREFIX}${b.name}`];
    const hits = (await listCampaigns(b.instance, { search: r.clientTag, strict: true })).filter((c) => want.includes(c.name));
    for (const c of hits) found.push({ ...b, campaignId: c.id });
    if (!hits.length && Date.now() - Date.parse(b.at) < 10 * 60_000) settling++;
  }
  for (const b of [...r.built, ...found]) {
    if (b.campaignId == null) continue;
    if (Date.now() > deadline - 15_000) return true;
    const c = await lookUpCampaign(b.instance, b.campaignId);
    if (c === null) throw new Error(`Couldn't read #${b.campaignId}`);
    if (c === "gone") continue;
    if (/delet/i.test(c.status)) { waiting++; continue; }
    // Only what this reset made, by its exact name, and never with leads in it.
    if (![b.name, `${CHECK_PREFIX}${b.name}`, `${BUILD_PREFIX}${b.name}`].includes(c.name)) { kept.push(`#${b.campaignId} “${c.name}” (renamed since)`); continue; }
    const raw = await getCampaignRaw(b.instance, b.campaignId);
    if (!raw) throw new Error(`Couldn't read #${b.campaignId}`);
    if (Number(raw.total_leads ?? 0) > 0) { kept.push(`#${b.campaignId} “${c.name}” (it has leads)`); continue; }
    const d = await deleteCampaign(b.instance, b.campaignId);
    if (!d.ok && d.status !== 404) throw new Error(`#${b.campaignId} wasn't deleted (${d.status})`);
    waiting++; // Email Bison deletes in the background — checked again next round
  }
  if (waiting || settling) {
    const round = r.attempts + 1;
    if (waiting && round >= CANCEL_ROUNDS) {
      await patchReset(r.id, {
        status: "failed", failed_step: "cancelling", attempts: round,
        error: `Email Bison still shows ${waiting} of the new campaigns after ${round} checks — delete them by hand in Email Bison, then “Try again” finishes the cancel.`,
      }, { from: ["cancelling"], holder });
    } else {
      await save(r, holder, { attempts: round, error: [
        waiting ? `Waiting for Email Bison to delete ${waiting} campaign${waiting === 1 ? "" : "s"} (it does that in the background).` : "",
        settling ? "Waiting a few minutes in case an interrupted try made a campaign Email Bison doesn't list yet." : "",
      ].filter(Boolean).join(" ") });
    }
    return false;
  }
  await moveTo(r, holder, "cancelling", "cancelled", { finished_at: nowIso(), error: kept.length ? `Left in Email Bison: ${kept.join("; ")}.` : null });
  return false;
}

// ── the loop ────────────────────────────────────────────────────────────────

async function step(r: HardReset, holder: string, deadline: number): Promise<boolean> {
  switch (r.status) {
    case "creating": return createStep(r, holder, deadline);
    case "attaching": return attachStep(r, holder, deadline);
    case "repointing": return repointStep(r, holder);
    case "requeueing": return requeueStep(r, holder, deadline);
    case "archiving": return archiveStep(r, holder, deadline);
    case "cancelling": return cancelStep(r, holder, deadline);
    default: return false;
  }
}

/** Lease and work one reset until the deadline. */
export async function runHardResetJobs(deadlineMs: number, id?: number): Promise<{ ran: number | null }> {
  const leased = await leaseReset(id);
  if (!leased) return { ran: null };
  const rid = leased.id, holder = leased.leaseHolder!;
  let more = false;
  try {
    while (Date.now() < deadlineMs - STEP_MIN_MS) {
      const r = await getReset(rid);
      if (!r || r.leaseHolder !== holder) break;
      let did: boolean;
      try {
        did = await step(r, holder, deadlineMs);
        if (did && (r.attempts || r.error)) await patchReset(rid, { attempts: 0, error: null }, { holder });
      } catch (e) {
        if ((e as Error).name === "LeaseLost") break;
        const msg = ((e as Error).message || "failed").slice(0, 800);
        if ((e as Error).name === "Wait") { await patchReset(rid, { error: msg }, { holder }); break; }
        const stop = (e as Error).name === "Stop" || r.attempts + 1 >= MAX_ATTEMPTS;
        if (stop) {
          // Only from the step it was in (a cancel that came in meanwhile wins).
          await patchReset(rid, { status: "failed", failed_step: r.status, error: msg, attempts: r.attempts + 1 }, { holder, from: [r.status] });
          await log(r, "failed", { step: r.status, error: msg });
          await logError("hard-reset", `${r.clientTag}/#${rid}`, `${r.status}: ${msg}`, { reset_id: rid }).catch(() => {});
        } else {
          await patchReset(rid, { attempts: r.attempts + 1, error: `${msg} — trying again` }, { holder });
        }
        break;
      }
      await heartbeat(rid, holder);
      if (!did) break;
      more = true;
    }
  } catch (e) {
    if ((e as Error).name !== "LeaseLost") await logError("hard-reset", `#${rid}`, (e as Error).message).catch(() => {});
  } finally {
    await releaseLease(rid, holder).catch(() => {});
  }
  const after = await getReset(rid);
  // Straight on while it's making progress; a cancel waiting on Email Bison's background deletes is left to the cron.
  if (after && more && ["creating", "attaching", "repointing", "requeueing", "archiving"].includes(after.status)) triggerHardResetRunner(rid);
  return { ran: rid };
}
