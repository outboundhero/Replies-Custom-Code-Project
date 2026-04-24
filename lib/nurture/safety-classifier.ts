/**
 * Nurture-safety classifier — strict, content-based.
 *
 * Decides purely from the reply text (NOT from any prior AI category) whether
 * a lead can be safely re-emailed in a nurture campaign 45 days later.
 *
 * Output:
 *   safety: "safe" | "unsafe" | "unknown"
 *   bucket: "soft_negative" | "out_of_office" | "other" | null
 *   reason: short human-readable explanation
 *
 * Safety principle (from spec): when in doubt, exclude. Default to "unknown".
 */

export type NurtureSafety = "safe" | "unsafe" | "unknown";
export type NurtureBucket = "soft_negative" | "out_of_office" | "other" | null;

export interface NurtureSafetyResult {
  safety: NurtureSafety;
  bucket: NurtureBucket;
  reason: string;
}

const SYSTEM_PROMPT = `You are a strict B2B email-nurture safety classifier. Read a lead's reply text and return whether they can be safely re-emailed 45 days later, plus which "bucket" they fall into.

DECIDE BUCKET FIRST — based on what the reply IS:
- "soft_negative"  → soft negative or timing reply that does NOT hard-close, e.g. "not right now", "no thanks", "internal team handles this", "we have an internal team", "maybe later", "bad timing", "circle back later", "we are good for now", "not interested at the moment"
- "out_of_office"  → automatic out-of-office or vacation auto-reply (mentions being away, returning date, alternate contact for urgent matters, etc.)
- "other"          → anything else — including hard refusals, opt-outs, wrong-person redirects, or unrelated content

DECIDE SAFETY — independent of bucket:

safety = "safe"  ONLY if BOTH conditions hold:
  1. Bucket is "soft_negative" OR "out_of_office"
  2. The reply contains NONE of the unsafe signals below

safety = "unsafe"  if the reply contains ANY of these signals (regardless of bucket):
  - Wrong person: "wrong person", "not the right contact", "I don't handle this", "please contact <someone else>", "you should reach out to ___", "this isn't my area"
  - Remote / no office: "remote", "no office", "no physical location", "we don't have an office", "we work remotely", "no local presence"
  - Wrong area: "wrong city", "wrong state", "wrong area", "we're not in <area>", "outside <region>", "we don't service <area>"
  - Opt-out / blacklist: "do not contact", "remove me", "unsubscribe", "stop emailing", "take me off your list", "no one at <company> wants email", "company-wide do not contact"
  - Hard refusal with finality: "we will never", "absolutely not", "do not email again", strong/legal/compliance language

safety = "unknown"  for any case that doesn't clearly fit safe or unsafe — when in doubt, return unknown (the system treats unknown as exclusion).

Also return safety = "unknown" if bucket is "other" but no clear unsafe signal exists.

Respond ONLY with this JSON shape:
{"safety": "safe" | "unsafe" | "unknown", "bucket": "soft_negative" | "out_of_office" | "other", "reason": "<one short sentence quoting the language used>"}`;

export async function classifyNurtureSafety(input: {
  replyText: string;
}): Promise<NurtureSafetyResult> {
  if (!input.replyText?.trim()) {
    return { safety: "unknown", bucket: null, reason: "Reply text is empty" };
  }

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
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Lead's reply:\n"""\n${input.replyText.slice(0, 3000)}\n"""`,
          },
        ],
      }),
    });

    if (!response.ok) {
      return { safety: "unknown", bucket: null, reason: `Classifier API error (${response.status})` };
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw) as { safety?: string; bucket?: string; reason?: string };

    const safetyRaw = (parsed.safety || "").toLowerCase().trim();
    let safety: NurtureSafety = "unknown";
    if (safetyRaw === "safe") safety = "safe";
    else if (safetyRaw === "unsafe") safety = "unsafe";

    const bucketRaw = (parsed.bucket || "").toLowerCase().trim();
    let bucket: NurtureBucket = null;
    if (bucketRaw === "soft_negative") bucket = "soft_negative";
    else if (bucketRaw === "out_of_office") bucket = "out_of_office";
    else if (bucketRaw === "other") bucket = "other";

    return {
      safety,
      bucket,
      reason: parsed.reason || "No reason provided",
    };
  } catch (error) {
    return { safety: "unknown", bucket: null, reason: `Classifier failed: ${(error as Error).message}` };
  }
}
