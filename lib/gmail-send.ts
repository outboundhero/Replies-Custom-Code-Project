/**
 * Sends an email AS a Google Workspace user (e.g. madison@outboundhero.co) through the Gmail API,
 * using the app's service account with domain-wide delegation (scope gmail.send only — it can't read
 * mail). Images can be embedded in the email (multipart/related + Content-ID), not attached.
 *
 * Safety: unless the caller passes allowAnyRecipient (only when its sending switch is on), every
 * recipient must be one of TEST_RECIPIENTS — so tests and switched-off code can never email a client.
 */
import { google } from "googleapis";
import { randomBytes } from "crypto";

export const TEST_RECIPIENTS = ["sankalp@outreachify.io", "admin@outreachify.io"];

export interface InlineImage { cid: string; filename: string; contentType: string; base64: string }
export interface OutgoingEmail {
  fromEmail: string;
  fromName: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text: string;
  inline?: InlineImage[];
  /** Only true when the feature's send switch is on. Otherwise only TEST_RECIPIENTS may receive it. */
  allowAnyRecipient: boolean;
}

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const noBreaks = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** RFC 2047 encoded-word for a header value (only when it isn't plain ASCII). */
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function checkRecipients(m: Pick<OutgoingEmail, "to" | "cc" | "bcc" | "allowAnyRecipient">): string[] {
  const all = [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map((x) => x.trim());
  if (!m.to.length) throw new Error("No recipient.");
  for (const a of all) if (!EMAIL.test(a)) throw new Error(`"${a}" isn't an email address.`);
  if (!m.allowAnyRecipient) {
    const bad = all.filter((a) => !TEST_RECIPIENTS.includes(a.toLowerCase()));
    if (bad.length) throw new Error(`Sending to clients is switched off — refused: ${bad.join(", ")}. Only ${TEST_RECIPIENTS.join(" / ")} can receive it.`);
  }
  return all;
}

/** The raw RFC 822 message: text + (html + embedded images) as alternatives. */
export function buildMime(m: OutgoingEmail): string {
  checkRecipients(m);
  const alt = `alt-${randomBytes(12).toString("hex")}`, rel = `rel-${randomBytes(12).toString("hex")}`;
  const head = [
    `From: ${word(noBreaks(m.fromName))} <${noBreaks(m.fromEmail)}>`,
    `To: ${m.to.map(noBreaks).join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(noBreaks).join(", ")}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${m.bcc.map(noBreaks).join(", ")}`] : []),
    `Subject: ${word(noBreaks(m.subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${alt}"`,
  ];
  const body = [
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(m.text)),
    `--${alt}`,
    `Content-Type: multipart/related; boundary="${rel}"`,
    "",
    `--${rel}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(m.html)),
    ...(m.inline ?? []).flatMap((img) => [
      `--${rel}`,
      `Content-Type: ${img.contentType}; name="${img.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${img.cid}>`,
      `Content-Disposition: inline; filename="${img.filename}"`,
      "",
      wrap76(img.base64),
    ]),
    `--${rel}--`,
    `--${alt}--`,
    "",
  ];
  return [...head, "", ...body].join("\r\n");
}

/** Sends as m.fromEmail. Returns Gmail's message id. Throws with Google's reason on failure. */
export async function sendEmailAs(m: OutgoingEmail): Promise<{ id: string; threadId: string }> {
  const raw = Buffer.from(buildMime(m), "utf8").toString("base64url");
  const jwt = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    subject: m.fromEmail,
  });
  let token: string | null | undefined;
  try { token = (await jwt.authorize()).access_token; }
  catch (e) {
    const d = (e as { response?: { data?: { error?: string; error_description?: string } } }).response?.data;
    throw new Error(`Google refused to let us send as ${m.fromEmail}: ${d?.error_description || d?.error || (e as Error).message}`);
  }
  let res: Response;
  try {
    res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    // The request may have reached Gmail — the caller must not resend on its own.
    throw Object.assign(new Error(`Lost the connection to Gmail while sending (${(e as Error).message})`), { uncertain: true });
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail didn't send it (${res.status}): ${j?.error?.message ?? "unknown error"}`);
  return { id: String(j.id), threadId: String(j.threadId) };
}
