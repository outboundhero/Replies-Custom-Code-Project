/**
 * Airtable → Supabase backfill for the nurture queue.
 *
 * Reads every record from a single Airtable table (default: Master Inbox in
 * base appqZiSdsbeBCuHEp) and upserts it into Supabase `nurture_legacy_leads`.
 *
 * Field mapping (confirmed with user):
 *   lead_email           ← Lead Email
 *   first_name           ← First Name → fallback First Name (Extracted)
 *   last_name            ← Last Name  → fallback Last Name (Extracted)
 *   company              ← Company Name
 *   client_tag           ← Client Tag
 *   reply_text           ← Reply we got
 *   reply_at             ← Time we got the reply → fallback Reply Time
 *   original_ai_category ← Lead Category, but fall back to "AI Categorized
 *                          Lead Category" when Lead Category is "Open Response"
 *
 * Rows are SKIPPED when `reply_text` is empty / blank — the safety classifier
 * has nothing to work with.
 *
 * Idempotent: composite UNIQUE on (airtable_base_id, airtable_table_id,
 * airtable_record_id) means re-running upserts in place. Lifecycle columns
 * (nurture_safety, nurture_added_at, nurture_skipped, ...) are NEVER touched
 * — only the Airtable-derived columns and `synced_at` change.
 */

import supabase from "@/lib/supabase";
import { listAllRecords, type AirtableRecord } from "@/lib/airtable";

export const DEFAULT_BASE_ID = "appqZiSdsbeBCuHEp"; // Section 1
export const DEFAULT_TABLE_ID = "tbl1BnpnsUBrBGeuy"; // Master Inbox (Table)

export interface BackfillResult {
  baseId: string;
  tableId: string;
  pagesScanned: number;
  recordsScanned: number;
  inserted: number;
  skippedNoReply: number;
  skippedNoEmail: number;
  errors: number;
}

function pickString(fields: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function pickRichText(fields: Record<string, unknown>, key: string): string | null {
  const v = fields[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function pickIso(fields: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === "string" && v.trim()) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

function pickCategory(fields: Record<string, unknown>): string | null {
  // Use Lead Category first; fall back to AI Categorized Lead Category when
  // Lead Category is "Open Response" (= the human hasn't categorized yet).
  const human = pickString(fields, "Lead Category");
  if (human && human !== "Open Response") return human;
  return pickString(fields, "AI Categorized Lead Category") || human;
}

interface LegacyRow {
  airtable_base_id: string;
  airtable_table_id: string;
  airtable_record_id: string;
  lead_email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  client_tag: string | null;
  reply_text: string;
  reply_at: string;
  original_ai_category: string | null;
  raw_fields: Record<string, unknown>;
  airtable_created_at: string | null;
}

function mapRecord(
  baseId: string,
  tableId: string,
  rec: AirtableRecord
): LegacyRow | { skip: "no_email" | "no_reply" } {
  const f = rec.fields;

  const reply_text = pickRichText(f, "Reply we got");
  if (!reply_text) return { skip: "no_reply" };

  const lead_email = pickString(f, "Lead Email");
  if (!lead_email) return { skip: "no_email" };

  const reply_at = pickIso(f, "Time we got the reply", "Reply Time");
  // If we have no reply timestamp, fall back to Airtable's createdTime so the
  // 45-day cooldown still has something to anchor on.
  const finalReplyAt = reply_at || (rec.createdTime ? new Date(rec.createdTime).toISOString() : null);
  if (!finalReplyAt) return { skip: "no_reply" };

  return {
    airtable_base_id: baseId,
    airtable_table_id: tableId,
    airtable_record_id: rec.id,
    lead_email,
    first_name: pickString(f, "First Name", "First Name (Extracted)"),
    last_name: pickString(f, "Last Name", "Last Name (Extracted)"),
    company: pickString(f, "Company Name"),
    client_tag: pickString(f, "Client Tag"),
    reply_text,
    reply_at: finalReplyAt,
    original_ai_category: pickCategory(f),
    raw_fields: f,
    airtable_created_at: rec.createdTime ? new Date(rec.createdTime).toISOString() : null,
  };
}

/**
 * Backfill one Airtable table into nurture_legacy_leads.
 * Streams in pages of 100 to keep memory flat for large tables.
 */
export async function backfillTable(
  baseId: string = DEFAULT_BASE_ID,
  tableId: string = DEFAULT_TABLE_ID,
  log: (line: string) => void = () => {}
): Promise<BackfillResult> {
  const result: BackfillResult = {
    baseId,
    tableId,
    pagesScanned: 0,
    recordsScanned: 0,
    inserted: 0,
    skippedNoReply: 0,
    skippedNoEmail: 0,
    errors: 0,
  };

  await listAllRecords(baseId, tableId, {
    pageSize: 100,
    onPage: async (records, pageNumber) => {
      result.pagesScanned = pageNumber;
      result.recordsScanned += records.length;

      const rows: LegacyRow[] = [];
      for (const rec of records) {
        const mapped = mapRecord(baseId, tableId, rec);
        if ("skip" in mapped) {
          if (mapped.skip === "no_email") result.skippedNoEmail++;
          else result.skippedNoReply++;
          continue;
        }
        rows.push(mapped);
      }

      if (rows.length === 0) {
        log(`Page ${pageNumber}: scanned ${records.length}, all skipped.`);
        return;
      }

      // Upsert ONLY the Airtable-derived columns. Lifecycle columns are
      // managed by the nurture pipeline and must not be reset by a re-sync.
      const { error } = await supabase
        .from("nurture_legacy_leads")
        .upsert(rows, {
          onConflict: "airtable_base_id,airtable_table_id,airtable_record_id",
          ignoreDuplicates: false,
        });

      if (error) {
        result.errors++;
        log(`Page ${pageNumber}: upsert error — ${error.message}`);
        return;
      }

      result.inserted += rows.length;
      log(`Page ${pageNumber}: ${rows.length} upserted, ${records.length - rows.length} skipped.`);
    },
  });

  return result;
}
