/**
 * Extracts the date a lead's out-of-office auto-reply says they'll be
 * back. Used when a user marks a lead "Out Of Office" — the auto-reply
 * cron re-sends the original cold email on that date.
 *
 * Returns:
 *   - YYYY-MM-DD string when a future return date is clearly stated
 *   - null when the reply is vague ("back soon"), already in the past,
 *     too far out (>365 days — almost always a parsing mistake), or
 *     when extraction fails
 *
 * Strict by design: better to skip auto-scheduling than to email a lead
 * on the wrong day.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function extractReturnDate(
  replyBody: string,
  /** Today's date in the user's local frame so the model can resolve
   *  relative phrases ("Monday", "next week"). */
  today: Date = new Date(),
): Promise<string | null> {
  if (!replyBody?.trim()) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const todayIso = toIsoDate(today);
  const todayDow = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "America/Los_Angeles",
  }).format(today);

  const systemPrompt = [
    "You read out-of-office email replies and extract the date the sender says they'll be back at work.",
    "Respond with ONLY valid JSON in this shape:",
    `{ "return_date": string|null }`,
    "",
    "Rules:",
    `  - "return_date" is a YYYY-MM-DD calendar date, in the sender's frame.`,
    `  - Today is ${todayIso} (${todayDow}). Resolve relative phrases ("Monday", "next week", "this Friday") accordingly.`,
    `  - Return null when the reply doesn't give a specific return date OR the date is unclear / vague ("back soon", "next month sometime").`,
    `  - Return null if the date you'd return has already passed (the lead is already back).`,
    `  - Return null if the date is more than 365 days out — that's almost certainly a parsing mistake.`,
    `  - Year is implied from context: "back on March 5" with today after March 5 means next year.`,
    `  - DO NOT invent a date. If unsure, return null.`,
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
        max_tokens: 50,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: replyBody.slice(0, 3000) },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { return_date?: string | null };
    const candidate = (parsed.return_date || "").trim();
    if (!candidate) return null;
    if (!ISO_DATE_RE.test(candidate)) return null;

    // Sanity-check the date is real + within bounds.
    const d = new Date(`${candidate}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;

    const todayMidnight = new Date(`${todayIso}T00:00:00Z`);
    const yearOut = new Date(todayMidnight.getTime() + 365 * 24 * 60 * 60 * 1000);
    // Allow today (auto-reply fires later same day after the cron picks it up).
    if (d < todayMidnight) return null;
    if (d > yearOut) return null;

    return candidate;
  } catch {
    return null;
  }
}

function toIsoDate(d: Date): string {
  // Anchor to PT so "today" matches the user's working frame.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA produces YYYY-MM-DD natively.
  return fmt.format(d);
}
