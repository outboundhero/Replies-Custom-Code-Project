/**
 * Regenerates an outgoing reply draft for the Send-Reply preview (spec §15).
 *
 * The team stages a reply before it sends; from that preview they can ask the
 * AI to rewrite the draft — either a plain "clean this up" pass or with
 * freeform instructions ("make it warmer", "add that we can call Tuesday").
 * This takes the lead's inbound reply for context plus the current draft, and
 * returns a revised plain-text reply that keeps the same intent and sign-off.
 *
 * Never invents commitments the draft/instructions didn't state, never adds a
 * subject line or quoted history, and returns plain text (the composer wraps
 * it). Falls back to the current draft if the model is unavailable.
 */

interface RegenerateInput {
  /** The lead's inbound message we're replying to (for context only). */
  replyBody: string;
  /** The reply we currently have staged (may be empty on a first generate). */
  currentDraft: string;
  /** Freeform guidance from the user, e.g. "shorter and more casual". */
  instructions?: string;
  /** Our rep's name, for the sign-off. */
  senderName?: string;
  /** The lead's name, for the greeting. */
  leadName?: string;
}

export async function regenerateReply(input: RegenerateInput): Promise<{ ok: boolean; message: string; error?: string }> {
  const currentDraft = (input.currentDraft || "").trim();
  const instructions = (input.instructions || "").trim();

  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, message: currentDraft, error: "AI unavailable (no API key) — edit the draft manually." };
  }

  const systemPrompt = [
    "You rewrite a sales rep's outgoing email reply. You are given the lead's inbound message (context), the rep's current draft, and optional instructions.",
    "Return ONLY valid JSON in this exact shape:",
    `{ "message": string }`,
    "",
    "Rules:",
    "  - Rewrite the CURRENT DRAFT, honoring the INSTRUCTIONS if given; if there are no instructions, tighten and polish it while keeping the same meaning.",
    "  - Keep the rep's intent and any concrete commitments from the draft. NEVER invent offers, prices, dates, or promises the draft/instructions didn't state.",
    "  - Natural, professional, human tone. Plain text only — no subject line, no quoted history, no markdown, no placeholders like [Name].",
    "  - Address the lead by first name if one is provided. Sign off as the rep if a rep name is provided.",
    "  - Output the email body only.",
  ].join("\n");

  const userContent = [
    input.leadName ? `Lead's name: ${input.leadName}` : "",
    input.senderName ? `Rep's name (sign off as this): ${input.senderName}` : "",
    "",
    "Lead's inbound message (context — do NOT reply to quoted history):",
    (input.replyBody || "(none)").slice(0, 2000),
    "",
    "Current draft:",
    currentDraft || "(empty — write a suitable reply)",
    "",
    instructions ? `Instructions: ${instructions}` : "Instructions: (none — just polish and tighten)",
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!response.ok) return { ok: false, message: currentDraft, error: `AI error (${response.status}) — edit manually.` };
    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) return { ok: false, message: currentDraft, error: "AI returned nothing — edit manually." };
    const parsed = JSON.parse(raw) as { message?: string };
    const message = (parsed.message || "").trim();
    if (!message) return { ok: false, message: currentDraft, error: "AI returned an empty draft — edit manually." };
    return { ok: true, message };
  } catch (e) {
    return { ok: false, message: currentDraft, error: `AI failed (${(e as Error).message}) — edit manually.` };
  }
}
