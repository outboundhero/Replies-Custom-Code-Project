/**
 * Shared classifier batch — used by both the manual "Classify Unclassified"
 * button (POST /api/nurture/mutate) and the auto-running cron job
 * (GET /api/cron/nurture-classify-unclassified).
 *
 * One call processes up to BATCH_SIZE rows from `replies` AND BATCH_SIZE
 * rows from `nurture_legacy_leads` whose nurture_safety is still NULL,
 * runs the safety classifier on each, and writes the result back. Bounded
 * concurrency keeps GPT throughput high without exceeding rate limits.
 */

import supabase from "@/lib/supabase";
import { classifyNurtureSafety } from "@/lib/nurture/safety-classifier";

export const BATCH_SIZE = 200;
export const CONCURRENCY = 8;

export interface ClassifyResult {
  classified: number;
  replyClassified: number;
  legacyClassified: number;
  done: boolean;            // true if both tables returned <BATCH_SIZE rows
}

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
        console.error("[nurture/auto-classify] worker error", e);
      }
    }
  });
  await Promise.all(runners);
}

export async function classifyOneBatch(): Promise<ClassifyResult> {
  const [{ data: replyRows, error: replyErr }, { data: legacyRows, error: legacyErr }] =
    await Promise.all([
      supabase
        .from("replies")
        .select("id, reply_we_got, ai_categorized_lead_category")
        .not("reply_we_got", "is", null)
        .neq("reply_we_got", "")
        .is("nurture_safety", null)
        .limit(BATCH_SIZE),
      supabase
        .from("nurture_legacy_leads")
        .select("id, reply_text, original_ai_category")
        .not("reply_text", "is", null)
        .neq("reply_text", "")
        .is("nurture_safety", null)
        .limit(BATCH_SIZE),
    ]);
  if (replyErr) throw new Error(`replies: ${replyErr.message}`);
  if (legacyErr) throw new Error(`legacy: ${legacyErr.message}`);

  let classified = 0;

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
      classified++;
    },
    CONCURRENCY
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
      classified++;
    },
    CONCURRENCY
  );

  const replyDone = (replyRows?.length || 0) < BATCH_SIZE;
  const legacyDone = (legacyRows?.length || 0) < BATCH_SIZE;

  return {
    classified,
    replyClassified: replyRows?.length || 0,
    legacyClassified: legacyRows?.length || 0,
    done: replyDone && legacyDone,
  };
}
