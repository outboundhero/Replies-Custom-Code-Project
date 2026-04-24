/**
 * Nurture-safety classifier — strict, content-based, defence-in-depth.
 *
 * Decides purely from the reply text (NOT from any prior AI category) whether
 * a lead can be safely re-emailed in a nurture campaign 45 days later.
 *
 * Three-layer defence:
 *   1. Hard deny-list regex pre-check — catches the loudest "no / remove me"
 *      phrasings without a GPT call.
 *   2. Strict GPT classifier with bucket and safety treated independently.
 *   3. Post-GPT regex backstop — re-runs the deny-list and forces "unsafe"
 *      if GPT missed an obvious opt-out phrase.
 *
 * Output:
 *   safety: "safe" | "unsafe" | "unknown"
 *   bucket: "soft_negative" | "out_of_office" | "other" | null
 *   reason: short human-readable explanation
 *
 * Safety principle: when in doubt, exclude. Default to "unknown".
 */

export type NurtureSafety = "safe" | "unsafe" | "unknown";
export type NurtureBucket = "soft_negative" | "out_of_office" | "other" | null;

export interface NurtureSafetyResult {
  safety: NurtureSafety;
  bucket: NurtureBucket;
  reason: string;
}

const HARD_NO_PATTERNS: { regex: RegExp; reason: string }[] = [
  { regex: /\bdo\s*not\s*contact\b/i,                          reason: "Said 'do not contact'" },
  { regex: /\bdon'?t\s*contact\b/i,                            reason: "Said 'don't contact'" },
  { regex: /\bdo\s*not\s*(email|reach\s*out|message)\b/i,      reason: "Said 'do not email/reach out'" },
  { regex: /\bdon'?t\s*(email|reach\s*out|message)\b/i,        reason: "Said 'don't email/reach out'" },
  { regex: /\b(please\s+)?remove\s+(me|us|my|our)\b/i,         reason: "Asked to be removed" },
  { regex: /\btake\s+(me|us|my|our)\s+off\b/i,                 reason: "Asked to be taken off list" },
  { regex: /\bunsubscribe\b/i,                                 reason: "Said 'unsubscribe'" },
  { regex: /\bopt[\s-]?out\b/i,                                reason: "Said 'opt out'" },
  { regex: /\bstop\s+(emailing|contacting|messaging|reaching)\b/i, reason: "Said 'stop emailing/contacting'" },
  { regex: /\bno\s+more\s+emails?\b/i,                         reason: "Said 'no more emails'" },
  { regex: /\bcease\s+(and\s+desist|all\s+communication|contact)\b/i, reason: "Cease & desist" },
  { regex: /\bnot\s+interested\b/i,                            reason: "Said 'not interested'" },
  { regex: /\bnot\s+a?\s*fit\b/i,                              reason: "Said 'not a fit'" },
  { regex: /\bwe['']?re\s+(all\s+)?good\b/i,                   reason: "Said 'we're good'" },
  { regex: /\bwe\s+are\s+(all\s+)?good\b/i,                    reason: "Said 'we are good'" },
  { regex: /\bnever\s+(contact|email|reach)\b/i,               reason: "Said 'never contact'" },
  { regex: /\bwrong\s+(person|contact|number|email)\b/i,       reason: "Wrong person" },
  { regex: /\b(no|not)\s+(the\s+)?right\s+(person|contact|fit)\b/i, reason: "Not right person/fit" },
  { regex: /\bwork\s+remote(ly)?\b/i,                          reason: "Remote / no office" },
  { regex: /\bno\s+(physical\s+)?(office|location)\b/i,        reason: "No office" },
  { regex: /\bdon'?t\s+have\s+(an?\s+)?office\b/i,             reason: "No office" },
  { regex: /\bspam\s+(report|complaint)\b/i,                   reason: "Spam complaint threatened" },
  { regex: /\breport\s+(you|this)\s+(as\s+)?spam\b/i,          reason: "Spam report threatened" },
];

function checkDenyList(text: string): { match: boolean; reason: string } {
  for (const p of HARD_NO_PATTERNS) {
    if (p.regex.test(text)) return { match: true, reason: p.reason };
  }
  return { match: false, reason: "" };
}

const SYSTEM_PROMPT = `You are a strict B2B email-nurture safety classifier. Read a lead's reply and decide:
  1. bucket  — what type of reply this is (descriptive)
  2. safety  — whether it is SAFE to email this lead again 45 days from now (decision)

These are independent. Bucket does NOT determine safety. Always run the unsafe checklist regardless of bucket.

BUCKETS (descriptive only):
- "soft_negative"  → mild "not right now / bad timing" replies that do not explicitly close the door:
                      "circle back next quarter", "not a priority this month", "checking budget", "revisit in Q3"
- "out_of_office"  → automated OOO / vacation auto-reply (mentions being away, return date, alternate contact)
- "other"          → anything else, including hard nos, opt-outs, wrong-person, and unrelated content

SAFETY = "unsafe"  if the reply contains ANY of these signals:
  • Hard no:        "no thanks", "not interested", "we're good", "we are good", "no need", "we'll pass", "not a fit"
  • Opt-out:        "do not contact", "don't contact", "remove me", "take me off", "unsubscribe", "stop emailing", "no more emails", "opt out", "cease"
  • Finality:       "never contact", "absolutely not", "do not email again", legal/compliance threats
  • Wrong person:   "wrong person", "not the right contact", "I don't handle this", "contact <someone else>", "this isn't my area"
  • No office:      "remote", "no office", "no physical location", "we work remotely", "no local presence"
  • Wrong area:     "wrong city/state/area", "we're not in <area>", "outside <region>", "we don't service <area>"
  • Spam threat:    "report you for spam", "spam complaint", GDPR/CCPA references

SAFETY = "safe"  ONLY if ALL of:
  • bucket is "soft_negative" OR "out_of_office"
  • NONE of the unsafe signals above appear
  • Reply does not express any frustration, finality, or rejection of the offer itself
  • You are at least 80% confident the lead is open to being contacted again later

SAFETY = "unknown"  for anything else. When in doubt, return unknown.

Respond ONLY with this JSON shape:
{"safety": "safe" | "unsafe" | "unknown", "bucket": "soft_negative" | "out_of_office" | "other", "reason": "<one short sentence quoting the actual phrase used>"}`;

export async function classifyNurtureSafety(input: {
  replyText: string;
}): Promise<NurtureSafetyResult> {
  const text = input.replyText?.trim() || "";
  if (!text) {
    return { safety: "unknown", bucket: null, reason: "Reply text is empty" };
  }

  // ─── Layer 1: hard deny-list pre-check (no GPT call) ───
  const pre = checkDenyList(text);
  if (pre.match) {
    return { safety: "unsafe", bucket: "other", reason: pre.reason };
  }

  // ─── Layer 2: GPT classifier ───
  let result: NurtureSafetyResult;
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
            content: `Lead's reply:\n"""\n${text.slice(0, 3000)}\n"""`,
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

    result = {
      safety,
      bucket,
      reason: parsed.reason || "No reason provided",
    };
  } catch (error) {
    return { safety: "unknown", bucket: null, reason: `Classifier failed: ${(error as Error).message}` };
  }

  // ─── Layer 3: post-GPT regex backstop ───
  // If GPT missed a deny-list phrase, force unsafe.
  if (result.safety !== "unsafe") {
    const post = checkDenyList(text);
    if (post.match) {
      return {
        safety: "unsafe",
        bucket: result.bucket ?? "other",
        reason: `${post.reason} (forced unsafe by deny-list)`,
      };
    }
  }

  return result;
}
