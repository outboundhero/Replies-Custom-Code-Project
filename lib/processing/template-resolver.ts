/**
 * Resolves template variables in reply templates.
 *
 * Supported variables (only replaced when manually mapped in the template):
 *   {FIRST_NAME}    — Lead's first name
 *   {PHONE}         — Extracted phone number from lead data
 *   {COMPANY}       — Lead's company name
 *   {CONTEXT}       — GPT-extracted context from lead's reply
 *   {SENDER_NAME}   — Our rep's first name
 */

interface TemplateVars {
  firstName: string;
  phoneNumber: string;
  companyName: string;
  senderFirstName: string;
  replyBody: string;
  replySubject: string;
}

async function extractContext(replyBody: string, replySubject: string): Promise<string> {
  const fallback = "Having a conversation about cleaning/janitorial.";

  if (!replyBody?.trim()) return fallback;

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
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content: `You extract what a lead is interested in from their email reply. Write a short phrase (under 15 words) describing their interest, written to complete the sentence "since you're interested in...". Examples: "getting a cleaning estimate for your office", "discussing janitorial services for your building", "exploring floor care options". If unclear, respond with: Having a conversation about cleaning/janitorial.`,
          },
          {
            role: "user",
            content: `Subject: ${replySubject}\nReply: ${replyBody.slice(0, 500)}`,
          },
        ],
      }),
    });

    if (!response.ok) return fallback;

    const data = await response.json();
    const result = (data?.choices?.[0]?.message?.content || "").trim();
    return result || fallback;
  } catch {
    return fallback;
  }
}

export async function resolveTemplate(template: string, vars: TemplateVars): Promise<string> {
  // Only replace variables that exist in the template
  let resolved = template;

  if (resolved.includes("{FIRST_NAME}") && vars.firstName) {
    resolved = resolved.replaceAll("{FIRST_NAME}", vars.firstName);
  }

  if (resolved.includes("{PHONE}") && vars.phoneNumber) {
    resolved = resolved.replaceAll("{PHONE}", vars.phoneNumber);
  }

  if (resolved.includes("{COMPANY}") && vars.companyName) {
    resolved = resolved.replaceAll("{COMPANY}", vars.companyName);
  }

  if (resolved.includes("{SENDER_NAME}") && vars.senderFirstName) {
    resolved = resolved.replaceAll("{SENDER_NAME}", vars.senderFirstName);
  }

  if (resolved.includes("{CONTEXT}")) {
    const context = await extractContext(vars.replyBody, vars.replySubject);
    resolved = resolved.replaceAll("{CONTEXT}", context);
  }

  return resolved;
}
