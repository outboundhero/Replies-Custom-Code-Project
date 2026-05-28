/**
 * CW router status report.
 *
 * Scans the most recent CWSJ + CWSV rows and shows which ones the auto-
 * router actually evaluated, with their ZIPs and routing decisions. Useful
 * for verifying the router fired on real production data.
 *
 * Run:  npx tsx scripts/cw-router-status.ts            # last 100 per tag
 *       npx tsx scripts/cw-router-status.ts 200        # last 200 per tag
 *
 * The router only runs inside qualifyLead, which only runs for qualifying
 * AI categories (Interested / Meeting Request / Follow Up / Unrecognizable).
 * Rows in non-qualifying categories will show as "router skipped" — that
 * is expected behaviour, not a bug.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import supabase from "../lib/supabase";
import { createClient } from "@libsql/client";

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const LIMIT = Number(process.argv[2] || 100);
const TAGS = ["CWSJ", "CWSV"];

interface Row {
  id: number;
  created_at: string;
  client_tag: string | null;
  lead_email: string | null;
  company_name: string | null;
  ai_categorized_lead_category: string | null;
  lead_category: string | null;
  zip: string | null;
  zip_source: string | null;
  suggested_client: string | null;
  location_audit: string | null;
}

type Bucket =
  | "rerouted"
  | "no_match"
  | "zip_missing"
  | "evaluated_kept"   // router ran, ZIP matched current CW tag, no swap needed
  | "router_skipped";  // qualifyLead didn't run (non-qualifying AI category)

function classify(r: Row): Bucket {
  const sug = (r.suggested_client || "").toLowerCase();
  if (sug.startsWith("auto-rerouted")) return "rerouted";
  if (sug.startsWith("no city wide") || sug.startsWith("no cw match")) return "no_match";
  if (sug.startsWith("zip unknown")) return "zip_missing";
  // If zip_source is populated, qualifyLead + cw-router both ran. If we
  // didn't write a suggested_client note, the ZIP must have matched the
  // current CW tag (no swap needed).
  if (r.zip_source) return "evaluated_kept";
  return "router_skipped";
}

function bucketLabel(b: Bucket): string {
  switch (b) {
    case "rerouted":         return "Auto-rerouted to other CW client";
    case "no_match":         return "No CW match (kept original)";
    case "zip_missing":      return "ZIP unknown (manual review)";
    case "evaluated_kept":   return "Router ran, ZIP matched current tag";
    case "router_skipped":   return "Router skipped (non-qualifying AI category)";
  }
}

async function main() {
  console.log(`\nCW router status — last ${LIMIT} rows per tag\n`);

  // First: check activity_log for any router events ever — definitive
  // proof that the new code is reaching production.
  const evtRes = await turso.execute({
    sql: `SELECT action, COUNT(*) as n, MAX(timestamp) as latest
          FROM activity_log
          WHERE workflow = 'cw-router'
          GROUP BY action
          ORDER BY latest DESC`,
    args: [],
  });
  console.log("activity_log events for workflow='cw-router':");
  if (evtRes.rows.length === 0) {
    console.log("  (none yet — router has never logged an event since deploy)");
  } else {
    for (const r of evtRes.rows) {
      console.log(`  ${String(r.n).padStart(4)}  ${r.action}  — latest at ${r.latest}`);
    }
  }
  console.log("");

  // Also check for cw-router errors.
  const errRes = await turso.execute({
    sql: `SELECT stage, COUNT(*) as n, MAX(timestamp) as latest
          FROM error_log
          WHERE workflow = 'cw-router' OR stage = 'cw-auto-reroute'
          GROUP BY stage
          ORDER BY latest DESC`,
    args: [],
  });
  if (errRes.rows.length > 0) {
    console.log("⚠️  cw-router errors recorded:");
    for (const r of errRes.rows) {
      console.log(`  ${String(r.n).padStart(4)}  ${r.stage}  — latest at ${r.latest}`);
    }
    console.log("");
  }

  for (const tag of TAGS) {
    const { data, error } = await supabase
      .from("replies")
      .select(
        "id, created_at, client_tag, lead_email, company_name, " +
        "ai_categorized_lead_category, lead_category, zip, zip_source, " +
        "suggested_client, location_audit"
      )
      .eq("client_tag", tag)
      .order("created_at", { ascending: false })
      .limit(LIMIT);

    if (error) {
      console.error(`[${tag}] query failed:`, error.message);
      continue;
    }
    const rows = (data || []) as Row[];

    const counts: Record<Bucket, number> = {
      rerouted: 0, no_match: 0, zip_missing: 0,
      evaluated_kept: 0, router_skipped: 0,
    };
    const evaluated: Array<Row & { bucket: Bucket }> = [];

    for (const r of rows) {
      const b = classify(r);
      counts[b]++;
      if (b !== "router_skipped") evaluated.push({ ...r, bucket: b });
    }

    const evaluatedCount = rows.length - counts.router_skipped;

    console.log("=".repeat(78));
    console.log(`${tag}  —  ${rows.length} rows scanned  /  ${evaluatedCount} evaluated by router`);
    console.log("=".repeat(78));
    for (const b of Object.keys(counts) as Bucket[]) {
      const n = counts[b];
      if (n === 0) continue;
      console.log(`  ${String(n).padStart(4)}  ${bucketLabel(b)}`);
    }

    // AI-category breakdown — helps tell apart "no qualifying replies
    // arrived" vs "qualifying replies arrived but router didn't run".
    const QUALIFYING = new Set([
      "Interested", "Meeting Request",
      "Follow Up at a Later Date", "Unrecognizable by AI",
    ]);
    const catCounts: Record<string, number> = {};
    let qualifyingTotal = 0;
    let qualifyingButNotRouted = 0;
    for (const r of rows) {
      const c = r.ai_categorized_lead_category || "(none)";
      catCounts[c] = (catCounts[c] || 0) + 1;
      if (QUALIFYING.has(c)) {
        qualifyingTotal++;
        if (!r.zip_source) qualifyingButNotRouted++;
      }
    }
    console.log("\n  AI category distribution:");
    for (const [c, n] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      const marker = QUALIFYING.has(c) ? " *" : "  ";
      console.log(`  ${String(n).padStart(4)}${marker} ${c}`);
    }
    console.log(`  (* = qualifying category — qualifyLead + CW router should run for these)`);
    if (qualifyingTotal > 0) {
      console.log(`\n  → ${qualifyingTotal} qualifying replies in window; ${qualifyingButNotRouted} of them have NO zip_source.`);
      if (qualifyingButNotRouted > 0) {
        console.log(`\n  Qualifying CW rows missing zip_source (newest first):`);
        const stale = rows
          .filter((r) => QUALIFYING.has(r.ai_categorized_lead_category || "") && !r.zip_source)
          .slice(0, 10);
        for (const r of stale) {
          const when = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16);
          console.log(`    ${when}  ${(r.lead_email || "—").slice(0, 35).padEnd(35)}  ${r.ai_categorized_lead_category}`);
        }
        console.log(`\n  → Anything with a timestamp BEFORE the CW router deploy is expected to be empty.`);
        console.log(`    Anything AFTER the deploy with no zip_source means qualifyLead silently failed.`);
      }
    }

    if (evaluated.length === 0) {
      console.log(`\n  (no router-evaluated rows in the last ${LIMIT} for ${tag})`);
      console.log(`  Most leads here are Not Interested / Wrong Person etc., so the`);
      console.log(`  router intentionally skipped them. Send a test reply on an active`);
      console.log(`  CW campaign with a qualifying response to see the router fire.\n`);
      continue;
    }

    console.log(`\n  Recent router decisions (newest first):\n`);
    for (const r of evaluated.slice(0, 20)) {
      const when = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16);
      const email = (r.lead_email || "—").slice(0, 30).padEnd(30);
      const cat = (r.ai_categorized_lead_category || "—").slice(0, 20).padEnd(20);
      const zip = (r.zip || "—").padEnd(6);
      const note = r.suggested_client || "(matched current tag)";
      console.log(`  ${when}  ${email}  ${cat}  zip=${zip}  ${note}`);
    }
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
