/**
 * POST /api/nurture/mutate
 *
 * Actions:
 *  - "classify-batch": Run safety classifier on a list of unclassified reply IDs
 *  - "classify-all-unclassified": Classify ALL replies that are nurture candidates and don't yet have a safety
 *  - "push-to-nurture": Push items (replies + sequence-finished leads) to a nurture campaign
 *  - "skip": Mark an item as skipped (do not nurture)
 *  - "unskip": Reverse a skip
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { classifyNurtureSafety } from "@/lib/nurture/safety-classifier";
import { attachLeadsToCampaign, findLeadByEmail } from "@/lib/outboundhero-api";

interface ItemRef {
  id: string;          // "reply:123" or "seq:456"
  ob_lead_id?: number; // optional override (for sequence_finished items it's known)
  email?: string;      // optional, used to find OB lead ID for reply-based items
}

function parseItemId(id: string): { source: "reply" | "seq"; rowId: number } | null {
  const m = id.match(/^(reply|seq):(\d+)$/);
  if (!m) return null;
  return { source: m[1] as "reply" | "seq", rowId: Number(m[2]) };
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
        .select("id, ai_categorized_lead_category, reply_we_got")
        .in("id", ids);
      if (error) throw new Error(error.message);

      const results: Array<{ id: number; safety: string; reason: string }> = [];
      for (const r of rows || []) {
        const result = await classifyNurtureSafety({
          aiCategory: r.ai_categorized_lead_category,
          replyText: r.reply_we_got || "",
        });
        await supabase.from("replies").update({
          nurture_safety: result.safety,
          nurture_safety_reason: result.reason,
          nurture_classified_at: new Date().toISOString(),
        }).eq("id", r.id);
        results.push({ id: r.id, safety: result.safety, reason: result.reason });
      }

      return NextResponse.json({ ok: true, classified: results.length, results });
    }

    // ── classify EVERY unclassified candidate ──
    if (action === "classify-all-unclassified") {
      const CANDIDATE_CATS = [
        "Not Interested", "Follow Up", "Open Response", "Out Of Office",
      ];
      const { data: rows, error } = await supabase
        .from("replies")
        .select("id, ai_categorized_lead_category, reply_we_got")
        .in("ai_categorized_lead_category", CANDIDATE_CATS)
        .is("nurture_safety", null)
        .limit(200); // safety cap per request
      if (error) throw new Error(error.message);

      let classified = 0;
      for (const r of rows || []) {
        const result = await classifyNurtureSafety({
          aiCategory: r.ai_categorized_lead_category,
          replyText: r.reply_we_got || "",
        });
        await supabase.from("replies").update({
          nurture_safety: result.safety,
          nurture_safety_reason: result.reason,
          nurture_classified_at: new Date().toISOString(),
        }).eq("id", r.id);
        classified++;
      }

      return NextResponse.json({ ok: true, classified, remaining: (rows?.length || 0) === 200 ? "200+ — re-run to continue" : 0 });
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
      for (const id of items) {
        const parsed = parseItemId(id);
        if (!parsed) continue;
        if (parsed.source === "reply") replyIds.push(parsed.rowId);
        else seqIds.push(parsed.rowId);
      }
      if (replyIds.length) {
        await supabase.from("replies").update({ nurture_skipped: skipValue }).in("id", replyIds);
      }
      if (seqIds.length) {
        await supabase.from("nurture_sequence_finished").update({ skipped: skipValue }).in("id", seqIds);
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
