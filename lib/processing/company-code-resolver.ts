import db from "@/lib/db";
import type { CompanyCode } from "@/lib/types";

/**
 * Detect company code from untracked reply using regex patterns.
 * Builds a "blob" from email domain + redirect link + body text and tests each pattern.
 * Returns the first matching code or "N/A".
 */
export async function detectCompanyCode(
  fromEmail: string,
  textBody: string,
  redirectLink?: string
): Promise<{ code: string; domain: string }> {
  const domain = fromEmail.split("@")[1]?.toLowerCase() || "";
  const blob = `${domain} ${redirectLink || ""} ${textBody}`.toLowerCase();

  const result = await db.execute(
    "SELECT code, pattern FROM company_codes ORDER BY priority DESC"
  );

  for (const row of result.rows) {
    const pattern = row.pattern as string;
    const code = row.code as string;
    try {
      if (new RegExp(pattern).test(blob)) {
        return { code, domain };
      }
    } catch {
      // Invalid regex pattern — skip
    }
  }

  return { code: "N/A", domain };
}
