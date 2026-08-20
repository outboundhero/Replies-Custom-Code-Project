/**
 * Reconnect a sending inbox via the deliverability dashboard's Inboxing-upload
 * endpoint (google-sheets-dashboard-nine — same token as the tracked-sheets /
 * domain-tag feeds).
 *
 * Used when a reply send fails because the sender inbox lost its SMTP auth
 * (Bison: "Please re-connect this email account … SMTP Error: Could not
 * authenticate."). Re-uploading the inbox to its instance's Inboxing connection
 * (warmup on) reconnects it. The upload is async (a job), so the operator retries
 * the send once it reconnects.
 *
 * POST /api/external/inboxing-upload  { email, instance }
 *   Auth: Authorization: Bearer <token>
 *   instance ∈ outboundhero | cleaningoutbound | facilityreach | outboundclean
 *   → { email, instance, isInboxing, jobsCreated, matched, skipped,
 *       connectionName, message }  (422 if the domain isn't Inboxing-provisioned)
 */
const UPLOAD_URL =
  process.env.INBOXING_UPLOAD_URL ||
  "https://google-sheets-dashboard-nine.vercel.app/api/external/inboxing-upload";
const TOKEN = process.env.GOOGLE_SHEETS_REGISTRY_TOKEN || "outboundhero2024";

const VALID_INSTANCES = new Set(["outboundhero", "cleaningoutbound", "facilityreach", "outboundclean"]);

export interface ReconnectResult {
  ok: boolean;
  email?: string;
  instance?: string;
  isInboxing?: boolean;
  jobsCreated?: number;
  connectionName?: string;
  message?: string;
  error?: string;
  status?: number;
}

/** Re-upload (reconnect) a sending inbox to its instance's Inboxing connection. */
export async function reconnectInbox(email: string, instance: string): Promise<ReconnectResult> {
  const addr = (email || "").trim();
  const inst = (instance || "").trim();
  if (!addr) return { ok: false, error: "no sender email on this reply" };
  if (!VALID_INSTANCES.has(inst)) return { ok: false, error: `unknown sending instance "${inst}"` };

  try {
    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: addr, instance: inst }),
      cache: "no-store",
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        email: addr,
        instance: inst,
        isInboxing: typeof j.isInboxing === "boolean" ? j.isInboxing : undefined,
        error: typeof j.error === "string" ? j.error : `${res.status}`,
      };
    }
    return {
      ok: true,
      email: addr,
      instance: inst,
      isInboxing: typeof j.isInboxing === "boolean" ? j.isInboxing : undefined,
      jobsCreated: typeof j.jobsCreated === "number" ? j.jobsCreated : undefined,
      connectionName: typeof j.connectionName === "string" ? j.connectionName : undefined,
      message: typeof j.message === "string" ? j.message : undefined,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** True when a send error means the sender inbox needs reconnecting. */
export function isReconnectableSendError(err: string | null | undefined): boolean {
  const s = String(err || "");
  // "sender email id is invalid" = the inbox was removed/re-added in the instance
  // (its id changed or it's gone). Reconnect it + the retry re-resolves the live
  // id by email before resending (see lib/send-retry.ts).
  return /re-?connect this email account|could not authenticate|smtp error|sender email id is invalid/i.test(s);
}
