/**
 * GET /api/nurture/clients-summary
 *
 * Per-client snapshot for the Nurture hub page. For every client tag in
 * the Turso `client_tags` table, returns the four headline counts (Ready,
 * Eligible, Waiting, Added) that drive the client cards on the hub.
 *
 * Implementation: one Supabase HEAD-count per (client, view) — 4 counts
 * across 3 source tables (replies + nurture_sequence_finished +
 * nurture_legacy_leads) means up to 12 queries per client. Parallelised
 * with bounded concurrency 8 so 50 clients × 12 ≈ 75 batches, finishing
 * in ~2–4 s on warm planner stats.
 *
 * Counts use `count: "estimated"` (the planner-cached value) so this
 * endpoint stays fast even on the 400k+ row legacy table.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";
import db from "@/lib/db";

export const maxDuration = 60;

const NURTURE_DAYS = 45;
const CONCURRENCY = 8;

// Same exclusion list as the rest of the nurture endpoints.
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
  "Referral Given",
  "Internally Forwarded",
];

const excludedInList = EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",");

interface ClientSummary {
  clientTag: string;
  ready: number;      // eligible + safe + not added/skipped
  eligible: number;   // eligible (any safety) + not added/skipped
  waiting: number;    // not yet eligible + not added/skipped
  added: number;      // already pushed
  total: number;      // ready + eligible + waiting + added (rough)
}

async function runWithConcurrency<T>(items: T[], worker: (i: T) => Promise<void>, conc: number) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { await worker(items[idx]); } catch { /* swallow */ }
      }
    }),
  );
}

async function safeCount(q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  try {
    const { count } = await q;
    return count ?? 0;
  } catch { return 0; }
}

async function fetchSummaryFor(clientTag: string, cutoffIso: string): Promise<ClientSummary> {
  // ── replies base
  const baseReplies = () =>
    supabase
      .from("replies")
      .select("id", { count: "estimated", head: true })
      .eq("client_tag", clientTag)
      .not("reply_we_got", "is", null)
      .neq("reply_we_got", "")
      .not("reply_time", "is", null)
      .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${excludedInList})`);

  const baseSeq = () =>
    supabase
      .from("nurture_sequence_finished")
      .select("id", { count: "estimated", head: true })
      .eq("client_tag", clientTag);

  const baseLegacy = () =>
    supabase
      .from("nurture_legacy_leads")
      .select("id", { count: "estimated", head: true })
      .eq("client_tag", clientTag)
      .or(`original_ai_category.is.null,original_ai_category.not.in.(${excludedInList})`);

  const [
    rReady, rEligible, rWaiting, rAdded,
    sEligible, sWaiting, sAdded,
    lReady, lEligible, lWaiting, lAdded,
  ] = await Promise.all([
    // replies
    safeCount(baseReplies().lte("reply_time", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true).eq("nurture_safety", "safe")),
    safeCount(baseReplies().lte("reply_time", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true)),
    safeCount(baseReplies().gt("reply_time", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true)),
    safeCount(baseReplies().not("nurture_added_at", "is", null)),
    // seq (no safety column — treat all eligible as ready)
    safeCount(baseSeq().lte("sequence_finished_at", cutoffIso).is("added_at", null).not("skipped", "is", true)),
    safeCount(baseSeq().gt("sequence_finished_at", cutoffIso).is("added_at", null).not("skipped", "is", true)),
    safeCount(baseSeq().not("added_at", "is", null)),
    // legacy
    safeCount(baseLegacy().lte("reply_at", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true).eq("nurture_safety", "safe")),
    safeCount(baseLegacy().lte("reply_at", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true)),
    safeCount(baseLegacy().gt("reply_at", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true)),
    safeCount(baseLegacy().not("nurture_added_at", "is", null)),
  ]);

  // Sequence rows have no safety classifier — treat all eligible as Ready.
  const ready = rReady + sEligible + lReady;
  const eligible = rEligible + sEligible + lEligible;
  const waiting = rWaiting + sWaiting + lWaiting;
  const added = rAdded + sAdded + lAdded;

  return {
    clientTag,
    ready,
    eligible,
    waiting,
    added,
    total: ready + waiting + added,
  };
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Canonical list of clients from Turso. Skip "N/A" — not real clients.
    const tagsRes = await db.execute("SELECT DISTINCT tag FROM client_tags WHERE tag IS NOT NULL AND tag != 'N/A' ORDER BY tag");
    const tags = (tagsRes.rows as unknown as Array<{ tag: string }>).map((r) => r.tag).filter(Boolean);

    if (tags.length === 0) {
      return NextResponse.json({ clients: [] });
    }

    const out: ClientSummary[] = new Array(tags.length);
    await runWithConcurrency(
      tags.map((tag, i) => ({ tag, i })),
      async ({ tag, i }) => {
        out[i] = await fetchSummaryFor(tag, cutoffIso);
      },
      CONCURRENCY,
    );

    return NextResponse.json({ clients: out });
  } catch (error) {
    console.error("[api/nurture/clients-summary] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
