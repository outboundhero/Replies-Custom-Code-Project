/**
 * Eval harness for the qualification audits.
 *
 * Runs the REAL audit functions (industry + location, both Gemini-grounded)
 * against tests/qualification/error-fixtures.json — cases codified from the
 * reported audit errors — and reports pass/fail + an overall score.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/eval-qualification.ts
 *
 * Acceptance bar: >= 90% before shipping prompt/model changes.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { auditIndustry } from "../lib/qualification/industry-audit";
import { auditLocation } from "../lib/qualification/location-audit";

interface Fixture {
  id: string;
  category: "industry" | "location";
  note?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>;
  expected: { industry?: string; location?: string };
}

const THRESHOLD = 0.9;

async function main() {
  const fixtures: Fixture[] = JSON.parse(
    readFileSync("tests/qualification/error-fixtures.json", "utf8"),
  );

  let pass = 0;
  const failures: Array<{ id: string; expected: string; actual: string; reason: string }> = [];

  for (const fx of fixtures) {
    let actual = "ERROR", reason = "";
    try {
      if (fx.category === "industry") {
        const i = fx.input;
        const r = await auditIndustry(
          i.companyName || "", i.website || null, i.industry || "",
          i.exclusionIndustries || "", "high", "eval",
          i.replyText || "", i.leadEmail || null,
        );
        actual = r.result; reason = r.reason;
      } else {
        const i = fx.input;
        const r = await auditLocation(
          i.city || null, i.state || null, i.address || null, i.zip || null,
          i.inclusionLocations || "", "high", i.hqAnchor || null,
        );
        actual = r.result; reason = r.reason;
      }
    } catch (e) {
      reason = (e as Error).message;
    }
    const expected = fx.expected.industry || fx.expected.location || "";
    const ok = actual === expected;
    if (ok) pass++;
    else failures.push({ id: fx.id, expected, actual, reason });
    console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  [${fx.category}] ${fx.id.padEnd(24)} expected=${expected} got=${actual}`);
  }

  const total = fixtures.length;
  const pct = Math.round((pass / total) * 100);
  console.log(`\nScore: ${pass}/${total} (${pct}%)  — threshold ${THRESHOLD * 100}%`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ${f.id}: expected ${f.expected}, got ${f.actual} — ${f.reason.slice(0, 120)}`);
  }
  if (pass / total < THRESHOLD) {
    console.log(`\n⛔ Below ${THRESHOLD * 100}% — do NOT merge the audit changes.`);
    process.exit(1);
  }
  console.log(`\n✅ Passes the ${THRESHOLD * 100}% bar.`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
