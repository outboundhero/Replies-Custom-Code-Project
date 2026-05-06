/**
 * Builds the auto-reply body sent ~5–10 minutes after a lead is marked
 * "Not Interested (Send Reply)" in the inbox. Faithful port of the
 * Airtable script the team used to run by hand.
 *
 * Tone is short and gracious — acknowledges the no, opens the door to
 * future contact, signs off with the original sender's first name.
 *
 * "Day of week" is computed in America/Los_Angeles so a Friday-night PT
 * mark doesn't say "have a good Saturday".
 */

function splitName(name: string | null | undefined): [string | null, string | null] {
  if (!name) return [null, null];
  const trimmed = name.trim();
  if (!trimmed) return [null, null];
  if (trimmed.includes(" ")) {
    const [first, ...rest] = trimmed.split(/\s+/);
    return [first, rest.join(" ") || null];
  }
  // CamelCase split: "JohnSmith" → ["John", "Smith"]
  const match = trimmed.match(/^([A-Z][a-z]+)([A-Z][a-z]+)$/);
  if (match) return [match[1], match[2]];
  return [trimmed, null];
}

function dayOfWeekPT(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "America/Los_Angeles",
  }).format(now);
}

export function buildNotInterestedReply(
  leadName: string | null | undefined,
  senderName: string | null | undefined,
  now: Date = new Date(),
): string {
  const [leadFirstName] = splitName(leadName);
  const [senderFirstName] = splitName(senderName);

  const dayOfWeek = dayOfWeekPT(now);
  const closingLine =
    dayOfWeek === "Friday"
      ? "Have a good weekend!"
      : `Have a good rest of your ${dayOfWeek}`;

  const senderSig = senderFirstName || "";

  if (leadFirstName) {
    return `Got it, thanks ${leadFirstName}. ${closingLine}\n\nPlease email me if anything changes in the future. Happy to help.\n\n${senderSig}`;
  }
  return `Got it, thanks for letting me know. ${closingLine}\n\nPlease email me if anything changes in the future. Happy to help.\n\n${senderSig}`;
}
