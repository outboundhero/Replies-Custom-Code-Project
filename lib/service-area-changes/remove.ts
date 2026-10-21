/**
 * Service-area removals — taking the ticked leads out, on the removal day.
 *
 *   1. block    — every ticked email goes on the client's block list first, so no
 *                 automation can add it back while the rest runs
 *   2. queue    — the client's nurture-queue rows for those emails get the queue's
 *                 own skip flag (the same database function as the queue's Remove)
 *   3. campaigns— each lead is read live in every instance the client has campaigns
 *                 in (by its Bison id where the scan saw it). A lead ticked by default
 *                 whose details NOW put it outside the removed places is kept (and
 *                 unblocked); otherwise it's taken out of every one of the CLIENT's
 *                 campaigns it's in now plus every one the scan saw it in.
 *                 Never unsubscribed or blacklisted (that would hit other clients),
 *                 never deleted from Bison, never removed from the client's sheet.
 *   4. verify   — 10 minutes later (Bison finishes some removals in the background)
 *                 each lead is read again; anything still there is removed again;
 *                 three checks, 10 minutes apart, before it's called failed.
 *   5. re-check — 7 days later and again about 30 days after the removal, the same
 *                 check: a lead re-added from outside (Clay, the lead database) is taken
 *                 out again. Leads let back in are left alone.
 * Every lookup that doesn't give a clear answer is an error (retried), never
 * "not there".
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { getLeadCampaigns, removeLeadsFromCampaign } from "@/lib/outboundhero-api";
import { logActivity } from "@/lib/errors";
import { addSuppressions, liftSuppressions } from "@/lib/service-area-changes/suppression";
import { clientCampaigns } from "@/lib/service-area-changes/scan";
import { ensureRemovalsTable, dropFirstPageCache } from "@/lib/nurture/queue-removals";
import { markTagStatsDirty } from "@/lib/nurture/overview";
import { classify, inputFromCustomVars, mergeSignals, signalsOf, type Signals } from "@/lib/service-area-changes/places";
import {
  cityStatesFor, heartbeat, knownMemberships, leadsAt, patchChange, resetAttempts, setResults, tickedEmails, zipFactsFor,
  type Change, type Found, type LeadResult, type ScanCampaign,
} from "@/lib/service-area-changes/store";

export const VERIFY_DELAY_MS = 10 * 60_000;
export const RECHECK_DELAY_MS = 7 * 24 * 60 * 60_000;
const SECOND_RECHECK_DELAY_MS = 23 * 24 * 60 * 60_000; // after the first: ~30 days from the removal
const MAX_REMOVE_ATTEMPTS = 3;
const RETRY_AFTER_MS = 2 * 60_000;
const MAX_VERIFY_ROUNDS = 3; // checks, 10 minutes apart; removed again after the first two
const BATCH = 40;
const LOOKUP_CONCURRENCY = 6;
const QUEUE_CHUNK = 5000;

type CampaignIndex = Map<string, Map<number, ScanCampaign>>;

/** The client's campaigns in every instance, all statuses (archived too — a lead there is still "in" it). */
export async function campaignIndex(clientTag: string): Promise<CampaignIndex> {
  const idx: CampaignIndex = new Map();
  for (const c of await clientCampaigns(clientTag)) {
    if (!idx.has(c.instance)) idx.set(c.instance, new Map());
    idx.get(c.instance)!.set(c.id, c);
  }
  return idx;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

interface Located { found: Found[]; live: Signals | null; error?: string }

/**
 * Where each lead is right now among the client's campaigns, and what its
 * records say now. Looked up by the Bison id we know for an instance, else by
 * email, in every instance the client has campaigns in.
 */
async function locate(leads: Array<{ email: string; known: Found[] }>, idx: CampaignIndex): Promise<Map<string, Located>> {
  const out = new Map<string, Located>();
  await pool(leads, LOOKUP_CONCURRENCY, async ({ email, known }) => {
    const found: Found[] = [];
    let live: Signals | null = null;
    try {
      for (const [instance, camps] of idx) {
        const id = known.find((k) => k.instance === instance)?.leadId;
        let r = await getLeadCampaigns(instance, id ?? email, email);
        // The id we knew is gone (deleted, or re-imported under a new id): look it up by email.
        if (!r && id != null) r = await getLeadCampaigns(instance, email, email);
        if (!r) continue;
        const s = signalsOf(inputFromCustomVars(r.customVariables)).signals;
        live = live ? mergeSignals(live, s) : s;
        for (const c of r.campaigns) if (camps.has(c.campaignId)) found.push({ instance, campaignId: c.campaignId, leadId: r.leadId });
      }
      out.set(email, { found, live });
    } catch (e) {
      out.set(email, { found, live, error: (e as Error).message || "lookup failed" });
    }
  });
  return out;
}

/** Remove memberships, grouped per campaign. Returns the "instance:campaign" keys whose removal failed. */
async function removeMemberships(all: Found[]): Promise<Set<string>> {
  const groups = new Map<string, { instance: string; campaignId: number; leadIds: Set<number> }>();
  for (const f of all) {
    const k = `${f.instance}:${f.campaignId}`;
    if (!groups.has(k)) groups.set(k, { instance: f.instance, campaignId: f.campaignId, leadIds: new Set() });
    groups.get(k)!.leadIds.add(f.leadId);
  }
  const failed = new Set<string>();
  for (const [k, g] of groups) {
    const r = await removeLeadsFromCampaign(g.instance, g.campaignId, [...g.leadIds], 200);
    if (!r.ok) failed.add(k);
  }
  return failed;
}

const dedupe = (xs: Found[]) => [...new Map(xs.map((f) => [`${f.instance}:${f.campaignId}:${f.leadId}`, f])).values()];
const names = (found: Found[], idx: CampaignIndex) => [...new Set(found.map((f) => idx.get(f.instance)?.get(f.campaignId)?.name ?? `#${f.campaignId}`))];
const listNames = (xs: string[]) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, 2).join(", ")} and ${xs.length - 2} more`);

// ── steps ────────────────────────────────────────────────────────────────────

async function blockAll(change: Change, holder: string): Promise<number> {
  let after = "", n = 0;
  for (;;) {
    // Not the ones already let back in (if this step re-runs after someone did).
    const emails = await tickedEmails(change.id, after, 1000, { stillGoing: true });
    if (!emails.length) break;
    n += await addSuppressions(change.clientTag, emails, change.id, change.approvedBy, `Service area change #${change.id}`);
    after = emails[emails.length - 1];
    await heartbeat(change.id, holder);
  }
  await patchChange(change.id, { suppressed_at: new Date().toISOString() });
  return n;
}

/**
 * Skip-flag the ticked emails' nurture-queue rows, 5,000 emails per call (each
 * call reads the client's whole pending queue, so fewer is lighter), saving
 * the place after each so a long list carries over between runs. The exact
 * rows go on one Nurture "removal" record (marked as a service-area removal,
 * which the queue's Undo refuses). Returns true when the whole list is done.
 */
async function removeFromQueue(change: Change, deadline: number, holder: string): Promise<boolean> {
  const tag = change.clientTag;
  await ensureRemovalsTable();
  let removalId = change.queueRemovalId;
  if (!removalId) {
    const ins = await db.execute({
      sql: `INSERT INTO nurture_queue_removals (client_tag, removed_at, removed_by, mode, filters_json, status, contacts, row_count, ids_json)
            VALUES (?, ?, ?, 'service-area', ?, 'pending', 0, 0, ?) RETURNING id`,
      args: [tag, new Date().toISOString(), change.approvedBy, JSON.stringify({ service_area_change: change.id }), JSON.stringify({ reply: [], seq: [], legacy: [] })],
    });
    removalId = Number(ins.rows[0]?.id);
    await patchChange(change.id, { queue_removal_id: removalId });
  }
  let cursor = change.queueCursor ?? "";
  while (Date.now() < deadline) {
    const emails = await tickedEmails(change.id, cursor, QUEUE_CHUNK, { stillGoing: true });
    if (!emails.length) {
      const rows = Number((await db.execute({ sql: "SELECT row_count FROM nurture_queue_removals WHERE id = ?", args: [removalId] })).rows[0]?.row_count) || 0;
      await db.execute({ sql: "UPDATE nurture_queue_removals SET status = 'done' WHERE id = ?", args: [removalId] });
      if (rows > 0) { await markTagStatsDirty(tag).catch(() => {}); await dropFirstPageCache(tag); }
      await patchChange(change.id, { queue_done_at: new Date().toISOString(), queue_rows: rows });
      await logActivity("service-area", "queue-removed", { client_tag: tag, details: { change_id: change.id, rows, removal_id: removalId } });
      return true;
    }
    const { data, error } = await supabase.rpc("nurture_queue_remove", { p_tag: tag, p_emails: emails, p_all_matching: false });
    if (error) {
      await db.execute({ sql: "UPDATE nurture_queue_removals SET error = ? WHERE id = ?", args: [error.message.slice(0, 300), removalId] });
      throw new Error(`Couldn't remove the nurture-queue rows: ${error.message}`);
    }
    // Add this chunk's exact rows to the record.
    const rec = (await db.execute({ sql: "SELECT contacts, row_count, ids_json FROM nurture_queue_removals WHERE id = ?", args: [removalId] })).rows[0];
    const ids = rec?.ids_json ? JSON.parse(String(rec.ids_json)) : { reply: [], seq: [], legacy: [] };
    ids.reply.push(...((data?.reply_ids as number[]) ?? []));
    ids.seq.push(...((data?.seq_ids as number[]) ?? []));
    ids.legacy.push(...((data?.legacy_ids as number[]) ?? []));
    await db.execute({
      sql: "UPDATE nurture_queue_removals SET contacts = ?, row_count = ?, ids_json = ? WHERE id = ?",
      args: [(Number(rec?.contacts) || 0) + Number(data?.contacts ?? 0), (Number(rec?.row_count) || 0) + Number(data?.rows ?? 0), JSON.stringify(ids), removalId],
    });
    cursor = emails[emails.length - 1];
    await patchChange(change.id, { queue_cursor: cursor });
    await heartbeat(change.id, holder);
  }
  return false;
}

/** One batch of not-yet-removed leads. Returns false when there was nothing left to try now. */
async function removeBatch(change: Change, idx: CampaignIndex): Promise<boolean> {
  const batch = await leadsAt(change.id, null, BATCH, { maxAttempts: MAX_REMOVE_ATTEMPTS, retryAfterMs: RETRY_AFTER_MS });
  if (!batch.length) return false;
  const known = await knownMemberships(change.id, batch.map((b) => b.email));
  const inClient = (f: Found) => !!idx.get(f.instance)?.has(f.campaignId);
  const where = await locate(batch.map((b) => ({ email: b.email, known: known.get(b.email) ?? [] })), idx);
  const zips = new Set<string>();
  for (const b of batch) { b.signals.zips.forEach((z) => zips.add(z)); where.get(b.email)?.live?.zips.forEach((z) => zips.add(z)); }
  for (const p of change.places) if (p.zip) zips.add(p.zip);
  const facts = await zipFactsFor(zips);
  const cityStates = await cityStatesFor(change.places);

  // Decide per lead: keep (location changed since the check), or remove from what's live + what the scan saw.
  const keep: Array<{ email: string; reason: string }> = [];
  const plan = new Map<string, Found[]>();
  for (const b of batch) {
    const w = where.get(b.email)!;
    if (w.error) continue;
    if (!b.byHand && w.live) {
      const now = classify(mergeSignals(b.signals, w.live), change.places, facts, cityStates);
      if (now.cls !== "match") { keep.push({ email: b.email, reason: now.cls === "out" ? "its location no longer points to a removed place" : now.reason }); continue; }
    }
    plan.set(b.email, dedupe([...w.found, ...(known.get(b.email) ?? []).filter(inClient)]));
  }
  // Blocks first, so a run cut short in between never leaves a lead removed but
  // unblocked, or kept but blocked: the ones going are (still) blocked; the ones
  // kept are unblocked — only the block this change made (another change's stays).
  if (plan.size) await addSuppressions(change.clientTag, [...plan.keys()], change.id, change.approvedBy, `Service area change #${change.id}`);
  if (keep.length) await liftSuppressions(change.clientTag, keep.map((k) => k.email), "service-area check on the removal day", { changeId: change.id });
  const failedCamps = await removeMemberships([...plan.values()].flat());

  const updates: Parameters<typeof setResults>[1] = [];
  for (const k of keep) updates.push({ email: k.email, result: "kept", detail: `Not removed — ${k.reason} (checked on the removal day)` });
  for (const b of batch) {
    const w = where.get(b.email)!;
    if (w.error) {
      const last = b.attempts + 1 >= MAX_REMOVE_ATTEMPTS;
      updates.push({ email: b.email, result: last ? "failed" : null, detail: `Couldn't look it up in Email Bison: ${w.error}`, bumpAttempts: true });
      continue;
    }
    const mine = plan.get(b.email);
    if (!mine) continue; // kept
    if (mine.some((f) => failedCamps.has(`${f.instance}:${f.campaignId}`))) {
      const last = b.attempts + 1 >= MAX_REMOVE_ATTEMPTS;
      updates.push({ email: b.email, result: last ? "failed" : null, detail: "Email Bison didn't take the removal", bumpAttempts: true });
    } else if (!mine.length) {
      updates.push({ email: b.email, result: "removed", detail: "Wasn't in any of the client's campaigns any more", found: [] });
    } else {
      updates.push({ email: b.email, result: "removed", detail: `Taken out of ${listNames(names(mine, idx))}`, found: mine });
    }
  }
  await setResults(change.id, updates);
  return true;
}

/**
 * One batch of a verification round: leads removed but not yet checked this
 * round (attempts = round). Gone → verified. Still there → removed again and
 * checked next round, 10 minutes later; on the last round → failed.
 */
async function verifyBatch(change: Change, idx: CampaignIndex, round: number): Promise<boolean> {
  const batch = await leadsAt(change.id, "removed", BATCH, { attempts: round });
  if (!batch.length) return false;
  const known = await knownMemberships(change.id, batch.map((b) => b.email));
  const where = await locate(batch.map((b) => ({ email: b.email, known: dedupe([...b.found, ...(known.get(b.email) ?? [])]) })), idx);
  const lastRound = round + 1 >= MAX_VERIFY_ROUNDS;
  const still = [...where.values()].flatMap((w) => w.found);
  if (still.length && !lastRound) await removeMemberships(still);
  const updates: Parameters<typeof setResults>[1] = [];
  const ok: string[] = [];
  for (const b of batch) {
    const w = where.get(b.email)!;
    if (w.error) {
      updates.push({ email: b.email, result: lastRound ? "failed" : "removed", detail: `Couldn't check it in Email Bison: ${w.error}`, bumpAttempts: true });
    } else if (w.found.length) {
      updates.push({
        email: b.email, result: lastRound ? "failed" : "removed", bumpAttempts: true, found: dedupe([...b.found, ...w.found]),
        detail: lastRound ? `Still in ${listNames(names(w.found, idx))} after being removed ${MAX_VERIFY_ROUNDS - 1} times — take it out by hand` : `Was still in ${listNames(names(w.found, idx))} — removed again`,
      });
    } else ok.push(b.email);
  }
  await setResults(change.id, updates);
  // Verified leads keep the detail they had ("Taken out of …").
  for (let i = 0; i < ok.length; i += 200) {
    const chunk = ok.slice(i, i + 200);
    await db.execute({ sql: `UPDATE sa_lead SET result = 'verified', updated_at = ? WHERE change_id = ? AND result = 'removed' AND email IN (${chunk.map(() => "?").join(",")})`, args: [new Date().toISOString(), change.id, ...chunk] });
  }
  return true;
}

/**
 * One batch of the 7-day re-check. A lead is looked up up to RECHECK_TRIES
 * times: a clear answer finishes it (attempts jump to the cap); a lookup error
 * counts one try, and after the last it's noted on the lead.
 */
const RECHECK_TRIES = 3;
async function recheckBatch(change: Change, idx: CampaignIndex): Promise<{ more: boolean; cameBack: number }> {
  const batch = await leadsAt(change.id, "verified", BATCH, { maxAttempts: RECHECK_TRIES });
  if (!batch.length) return { more: false, cameBack: 0 };
  const known = await knownMemberships(change.id, batch.map((b) => b.email));
  const where = await locate(batch.map((b) => ({ email: b.email, known: dedupe([...b.found, ...(known.get(b.email) ?? [])]) })), idx);
  const back = [...where.values()].flatMap((w) => w.found);
  if (back.length) await removeMemberships(back);
  const day = new Date().toISOString().slice(0, 10);
  const updates: Parameters<typeof setResults>[1] = [];
  let came = 0;
  for (const b of batch) {
    const w = where.get(b.email)!;
    if (w.error) {
      const last = b.attempts + 1 >= RECHECK_TRIES;
      updates.push({ email: b.email, result: "verified" as LeadResult, bumpAttempts: true, ...(last ? { detail: `The re-check on ${day} couldn't look it up in Email Bison (${w.error}) — “Check for re-added leads now” tries again` } : {}) });
      continue;
    }
    if (w.found.length) {
      came++;
      updates.push({ email: b.email, result: "removed", detail: `Came back into ${listNames(names(w.found, idx))} (found ${day}) — taken out again`, found: dedupe([...b.found, ...w.found]), bumpAttempts: true, addAttempts: RECHECK_TRIES });
    } else updates.push({ email: b.email, result: "verified", bumpAttempts: true, addAttempts: RECHECK_TRIES });
  }
  await setResults(change.id, updates);
  return { more: true, cameBack: came };
}

// ── the phases, each run until the (short) step deadline ─────────────────────

/**
 * status 'removing': block → campaigns (where a lead whose details changed is
 * kept) → nurture queue (all but the kept ones), then hand over to the
 * 10-minute check. Returns true if it did work.
 */
export async function runRemoval(change: Change, deadline: number, holder: string): Promise<boolean> {
  if (!change.suppressedAt) {
    const n = await blockAll(change, holder);
    await logActivity("service-area", "removal-started", { client_tag: change.clientTag, details: { change_id: change.id, blocked: n } });
    return true;
  }
  const idx = await campaignIndex(change.clientTag);
  let did = false;
  while (Date.now() < deadline) {
    if (!(await removeBatch(change, idx))) break;
    did = true;
    await heartbeat(change.id, holder);
  }
  if (did) return true;
  // Nothing to try right now: leads waiting out a retry pause come back next run.
  const waiting = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sa_lead WHERE change_id = ? AND remove = 1 AND result IS NULL AND attempts < ?", args: [change.id, MAX_REMOVE_ATTEMPTS] })).rows[0]?.n) || 0;
  if (waiting > 0) return false;
  // Out of attempts → failed.
  await db.execute({ sql: "UPDATE sa_lead SET result = 'failed' WHERE change_id = ? AND remove = 1 AND result IS NULL", args: [change.id] });
  if (!change.queueDoneAt) {
    await removeFromQueue(change, deadline, holder);
    return true;
  }
  await resetAttempts(change.id);
  const now = new Date();
  await patchChange(change.id, { status: "verifying", removal_finished_at: now.toISOString(), verify_round: 0, verify_after: new Date(now.getTime() + VERIFY_DELAY_MS).toISOString() }, ["removing"]);
  await logActivity("service-area", "removal-finished", { client_tag: change.clientTag, details: { change_id: change.id } });
  return true;
}

/** status 'verifying' (due): one round over the removed leads; another round in 10 minutes if any were still there. */
export async function runVerify(change: Change, deadline: number, holder: string): Promise<boolean> {
  const idx = await campaignIndex(change.clientTag);
  const round = change.verifyRound;
  while (Date.now() < deadline) {
    if (await verifyBatch(change, idx, round)) { await heartbeat(change.id, holder); continue; }
    // Round finished.
    const now = new Date();
    const left = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sa_lead WHERE change_id = ? AND remove = 1 AND result = 'removed'", args: [change.id] })).rows[0]?.n) || 0;
    if (left > 0) {
      await patchChange(change.id, { verify_round: round + 1, verify_after: new Date(now.getTime() + VERIFY_DELAY_MS).toISOString() });
      return true;
    }
    const failed = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sa_lead WHERE change_id = ? AND remove = 1 AND result = 'failed'", args: [change.id] })).rows[0]?.n) || 0;
    await resetAttempts(change.id);
    await patchChange(change.id, {
      status: failed ? "partial" : "done", verified_at: now.toISOString(), verify_after: null, verify_round: 0,
      // The first re-check a week after the removal; after a re-check's own follow-up,
      // whatever the re-check scheduled next stays as it is.
      recheck_at: change.recheckedAt ? change.recheckAt : new Date(now.getTime() + RECHECK_DELAY_MS).toISOString(),
    }, ["verifying"]);
    await logActivity("service-area", "removal-verified", { client_tag: change.clientTag, details: { change_id: change.id, failed } });
    return true;
  }
  return true; // out of time mid-round; the next step carries on
}

/** The 7-day re-check (status done/partial with recheck_at due). */
export async function runRecheck(change: Change, deadline: number, holder: string): Promise<boolean> {
  const idx = await campaignIndex(change.clientTag);
  let came = 0;
  while (Date.now() < deadline) {
    const r = await recheckBatch(change, idx);
    came += r.cameBack;
    await heartbeat(change.id, holder);
    if (!r.more) {
      await resetAttempts(change.id);
      // Leads that came back were removed again: check those once more in 10 minutes.
      const reRemoved = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sa_lead WHERE change_id = ? AND remove = 1 AND result = 'removed'", args: [change.id] })).rows[0]?.n) || 0;
      const now = new Date();
      await patchChange(change.id, {
        // Two re-checks: a week after the removal, then about a month after it.
        came_back: change.cameBack + came, rechecked_at: now.toISOString(),
        recheck_at: change.recheckedAt ? null : new Date(now.getTime() + SECOND_RECHECK_DELAY_MS).toISOString(),
        ...(reRemoved ? { status: "verifying", verify_round: 0, verify_after: new Date(now.getTime() + VERIFY_DELAY_MS).toISOString() } : {}),
      });
      await logActivity("service-area", "recheck", { client_tag: change.clientTag, details: { change_id: change.id, came_back: came } });
      return true;
    }
  }
  if (came) await patchChange(change.id, { came_back: change.cameBack + came });
  return true;
}
