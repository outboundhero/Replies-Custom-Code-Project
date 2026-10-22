/**
 * POST /api/clients/[tag]/service-area/[id]/mutate { action, ... }
 *
 *   decide       { emails, remove }               tick / untick leads (while scanning or in review)
 *   decide-all   { tab, q?, remove, expected }     tick / untick every lead matching a tab + search
 *   approve      { confirm: TAG, removalDate }     approve — removal runs on the removal day (the one the approver saw)
 *   unapprove                                      back to review (before the removal day)
 *   cancel                                         stop this change (before removal starts)
 *   set-removal-date { removalDate }               move the removal day (before the removal starts); an
 *                                                  approved change moved EARLIER goes back to review
 *   retry-scan                                     re-read the parts of the check that failed
 *   rescan                                         check again for leads added since (keeps the ticks)
 *   retry-removal                                  try the leads whose removal failed again
 *   let-back-in  { emails }                        take leads off the client's block list
 *   recheck-now                                    run the "did any come back?" check now
 */
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { teamAccess } from "@/lib/service-area-changes/access";
import {
  addTasks, countMatching, counts, failedTasks, getChange, patchChange, retryFailedTasks, setDecisions, setDecisionsMatching, type Tab,
} from "@/lib/service-area-changes/store";
import { clientCampaigns, scanTasks } from "@/lib/service-area-changes/scan";
import { liftSuppressions } from "@/lib/service-area-changes/suppression";
import { triggerServiceAreaRunner } from "@/lib/service-area-changes/runner";
import { logActivity } from "@/lib/errors";
import { pacificMidnight, pacificToday, removalDateProblem } from "@/lib/service-area-changes/places";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TABS: Tab[] = ["match", "check", "noloc", "ticked"];
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ tag: string; id: string }> }) {
  const p = await params;
  const a = await teamAccess(p.tag);
  if (!a.ok) return a.res;
  const id = Number(p.id);
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");
  try {
    const change = Number.isInteger(id) ? await getChange(id) : null;
    if (!change || change.clientTag !== a.tag) return bad("Change not found", 404);
    const now = new Date().toISOString();
    const log = (what: string, details: Record<string, unknown> = {}) =>
      logActivity("service-area", what, { client_tag: a.tag, details: { change_id: id, by: a.email, ...details } });

    switch (action) {
      case "decide": {
        if (!["scanning", "review"].includes(change.status)) return bad(change.status === "approved" ? "It's approved — reopen the review to change ticks." : "Ticks can't change any more.", 409);
        const emails = Array.isArray(body?.emails) ? (body.emails as unknown[]).map(String).slice(0, 5000) : [];
        if (!emails.length) return bad("No leads given");
        const n = await setDecisions(id, emails, !!body?.remove, a.email);
        return NextResponse.json({ ok: true, changed: n });
      }

      case "decide-all": {
        if (!["scanning", "review"].includes(change.status)) return bad(change.status === "approved" ? "It's approved — reopen the review to change ticks." : "Ticks can't change any more.", 409);
        const tab = String(body?.tab) as Tab;
        if (!TABS.includes(tab)) return bad("Unknown tab");
        const f = { tab, q: body?.q ? String(body.q) : undefined };
        const total = await countMatching(id, f);
        const expected = Number(body?.expected);
        if (!Number.isFinite(expected)) return bad("expected count required");
        if (total !== expected) {
          return NextResponse.json({ error: `The list changed (now ${total.toLocaleString()} leads) — look again and retry.`, total }, { status: 409 });
        }
        const n = await setDecisionsMatching(id, f, !!body?.remove, a.email);
        await log(body?.remove ? "ticked-all" : "unticked-all", { tab, q: f.q ?? null, leads: n });
        return NextResponse.json({ ok: true, changed: n });
      }

      case "approve": {
        if (change.status !== "review") return bad(change.status === "scanning" ? "The check is still running." : "Only a change in review can be approved.", 409);
        if (String(body?.confirm || "").trim().toUpperCase() !== a.tag) return bad(`Type ${a.tag} to confirm.`);
        if ((await failedTasks(id)).length) return bad("Part of the check couldn't be read — retry it first.", 409);
        const c = await counts(id);
        if (c.ticked === 0) return bad("Nothing is ticked to remove.", 409);
        // Approved for the removal day the approver saw — if someone moved it meanwhile, look again.
        const seen = String(body?.removalDate ?? "");
        if (seen !== change.removalDate) return bad(`The removal day is now ${change.removalDate} — reload and check it before approving.`, 409);
        const r = await db.execute({
          sql: "UPDATE sa_change SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'review' AND removal_date = ?",
          args: [a.email, now, now, id, seen],
        });
        if (!(r.rowsAffected ?? 0)) return bad("It changed meanwhile — reload.", 409);
        await log("approved", { leads: c.ticked, removal_at: change.removalAt });
        if (Date.parse(change.removalAt) <= Date.now()) triggerServiceAreaRunner(id);
        return NextResponse.json({ ok: true });
      }

      case "unapprove": {
        if (change.status !== "approved") return bad("It isn't approved.", 409);
        if (Date.parse(change.removalAt) <= Date.now()) return bad("The removal has already started.", 409);
        const ok = await patchChange(id, { status: "review", approved_by: null, approved_at: null }, ["approved"]);
        if (!ok) return bad("It changed meanwhile — reload.", 409);
        await log("unapproved");
        return NextResponse.json({ ok: true });
      }

      case "cancel": {
        const ok = await patchChange(id, { status: "cancelled", cancelled_by: a.email, cancelled_at: now }, ["planning", "scanning", "review", "approved"]);
        if (!ok) return bad("It can't be cancelled now — the removal has started.", 409);
        await db.execute({ sql: "UPDATE sa_task SET status = 'cancelled', updated_at = ? WHERE change_id = ? AND status = 'pending'", args: [now, id] });
        await log("cancelled");
        return NextResponse.json({ ok: true });
      }

      case "set-removal-date": {
        const before = ["planning", "scanning", "review", "approved"] as const;
        if (!(before as readonly string[]).includes(change.status) || (change.status === "approved" && Date.parse(change.removalAt) <= Date.now())) {
          return bad("The removal has started — its day can't change now.", 409);
        }
        const date = String(body?.removalDate ?? "");
        const problem = removalDateProblem(date, change.noticeDate, pacificToday());
        if (problem) return bad(problem);
        if (date === change.removalDate) return NextResponse.json({ ok: true, unchanged: true });
        const at = pacificMidnight(date).toISOString();
        // Approved for a later day than the new one: the approval was for that day — back to review.
        const reapprove = change.status === "approved" && date < change.removalDate;
        const fields = reapprove ? { removal_date: date, removal_at: at, status: "review", approved_by: null, approved_at: null } : { removal_date: date, removal_at: at };
        const r = await db.execute({
          sql: `UPDATE sa_change SET ${Object.keys(fields).map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND status = ? AND removal_date = ?`,
          args: [...Object.values(fields), now, id, change.status, change.removalDate],
        });
        if (!(r.rowsAffected ?? 0)) return bad("It changed meanwhile — reload.", 409);
        await log("removal-date-changed", { from: change.removalDate, to: date, back_to_review: reapprove });
        return NextResponse.json({ ok: true, backToReview: reapprove });
      }

      case "retry-scan": {
        if (!["scanning", "review"].includes(change.status)) return bad("Only while checking or in review.", 409);
        if (!(await failedTasks(id)).length) return bad("Nothing failed.", 409);
        // Back to checking (from review only — never over an approval or a cancel).
        if (!(await patchChange(id, { status: "scanning", scan_done_at: null }, ["scanning", "review"]))) return bad("It changed meanwhile — reload.", 409);
        const n = await retryFailedTasks(id);
        // Re-run the final pass over our database once the retried parts are read.
        await db.execute({ sql: "DELETE FROM sa_task WHERE change_id = ? AND kind = 'enrich' AND term = 'final'", args: [id] });
        await log("scan-retried", { tasks: n });
        triggerServiceAreaRunner(id);
        return NextResponse.json({ ok: true, retried: n });
      }

      case "rescan": {
        // From review, or from a set-up that stopped half-way ("planning" / an incomplete check).
        const incomplete = change.status === "scanning" && !!change.error && /isn't complete|Setting up the check failed/.test(change.error);
        if (!["review", "planning"].includes(change.status) && !incomplete) return bad("Only a change in review can be checked again.", 409);
        let campaigns;
        try { campaigns = await clientCampaigns(a.tag); }
        catch (e) { return bad(`Couldn't read the campaigns in Email Bison (${(e as Error).message}).`, 502); }
        if (!(await patchChange(id, { status: "planning", campaigns_json: JSON.stringify(campaigns), quick_done_at: null, scan_done_at: null, error: null }, ["review", "planning", "scanning"]))) {
          return bad("It changed meanwhile — reload.", 409);
        }
        await db.execute({ sql: "DELETE FROM sa_task WHERE change_id = ?", args: [id] });
        await db.execute({ sql: "UPDATE sa_lead SET xchecked = 0 WHERE change_id = ?", args: [id] });
        try {
          await addTasks(id, scanTasks((await getChange(id))!, campaigns));
        } catch (e) {
          await patchChange(id, { error: `Setting up the check failed: ${(e as Error).message}. Use “Check again”.` });
          throw e;
        }
        await patchChange(id, { status: "scanning" }, ["planning"]);
        await log("rescan", { campaigns: campaigns.length });
        triggerServiceAreaRunner(id);
        return NextResponse.json({ ok: true });
      }

      case "retry-removal": {
        if (change.status !== "partial") return bad("Only after a removal that didn't fully work.", 409);
        if (!(await patchChange(id, { status: "removing", verify_round: 0 }, ["partial"]))) return bad("It changed meanwhile — reload.", 409);
        const r = await db.execute({ sql: "UPDATE sa_lead SET result = NULL, attempts = 0, result_detail = NULL WHERE change_id = ? AND remove = 1 AND result = 'failed'", args: [id] });
        await log("removal-retried", { leads: r.rowsAffected ?? 0 });
        triggerServiceAreaRunner(id);
        return NextResponse.json({ ok: true, leads: r.rowsAffected ?? 0 });
      }

      case "let-back-in": {
        if (!["removing", "verifying", "done", "partial"].includes(change.status)) return bad("Only after the removal has started.", 409);
        const asked = Array.isArray(body?.emails) ? [...new Set((body.emails as unknown[]).map((e) => String(e).trim().toLowerCase()).filter(Boolean))].slice(0, 5000) : [];
        if (!asked.length) return bad("No leads given");
        // Only leads this change took out.
        const emails: string[] = [];
        for (let i = 0; i < asked.length; i += 200) {
          const chunk = asked.slice(i, i + 200);
          const r = await db.execute({ sql: `SELECT email FROM sa_lead WHERE change_id = ? AND remove = 1 AND email IN (${chunk.map(() => "?").join(",")})`, args: [id, ...chunk] });
          emails.push(...r.rows.map((x) => String(x.email)));
        }
        if (!emails.length) return bad("Those leads weren't removed by this change.", 409);
        const n = await liftSuppressions(a.tag, emails, a.email);
        const day = now.slice(0, 10);
        // "let_in": left out of the verification and the 7-day re-check from now on.
        for (let i = 0; i < emails.length; i += 200) {
          const chunk = emails.slice(i, i + 200);
          await db.execute({
            sql: `UPDATE sa_lead SET result = 'let_in', result_detail = COALESCE(result_detail || ' · ', '') || ?, updated_at = ? WHERE change_id = ? AND remove = 1 AND email IN (${chunk.map(() => "?").join(",")})`,
            args: [`Let back in by ${a.email ?? "someone"} on ${day}`, now, id, ...chunk],
          });
        }
        await log("let-back-in", { leads: n, sample: emails.slice(0, 20) });
        return NextResponse.json({ ok: true, lifted: n });
      }

      case "recheck-now": {
        if (!["done", "partial"].includes(change.status)) return bad("Only after the removal has finished.", 409);
        await patchChange(id, { recheck_at: now });
        await log("recheck-requested");
        triggerServiceAreaRunner(id);
        return NextResponse.json({ ok: true });
      }

      default:
        return bad(`Unknown action “${action}”`);
    }
  } catch (e) {
    console.error("[api/clients/service-area/mutate]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
