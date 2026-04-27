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

async function classifyAndStore(r: {
  id: number;
  reply_we_got: string | null;
  ai_categorized_lead_category?: string | null;
}) {
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
}

async function classifyAndStoreLegacy(r: {
  id: number;
  reply_text: string | null;
  original_ai_category?: string | null;
}) {
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
    // Re-run to continue if more remain.
    if (action === "classify-all-unclassified") {
      const [{ data: replyRows, error: replyErr }, { data: legacyRows, error: legacyErr }] =
        await Promise.all([
          supabase
            .from("replies")
            .select("id, reply_we_got, ai_categorized_lead_category")
            .not("reply_we_got", "is", null)
            .neq("reply_we_got", "")
            .is("nurture_safety", null)
            .limit(200),
          supabase
            .from("nurture_legacy_leads")
            .select("id, reply_text, original_ai_category")
            .not("reply_text", "is", null)
            .neq("reply_text", "")
            .is("nurture_safety", null)
            .limit(200),
        ]);
      if (replyErr) throw new Error(replyErr.message);
      if (legacyErr) throw new Error(legacyErr.message);

      let classified = 0;
      await runWithConcurrency(
        replyRows || [],
        async (r) => { await classifyAndStore(r); classified++; },
        CLASSIFY_CONCURRENCY
      );
      await runWithConcurrency(
        legacyRows || [],
        async (r) => { await classifyAndStoreLegacy(r); classified++; },
        CLASSIFY_CONCURRENCY
      );

      const replyDone = (replyRows?.length || 0) < 200;
      const legacyDone = (legacyRows?.length || 0) < 200;
      return NextResponse.json({
        ok: true,
        classified,
        replyClassified: replyRows?.length || 0,
        legacyClassified: legacyRows?.length || 0,
        remaining: replyDone && legacyDone ? 0 : "more remaining — re-run to continue",
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

      // 1. Resolve each item to an OutboundHero lead ID
      const leadIds: number[] = [];
      const replyIdsBeingAdded: number[] = [];
      const seqIdsBeingAdded: number[] = [];
      const legacyIdsBeingAdded: number[] = [];
      const failures: Array<{ id: string; reason: string }> = [];

      for (const it of items) {
        const parsed = parseItemId(it.id);
        if (!parsed) { failures.push({ id: it.id, reason: "Invalid item id" }); continue; }

        if (parsed.source === "seq") {
          // Sequence-finished items already have ob_lead_id stored
          const { data: row } = await supabase
            .from("nurture_sequence_finished")
            .select("ob_lead_id, added_at, skipped")
            .eq("id", parsed.rowId)
            .single();
          if (!row || !row.ob_lead_id) { failures.push({ id: it.id, reason: "Lead not found" }); continue; }
          if (row.added_at) { failures.push({ id: it.id, reason: "Already added" }); continue; }
          if (row.skipped) { failures.push({ id: it.id, reason: "Skipped" }); continue; }
          leadIds.push(row.ob_lead_id);
          seqIdsBeingAdded.push(parsed.rowId);
        } else if (parsed.source === "legacy") {
          // Legacy Airtable rows: look up OutboundHero lead by email
          const { data: row } = await supabase
            .from("nurture_legacy_leads")
            .select("lead_email, nurture_added_at, nurture_skipped, nurture_safety")
            .eq("id", parsed.rowId)
            .single();
          if (!row) { failures.push({ id: it.id, reason: "Legacy lead not found" }); continue; }
          if (row.nurture_added_at) { failures.push({ id: it.id, reason: "Already added" }); continue; }
          if (row.nurture_skipped) { failures.push({ id: it.id, reason: "Skipped" }); continue; }
          if (row.nurture_safety !== "safe") { failures.push({ id: it.id, reason: `Not safe (${row.nurture_safety || "unclassified"})` }); continue; }

          let obLeadId = it.ob_lead_id;
          if (!obLeadId && row.lead_email) {
            const lead = await findLeadByEmail(row.lead_email);
            if (lead) obLeadId = lead.id;
          }
          if (!obLeadId) { failures.push({ id: it.id, reason: "Could not find lead in OutboundHero" }); continue; }
          leadIds.push(obLeadId);
          legacyIdsBeingAdded.push(parsed.rowId);
        } else {
          // Reply-based: look up the lead in OutboundHero by email
          const { data: row } = await supabase
            .from("replies")
            .select("lead_email, nurture_added_at, nurture_skipped, nurture_safety")
            .eq("id", parsed.rowId)
            .single();
          if (!row) { failures.push({ id: it.id, reason: "Reply not found" }); continue; }
          if (row.nurture_added_at) { failures.push({ id: it.id, reason: "Already added" }); continue; }
          if (row.nurture_skipped) { failures.push({ id: it.id, reason: "Skipped" }); continue; }
          if (row.nurture_safety !== "safe") { failures.push({ id: it.id, reason: `Not safe (${row.nurture_safety || "unclassified"})` }); continue; }

          let obLeadId = it.ob_lead_id;
          if (!obLeadId && row.lead_email) {
            const lead = await findLeadByEmail(row.lead_email);
            if (lead) obLeadId = lead.id;
          }
          if (!obLeadId) { failures.push({ id: it.id, reason: "Could not find lead in OutboundHero" }); continue; }
          leadIds.push(obLeadId);
          replyIdsBeingAdded.push(parsed.rowId);
        }
      }

      if (leadIds.length === 0) {
        return NextResponse.json({ ok: false, attached: 0, failures }, { status: 400 });
      }

      // 2. Push them all to the nurture campaign in one call
      const result = await attachLeadsToCampaign(nurtureCampaignId, leadIds);
      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error, attached: 0, failures }, { status: 502 });
      }

      // 3. Mark them as added in our DB
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
