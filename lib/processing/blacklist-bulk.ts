/**
 * Log-free bulk blacklist helper.
 *
 * The existing `blacklistDomain`/`blacklistEmail` in ./domain-blacklist.ts SWALLOW
 * errors and write an activity/error_log row PER call — fine for the one-at-a-time
 * inbox/auto-categorizer flow, but wrong for a bulk UI that pushes thousands of
 * items and needs a real per-item status back (and must NOT hammer Turso with a
 * write per item). This module does the raw Bison POST and RETURNS a structured
 * result, importing no db/logging. Blacklisting is per-instance, so the caller
 * loops the 4 instances.
 *
 * 422 "already been taken" = the item is already blacklisted on that instance —
 * a success for our purposes (idempotent), reported as "already".
 */

export type BlacklistOp = "blacklisted" | "already" | "error";
export interface BlacklistResult {
  status: BlacklistOp;
  error?: string;
}

/**
 * Blacklist a single email/domain on ONE instance. Never throws — network and
 * HTTP failures come back as { status: "error" } so the caller can classify.
 */
export async function blacklistOne(
  cfg: { baseUrl: string; token: string },
  kind: "email" | "domain",
  value: string,
  signal?: AbortSignal,
): Promise<BlacklistResult> {
  const path = kind === "domain" ? "blacklisted-domains" : "blacklisted-emails";
  try {
    const res = await fetch(`${cfg.baseUrl}/api/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ [kind]: value }),
      signal,
    });

    if (res.ok) return { status: "blacklisted" };

    const body = await res.text().catch(() => "");
    // 422 "already been taken" = already blacklisted — treat as success (idempotent).
    if (res.status === 422 && body.includes("already been taken")) {
      return { status: "already" };
    }
    return { status: "error", error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
}
