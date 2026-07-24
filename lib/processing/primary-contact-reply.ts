/**
 * Generates the "Request for Primary Point of Contact (Send Reply)" reply
 * (spec §23 + client refinement 2026-07-24).
 *
 * Exact structure the client wants:
 *
 *   Thanks for letting me know, {first_name}.
 *
 *   Would you be able to provide me with the email address of your primary
 *   point of contact at {ORGANIZATION}?
 *
 *   We'd like to reach out to see if they're in the market for the services
 *   we provide.
 *
 *   {sender_first_name}
 *
 * Organization resolution (in order):
 *   1. The specific org/person the prospect NAMES in the reply
 *      ("Highland Hills Parks & Rec handles that") — always preferred.
 *   2. If not named but clearly inferable from the signature / company data,
 *      use that (normalized).
 *   3. If NOT confident, go GENERIC — "…the primary point of contact who
 *      handles that for your location?" — never invent or guess an org.
 *      (Covers property-management-on-lease and "I forwarded it internally".)
 *
 * Forwarded-internally replies ask for the email of the person it was sent
 * to. No extra sales arguments — the universal reason line is the whole
 * pitch. The reply is generated naturally, not by token insertion.
 *
 * The caller (Send-Reply preview / bulk review card) ALWAYS shows this as an
 * editable draft — generate → preview → human review → confirm. Never sent
 * without explicit confirmation.
 */

interface PrimaryContactInput {
  replyBody: string;
  /** Lead's first name (greeting). */
  firstName: string;
  /** Our rep's first name (sign-off). */
  senderFirstName: string;
  /** Normalized company/org from our lead data — fallback org source only. */
  companyName?: string;
}

/** Generic fallback in the exact client-approved structure. */
export function primaryContactFallback(firstName: string, senderFirstName: string): string {
  const greet = firstName ? `Thanks for letting me know, ${firstName}.` : "Thanks for letting me know.";
  return [
    greet,
    "",
    "Would you mind sharing the email address of the primary point of contact who handles that for your location?",
    "",
    "We'd like to reach out to see if they're in the market for the services we provide.",
    ...(senderFirstName ? ["", senderFirstName] : []),
  ].join("\n");
}

const REASON_LINE = "We'd like to reach out to see if they're in the market for the services we provide.";

/** Enforce the client-approved structure regardless of model whitespace:
 *  paragraphs separated by blank lines, the universal reason line always
 *  present (inserted before the sign-off if the model dropped it). */
function normalizeStructure(message: string, senderFirstName: string): string {
  const paras = message.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const hasReason = paras.some((p) => p.toLowerCase().includes("in the market for the services we provide"));
  if (!hasReason) {
    const last = paras[paras.length - 1] || "";
    if (senderFirstName && last.toLowerCase() === senderFirstName.toLowerCase()) {
      paras.splice(paras.length - 1, 0, REASON_LINE);
    } else {
      paras.push(REASON_LINE);
    }
  }
  return paras.join("\n\n");
}

export async function generatePrimaryContactReply(
  input: PrimaryContactInput,
): Promise<{ ok: boolean; message: string; error?: string }> {
  const { replyBody, firstName, senderFirstName, companyName } = input;
  const fallback = primaryContactFallback(firstName, senderFirstName);
  if (!replyBody?.trim() || !process.env.OPENAI_API_KEY) {
    return { ok: !!process.env.OPENAI_API_KEY, message: fallback, error: process.env.OPENAI_API_KEY ? undefined : "AI unavailable — using the generic ask." };
  }

  const systemPrompt = [
    "You write a short reply asking a prospect for the email address of the primary point of contact who actually controls the service (cleaning/facilities). Your ONLY goal is to obtain the correct contact — no sales arguments.",
    "Respond with ONLY valid JSON: { \"message\": string }",
    "",
    "The reply MUST follow this exact structure (plain text, these blank lines):",
    "",
    "Thanks for letting me know, {first_name}.",
    "",
    "<the ask — one sentence>",
    "",
    "We'd like to reach out to see if they're in the market for the services we provide.",
    "",
    "{sender_first_name}",
    "",
    "Rules for the ask sentence:",
    "  1. Read the prospect's reply and identify the organization or person responsible for the service.",
    "  2. PREFER the specific organization named in the reply — e.g. reply says 'Highland Hills Parks & Rec handles that' → 'Would you mind sharing the email address of your primary point of contact at Highland Hills Parks & Rec?'",
    "  3. If the reply names a PERSON (even first-name-only, 'Bob handles this') → ask for that person's email: 'Would you be able to share Bob's email address?' then keep the universal reason line.",
    "  4. If they say they FORWARDED it internally / to a department → ask for the email of the person or department they sent it to.",
    "  5. If no org is named in the reply but the provided company/organization data clearly IS the responsible org, you may use it (normalized).",
    "  6. If you are NOT confident which organization they mean, go GENERIC: 'Would you mind sharing the email address of the primary point of contact who handles that for your location?' NEVER invent or guess an organization name — a generic ask beats a wrong name.",
    "  7. Phrase the ask naturally ('Would you be able to provide me with…' / 'Would you mind sharing…') — do not mechanically insert tokens.",
    "",
    "Other rules:",
    "  - Greeting: 'Thanks for letting me know, {first_name}.' — omit the name (just 'Thanks for letting me know.') if no first name is provided.",
    "  - The reason line is EXACTLY: \"We'd like to reach out to see if they're in the market for the services we provide.\" — no additions (no saving money, no service quality).",
    "  - Sign off with the sender's first name only (omit if not provided). No subject line, no markdown, no placeholders left in the output.",
  ].join("\n");

  const userContent = [
    `Lead's first name: ${firstName || "(unknown)"}`,
    `Sender's first name (sign-off): ${senderFirstName || "(unknown)"}`,
    `Normalized company/org from our data (FALLBACK only, may be the prospect's own company — use per rules 5/6): ${companyName || "(none)"}`,
    "",
    "Prospect's reply:",
    replyBody.slice(0, 1500),
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!response.ok) return { ok: false, message: fallback, error: `AI error (${response.status}) — using the generic ask.` };
    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) return { ok: false, message: fallback, error: "AI returned nothing — using the generic ask." };
    const parsed = JSON.parse(raw) as { message?: string };
    const message = (parsed.message || "").trim();
    if (!message) return { ok: false, message: fallback, error: "AI returned empty — using the generic ask." };
    return { ok: true, message: normalizeStructure(message, senderFirstName) };
  } catch (e) {
    return { ok: false, message: fallback, error: `AI failed (${(e as Error).message}) — using the generic ask.` };
  }
}
