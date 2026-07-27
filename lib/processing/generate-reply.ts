/**
 * "Generate Reply" for the Reply Router inbox: takes the client's reply template
 * (already personalized with the lead's name / company / phone) as the CORE
 * message, and lightly adapts it to the ACTUAL conversation — the lead's latest
 * message + the full thread — so the reply reads like a natural response
 * instead of a canned template.
 *
 * Hard rule: the template's core is preserved — same intent, same call-to-action,
 * same CC/team mention, same sign-off. We only reword so it fits what the lead
 * actually said (their request, timing, specifics). Never invents offers.
 */

interface GenerateInput {
  /** The client's reply template, already variable-resolved (the CORE). */
  template: string;
  /** The lead's own latest message (quoted history stripped). */
  leadMessage: string;
  /** The full conversation thread, for context only. */
  fullThread: string;
}

export async function generateReplyFromTemplate(input: GenerateInput): Promise<{ ok: boolean; reply: string; error?: string }> {
  const template = (input.template || "").trim();
  if (!template) return { ok: false, reply: "", error: "This client has no reply template set." };
  if (!process.env.OPENAI_API_KEY) return { ok: false, reply: template, error: "AI unavailable — using the template as-is." };

  const systemPrompt = [
    "You refine a sales rep's outgoing reply to a lead about commercial cleaning services.",
    "You are given the CLIENT'S TEMPLATE reply (already personalized with the lead's name, company and phone) and the actual conversation. Return an improved version of the template that fits THIS conversation.",
    "Respond with ONLY valid JSON: { \"reply\": string }",
    "",
    "PRESERVE THE TEMPLATE'S CORE — this is the most important rule:",
    "  - Keep its intent, its main sentences, its call-to-action, its CC / 'copying my team' mention, and its sign-off. Do NOT drop or replace them.",
    "  - Keep the personalized values already in it (first name, company, phone) exactly as written.",
    "  - Do NOT invent new offers, prices, dates, guarantees, or claims that aren't in the template.",
    "",
    "ADAPT LIGHTLY to the conversation:",
    "  - Acknowledge what the lead actually said — their specific request, question, or the timing they mentioned (e.g. 'closer to December', 'once your new office is finished', 'for the 2027 school year').",
    "  - Answer a direct question if they asked one, in one short sentence, without over-promising.",
    "  - Adjust only the wording needed to make it read as a genuine reply to this lead — keep it close to the template, concise, professional and human.",
    "",
    "Plain text only. No subject line, no quoted history, no markdown, no placeholders.",
  ].join("\n");

  const userContent = [
    "CLIENT'S TEMPLATE REPLY (preserve the core, adapt lightly):",
    `"""${template}"""`,
    "",
    "LEAD'S LATEST MESSAGE:",
    `"""${(input.leadMessage || "(none)").slice(0, 1500)}"""`,
    "",
    "FULL CONVERSATION THREAD (context only — do not reply to quoted history):",
    `"""${(input.fullThread || "").slice(0, 3000)}"""`,
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
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
    const reply = (parsed.reply || "").trim();
    if (!reply) return { ok: false, reply: template, error: "AI returned empty — using the template as-is." };
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, reply: template, error: `AI failed (${(e as Error).message}) — using the template as-is.` };
  }
}
