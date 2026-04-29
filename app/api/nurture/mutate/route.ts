/**
 * POST /api/nurture/mutate
 *
 * Actions:
 *  - "classify-batch": Run safety classifier on a list of unclassified reply IDs
 *  - "classify-all-unclassified": Classify ALL replies that are nurture candidates and don't yet have a safety
 *  - "classify-reset-safe": Re-classify replies currently marked "safe" (apply new classifier rules retroactively)
 *  - "push-to-nurture": Push items (replies + sequence-finished leads) to a nurture campaign
 *  - "skip": Mark an item as skipped (do not nurture)
 *  - "unskip": Reverse a skip
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { classifyNurtureSafety } from "@/lib/nurture/safety-classifier";
import { classifyOneBatch } from "@/lib/nurture/auto-classify";
import { attachLeadsToCampaign, findLeadByEmail } from "@/lib/outboundhero-api";

const CLASSIFY_CONCURRENCY = 8;

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        await worker(items[idx]);
      } catch (e) {
        console.error("[nurture/mutate] worker error", e);
      }
    }
  });
  await Promise.all(runners);
}

interface ItemRef {
  id: string;          // "reply:123", "seq:456", or "legacy:789"
  ob_lead_id?: number; // optional override (for sequence_finished items it's known)
  email?: string;      // optional, used to find OB lead ID for reply-based / legacy items
}

function parseItemId(id: string): { source: "reply" | "seq" | "legacy"; rowId: number } | null {
  const m = id.match(/^(reply|seq|legacy):(\d+)$/);
  if (!m) return null;
  return { source: m[1] as "reply" | "seq" | "legacy", rowId: Number(m[2]) };
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const body = await req.json();
    const { action } = body;

    // ── classify a specific batch of reply IDs ──
    if (action === "classify-batch") {
      const ids: number[] = body.replyIds || [];
      if (!Array.isArray(ids) || ids.length === 0) {
        return NextResponse.json({ error: "replyIds required" }, { status: 400 });
      }

      const { data: rows, error } = await supabase
        .from("replies")
        .select("id, reply_we_got, ai_categorized_lead_category")
        .in("id", ids);
      if (error) throw new Error(error.message);

      const results: Array<{ id: number; safety: string; bucket: string | null; reason: string }> = [];
      await runWithConcurrency(
        rows || [],
        async (r) => {
          const result = await classifyNurtureSafety({
            replyText: r.reply_we_got || "",
            aiCategory: r.ai_categorized_lead_category ?? null,
          });
          await supabase
            .from("replies")
            .update({
              nurture_safety: result.safety,
              nurture_bucket: result.bucket,
              nurture_safety_reason: result.reason,
              nurture_classified_at: new Date().toISOString(),
            })
            .eq("id", r.id);
          results.push({ id: r.id, safety: result.safety, bucket: result.bucket, reason: result.reason });
        },
        CLASSIFY_CONCURRENCY
      );

      return NextResponse.json({ ok: true, classified: results.length, results });
    }

    // ── classify EVERY unclassified reply (regardless of AI category) ──
    // Pulls in batches of 200 per request from BOTH replies and legacy.
    // Re-run to continue if more remain. Shares the same code path as the
    // /api/cron/nurture-classify-unclassified job.
    if (action === "classify-all-unclassified") {
      const result = await classifyOneBatch();
      return NextResponse.json({
        ok: true,
        classified: result.classified,
        replyClassified: result.replyClassified,
        legacyClassified: result.legacyClassified,
        remaining: result.done ? 0 : "more remaining — re-run to continue",
      });
    }

    // ── re-classify everything currently marked safe (apply new classifier rules) ──
    // Pulls 200 from each of replies + legacy.
    if (action === "classify-reset-safe") {
      const [{ data: replyRows, error: replyErr }, { data: legacyRows, error: legacyErr }] =
        await Promise.all([
          supabase
            .from("replies")
            .select("id, reply_we_got, ai_categorized_lead_category, nurture_safety")
            .not("reply_we_got", "is", null)
            .neq("reply_we_got", "")
            .eq("nurture_safety", "safe")
            .limit(200),
          supabase
            .from("nurture_legacy_leads")
            .select("id, reply_text, original_ai_category, nurture_safety")
            .not("reply_text", "is", null)
            .neq("reply_text", "")
            .eq("nurture_safety", "safe")
            .limit(200),
        ]);
      if (replyErr) throw new Error(replyErr.message);
      if (legacyErr) throw new Error(legacyErr.message);

      let reclassified = 0;
      let flippedToUnsafe = 0;
      await runWithConcurrency(
        replyRows || [],
        async (r) => {
          const result = await classifyNurtureSafety({
            replyText: r.reply_we_got || "",
            aiCategory: r.ai_categorized_lead_category ?? null,
          });
          await supabase
            .from("replies")
            .update({
              nurture_safety: result.safety,
              nurture_bucket: result.bucket,
              nurture_safety_reason: result.reason,
              nurture_classified_at: new Date().toISOString(),
            })
            .eq("id", r.id);
          reclassified++;
          if (result.safety !== "safe") flippedToUnsafe++;
        },
        CLASSIFY_CONCURRENCY
      );
      await runWithConcurrency(
        legacyRows || [],
        async (r) => {
          const result = await classifyNurtureSafety({
            replyText: r.reply_text || "",
            aiCategory: r.original_ai_category ?? null,
          });
          await supabase
            .from("nurture_legacy_leads")
            .update({
              nurture_safety: result.safety,
              nurture_bucket: result.bucket,
              nurture_safety_reason: result.reason,
              nurture_classified_at: new Date().toISOString(),
            })
            .eq("id", r.id);
          reclassified++;
          if (result.safety !== "safe") flippedToUnsafe++;
        },
        CLASSIFY_CONCURRENCY
      );

      const replyDone = (replyRows?.length || 0) < 200;
      const legacyDone = (legacyRows?.length || 0) < 200;
      return NextResponse.json({
        ok: true,
        reclassified,
        flippedToUnsafe,
        replyReclassified: replyRows?.length || 0,
        legacyReclassified: legacyRows?.length || 0,
        remaining: replyDone && legacyDone ? 0 : "more remaining — re-run to continue",
      });
    }

    // ── skip / unskip ──
    if (action === "skip" || action === "unskip") {
      const items: string[] = body.itemIds || [];
      if (!Array.isArray(items) || items.length === 0) {
        return NextResponse.json({ error: "itemIds required" }, { status: 400 });
      }
      const skipValue = action === "skip";
      const replyIds: number[] = [];
      const seqIds: number[] = [];
      const legacyIds: number[] = [];
      for (const id of items) {
        const parsed = parseItemId(id);
        if (!parsed) continue;
        if (parsed.source === "reply") replyIds.push(parsed.rowId);
        else if (parsed.source === "seq") seqIds.push(parsed.rowId);
        else legacyIds.push(parsed.rowId);
      }
      if (replyIds.length) {
        await supabase.from("replies").update({ nurture_skipped: skipValue }).in("id", replyIds);
      }
      if (seqIds.length) {
        await supabase.from("nurture_sequence_finished").update({ skipped: skipValue }).in("id", seqIds);
      }
      if (legacyIds.length) {
        await supabase.from("nurture_legacy_leads").update({ nurture_skipped: skipValue }).in("id", legacyIds);
      }
      return NextResponse.json({ ok: true, updated: items.length });
    }

    // ── push to nurture ──
    if (action === "push-to-nurture") {
      const nurtureCampaignId: number = body.nurtureCampaignId;
      const items: ItemRef[] = body.items || [];
      if (!nurtureCampaignId || !items.length) {
        return NextResponse.json({ error: "nurtureCampaignId and items required" }, { status: 400 });
      }

      // 1. Resolve each item to an OutboundHero lead ID.
      //
      // Old version did one Supabase .single() per item AND one
      // findLeadByEmail per item without ob_lead_id, all sequentially —
      // pushing 90 leads took 30–60s before the actual attach call fired.
      //
      // New flow:
      //   a) Group item IDs by source up-front.
      //   b) Run THREE parallel batched SELECTs (one per source) using
      //      .in("id", [...]) — the whole validation phase is two round
      //      trips no matter how many leads.
      //   c) For items still missing ob_lead_id after step (b), run
      //      findLeadByEmail with bounded concurrency 10 instead of one
      //      at a time.
      const leadIds: number[] = [];
      const replyIdsBeingAdded: number[] = [];
      const seqIdsBeingAdded: number[] = [];
      const legacyIdsBeingAdded: number[] = [];
      const failures: Array<{ id: string; reason: string }> = [];

      // (a) Group by source
      const replyItemsByRowId = new Map<number, ItemRef>();
      const seqItemsByRowId = new Map<number, ItemRef>();
      const legacyItemsByRowId = new Map<number, ItemRef>();
      for (const it of items) {
        const parsed = parseItemId(it.id);
        if (!parsed) { failures.push({ id: it.id, reason: "Invalid item id" }); continue; }
        if (parsed.source === "reply") replyItemsByRowId.set(parsed.rowId, it);
        else if (parsed.source === "seq") seqItemsByRowId.set(parsed.rowId, it);
        else legacyItemsByRowId.set(parsed.rowId, it);
      }

      // (b) Three parallel batched SELECTs
      const replyRowIds = Array.from(replyItemsByRowId.keys());
      const seqRowIds = Array.from(seqItemsByRowId.keys());
      const legacyRowIds = Array.from(legacyItemsByRowId.keys());

      const [replyRowsRes, seqRowsRes, legacyRowsRes] = await Promise.all([
        replyRowIds.length
          ? supabase
              .from("replies")
              .select("id, lead_email, nurture_added_at, nurture_skipped, nurture_safety")
              .in("id", replyRowIds)
          : Promise.resolve({ data: [], error: null }),
        seqRowIds.length
          ? supabase
              .from("nurture_sequence_finished")
              .select("id, ob_lead_id, added_at, skipped")
              .in("id", seqRowIds)
          : Promise.resolve({ data: [], error: null }),
        legacyRowIds.length
          ? supabase
              .from("nurture_legacy_leads")
              .select("id, lead_email, nurture_added_at, nurture_skipped, nurture_safety")
              .in("id", legacyRowIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (replyRowsRes.error) throw new Error(`replies select: ${replyRowsRes.error.message}`);
      if (seqRowsRes.error) throw new Error(`seq select: ${seqRowsRes.error.message}`);
      if (legacyRowsRes.error) throw new Error(`legacy select: ${legacyRowsRes.error.message}`);

      const replyRowMap = new Map((replyRowsRes.data || []).map((r) => [r.id as number, r]));
      const seqRowMap = new Map((seqRowsRes.data || []).map((r) => [r.id as number, r]));
      const legacyRowMap = new Map((legacyRowsRes.data || []).map((r) => [r.id as number, r]));

      // Validate seq rows synchronously (no email lookup needed — ob_lead_id is on the row)
      for (const [rowId, it] of seqItemsByRowId) {
        const row = seqRowMap.get(rowId);
        if (!row || !row.ob_lead_id) { failures.push({ id: it.id, reason: "Lead not found" }); continue; }
        if (row.added_at) { failures.push({ id: it.id, reason: "Already added" }); continue; }
        if (row.skipped) { failures.push({ id: it.id, reason: "Skipped" }); continue; }
        leadIds.push(row.ob_lead_id as number);
        seqIdsBeingAdded.push(rowId);
      }

      // Validate reply + legacy rows. Items still needing findLeadByEmail
      // get pushed into a queue and resolved in parallel below.
      interface PendingLookup {
        itemId: string;
        rowId: number;
        source: "reply" | "legacy";
        email: string;
      }
      const pendingLookups: PendingLookup[] = [];

      const validateEmailRow = (
        source: "reply" | "legacy",
        rowId: number,
        it: ItemRef,
        row:
          | { lead_email: string | null; nurture_added_at: string | null; nurture_skipped: boolean | null; nurture_safety: string | null }
          | undefined,
        notFoundReason: string,
      ) => {
        if (!row) { failures.push({ id: it.id, reason: notFoundReason }); return; }
        if (row.nurture_added_at) { failures.push({ id: it.id, reason: "Already added" }); return; }
        if (row.nurture_skipped) { failures.push({ id: it.id, reason: "Skipped" }); return; }
        if (row.nurture_safety !== "safe") { failures.push({ id: it.id, reason: `Not safe (${row.nurture_safety || "unclassified"})` }); return; }

        if (it.ob_lead_id) {
          leadIds.push(it.ob_lead_id);
          if (source === "reply") replyIdsBeingAdded.push(rowId);
          else legacyIdsBeingAdded.push(rowId);
          return;
        }
        if (!row.lead_email) {
          failures.push({ id: it.id, reason: "Could not find lead in OutboundHero" });
          return;
        }
        pendingLookups.push({ itemId: it.id, rowId, source, email: row.lead_email });
      };

      for (const [rowId, it] of replyItemsByRowId) {
        validateEmailRow("reply", rowId, it, replyRowMap.get(rowId) as never, "Reply not found");
      }
      for (const [rowId, it] of legacyItemsByRowId) {
        validateEmailRow("legacy", rowId, it, legacyRowMap.get(rowId) as never, "Legacy lead not found");
      }

      // (c) Parallel findLeadByEmail for everything that didn't have a
      // pre-resolved ob_lead_id. Concurrency 25 — OutboundHero's /leads
      // search endpoint comfortably handles this; we have not seen rate
      // limit pushback. For 90 lookups this brings wall time from ~10s
      // (concurrency 10) to ~3-4s.
      if (pendingLookups.length) {
        await runWithConcurrency(
          pendingLookups,
          async (p) => {
            const lead = await findLeadByEmail(p.email);
            if (!lead) {
              failures.push({ id: p.itemId, reason: "Could not find lead in OutboundHero" });
              return;
            }
            leadIds.push(lead.id);
            if (p.source === "reply") replyIdsBeingAdded.push(p.rowId);
            else legacyIdsBeingAdded.push(p.rowId);
          },
          25,
        );
      }

      if (leadIds.length === 0) {
        return NextResponse.json({ ok: false, attached: 0, failures }, { status: 400 });
      }

      // 2. Push them all to the nurture campaign in one call.
      //    allow_parallel_sending defaults to TRUE inside attachLeadsToCampaign
      //    — without it, OutboundHero silently drops leads already in another
      //    active campaign and still returns 200 OK.
      const result = await attachLeadsToCampaign(nurtureCampaignId, leadIds);
      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error, attached: 0, requested: leadIds.length, failures }, { status: 502 });
      }

      // 3. Decide whether to mark them as added in our DB.
      //
      //    If OutboundHero confirms attachedCount === requestedCount, mark
      //    everything. If the count is unknown (response shape didn't expose
      //    one), trust the request size — that's the legacy behavior, fine
      //    when allow_parallel_sending is true.
      //
      //    If OutboundHero attached FEWER than we asked for, we don't know
      //    WHICH leads were dropped (the response doesn't itemize). Mark
      //    nothing as added and return a partial-success payload so the
      //    user can investigate in OutboundHero before re-pushing. This is
      //    deliberately conservative — better to re-push than to silently
      //    record unattached leads as added (which is exactly the bug that
      //    triggered this whole change).
      const fullySucceeded =
        result.attachedCount === null || result.attachedCount === leadIds.length;

      if (!fullySucceeded) {
        return NextResponse.json({
          ok: false,
          partial: true,
          attached: result.attachedCount,
          requested: leadIds.length,
          message:
            `OutboundHero attached only ${result.attachedCount} of ${leadIds.length} leads — likely some are blocked, deleted, or in another campaign that doesn't allow parallel sending. ` +
            `Nothing has been marked as added in the dashboard. Inspect the campaign in OutboundHero and re-push.`,
          obMessage: result.message,
          failures,
        });
      }

      const nowIso = new Date().toISOString();
      if (replyIdsBeingAdded.length) {
        await supabase.from("replies").update({
          nurture_added_at: nowIso,
          nurture_campaign_id: nurtureCampaignId,
        }).in("id", replyIdsBeingAdded);
      }
      if (seqIdsBeingAdded.length) {
        await supabase.from("nurture_sequence_finished").update({
          added_at: nowIso,
          nurture_campaign_id: nurtureCampaignId,
        }).in("id", seqIdsBeingAdded);
      }
      if (legacyIdsBeingAdded.length) {
        await supabase.from("nurture_legacy_leads").update({
          nurture_added_at: nowIso,
          nurture_campaign_id: nurtureCampaignId,
        }).in("id", legacyIdsBeingAdded);
      }

      return NextResponse.json({
        ok: true,
        attached: leadIds.length,
        requested: leadIds.length,
        message: result.message,
        failures,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("[api/nurture/mutate] POST failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
