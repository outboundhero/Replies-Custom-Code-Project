/**
 * Shared phone-number resolution for a lead — used by BOTH the Google-Sheet push
 * (Phone column) and the reply-template {PHONE} variable, so they stay in sync.
 *
 * Waterfall priority (the FIRST source that yields any number wins; ALL numbers
 * from that source are returned, deduped):
 *   1. the lead's REPLY content + signature   (AI extraction) — always preferred
 *   2. the lead's WEBSITE                      (scraped from their email domain)
 *   3. the Bison "Company Phone" custom var    (last resort)
 *
 * Formatters:
 *   phonesForSheet    → "A, B, C"        (comma-separated, for the sheet cell)
 *   phonesForTemplate → "A, B or C"      (commas + "or", for {PHONE})
 */

import { extractDomain, isPersonalDomain } from "@/lib/processing/personal-domains";

// US + international phone-ish sequences (mirrors PHONE_RE in generate-reply.ts).
const PHONE_RE = /\+?\d[\d().\-\s]{7,}\d(?:\s*(?:x|ext\.?)\s*\d+)?/gi;
const digitsOf = (s: string) => (s.match(/\d/g) || []).join("");

export type PhoneSource = "reply" | "website" | "custom" | "none";

/** Format to "(xxx) xxx-xxxx" (+ " ext. N") for US 10-digit numbers; otherwise
 *  return the trimmed original (keeps international/odd formats intact). */
function formatUsPhone(raw: string): string {
  const ext = raw.match(/(?:x|ext\.?)\s*(\d+)/i)?.[1] || "";
  let d = digitsOf(raw.replace(/(?:x|ext\.?)\s*\d+/i, ""));
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  const base = d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : raw.trim();
  return ext ? `${base} ext. ${ext}` : base;
}

/** Dedupe by digit-string, preserving order; drop anything with < 7 digits. */
function dedupePhones(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of list) {
    const key = digitsOf(p);
    if (key.length < 7 || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Extract every phone number the lead gave in their reply body + signature. */
export async function extractReplyPhones(replyBody: string, replySubject = ""): Promise<string[]> {
  if (!replyBody?.trim() || !process.env.OPENAI_API_KEY) return [];
  const systemPrompt = [
    "You read a sales lead's email reply and extract phone numbers for our records.",
    'Respond with ONLY valid JSON, no markdown fences: { "phones": string[] }.',
    "- Include EVERY distinct phone number the lead gives in their REPLY body or email signature (their DIRECT line AND their MOBILE/cell if both appear).",
    '- Format each number as "(xxx) xxx-xxxx" with optional " ext. NNN". Preserve extensions.',
    "- Do NOT invent numbers and do NOT use any CRM data. Return an empty array if the reply contains none.",
  ].join("\n");
  const userContent = [`Subject: ${replySubject || ""}`, "Reply:", replyBody.slice(0, 2000)].join("\n");
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
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
    if (!response.ok) return [];
    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { phones?: unknown };
    const phones = Array.isArray(parsed.phones) ? parsed.phones.map((p) => String(p)) : [];
    return dedupePhones(phones.map(formatUsPhone));
  } catch {
    return [];
  }
}

/** Best-effort scrape of a business domain's homepage + /contact for phones.
 *  Prefers tel: links; requires ≥10 digits to avoid picking up prices/zips.
 *  Never throws; capped at 3 numbers; ~4s per request. */
export async function fetchWebsitePhones(domain: string): Promise<string[]> {
  const clean = (domain || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim().toLowerCase();
  if (!clean || isPersonalDomain(clean)) return [];
  const urls = [`https://${clean}`, `https://${clean}/contact`];
  const found: string[] = [];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; OutboundHeroBot/1.0)" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      const telMatches = [...html.matchAll(/tel:([+\d().\-\s]{7,})/gi)].map((m) => m[1]);
      const textMatches = html.replace(/<[^>]+>/g, " ").match(PHONE_RE) || [];
      for (const m of [...telMatches, ...textMatches]) {
        if (digitsOf(m).length >= 10) found.push(m);
      }
    } catch {
      /* timeout / bad host / network — skip this URL */
    }
    if (found.length) break; // homepage had numbers → don't also hit /contact
  }
  return dedupePhones(found.map(formatUsPhone)).slice(0, 3);
}

/** Waterfall resolver — reply → website → custom var. Pass `replyPhones` when the
 *  caller already ran the reply AI extraction (avoids a duplicate call). */
export async function resolveLeadPhones(input: {
  replyPhones?: string[];
  replyBody?: string;
  replySubject?: string;
  leadEmail?: string;
  customVarPhone?: string;
}): Promise<{ phones: string[]; source: PhoneSource }> {
  // 1. Reply content + signature (always first preference).
  let replyPhones = input.replyPhones?.length ? dedupePhones(input.replyPhones.map(formatUsPhone)) : [];
  if (!replyPhones.length && input.replyBody) {
    replyPhones = await extractReplyPhones(input.replyBody, input.replySubject || "");
  }
  if (replyPhones.length) return { phones: replyPhones, source: "reply" };

  // 2. Website scraped from the lead's email domain (business domains only).
  const domain = input.leadEmail ? extractDomain(input.leadEmail) : null;
  if (domain && !isPersonalDomain(domain)) {
    const web = await fetchWebsitePhones(domain);
    if (web.length) return { phones: web, source: "website" };
  }

  // 3. Bison "Company Phone" custom variable (last resort).
  const custom = dedupePhones([input.customVarPhone || ""].filter(Boolean).map(formatUsPhone));
  if (custom.length) return { phones: custom, source: "custom" };

  return { phones: [], source: "none" };
}

export function phonesForSheet(phones: string[]): string {
  return phones.join(", ");
}

export function phonesForTemplate(phones: string[]): string {
  if (phones.length <= 1) return phones[0] || "";
  return `${phones.slice(0, -1).join(", ")} or ${phones[phones.length - 1]}`;
}
