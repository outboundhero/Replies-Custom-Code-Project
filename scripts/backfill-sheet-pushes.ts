/**
 * Recovery: re-push "stranded" leads to their client Google Sheet — leads that
 * were categorized into a sheet-push category but never landed in the sheet
 * (registry tag malformed, or the registry feed was stale). Answers "why is this
 * lead in the inbox but not the tracking sheet?".
 *
 * DUPLICATE-SAFE: per client, we read the emails already present in the sheet and
 * SKIP any stranded lead whose email is already there — so a lead is never added
 * twice. Only leads genuinely missing from the sheet get appended.
 *
 * Stranded = active (not archived) + lead_category is a push category +
 * pushed_to_sheet is not true.
 *
 *   # DRY RUN — per-client counts, changes nothing:
 *   tsx --env-file=.env.local scripts/backfill-sheet-pushes.ts
 *   # APPLY (optionally scope to one client):
 *   tsx --env-file=.env.local scripts/backfill-sheet-pushes.ts --apply
 *   tsx --env-file=.env.local scripts/backfill-sheet-pushes.ts --apply --client=CCHS
 */
import { google } from "googleapis";
import supabase from "@/lib/supabase";
import { pushReplyToSheet } from "@/lib/push-reply-to-sheet";
import { SHEET_PUSH_CATEGORIES, getAuth } from "@/lib/push-to-sheet";
import { getSheetForClient } from "@/lib/google-sheets-registry";

const APPLY = process.argv.includes("--apply");
const clientArg = (process.argv.find((a) => a.startsWith("--client=")) || "").split("=")[1]?.toUpperCase();
const GAP_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row { id: number; client_tag: string; lead_email: string; lead_category: string }

async function main() {
  let q = supabase.from("replies")
    .select("id, client_tag, lead_email, lead_category")
    .eq("archived", false)
    .in("lead_category", SHEET_PUSH_CATEGORIES)
    .or("pushed_to_sheet.is.null,pushed_to_sheet.eq.false")
    .neq("client_tag", "N/A")
    .not("client_tag", "is", null)
    .order("id", { ascending: true });
  if (clientArg) q = q.eq("client_tag", clientArg);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data || []) as Row[];

  // Group by client so we read each sheet's existing emails only once.
  const byClient: Record<string, Row[]> = {};
  for (const r of rows) (byClient[r.client_tag] ||= []).push(r);
  const clients = Object.keys(byClient).sort((a, b) => byClient[b].length - byClient[a].length);

  console.log(`Stranded leads: ${rows.length} across ${clients.length} clients${clientArg ? ` (scoped to ${clientArg})` : ""} · mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  for (const c of clients) console.log(`  ${c.padEnd(10)} ${byClient[c].length}`);

  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to push the missing ones (duplicates auto-skipped).`);
    return;
  }

  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  let pushed = 0, dupSkipped = 0, noSheet = 0, failed = 0;

  for (const tag of clients) {
    const leads = byClient[tag];
    const sheet = await getSheetForClient(tag);
    if (!sheet) { noSheet += leads.length; console.log(`\n⚠ ${tag}: no sheet registered — ${leads.length} skipped`); continue; }

    // Emails already in the sheet (column A) — for dedup.
    let existing: Set<string>;
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheet.id, range: `'${sheet.sheetName}'!A:A` });
      existing = new Set((res.data.values || []).map((r) => String(r[0] || "").trim().toLowerCase()).filter(Boolean));
    } catch (e) {
      failed += leads.length;
      console.log(`\n✗ ${tag}: can't read sheet to dedup (${(e as Error).message}) — skipping (won't blind-push)`);
      continue;
    }

    console.log(`\n${tag} (${leads.length} stranded, sheet has ${existing.size} rows):`);
    for (const lead of leads) {
      const email = String(lead.lead_email || "").trim().toLowerCase();
      if (email && existing.has(email)) {
        dupSkipped++;
        // Already in the sheet — reconcile the flag so it stops showing as stranded.
        try { await supabase.from("replies").update({ pushed_to_sheet: true, pushed_to_sheet_at: new Date().toISOString() }).eq("id", lead.id); } catch { /* */ }
        console.log(`  = already in sheet: ${email} (flag reconciled, not re-added)`);
        continue;
      }
      const r = await pushReplyToSheet(lead.id, { category: lead.lead_category });
      if (r.ok) { pushed++; if (email) existing.add(email); console.log(`  + pushed: ${email}`); }
      else if (r.skipped) { console.log(`  ⤳ skip: ${email} (${r.skipped})`); }
      else { failed++; console.log(`  ✗ fail: ${email} (${r.error})`); }
      await sleep(GAP_MS);
    }
  }

  console.log(`\nDone. pushed=${pushed} duplicatesSkipped=${dupSkipped} noSheet=${noSheet} failed=${failed}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
