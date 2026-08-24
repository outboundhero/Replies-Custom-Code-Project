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

import { resolveLeadPhones, phonesForTemplate } from "@/lib/processing/resolve-phones";
import { stripQuotedHistory } from "@/lib/qualification/strip-quoted";

interface TemplateVars {
  firstName: string;
  phoneNumber: string;        // raw company phone from Bison custom vars (fallback)
  companyName: string;        // raw company from Bison lead data (fallback)
  senderFirstName: string;
  replyBody: string;
  replySubject: string;
  leadName?: string;          // full lead name from CRM (e.g. "L&D Millwork Team") — used to detect company/team names
  leadEmail?: string;         // lead's email — its domain is scraped for phones when the reply has none
  fromName?: string;          // the email From display name (e.g. "Aubre Murphy") — a reliable person-name source
}

interface ExtractedVars {
  context: string;            // short lowercase phrase, no leading prefix, no trailing period
  company: string | null;     // company from reply/signature, null if not mentioned
  phone: string | null;       // phone(s) from reply, null if none
  firstName: string | null;   // the actual person's first name from the reply sign-off / signature
}

// Generic / role words that are never a person's first name.
const NON_NAME_WORDS = new Set([
  "team", "info", "sales", "support", "admin", "administrator", "hello", "hi", "hey",
  "there", "contact", "service", "services", "accounts", "billing", "help", "desk",
  "inquiries", "enquiries", "reception", "frontdesk", "noreply", "office", "group",
  "company", "the", "dear", "to", "whom", "owner", "manager", "director", "staff",
]);
// Words in the FULL lead name that mark it as a company/team, not a person.
const COMPANY_MARKERS = /\b(team|inc|incorporated|llc|l\.l\.c|corp|corporation|co|group|company|solutions|services|svcs|dept|department|office|associates|assoc|enterprises|holdings|realty|properties|management|mgmt|systems|industries|international|partners|works|millwork|supply|contractors?|construction|cleaning|janitorial)\b/i;

/** Is `token` a plausible human first name? `fullName` (if given) is checked for
 *  company/team markers — so "L&D Millwork Team" is rejected even though a bare
 *  token from it might look name-like. */
function looksLikePersonName(token?: string | null, fullName?: string | null): boolean {
  const first = (token || "").trim().split(/\s+/)[0];
  if (first.length < 2 || first.length > 20) return false;
  if (!/^[A-Za-z][A-Za-z'’-]*$/.test(first)) return false;     // letters/apostrophe/hyphen only — no &, digits, .
  if (NON_NAME_WORDS.has(first.toLowerCase())) return false;
  if (fullName && COMPANY_MARKERS.test(fullName)) return false; // "… Team / Inc / Millwork …" → company name
  return true;
}

function sanitizeFirstName(raw: string | null | undefined): string | null {
  const s = (raw || "").trim().replace(/^["'`]+|["'`.,]+$/g, "").trim();
  const first = s.split(/\s+/)[0];
  return looksLikePersonName(first) ? first : null;
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

/**
 * Normalize a company name for the reply: title-case ALL-CAPS names and drop a
 * trailing legal suffix (LLC / Inc / Corp / Co / LLP / PLLC / PC …). Applied to
 * the Bison-fallback company too, so it matches the AI-normalized path.
 */
function normalizeCompany(raw: string | null | undefined): string | null {
  let s = sanitizeCompany(raw);
  if (!s) return null;
  s = s.replace(/[,\s]+(?:L\.?L\.?C\.?|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|L\.?L\.?P\.?|L\.?P\.?|P\.?L\.?L\.?C\.?|P\.?C\.?)\.?$/i, "").trim();
  if (!s) return sanitizeCompany(raw); // don't let normalization empty a name
  // Title-case names that arrived ALL CAPS (e.g. "ABC CLEANING" → "ABC Cleaning").
  if (s === s.toUpperCase() && /[A-Z]{2,}/.test(s)) {
    s = s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
  }
  return s || null;
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
  leadName: string,
  senderFirstName: string,
): Promise<ExtractedVars | null> {
  if (!replyBody?.trim()) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const systemPrompt = [
    "You read a sales lead's email reply and extract fields for use in our auto-reply template.",
    "Respond with ONLY valid JSON, no markdown fences, in this exact shape:",
    `{ "context": string, "company": string|null, "phone": string|null, "first_name": string|null }`,
    "",
    "FIELD: first_name",
    `  - The first name of the actual PERSON to greet.`,
    `  - If the CRM lead name (given below) is already a real person's first name, use that.`,
    `  - If the CRM lead name is a COMPANY / team / generic name (e.g. "L&D Millwork Team", "Info", "Sales"), find the actual person's first name from the reply's sign-off / signature — e.g. a reply ending "Thanks, Drew" → "Drew".`,
    `  - Just the first name, proper case. Return null if no real personal name is available in the CRM name OR the reply.`,
    senderFirstName
      ? `  - CRITICAL: The lead is the person who REPLIED to us. NEVER return OUR OWN sender's first name ("${senderFirstName}"). The reply often QUOTES our original outbound email — usually signed off by our sender ("${senderFirstName}") — and any quoted lines (starting with ">") or "On <date> ... wrote:" blocks are OURS, not the lead's. Ignore that quoted history and our sender's signature entirely. If the only personal name you can find is "${senderFirstName}", return null.`
      : "",
    "",
    "FIELD: context",
    `  - A short, natural phrase (≤ 16 words) capturing what the lead wants AND any TIMING they mention.`,
    `  - It is inserted into OUR reply, addressed TO the lead: "since you're interested in {context} for {company}". So write it from OUR point of view, speaking to them.`,
    `  - PERSPECTIVE — CRITICAL: the lead describes THEIR OWN business in the first person ("our offices", "our building", "we", "us", "my facility"). You MUST flip those to the SECOND person, because we are the ones replying: "our offices" → "your offices", "our building" → "your building", "we need service" → "you need service". NEVER keep the lead's "our/we/us/my" — in our reply it would wrongly refer to us. So "a quote for cleaning our offices" becomes "a cleaning quote for your offices".`,
    `  - PARAPHRASE naturally into a clean noun phrase — do NOT copy the lead's sentence word-for-word.`,
    `  - INCLUDE timing details when the lead gives them, to sound human and precise: e.g. "a couple months before service", a specific month ("this December"), a season/term ("the 2027 school year"), or a milestone ("once your new location is built out").`,
    `  - DO NOT include "since you're interested in" — the template adds it.`,
    `  - DO NOT add a trailing period. Start with a lowercase letter (it continues a sentence).`,
    `  - Examples: lead "we would appreciate a quote for cleaning our offices here" → "a cleaning quote for your offices"; "getting a cleaning quote once your new office is finished this December"; "recurring janitorial service starting the 2027 school year".`,
    `  - If truly unclear, use: "discussing cleaning services".`,
    "",
    "FIELD: company",
    `  - The company the lead is asking us to service.`,
    `  - PREFER a company name explicitly mentioned in the reply body or email signature; otherwise use the lead's CRM company (provided below) when it looks like a real business.`,
    `  - NORMALIZE it: proper Title Case, and drop trailing legal suffixes (LLC, L.L.C., Inc., Incorporated, Corp., Corporation, Co., LLP, LP, PLLC, PC) and trailing punctuation — unless removing them would make the name confusing.`,
    `  - Return null when nothing reasonable is available — the template will fall back to "your space".`,
    "",
    "FIELD: phone",
    `  - EVERY distinct phone number the lead gives in their REPLY (their DIRECT line AND their MOBILE/cell if BOTH appear) — not from the CRM data (that's a fallback handled outside).`,
    `  - Format each number as "(xxx) xxx-xxxx" with optional " ext. NNN". Preserve any extension.`,
    `  - Join multiple numbers with " or " — e.g. "(812) 508-6685 or (812) 555-1212".`,
    `  - Return a SINGLE number only when the lead explicitly restricts it ("only call my cell", "don't use the office line").`,
    `  - Return null if the reply contains no phone numbers.`,
  ].join("\n");

  const userContent = [
    `Lead's CRM name: ${leadName || "(none)"}`,
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
        max_tokens: 300,
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

    const parsed = JSON.parse(raw) as { context?: string; company?: string | null; phone?: string | null; first_name?: string | null };

    return {
      context: sanitizeContext(parsed.context || ""),
      company: sanitizeCompany(parsed.company),
      phone: sanitizePhone(parsed.phone),
      firstName: sanitizeFirstName(parsed.first_name),
    };
  } catch {
    return null;
  }
}

export async function resolveTemplate(template: string, vars: TemplateVars): Promise<string> {
  let resolved = template;

  if (resolved.includes("{SENDER_NAME}") && vars.senderFirstName) {
    resolved = resolved.replaceAll("{SENDER_NAME}", vars.senderFirstName);
  }

  // Whether the CRM-provided first name is already a real person's name. When it
  // ISN'T (e.g. "L&D Millwork Team"), we need the AI to pull the real name from
  // the reply's signature.
  const providedFirstOk = looksLikePersonName(vars.firstName, vars.leadName);

  // CONTEXT / COMPANY / PHONE / FIRST_NAME all come from one GPT call — fire it
  // when any is needed. FIRST_NAME only needs the call when the CRM name isn't a
  // usable person name.
  const needsExtraction =
    resolved.includes("{CONTEXT}") ||
    resolved.includes("{COMPANY}") ||
    resolved.includes("{PHONE}") ||
    (resolved.includes("{FIRST_NAME}") && !providedFirstOk);

  // Strip the quoted history BEFORE extraction: a reply usually quotes OUR own
  // original outbound email underneath (signed by our sender). If the AI reads
  // that quoted block it can lift OUR sender's name / company / phone as if they
  // were the lead's — the classic "Hi <our own rep's name>" greeting bug. We only
  // ever want fields from the lead's NEW message.
  const leadOnlyBody = stripQuotedHistory(vars.replyBody);

  let extracted: ExtractedVars | null = null;
  if (needsExtraction) {
    extracted = await extractReplyVars(leadOnlyBody, vars.replySubject, vars.companyName, vars.leadName || vars.firstName || "", vars.senderFirstName || "");
  }

  if (resolved.includes("{FIRST_NAME}")) {
    // Priority: a real first name from the CRM lead name → the person who signed
    // the reply (signature) → the email From display name (e.g. "Aubre Murphy" →
    // "Aubre") → "there". Crucially, when the CRM name is a company/team we do NOT
    // keep it — otherwise the greeting becomes "Hi Anna Arts Council Team,".
    const sender = (vars.senderFirstName || "").trim().toLowerCase();
    // Start from the CRM name ONLY if it's a real person; else start empty so a
    // company/team value can never leak into the greeting.
    let greet = providedFirstOk ? vars.firstName : "";
    // Deterministic safety net: never greet the lead with OUR OWN sender's name.
    const extractedFirst = extracted?.firstName || "";
    const extractedOk = extractedFirst && (!sender || extractedFirst.toLowerCase() !== sender);
    // The From display name is a reliable person-name source when the CRM name is
    // a company and the signature has no personal sign-off. Reject it when the
    // full display name reads as a company/team (e.g. "L&D Millwork Team").
    const fromFirst = sanitizeFirstName(vars.fromName);
    const fromOk = fromFirst
      && !COMPANY_MARKERS.test(vars.fromName || "")
      && (!sender || fromFirst.toLowerCase() !== sender);
    if (!providedFirstOk) {
      if (extractedOk) greet = extractedFirst;
      else if (fromOk) greet = fromFirst as string;
    }
    // If whatever we landed on is just our sender's name (bad data), drop to "there".
    if ((greet || "").trim().toLowerCase() === sender && sender) greet = "";
    resolved = resolved.replaceAll("{FIRST_NAME}", greet || "there");
  }

  if (resolved.includes("{CONTEXT}")) {
    const ctx = extracted?.context || FALLBACK_CONTEXT;
    resolved = resolved.replaceAll("{CONTEXT}", ctx);
  }

  if (resolved.includes("{COMPANY}")) {
    // Priority: AI-extracted (from reply / signature) → Bison lead.company → "your space".
    // Both real-company paths are normalized (legal suffix dropped, ALL-CAPS title-cased).
    const company =
      normalizeCompany(extracted?.company)
      || normalizeCompany(vars.companyName)
      || FALLBACK_COMPANY;
    resolved = resolved.replaceAll("{COMPANY}", company);
  }

  if (resolved.includes("{PHONE}")) {
    // Priority: AI-extracted from reply (with mobile/office priority + extensions) → Bison company phone.
    //
    // When the phone came from the LEAD'S reply, it's almost certainly
    // their direct line and we can speak confidently. When we fall back
    // to the Bison custom-variable phone, it's the company switchboard
    // or a generic line — append a disclaimer so the reader doesn't
    // promise something we don't know to be true.
    //
    // Confident:   "Looks like a good number to call is (812) 508-6685."
    // Fallback:    "Looks like a good number to call is (812) 508-6685,
    //               but not sure if it's direct to Ryan's phone yet."
    // Reuse the phone(s) the single extraction call already pulled from the
    // reply (no duplicate AI call); the resolver only reaches for the website /
    // custom-var fallbacks when the reply had none.
    const replyPhones = extracted?.phone
      ? extracted.phone.split(/\s+or\s+|,\s*/i).map((s) => s.trim()).filter(Boolean)
      : [];
    const { phones, source } = await resolveLeadPhones({
      replyPhones,
      leadEmail: vars.leadEmail,
      customVarPhone: vars.phoneNumber,
    });
    const phone = phonesForTemplate(phones); // "A, B or C"
    const firstName = (vars.firstName || "").trim();
    // Only the company-switchboard fallback gets the "not sure if direct"
    // disclaimer — a number the LEAD gave (reply) or their site is spoken plainly.
    const replacement =
      source === "custom" && phone && firstName
        ? `${phone}, but not sure if it's direct to ${firstName}'s phone yet`
        : phone;
    resolved = resolved.replaceAll("{PHONE}", replacement);
  }

  return resolved;
}
