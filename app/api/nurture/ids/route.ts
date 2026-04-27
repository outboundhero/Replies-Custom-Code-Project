/**
 * GET /api/nurture/ids
 *
 * Returns just the IDs of pushable rows matching the current filters,
 * across the full dataset (capped at 1000). Used by the "Select all
 * matching" / "Select all in this client group" buttons on /nurture so
 * the user can bulk-push without having to load every page.
 *
 * "Pushable" = eligible (past 45-day cooldown) AND nurture_safety = 'safe'
 *              AND not added AND not skipped, with the same noise-sender,
 *              client-tag, and AI-category exclusions used by /api/nurture.
 *
 * Sequence-finished rows are also pushable when eligible / not added /
 * not skipped (they don't have safety classification).
 *
 * Query params:
 *   client_tag   filter by single client
 *   source       legacy_airtable | sequence_finished | soft_negative | out_of_office
 *
 * Response:
 *   { items: [{ id: "reply:123" | "legacy:456" | "seq:789",
 *               client_tag, ob_lead_id? }],
 *     truncated: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";

export const maxDuration = 60;

const NURTURE_DAYS = 45;
const MAX_IDS = 1000;

const EXCLUDED_AI_CATEGORIES = [
  "Interested",
  "Meeting Request",
  "Meeting Set",
  "Do Not Contact",
  "Wrong Person",
  "Wrong Person (Change of Target)",
  "Not Interested",
  "Mailbox No Longer Active",
  "Automated Error Message",
  "Automated Catch-All Message",
];

const NOISE_SENDER_PATTERNS = [
  "%@public.govdelivery.com",
  "%@govdelivery.com",
  "%@mailchimpapp.com",
  "%@em.%",
  "%@bounce.%",
  "%@bounces.%",
  "noreply@%",
  "no-reply@%",
  "no_reply@%",
  "donotreply@%",
  "do-not-reply@%",
  "do_not_reply@%",
  "notifications@%",
  "notification@%",
  "newsletter@%",
  "mailer-daemon@%",
  "mailer@%",
  "postmaster@%",
  "jira@%",
  "help@%",
  "helpdesk@%",
  "tickets@%",
  "ticket@%",
  "support-noreply@%",
  "%@spiceworks.com",
  "%.spiceworks.com",
  "%@zendesk.com",
  "%@freshdesk.com",
  "survey@%",
  "surveys@%",
  "feedback@%",
];

interface IdItem {
  id: string;
  client_tag: string | null;
  ob_lead_id?: number;
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const clientTag = req.nextUrl.searchParams.get("client_tag");
    const sourceParam = req.nextUrl.searchParams.get("source") || "all";
    const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const wantReplies = sourceParam === "all" || sourceParam === "soft_negative" || sourceParam === "out_of_office";
    const wantSeq = sourceParam === "all" || sourceParam === "sequence_finished";
    const wantLegacy = sourceParam === "all" || sourceParam === "legacy_airtable";

    const items: IdItem[] = [];

    // ── Replies ──
    if (wantReplies) {
      let q = supabase
        .from("replies")
        .select("id, client_tag")
        .not("reply_we_got", "is", null)
        .neq("reply_we_got", "")
        .not("reply_time", "is", null)
        .neq("client_tag", "N/A")
        .or(
          `ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
        )
        .lte("reply_time", cutoffIso)
        .is("nurture_added_at", null)
        .not("nurture_skipped", "is", true)
        .eq("nurture_safety", "safe")
        .limit(MAX_IDS);
      for (const p of NOISE_SENDER_PATTERNS) q = q.not("lead_email", "ilike", p);
      if (clientTag) q = q.eq("client_tag", clientTag);
      if (sourceParam === "soft_negative") q = q.eq("nurture_bucket", "soft_negative");
      else if (sourceParam === "out_of_office") q = q.eq("nurture_bucket", "out_of_office");

      const { data, error } = await q;
      if (error) throw new Error(`replies: ${error.message}`);
      for (const r of data || []) {
        items.push({ id: `reply:${r.id}`, client_tag: r.client_tag });
        if (items.length >= MAX_IDS) break;
      }
    }

    // ── Sequence-finished ──
    if (wantSeq && items.length < MAX_IDS) {
      let q = supabase
        .from("nurture_sequence_finished")
        .select("id, client_tag, ob_lead_id")
        .lte("sequence_finished_at", cutoffIso)
        .is("added_at", null)
        .not("skipped", "is", true)
        .limit(MAX_IDS - items.length);
      if (clientTag) q = q.eq("client_tag", clientTag);

      const { data, error } = await q;
      if (error) throw new Error(`seq: ${error.message}`);
      for (const r of data || []) {
        items.push({ id: `seq:${r.id}`, client_tag: r.client_tag, ob_lead_id: r.ob_lead_id });
        if (items.length >= MAX_IDS) break;
      }
    }

    // ── Legacy ──
    if (wantLegacy && items.length < MAX_IDS) {
      let q = supabase
        .from("nurture_legacy_leads")
        .select("id, client_tag")
        .neq("client_tag", "N/A")
        .or(
          `original_ai_category.is.null,original_ai_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
        )
        .lte("reply_at", cutoffIso)
        .is("nurture_added_at", null)
        .not("nurture_skipped", "is", true)
        .eq("nurture_safety", "safe")
        .limit(MAX_IDS - items.length);
      for (const p of NOISE_SENDER_PATTERNS) q = q.not("lead_email", "ilike", p);
      if (clientTag) q = q.eq("client_tag", clientTag);

      const { data, error } = await q;
      if (error) throw new Error(`legacy: ${error.message}`);
      for (const r of data || []) {
        items.push({ id: `legacy:${r.id}`, client_tag: r.client_tag });
        if (items.length >= MAX_IDS) break;
      }
    }

    return NextResponse.json({
      items,
      truncated: items.length >= MAX_IDS,
    });
  } catch (error) {
    console.error("[api/nurture/ids] failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
