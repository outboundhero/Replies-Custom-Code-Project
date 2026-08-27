/**
 * Minimal Slack bot client for the speed-to-lead reports (spec §11/§12).
 *
 * Uses a bot token (SLACK_BOT_TOKEN) with scopes:
 *   chat:write        — post to channels the bot is in / DMs
 *   users:read.email  — resolve a person's email → user id for DMs
 *   im:write          — open the DM conversation
 *
 * Channel posts go to SLACK_SPEED_REPORT_CHANNEL (a channel name like
 * "#inbox-management-team" or a channel ID). The weekly roundup DMs resolve
 * recipients from SLACK_ROUNDUP_EMAILS (comma-separated email addresses).
 */

const API = "https://slack.com/api";

function token(): string | null {
  return process.env.SLACK_BOT_TOKEN || null;
}

async function slackCall(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; [k: string]: unknown }> {
  const t = token();
  if (!t) return { ok: false, error: "SLACK_BOT_TOKEN not configured" };
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${t}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; [k: string]: unknown };
  return data;
}

/** Post a plain-text message to a channel (name or ID). No tags, no unfurls. */
export async function postToChannel(channel: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const r = await slackCall("chat.postMessage", { channel, text, unfurl_links: false, unfurl_media: false });
  return r.ok ? { ok: true } : { ok: false, error: String(r.error || "unknown") };
}

/** Post a Block Kit message to a channel. `fallbackText` is the notification/
 *  accessibility text shown where blocks can't render. */
export async function postBlocks(
  channel: string,
  blocks: unknown[],
  fallbackText: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await slackCall("chat.postMessage", {
    channel, text: fallbackText, blocks, unfurl_links: false, unfurl_media: false,
  });
  return r.ok ? { ok: true } : { ok: false, error: String(r.error || "unknown") };
}

/** DM the same message to each Slack member ID directly (no email lookup needed).
 *  Opens the DM channel for each id, then posts. Returns per-id failures. */
export async function dmBySlackIds(memberIds: string[], text: string): Promise<{ ok: boolean; sent: string[]; failed: { id: string; error: string }[] }> {
  const sent: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of memberIds) {
    const clean = (id || "").trim();
    if (!clean) continue;
    try {
      const open = await slackCall("conversations.open", { users: clean });
      const channelId = (open.channel as { id?: string } | undefined)?.id;
      if (!open.ok || !channelId) { failed.push({ id: clean, error: String(open.error || "could not open DM") }); continue; }
      const post = await slackCall("chat.postMessage", { channel: channelId, text, unfurl_links: false });
      if (post.ok) sent.push(clean);
      else failed.push({ id: clean, error: String(post.error || "post failed") });
    } catch (e) {
      failed.push({ id: clean, error: (e as Error).message });
    }
  }
  return { ok: failed.length === 0, sent, failed };
}

/** DM the same message to each person, resolved by their Slack account email. */
export async function dmByEmails(emails: string[], text: string): Promise<{ ok: boolean; sent: string[]; failed: { email: string; error: string }[] }> {
  const sent: string[] = [];
  const failed: { email: string; error: string }[] = [];
  for (const email of emails) {
    try {
      const lookup = await slackCall("users.lookupByEmail", { email });
      const userId = (lookup.user as { id?: string } | undefined)?.id;
      if (!lookup.ok || !userId) { failed.push({ email, error: String(lookup.error || "user not found") }); continue; }
      const open = await slackCall("conversations.open", { users: userId });
      const channelId = (open.channel as { id?: string } | undefined)?.id;
      if (!open.ok || !channelId) { failed.push({ email, error: String(open.error || "could not open DM") }); continue; }
      const post = await slackCall("chat.postMessage", { channel: channelId, text, unfurl_links: false });
      if (post.ok) sent.push(email);
      else failed.push({ email, error: String(post.error || "post failed") });
    } catch (e) {
      failed.push({ email, error: (e as Error).message });
    }
  }
  return { ok: failed.length === 0, sent, failed };
}
