/**
 * "Generate Reply" for the Reply Router inbox: takes the client's reply template
 * (already personalized with the lead's name / company / phone) as the CORE
 * message, and lightly adapts it to the ACTUAL conversation — the full campaign
 * + reply thread — so the reply reads like a natural response to what was said.
 *
 * Hard rules:
 *  - Preserve the template's core (intent, CTA, CC/team mention, sign-off).
 *  - Never flip the lead's second-person framing ("your courts" stays "your").
 *  - Never alter/remove the phone number(s) — enforced by tokenizing them out
 *    before the LLM sees the text and restoring the exact originals after.
 *  - Optional freeform `instructions` steer the output; empty = adapt normally.
 */

interface GenerateInput {
  /** The client's reply template, already variable-resolved (the CORE). */
  template: string;
  /** The lead's own latest message (quoted history stripped). */
  leadMessage: string;
  /** The full conversation thread (campaign email + follow-ups + replies), for context. */
  fullThread: string;
  /** Optional operator instructions for what the reply should say. */
  instructions?: string;
}

/** Match phone-number-looking sequences (US + international, with punctuation). */
const PHONE_RE = /\+?\d[\d().\-\s]{7,}\d(?:\s*(?:x|ext\.?)\s*\d+)?/gi;
const digitsOf = (s: string) => (s.match(/\d/g) || []).join("");

/**
 * Replace every phone number in `text` with a sentinel token so the LLM can't
 * touch the digits. Returns the masked text + a restore() that puts the exact
 * originals back, plus the set of original digit-strings for a final check.
 */
function protectPhones(text: string): { masked: string; restore: (out: string) => string; digits: string[] } {
  const found: string[] = [];
  const masked = text.replace(PHONE_RE, (m) => {
    // Ignore matches that aren't really phone numbers (too few digits).
    if (digitsOf(m).length < 7) return m;
    const idx = found.length;
    found.push(m);
    return `[[PHONE_${idx}]]`;
  });
  const restore = (out: string) => {
    let r = out;
    found.forEach((orig, i) => { r = r.replaceAll(`[[PHONE_${i}]]`, orig); });
    return r;
  };
  return { masked, restore, digits: found.map(digitsOf) };
}

export async function generateReplyFromTemplate(input: GenerateInput): Promise<{ ok: boolean; reply: string; error?: string }> {
  const template = (input.template || "").trim();
  if (!template) return { ok: false, reply: "", error: "This client has no reply template set." };
  if (!process.env.OPENAI_API_KEY) return { ok: false, reply: template, error: "AI unavailable — using the template as-is." };

  const { masked, restore, digits } = protectPhones(template);
  const instructions = (input.instructions || "").trim();

  const systemPrompt = [
    "You refine a sales rep's outgoing reply to a lead about commercial cleaning services.",
    "You are given the CLIENT'S TEMPLATE reply (already personalized with the lead's name, company and phone) and the full conversation. Return an improved version of the template that fits THIS conversation.",
    "Respond with ONLY valid JSON: { \"reply\": string }",
    "",
    "PRESERVE THE TEMPLATE'S CORE — most important:",
    "  - Keep its intent, main sentences, call-to-action, CC / 'copying my team' mention, and sign-off. Do NOT drop or replace them.",
    "  - Keep the personalized values already in it (first name, company, phone) exactly as written.",
    "  - Keep any [[PHONE_n]] tokens EXACTLY as-is — do not move, edit, remove, or duplicate them.",
    "  - Do NOT invent new offers, prices, dates, guarantees, or claims not in the template.",
    "",
    "FIDELITY RULES (do not violate):",
    "  - NEVER flip the lead's point of view: if the lead wrote 'your courts', keep 'your courts' — never change it to 'our courts'. Second-person about the lead's property stays second-person.",
    "  - Do NOT insert urgency or filler words the template didn't have (e.g. 'now', 'right away', 'ASAP').",
    "  - Do NOT add the company name in places the template didn't already have it.",
    "  - Do NOT repeat a question or information already stated earlier in the conversation.",
    "",
    "ADAPT LIGHTLY:",
    "  - Acknowledge what the lead actually said — their request, question, or timing.",
    "  - Answer a direct question in one short sentence, without over-promising.",
    "  - Reword only what's needed so it reads as a genuine reply — stay close to the template, concise, professional, human.",
    instructions ? "  - Follow the OPERATOR INSTRUCTIONS below; they take priority over light adaptation but must NOT break the rules above." : "",
    "",
    "Plain text only. No subject line, no quoted history, no markdown, no placeholders (except the [[PHONE_n]] tokens).",
  ].filter(Boolean).join("\n");

  const userContent = [
    "CLIENT'S TEMPLATE REPLY (preserve the core, adapt lightly):",
    `"""${masked}"""`,
    "",
    instructions ? `OPERATOR INSTRUCTIONS (what this reply should say):\n"""${instructions.slice(0, 800)}"""\n` : "",
    "LEAD'S LATEST MESSAGE:",
    `"""${(input.leadMessage || "(none)").slice(0, 1500)}"""`,
    "",
    "FULL CONVERSATION (campaign email → follow-ups → replies; context only — do not reply to quoted history):",
    `"""${(input.fullThread || "").slice(0, 4000)}"""`,
  ].filter(Boolean).join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!response.ok) return { ok: false, reply: template, error: `AI error (${response.status}) — using the template as-is.` };
    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) return { ok: false, reply: template, error: "AI returned nothing — using the template as-is." };
    const parsed = JSON.parse(raw) as { reply?: string };
    let reply = (parsed.reply || "").trim();
    if (!reply) return { ok: false, reply: template, error: "AI returned empty — using the template as-is." };

    // Restore the exact phone numbers.
    reply = restore(reply);
    // Guarantee: every original phone's digits must still be present. If the
    // model dropped a phone token, fall back to the resolved template (which has
    // the phone intact) rather than send a reply with a missing/altered number.
    const outDigits = digitsOf(reply);
    const phoneIntact = digits.every((d) => outDigits.includes(d));
    if (!phoneIntact) return { ok: true, reply: template, error: "Kept the client template to preserve the exact phone number." };

    return { ok: true, reply };
  } catch (e) {
    return { ok: false, reply: template, error: `AI failed (${(e as Error).message}) — using the template as-is.` };
  }
}
