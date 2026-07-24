/**
 * Generates the "Request for Primary Point of Contact (Send Reply)" reply,
 * picking the wording that matches the lead's situation (spec §23).
 *
 * The lead didn't give us a usable contact for whoever actually controls the
 * service, so we ask for it. The exact ask depends on the scenario:
 *   - Property management / landlord controls the service
 *   - A first name only was given ("Bob handles this")
 *   - The message was forwarded internally ("I forwarded this to our admin")
 *   - A department / org / city was named without a contact
 *
 * The four canonical templates come straight from the spec; this fills the
 * referenced person's name or the named department when present. Returns plain
 * text (the composer wraps it). Falls back to the property-management wording,
 * which is the generic ask, if the model is unavailable.
 */

// Generic fallback (property-management wording from §23), {FIRST_NAME} filled by caller.
export const PRIMARY_CONTACT_FALLBACK =
  "Thank you, {FIRST_NAME}. I appreciate you letting me know. Would you be able to provide the email address of your primary contact at the property management company? I'm asking because I'd like to see if they are currently in the market for the services we provide.";

export async function generatePrimaryContactReply(
  replyBody: string,
  firstName: string,
): Promise<{ ok: boolean; message: string; error?: string }> {
  const fallback = PRIMARY_CONTACT_FALLBACK.replaceAll("{FIRST_NAME}", firstName || "there");
  if (!replyBody?.trim() || !process.env.OPENAI_API_KEY) {
    return { ok: !!process.env.OPENAI_API_KEY, message: fallback, error: process.env.OPENAI_API_KEY ? undefined : "AI unavailable — using the default ask." };
  }

  const systemPrompt = [
    "You write a short reply asking a prospect for the email of the primary point of contact who actually controls the service. Pick the wording that fits the situation and fill in the specifics.",
    "Respond with ONLY valid JSON: { \"message\": string }",
    "",
    "Use exactly one of these four patterns, adapted with the given first name and any specific person/department mentioned:",
    "",
    "1) PROPERTY MANAGEMENT / LANDLORD controls it:",
    "\"Thank you, {FIRST_NAME}. I appreciate you letting me know. Would you be able to provide the email address of your primary contact at the property management company? I'm asking because I'd like to see if they are currently in the market for the services we provide.\"",
    "",
    "2) A FIRST NAME ONLY was given (e.g. 'Bob handles this'):",
    "\"Thank you, {FIRST_NAME}. Would you be able to share {NAME}'s email address? I'd like to reach out and see if they are currently in the market for the services we provide.\"",
    "",
    "3) FORWARDED INTERNALLY ('I forwarded this to our administrator'):",
    "\"Thank you for forwarding this. Would you be able to share the email address of the person you sent it to? I'd like to follow up with them directly regarding the services we provide.\"",
    "",
    "4) A DEPARTMENT / ORG / CITY was named without a contact (e.g. 'The City of Bellevue Parks Department handles this'):",
    "\"Thank you, {FIRST_NAME}. Would you be able to provide the email address of your primary contact at {DEPARTMENT}? I'd like to see if they are currently in the market for the services we provide.\"",
    "",
    "Rules: replace {FIRST_NAME} with the lead's first name (or drop the name and start 'Thank you.' if none). Replace {NAME} with the referenced person's name, {DEPARTMENT} with the named org/department verbatim. Plain text only, no subject, no placeholders left unfilled.",
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 250,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Lead's first name: ${firstName || "(unknown)"}\n\nLead's reply:\n${replyBody.slice(0, 1500)}` },
        ],
      }),
    });
    if (!response.ok) return { ok: false, message: fallback, error: `AI error (${response.status}) — using the default ask.` };
    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) return { ok: false, message: fallback, error: "AI returned nothing — using the default ask." };
    const parsed = JSON.parse(raw) as { message?: string };
    const message = (parsed.message || "").trim();
    if (!message) return { ok: false, message: fallback, error: "AI returned empty — using the default ask." };
    return { ok: true, message };
  } catch (e) {
    return { ok: false, message: fallback, error: `AI failed (${(e as Error).message}) — using the default ask.` };
  }
}
