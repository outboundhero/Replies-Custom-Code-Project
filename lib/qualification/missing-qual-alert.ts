/**
 * Missing-qualification-data alert.
 *
 * When a lead's audit runs and the client has NO qualification rules at all —
 * no exclusion industries AND no service area / office anchor — the audit
 * "passes" trivially and the lead isn't really being vetted. That usually means
 * the client's rules were never set up. This posts a clean alert to the inbox-
 * management Slack channel (with a direct link to the reply) so someone adds them.
 *
 * Guards (per product decisions):
 *  - "Only when truly missing everywhere": we re-read the LIVE qualification
 *    Google Sheet and stay quiet if the data is actually there (just a sync gap).
 *  - "Once per lead": deduped on the reply row id (a manual audit refresh won't
 *    re-alert).
 *  - Churned clients are skipped (missing rules is expected/noise for them).
 * Fire-and-forget: never throws, never blocks qualification.
 */
import db from "@/lib/db";
import { postBlocks } from "@/lib/slack";
import { fetchOnboardingForm } from "@/lib/google-sheets";
import { splitAbbreviations } from "@/lib/sync/sheets-to-supabase";
import { isChurned } from "@/lib/churn";
import { logActivity, logError } from "@/lib/errors";

const CHANNEL = process.env.SLACK_INBOX_MGMT_CHANNEL || "C0BKP83NP9Q";

let ready = false;
async function ensureTable(): Promise<void> {
  if (ready) return;
  await db.execute(`CREATE TABLE IF NOT EXISTS missing_qual_alert (
    reply_row_id INTEGER PRIMARY KEY,
    client_tag TEXT,
    created_at TEXT NOT NULL
  )`);
  ready = true;
}

/** Production host for building a shareable reply link (mirrors keep-warm). */
function baseHost(): string {
  return (
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.APP_BASE_URL ||
    process.env.VERCEL_URL ||
    "replies-custom-code-project.vercel.app"
  ).replace(/^https?:\/\//, "");
}

/** Look up a client's row in the live qualification sheet. `inSheet=false` when
 *  the client isn't listed at all. `cleaning` is false for Non-Cleaning/special
 *  clients (DM4PM, OH, SC, …) whose qualification rules don't apply. */
async function sheetQualInfo(clientTag: string): Promise<{ inSheet: boolean; hasData: boolean; cleaning: boolean }> {
  const rows = await fetchOnboardingForm();
  const tagU = clientTag.toUpperCase();
  for (const r of rows) {
    const tags = splitAbbreviations(r.clientAbbreviation).map((t) => t.toUpperCase());
    if (tags.includes(tagU)) {
      const hasData = !!(r.exclusionIndustries.trim() || r.inclusionLocations.trim() || r.hqAnchor.trim());
      // Client Type "Cleaning" (default when blank) vs "Non-Cleaning". Only
      // cleaning clients are audited on industry/location, so only they can be
      // "missing" qualification rules.
      const ct = (r.clientType || "").trim().toLowerCase();
      const cleaning = ct === "" || ct.startsWith("clean");
      return { inSheet: true, hasData, cleaning };
    }
  }
  return { inSheet: false, hasData: false, cleaning: true };
}

export interface MissingQualParams {
  replyRowId?: number | null;
  clientTag: string;
  leadEmail?: string;
  companyName?: string;
  /** exclusion_industries (client_qualifications) is non-empty. */
  hasExclusion: boolean;
  /** inclusion_locations OR hq_anchor (client_qualifications) is non-empty. */
  hasLocation: boolean;
}

export async function reportMissingQualificationIfNeeded(p: MissingQualParams): Promise<void> {
  try {
    if (!p.replyRowId || !p.clientTag) return;
    // Only when the app has NO rules at all (both sides empty).
    if (p.hasExclusion || p.hasLocation) return;
    // Churned clients: missing rules is expected — don't alert.
    if (await isChurned(p.clientTag)) return;

    await ensureTable();
    // Dedup: once per lead (reply row) — a manual audit refresh won't re-ping.
    const existing = await db.execute({
      sql: "SELECT 1 FROM missing_qual_alert WHERE reply_row_id = ?",
      args: [p.replyRowId],
    });
    if (existing.rows.length) return;

    // "Only when truly missing everywhere": confirm the LIVE sheet also has
    // nothing. If the sheet has data, it's a sync gap — stay quiet per the chosen
    // scope. Non-Cleaning/special clients (DM4PM, OH, SC) legitimately have no
    // rules — skip them. If we can't read the sheet, don't guess (avoid false
    // alarms).
    let info: { inSheet: boolean; hasData: boolean; cleaning: boolean };
    try {
      info = await sheetQualInfo(p.clientTag);
    } catch (e) {
      await logError("qualification", "missing-qual-sheet-read", (e as Error).message, { client_tag: p.clientTag });
      return;
    }
    if (info.hasData) return;    // sync gap, not truly missing
    if (!info.cleaning) return;  // non-cleaning client — qualification N/A

    const url = `https://${baseHost()}/inbox?reply=${p.replyRowId}`;
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "⚠️  Missing qualification data", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Client*\n\`${p.clientTag}\`` },
          { type: "mrkdwn", text: `*Lead*\n${p.leadEmail || "—"}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "This client has *no exclusion industries* and *no service area / office anchor* — " +
            "in the app *and* the qualification sheet. The audit passes trivially, so this lead isn't being vetted.\n" +
            ":point_right:  Add this client's rules in the qualification sheet.",
        },
      },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Open reply  →", emoji: true }, url, style: "primary" },
        ],
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `Client \`${p.clientTag}\`${p.companyName ? `  ·  ${p.companyName}` : ""}` },
        ],
      },
    ];
    const fallback = `⚠️ Missing qualification data for ${p.clientTag}${p.leadEmail ? ` — ${p.leadEmail}` : ""}. Add rules in the qualification sheet. ${url}`;

    const res = await postBlocks(CHANNEL, blocks, fallback);
    if (!res.ok) {
      await logError("qualification", "missing-qual-slack", res.error || "post failed", {
        client_tag: p.clientTag, reply_row_id: p.replyRowId,
      });
      return; // don't record dedup on failure — allow a later retry
    }
    // Record dedup only after a successful post.
    await db.execute({
      sql: "INSERT OR IGNORE INTO missing_qual_alert (reply_row_id, client_tag, created_at) VALUES (?, ?, ?)",
      args: [p.replyRowId, p.clientTag, new Date().toISOString()],
    });
    await logActivity("qualification", "missing-qual-alerted", {
      client_tag: p.clientTag, lead_email: p.leadEmail, details: { reply_row_id: p.replyRowId },
    });
  } catch (e) {
    await logError("qualification", "missing-qual-alert", (e as Error).message, { client_tag: p.clientTag });
  }
}
