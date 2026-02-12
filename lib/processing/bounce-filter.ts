import db from "@/lib/db";

interface ReplyFields {
  from_name: string;
  from_email: string;
  text_body: string;
  subject: string;
  to_address: string; // first to[] address
}

/**
 * Check if an untracked reply should be filtered out (bounces, DMARC, delivery failures).
 * Returns true if the reply should be DROPPED (is a bounce/system message).
 * All filter conditions are AND'd: ALL must pass for the reply to proceed.
 */
export async function shouldFilter(fields: ReplyFields): Promise<boolean> {
  const result = await db.execute("SELECT field, value, match_type FROM bounce_filters");

  for (const row of result.rows) {
    const field = row.field as string;
    const value = row.value as string;
    const matchType = row.match_type as string;

    const fieldValue = fields[field as keyof ReplyFields] || "";

    if (matchType === "notContains") {
      if (fieldValue.includes(value)) return true;
    } else if (matchType === "notEquals") {
      if (fieldValue === value) return true;
    }
  }

  return false;
}
