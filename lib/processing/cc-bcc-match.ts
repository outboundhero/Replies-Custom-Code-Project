/**
 * True when `fromEmail` matches one of a client_config's CC/BCC recipients
 * (cc_email_1..6, bcc_email_1..2). Used at reply ingest: when a reply comes from
 * the client's own CC/BCC people (their team on the thread), the lead is hard-
 * marked "Meeting-Ready Lead". Case-insensitive, whitespace-trimmed.
 *
 * Accepts a loose record so it works with both the tracked-path ClientConfig
 * interface and the untracked-path db row.
 */
export function isCcBccSender(
  config: Record<string, unknown> | null | undefined,
  fromEmail: string | null | undefined,
): boolean {
  if (!config || !fromEmail) return false;
  const target = String(fromEmail).trim().toLowerCase();
  if (!target) return false;
  const keys = [
    "cc_email_1", "cc_email_2", "cc_email_3", "cc_email_4", "cc_email_5", "cc_email_6",
    "bcc_email_1", "bcc_email_2",
  ];
  return keys.some((k) => {
    const v = config[k];
    return v != null && String(v).trim().toLowerCase() === target;
  });
}
