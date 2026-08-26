/**
 * Find "Send Reply" automation runs that FAILED to actually send.
 *
 * Why this exists: Airtable's public API has no automation run-history
 * endpoint (UI-only), and the Send Reply script reports failures via
 * output.set() instead of throwing — so failed sends show up as
 * "Ran successfully" and the Update-record steps still stamp {Sent time}.
 * The only reliable detector is the data itself: a record stamped with
 * {Sent time} whose lead has NO thread reply in Bison at/after that time
 * means the send never happened.
 *
 * Read-only: GETs against Airtable + Bison, writes nothing anywhere
 * (except the JSON report file).
 *
 * Deliberately self-contained (no lib/ imports beyond the browser-safe
 * instance list): lib/db.ts and lib/supabase.ts initialise their clients at
 * import time, which crashes under tsx before dotenv can load .env.local.
 *
 *   npx tsx scripts/find-failed-sends.ts                 # last 14 days, all Section bases
 *   npx tsx scripts/find-failed-sends.ts --days 7
 *   npx tsx scripts/find-failed-sends.ts --base "Section 3"
 *   npx tsx scripts/find-failed-sends.ts --baseId appXXXXXXXXXXXXXX   # extra base (e.g. AT 8)
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { BISON_INSTANCES, isValidInstance } from "../lib/bison-instances-shared";

const AIRTABLE_API = "https://api.airtable.com/v0";

const ALL_BASES: { name: string; baseId: string }[] = [
  { name: "Section 1", baseId: "appqZiSdsbeBCuHEp" },
  { name: "Section 2", baseId: "appGsk8TNtjwVmZZ4" },
  { name: "Section 3", baseId: "appQ8xxARCGmcft6E" },
  { name: "Section 4", baseId: "appYWttC5gLjV3kso" },
  { name: "Section 5", baseId: "appPmEI39HJfkFXjv" },
  { name: "Section 6", baseId: "appRr92qMRKP5YCUw" },
  { name: "Section 7", baseId: "appL5AaH8VcP2yWoQ" },
];

// Send Reply happens moments after {Sent time} is stamped; allow the clock
// on either side to be off by up to 30 minutes.
const CLOCK_SKEW_MS = 30 * 60 * 1000;

type Verdict =
  | "sent" // thread reply found in Bison at/after Sent time
  | "FAILED" // no thread reply in Bison → the automation run errored
  | "no-reply-id"
  | "bad-instance"
  | "reply-fetch-failed"
  | "untracked" // reply has no lead in Bison — can't verify automatically
  | "bison-error";

interface Row {
  base: string;
  baseId: string;
  tableId: string;
  recordId: string;
  recordUrl: string;
  leadEmail: string;
  subject: string;
  instance: string;
  replyId: number | null;
  sentTime: string;
  verdict: Verdict;
  detail?: string;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    days: Number(get("--days") ?? 14),
    baseFilter: get("--base")?.toLowerCase(),
    extraBaseIds: (get("--baseId") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function airtableHeaders() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` };
}

function bisonConfig(key: string): { baseUrl: string; token: string } {
  const cfg = BISON_INSTANCES.find((i) => i.key === key);
  const token = process.env[`BISON_${key.toUpperCase()}_TOKEN`];
  if (!cfg || !token) throw new Error(`Missing config/token for instance ${key}`);
  return { baseUrl: cfg.baseUrl, token };
}

function bisonHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

/** The replies table = the one named like "Master Inbox", else the first
 *  table carrying a "Reply ID" field. */
async function findRepliesTableId(baseId: string): Promise<string> {
  const res = await fetch(`${AIRTABLE_API}/meta/bases/${baseId}/tables`, { headers: airtableHeaders() });
  if (!res.ok) throw new Error(`schema fetch failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    tables: Array<{ id: string; name: string; fields: Array<{ name: string }> }>;
  };
  const byName = data.tables.find((t) => t.name.toLowerCase().includes("master inbox"));
  if (byName) return byName.id;
  const byField = data.tables.find((t) => t.fields.some((f) => f.name === "Reply ID"));
  if (byField) return byField.id;
  throw new Error("no Master Inbox / Reply ID table found");
}

/** Paged fetch of records whose {Sent time} falls inside the window. */
async function fetchSentRecords(baseId: string, tableId: string, days: number) {
  const records: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${AIRTABLE_API}/${baseId}/${tableId}`);
    url.searchParams.set(
      "filterByFormula",
      `IS_AFTER({Sent time}, DATEADD(TODAY(), -${days}, 'days'))`
    );
    for (const f of ["Reply ID", "Bison Instance", "Sent time", "Lead Email", "Email Subject"]) {
      url.searchParams.append("fields[]", f);
    }
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url.toString(), { headers: airtableHeaders() });
    if (!res.ok) throw new Error(`Airtable list failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      records: Array<{ id: string; fields: Record<string, unknown> }>;
      offset?: string;
    };
    records.push(...(data.records ?? []));
    offset = data.offset;
  } while (offset);
  return records;
}

/** GET /api/replies/{id} → lead_id (null = untracked reply). */
async function getReplyLeadId(
  instance: string,
  replyId: number
): Promise<{ ok: boolean; leadId: number | null; error?: string }> {
  const { baseUrl, token } = bisonConfig(instance);
  const res = await fetch(`${baseUrl}/api/replies/${replyId}`, { headers: bisonHeaders(token) });
  if (!res.ok) return { ok: false, leadId: null, error: `${res.status}: ${(await res.text()).slice(0, 160)}` };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j: any = await res.json().catch(() => null);
  const d = (j && (j.data ?? j)) || {};
  return { ok: true, leadId: d.lead_id ?? null };
}

interface SentEmail {
  id: number;
  sent_at: string | null;
  thread_reply: boolean;
}

/** GET /api/leads/{id}/sent-emails — every email Bison delivered to the lead.
 *  Upstream sometimes wraps the array in { data: [{ data: [...] }] }. */
async function getSentEmails(instance: string, leadId: number): Promise<SentEmail[]> {
  const { baseUrl, token } = bisonConfig(instance);
  const res = await fetch(`${baseUrl}/api/leads/${leadId}/sent-emails`, { headers: bisonHeaders(token) });
  if (!res.ok) throw new Error(`sent-emails(${instance}, ${leadId}) failed: ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) {
    const inner = data.data;
    if (inner.length && Array.isArray(inner[0]?.data)) return inner[0].data;
    return inner as SentEmail[];
  }
  return [];
}

async function verify(row: Row, sentEmailCache: Map<string, SentEmail[]>): Promise<Row> {
  if (!row.replyId) return { ...row, verdict: "no-reply-id" };
  if (!isValidInstance(row.instance)) {
    return { ...row, verdict: "bad-instance", detail: row.instance || "(blank)" };
  }

  try {
    const reply = await getReplyLeadId(row.instance, row.replyId);
    if (!reply.ok) return { ...row, verdict: "reply-fetch-failed", detail: reply.error };
    if (reply.leadId == null) return { ...row, verdict: "untracked" };

    const cacheKey = `${row.instance}:${reply.leadId}`;
    let emails = sentEmailCache.get(cacheKey);
    if (!emails) {
      emails = await getSentEmails(row.instance, reply.leadId);
      sentEmailCache.set(cacheKey, emails);
    }

    const sentAt = Date.parse(row.sentTime);
    const match = emails.find(
      (e) => e.thread_reply && e.sent_at && Date.parse(e.sent_at) >= sentAt - CLOCK_SKEW_MS
    );
    return match
      ? { ...row, verdict: "sent" }
      : { ...row, verdict: "FAILED", detail: `no thread reply in Bison after ${row.sentTime}` };
  } catch (err) {
    return { ...row, verdict: "bison-error", detail: (err as Error).message.slice(0, 160) };
  }
}

async function main() {
  if (!process.env.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env.local");
    process.exit(1);
  }
  const { days, baseFilter, extraBaseIds } = parseArgs();

  const bases = [
    ...ALL_BASES.filter((b) => !baseFilter || b.name.toLowerCase().includes(baseFilter)),
    ...extraBaseIds.map((baseId) => ({ name: baseId, baseId })),
  ];
  console.log(`Checking ${bases.length} base(s), Sent time within last ${days} days\n`);

  const rows: Row[] = [];
  for (const { name, baseId } of bases) {
    try {
      const tableId = await findRepliesTableId(baseId);
      const records = await fetchSentRecords(baseId, tableId, days);
      console.log(`${name}: ${records.length} record(s) with Sent time`);
      for (const rec of records) {
        const f = rec.fields;
        rows.push({
          base: name,
          baseId,
          tableId,
          recordId: rec.id,
          recordUrl: `https://airtable.com/${baseId}/${tableId}/${rec.id}`,
          leadEmail: String(f["Lead Email"] ?? ""),
          subject: String(f["Email Subject"] ?? ""),
          instance: String(f["Bison Instance"] ?? ""),
          replyId: f["Reply ID"] != null ? Number(f["Reply ID"]) : null,
          sentTime: String(f["Sent time"] ?? ""),
          verdict: "sent", // placeholder, set by verify()
        });
      }
    } catch (err) {
      console.log(`${name}: ✗ skipped — ${(err as Error).message.slice(0, 160)}`);
    }
  }

  console.log(`\nVerifying ${rows.length} send(s) against Bison…`);
  const sentEmailCache = new Map<string, SentEmail[]>();
  const results: Row[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map((r) => verify(r, sentEmailCache)))));
    if (results.length % 50 < CONCURRENCY) {
      console.log(`  …${results.length}/${rows.length}`);
    }
  }

  const byVerdict = new Map<Verdict, Row[]>();
  for (const r of results) {
    byVerdict.set(r.verdict, [...(byVerdict.get(r.verdict) ?? []), r]);
  }

  console.log("\n──────── SUMMARY ────────");
  for (const [verdict, list] of byVerdict) {
    console.log(`${verdict.padEnd(20)} ${list.length}`);
  }

  const failed = byVerdict.get("FAILED") ?? [];
  if (failed.length) {
    console.log(`\n──────── FAILED SENDS (${failed.length}) — reply was never delivered ────────`);
    for (const r of failed) {
      console.log(
        `\n• ${r.leadEmail || "(no email)"}  [${r.base} / ${r.instance} / reply ${r.replyId}]` +
          `\n  Sent time: ${r.sentTime}` +
          (r.subject ? `\n  Subject:   ${r.subject}` : "") +
          `\n  Record:    ${r.recordUrl}`
      );
    }
  } else {
    console.log("\nNo failed sends detected in this window. ✓");
  }

  const unverifiable = results.filter((r) =>
    ["untracked", "bad-instance", "no-reply-id", "reply-fetch-failed", "bison-error"].includes(r.verdict)
  );
  if (unverifiable.length) {
    console.log(`\n──────── UNVERIFIABLE (${unverifiable.length}) — check these by hand ────────`);
    for (const r of unverifiable) {
      console.log(`• ${r.verdict}: ${r.leadEmail || r.recordId} (${r.detail ?? ""}) ${r.recordUrl}`);
    }
  }

  const { writeFileSync } = await import("fs");
  const outPath = `scripts/failed-sends-report.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
