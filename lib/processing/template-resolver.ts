/**
 * Resolves template variables in reply templates.
 *
 * Supported variables (only replaced when present in the template):
 *   {FIRST_NAME}    — Lead's first name
 *   {PHONE}         — Phone number(s) — extracted from the lead's reply when
 *                     possible; falls back to the company phone from Bison.
 *   {COMPANY}       — Lead's company — sourced from the reply / signature
 *                     when present; falls back to Bison lead.company; final
 *                     fallback "your space".
 *   {CONTEXT}       — Short noun phrase finishing "since you're interested in…"
 *   {SENDER_NAME}   — Our rep's first name
 *
 * One GPT-4o-mini call extracts {CONTEXT}, {COMPANY}, and {PHONE} together
 * (cheaper + faster than three separate calls and lets the model reconcile
 * fields that depend on each other — e.g. the phone the lead asked us to
 * call). Output is strict JSON, post-processed to enforce the template's
 * surrounding grammar.
 */

interface TemplateVars {
  firstName: string;
  phoneNumber: string;        // raw company phone from Bison custom vars (fallback)
  companyName: string;        // raw company from Bison lead data (fallback)
  senderFirstName: string;
  replyBody: string;
  replySubject: string;
}

interface ExtractedVars {
  context: string;            // short lowercase phrase, no leading prefix, no trailing period
  company: string | null;     // company from reply/signature, null if not mentioned
  phone: string | null;       // phone(s) from reply, null if none
}

const FALLBACK_CONTEXT = "discussing cleaning services";
const FALLBACK_COMPANY = "your space";

/**
 * Defensive cleanup for the {CONTEXT} field.
 * Templates wrap it as "since you're interested in {CONTEXT} for {COMPANY}."
 * — so the value must not duplicate that prefix, must not end with a period,
 * and should start lowercase to read as a continuation of the sentence.
 */
function sanitizeContext(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return FALLBACK_CONTEXT;

  // Strip any leading "since you're interested in" the model echoed back
  // (with various punctuation / quoting). Loop in case it duplicated twice.
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/^["'`]?\s*since\s+you'?re\s+interested\s+in\s*[:,-]?\s*/i, "").trim();
    if (s === before) break;
  }

  // Strip wrapping quotes / trailing period(s).
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
  s = s.replace(/[.\s]+$/g, "").trim();

  if (!s) return FALLBACK_CONTEXT;

  // Lowercase the first letter so "since you're interested in {context}"
  // reads as a single sentence. Preserve subsequent capitals (proper nouns).
  s = s.charAt(0).toLowerCase() + s.slice(1);
  return s;
}

function sanitizeCompany(raw: string | null | undefined): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  // Strip wrapping quotes / trailing punctuation.
  return s.replace(/^["'`]+|["'`]+$/g, "").replace(/[.,;\s]+$/g, "").trim() || null;
}

function sanitizePhone(raw: string | null | undefined): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  // Quick sanity check: must contain at least one digit.
  if (!/\d/.test(s)) return null;
  return s;
}

/**
 * One combined GPT call to extract context + company + phone from the lead
 * reply. Returns null on any error so the caller can fall back to defaults.
 */
async function extractReplyVars(
  replyBody: string,
  replySubject: string,
  leadCompanyName: string,
): Promise<ExtractedVars | null> {
  if (!replyBody?.trim()) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const systemPrompt = [
    "You read a sales lead's email reply and extract three fields for use in our auto-reply template.",
    "Respond with ONLY valid JSON, no markdown fences, in this exact shape:",
    `{ "context": string, "company": string|null, "phone": string|null }`,
    "",
    "FIELD: context",
    `  - A short noun phrase (≤ 12 words) describing what the lead wants help with.`,
    `  - Will be inserted into the sentence: "since you're interested in {context} for {company}".`,
    `  - DO NOT include "since you're interested in" — the template adds it.`,
    `  - DO NOT add a trailing period.`,
    `  - Start with a lowercase letter (it continues a sentence).`,
    `  - Examples: "getting a cleaning estimate for your office", "discussing janitorial services", "exploring floor care options".`,
    `  - If unclear, use: "discussing cleaning services".`,
    "",
    "FIELD: company",
    `  - The company the lead is asking us to service.`,
    `  - PREFER a company name explicitly mentioned in the reply body or email signature.`,
    `  - If the reply doesn't mention one, use the lead's CRM company (provided below) when it looks like a real business.`,
    `  - Return null when nothing reasonable is available — the template will fall back to "your space".`,
    "",
    "FIELD: phone",
    `  - All phone numbers from the lead's REPLY (not from the CRM data — that's a fallback handled outside).`,
    `  - Format each number as "(xxx) xxx-xxxx" with optional " ext. NNN".`,
    `  - If the lead specifies a SPECIFIC number to use ("call me at…", "best to reach me on my mobile…"), return ONLY that number.`,
    `  - If multiple unspecified numbers: mobile first, office second, joined with " and ".`,
    `  - Preserve any extension the lead mentions.`,
    `  - Return null if the reply contains no phone numbers.`,
  ].join("\n");

  const userContent = [
    `Lead's CRM company: ${leadCompanyName || "(none)"}`,
    `Subject: ${replySubject || ""}`,
    `Reply:`,
    replyBody.slice(0, 2000),
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
        max_tokens: 200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { context?: string; company?: string | null; phone?: string | null };

    return {
      context: sanitizeContext(parsed.context || ""),
      company: sanitizeCompany(parsed.company),
      phone: sanitizePhone(parsed.phone),
    };
  } catch {
    return null;
  }
}

export async function resolveTemplate(template: string, vars: TemplateVars): Promise<string> {
  let resolved = template;

  if (resolved.includes("{FIRST_NAME}") && vars.firstName) {
    resolved = resolved.replaceAll("{FIRST_NAME}", vars.firstName);
  }

  if (resolved.includes("{SENDER_NAME}") && vars.senderFirstName) {
    resolved = resolved.replaceAll("{SENDER_NAME}", vars.senderFirstName);
  }

  // CONTEXT / COMPANY / PHONE all come from one GPT call so we only fire
  // it when at least one of the three vars actually appears.
  const needsExtraction =
    resolved.includes("{CONTEXT}") ||
    resolved.includes("{COMPANY}") ||
    resolved.includes("{PHONE}");

  let extracted: ExtractedVars | null = null;
  if (needsExtraction) {
    extracted = await extractReplyVars(vars.replyBody, vars.replySubject, vars.companyName);
  }

  if (resolved.includes("{CONTEXT}")) {
    const ctx = extracted?.context || FALLBACK_CONTEXT;
    resolved = resolved.replaceAll("{CONTEXT}", ctx);
  }

  if (resolved.includes("{COMPANY}")) {
    // Priority: AI-extracted (from reply / signature) → Bison lead.company → "your space"
    const company =
      extracted?.company
      || sanitizeCompany(vars.companyName)
      || FALLBACK_COMPANY;
    resolved = resolved.replaceAll("{COMPANY}", company);
  }

  if (resolved.includes("{PHONE}")) {
    // Priority: AI-extracted from reply (with mobile/office priority + extensions) → Bison company phone
    const phone = extracted?.phone || sanitizePhone(vars.phoneNumber) || "";
    resolved = resolved.replaceAll("{PHONE}", phone);
  }

  return resolved;
}
