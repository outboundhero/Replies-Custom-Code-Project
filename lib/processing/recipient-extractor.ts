import type { ExtractedRecipients } from "@/lib/types";

/**
 * Parse reply.to[] and reply.cc[] arrays into comma-separated strings.
 * Also generates a timestamp for reply time.
 */
export function extractRecipients(
  to: Array<{ name: string; address: string }> | null | undefined,
  cc: Array<{ name: string; address: string }> | null | undefined
): ExtractedRecipients {
  const toEmails = to?.map((p) => p.address).join(", ") || "";
  const toNames = to?.map((p) => p.name).join(", ") || "";
  const ccEmails = cc?.map((p) => p.address).join(", ") || "";
  const ccNames = cc?.map((p) => p.name).join(", ") || "";
  const replyTime = new Date().toISOString();

  return { toEmails, toNames, ccEmails, ccNames, replyTime };
}
