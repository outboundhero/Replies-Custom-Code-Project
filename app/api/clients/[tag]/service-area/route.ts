/**
 * Service-area changes for one client.
 *
 * GET  → the client's changes (newest first) with their counts, plus the last
 *        edit of the Onboarding Form's service-area text.
 * POST { entries: [{ type: "city"|"state"|"zip", text }], noticeDate, note?, preview? }
 *      → preview: the places as read, the removal date, problems — nothing saved.
 *      → otherwise: records the change and starts the (read-only) scan.
 * One open change per client at a time.
 */
import { NextRequest, NextResponse } from "next/server";
import { teamAccess } from "@/lib/service-area-changes/access";
import { isIsoDate, pacificMidnight, pacificToday, parsePlaces, removalDate, type Place, type PlaceType } from "@/lib/service-area-changes/places";
import { addTasks, changeSummary, counts, createChange, getChange, listChanges, openChanges, patchChange, zipFactsFor } from "@/lib/service-area-changes/store";
import { clientCampaigns, scanTasks } from "@/lib/service-area-changes/scan";
import { triggerServiceAreaRunner } from "@/lib/service-area-changes/runner";
import { latestTextChange } from "@/lib/service-area-changes/text-versions";
import { logActivity } from "@/lib/errors";
import { zipsOfCity } from "@/lib/qualification/zip-audit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  const a = await teamAccess((await params).tag);
  if (!a.ok) return a.res;
  try {
    const changes = await listChanges(a.tag);
    const out = await Promise.all(changes.slice(0, 12).map(async (c) => ({ ...changeSummary(c), counts: await counts(c.id) })));
    const textChange = await latestTextChange(a.tag).catch(() => null);
    return NextResponse.json({ ok: true, tag: a.tag, today: pacificToday(), changes: out, textChange });
  } catch (e) {
    console.error("[api/clients/service-area]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

const TYPES: PlaceType[] = ["city", "state", "zip"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  const a = await teamAccess((await params).tag);
  if (!a.ok) return a.res;
  const body = await req.json().catch(() => ({}));
  try {
    // Read the places, every group the same way the screen does.
    const entries = Array.isArray(body?.entries) ? body.entries as Array<{ type?: unknown; text?: unknown }> : [];
    const places: Place[] = [];
    const errors: string[] = [], warnings: string[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const type = String(e?.type) as PlaceType;
      if (!TYPES.includes(type)) { errors.push(`Unknown kind of place “${String(e?.type)}”.`); continue; }
      const r = parsePlaces(type, String(e?.text ?? ""));
      errors.push(...r.errors);
      for (const p of r.places) if (!seen.has(p.key)) { seen.add(p.key); places.push(p); }
    }
    if (!places.length && !errors.length) errors.push("Add at least one city, state or ZIP to remove.");
    if (places.length > 300) errors.push("That's more than 300 places — split it into a few changes.");

    // ZIPs: which city and state each one is (used to catch leads with no ZIP).
    const zips = places.filter((p) => p.type === "zip").map((p) => p.zip!);
    if (zips.length) {
      const facts = await zipFactsFor(zips);
      for (const p of places) {
        if (p.type !== "zip") continue;
        const f = facts.get(p.zip!);
        if (f) {
          p.city = f.city; p.state = f.state; p.label = `${p.zip} (${f.city}, ${f.state})`;
          // How many ZIPs its city has: a lead with no ZIP there only needs checking when it's 1–2.
          p.cityZipCount = (await zipsOfCity(f.city, f.state)).length || undefined;
        }
        else warnings.push(`ZIP ${p.zip} isn't in our US ZIP list — it'll still be matched exactly.`);
      }
    }

    const today = pacificToday();
    const notice = String(body?.noticeDate ?? "");
    if (!isIsoDate(notice)) errors.push("Pick the date the notice was received.");
    else if (notice > today) errors.push("The notice date can't be in the future.");
    else if (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${notice}T00:00:00Z`) > 60 * 86_400_000) errors.push("The notice date is more than 60 days ago — check it.");
    const rDate = isIsoDate(notice) ? removalDate(notice) : null;
    const rAt = rDate ? pacificMidnight(rDate).toISOString() : null;
    const note = String(body?.note ?? "").trim().slice(0, 500) || null;

    if (body?.preview) return NextResponse.json({ ok: true, places, errors, warnings, removalDate: rDate, removalAt: rAt });
    if (errors.length) return NextResponse.json({ error: errors[0], errors }, { status: 400 });

    const open = await openChanges(a.tag);
    if (open.length) return NextResponse.json({ error: `${a.tag} already has an open change (#${open[0].id}) — finish or cancel it first.` }, { status: 409 });

    // The campaigns to check: every "TAG: …" campaign in all four instances.
    let campaigns;
    try { campaigns = await clientCampaigns(a.tag); }
    catch (e) { return NextResponse.json({ error: `Couldn't read ${a.tag}'s campaigns in Email Bison (${(e as Error).message}) — try again in a minute.` }, { status: 502 }); }

    // Recorded as "planning"; it only starts checking once every task is written,
    // so a set-up that stops half-way can never pass for a finished check.
    let id: number;
    try { id = await createChange({ clientTag: a.tag, places, noticeDate: notice, removalDate: rDate!, removalAt: rAt!, note, by: a.email }); }
    catch (e) {
      // Someone started one for this client at the same moment (one open change per client).
      if (/UNIQUE constraint failed/i.test((e as Error).message)) return NextResponse.json({ error: `${a.tag} already has an open change — reload to see it.` }, { status: 409 });
      throw e;
    }
    try {
      await patchChange(id, { campaigns_json: JSON.stringify(campaigns) });
      await addTasks(id, scanTasks((await getChange(id))!, campaigns));
      await patchChange(id, { status: "scanning" }, ["planning"]);
    } catch (e) {
      await patchChange(id, { error: `Setting up the check failed: ${(e as Error).message}. Open the change and use “Check again”.` }).catch(() => {});
      throw e;
    }
    await logActivity("service-area", "change-recorded", {
      client_tag: a.tag,
      details: { change_id: id, by: a.email, places: places.map((p) => p.label), notice_date: notice, removal_date: rDate, campaigns: campaigns.length },
    });
    triggerServiceAreaRunner(id);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    console.error("[api/clients/service-area POST]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
