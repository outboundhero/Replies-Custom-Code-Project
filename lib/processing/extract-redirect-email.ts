/**
 * Extracts the email address a "Change of Target" reply directs us to.
 *
 * Used when a user marks a lead as Change Of Target in the inbox — the AI
 * pulls the new contact's email out of the lead's reply ("please contact
 * John at john@acme.com") so we can immediately re-pitch the original
 * cold email to that new address.
 *
 * Returns:
 *   - a lowercased email string when one is clearly present
 *   - null when the reply doesn't surface a usable address (the caller
 *     should leave the lead in the inbox for manual handling)
 *
 * Strict: never invents a new email, never returns the original sender's
 * own address back, never picks up addresses from quoted history.
 */

interface ExtractResult {
  email: string | null;
  /** Optional name the lead provided alongside the email — we use this
   *  for the "to_name" field when sending the cold email. */
  name: string | null;
}

const EMAIL_RE = /[\w!#$%&'*+/=?^`{|}~.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

export async function extractRedirectEmail(
  replyBody: string,
  /** The email of the lead WE originally contacted — never returned. */
  originalLeadEmail: string,
): Promise<ExtractResult> {
  if (!replyBody?.trim()) return { email: null, name: null };
  if (!process.env.OPENAI_API_KEY) {
    // Fall back to a regex pass over the reply if the LLM is unavailable.
    // Picks the first email-shaped string that isn't the original lead.
    return regexFallback(replyBody, originalLeadEmail);
  }

  const systemPrompt = [
    "You read a sales lead's email reply and extract the alternative contact they're directing us to.",
    "Respond with ONLY valid JSON in this exact shape:",
    `{ "email": string|null, "name": string|null }`,
    "",
    "Rules:",
    `  - "email" is the alternative contact's address the lead asks us to reach instead of them.`,
    `  - DO NOT return the lead's own address (you'll be told what it is below) — return null instead.`,
    `  - DO NOT pull addresses from quoted history (lines beginning with ">" or after "-----Original Message-----").`,
    `  - DO NOT invent or correct emails — return only addresses that appear verbatim in the body.`,
    `  - If multiple alternative addresses are listed, return the FIRST one mentioned.`,
    `  - "name" is the alternative contact's name if mentioned (e.g. "John Smith"), else null.`,
    `  - If the reply does not direct us to anyone with an email, return both fields null.`,
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 100,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Original lead's email (DO NOT return this): ${originalLeadEmail}\n\nReply body:\n${replyBody.slice(0, 2000)}`,
          },
        ],
      }),
    });

    if (!response.ok) return regexFallback(replyBody, originalLeadEmail);

    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) return regexFallback(replyBody, originalLeadEmail);

    const parsed = JSON.parse(raw) as { email?: string | null; name?: string | null };
    const email = sanitize(parsed.email, originalLeadEmail);
    const name = (parsed.name || "").trim() || null;
    if (email) return { email, name };
    return regexFallback(replyBody, originalLeadEmail);
  } catch {
    return regexFallback(replyBody, originalLeadEmail);
  }
}

function sanitize(raw: string | null | undefined, originalLeadEmail: string): string | null {
  if (!raw) return null;
  const candidate = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(candidate)) return null;
  if (candidate === originalLeadEmail.toLowerCase()) return null;
  return candidate;
}

function regexFallback(replyBody: string, originalLeadEmail: string): ExtractResult {
  // Strip quoted history before scanning — we only want emails the lead
  // typed out themselves, not addresses from our own previous message.
  const liveBody = replyBody
    .split(/\n/)
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n")
    .split(/-----\s*Original Message\s*-----/i)[0];

  const match = liveBody.match(EMAIL_RE);
  if (!match) return { email: null, name: null };
  const found = match[0].toLowerCase();
  if (found === originalLeadEmail.toLowerCase()) return { email: null, name: null };
  return { email: found, name: null };
}
