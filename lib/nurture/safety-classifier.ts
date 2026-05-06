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

/**
 * Lead categories that DISQUALIFY a row from the nurture queue.
 *
 * Two reasons to block:
 *
 * (a) Already-engaged (a nurture sequence here would step on an active
 *     conversation handled by sales/CS):
 *       - Interested, Meeting Request, Meeting Set
 *
 * (b) Definitively-not-contactable (already opted out, wrong contact, or
 *     not a human at all):
 *       - Do Not Contact, Wrong Person, Wrong Person (Change of Target),
 *         Not Interested, Mailbox No Longer Active,
 *         Automated Error Message, Automated Catch-All Message
 *
 * Categories that REMAIN nurture candidates (decided by reply-text safety
 * classifier, not hard-blocked):
 *   - Out Of Office, Follow Up at a Later Date, Open Response,
 *     Unrecognizable by AI
 *
 * Includes both the AI-Categorized variant ("Meeting Request") and the
 * human Lead-Category variant ("Meeting Set") because the import maps
 * either to original_ai_category.
 */
const HARD_BLOCK_AI_CATEGORIES = new Set([
  // Hot leads — already engaged, nurture would interfere
  "Interested",
  "Meeting Request",
  "Meeting Set",
  // Hard opt-outs / bad contacts
  "Do Not Contact",
  "Wrong Person",
  "Wrong Person (Change of Target)",
  "Not Interested",
  // Dead mailboxes / bots
  "Mailbox No Longer Active",
  "Automated Error Message",
  "Automated Catch-All Message",
  // Lead has handed us off — original address is no longer the right
  // recipient, so nurture would be pointless or rude.
  "Referral Given",
  "Internally Forwarded",
]);

const HARD_NO_PATTERNS: { regex: RegExp; reason: string }[] = [
  // Explicit opt-out
  { regex: /\bdo\s*not\s*contact\b/i,                          reason: "Said 'do not contact'" },
  { regex: /\bdon'?t\s*contact\b/i,                            reason: "Said 'don't contact'" },
  { regex: /\bdo\s*not\s*(email|reach\s*out|message|call)\b/i, reason: "Said 'do not email/reach out'" },
  { regex: /\bdon'?t\s*(email|reach\s*out|message|call)\b/i,   reason: "Said 'don't email/reach out'" },
  { regex: /\b(please\s+)?remove\s+(me|us|my|our)\b/i,         reason: "Asked to be removed" },
  { regex: /\btake\s+(me|us|my|our)\s+off\b/i,                 reason: "Asked to be taken off list" },
  { regex: /\bunsubscribe\b/i,                                 reason: "Said 'unsubscribe'" },
  { regex: /\bopt[\s-]?out\b/i,                                reason: "Said 'opt out'" },
  { regex: /\bstop\s+(emailing|contacting|messaging|reaching|sending)\b/i, reason: "Said 'stop emailing/contacting'" },
  { regex: /\bno\s+more\s+emails?\b/i,                         reason: "Said 'no more emails'" },
  { regex: /\bcease\s+(and\s+desist|all\s+communication|contact|further)\b/i, reason: "Cease & desist" },

  // Standalone hard-no words (treat very short replies as opt-out)
  { regex: /^\s*(quit|stop|end|remove|cancel|unsubscribe|leave\s+me\s+alone)\s*[.!?]*\s*$/im, reason: "One-word opt-out" },
  { regex: /\b(please\s+)?(stop|quit|end\s+this|cancel\s+this)\s*([.!?]|$)/i, reason: "Said stop/quit/end/cancel" },

  // Hard refusal phrases
  { regex: /\bnot\s+interested\b/i,                            reason: "Said 'not interested'" },
  { regex: /\bnot\s+a?\s*fit\b/i,                              reason: "Said 'not a fit'" },
  { regex: /\bwe['']?re\s+(all\s+)?good\b/i,                   reason: "Said 'we're good'" },
  { regex: /\bwe\s+are\s+(all\s+)?good\b/i,                    reason: "Said 'we are good'" },
  { regex: /\bnever\s+(contact|email|reach)\b/i,               reason: "Said 'never contact'" },
  { regex: /\b(we'?ll|we\s+will)\s+pass\b/i,                   reason: "Said 'we'll pass'" },
  { regex: /\bno\s+thank(s|\s+you)\b/i,                        reason: "Said 'no thanks'" },
  { regex: /\bgo\s+away\b/i,                                   reason: "Said 'go away'" },

  // Wrong person / area
  { regex: /\bwrong\s+(person|contact|number|email)\b/i,       reason: "Wrong person" },
  { regex: /\b(no|not)\s+(the\s+)?right\s+(person|contact|fit)\b/i, reason: "Not right person/fit" },
  { regex: /\bwork\s+remote(ly)?\b/i,                          reason: "Remote / no office" },
  { regex: /\bno\s+(physical\s+)?(office|location)\b/i,        reason: "No office" },
  { regex: /\bdon'?t\s+have\s+(an?\s+)?office\b/i,             reason: "No office" },

  // Compliance / spam
  { regex: /\bspam\s+(report|complaint)\b/i,                   reason: "Spam complaint threatened" },
  { regex: /\breport\s+(you|this)\s+(as\s+)?spam\b/i,          reason: "Spam report threatened" },
  { regex: /\b(GDPR|CCPA|attorney|lawyer|legal\s+action)\b/i,  reason: "Legal/compliance threat" },
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

DEFAULT POSITION: most replies are NOT safe to nurture. Only allow safe when the lead clearly says "not now, but possibly later" with no negative finality. When in doubt, choose "unsafe" — never "unknown" — because unknown leaks; unsafe excludes.

BUCKETS (descriptive only):
- "soft_negative"  → mild "not right now / bad timing" replies that do not explicitly close the door:
                      "circle back next quarter", "not a priority this month", "checking budget", "revisit in Q3"
- "out_of_office"  → automated OOO / vacation auto-reply (mentions being away, return date, alternate contact)
- "other"          → anything else, including hard nos, opt-outs, wrong-person, and unrelated content

SAFETY = "unsafe"  if the reply contains ANY of these signals (always run this checklist regardless of bucket):
  • Standalone words: "Quit", "Stop", "End", "Remove", "Cancel", "Pass", "No", "Leave me alone" (a one-word reply almost always means NO)
  • Hard no:        "no thanks", "not interested", "we're good", "we are good", "no need", "we'll pass", "not a fit", "we'll decline"
  • Opt-out:        "do not contact", "don't contact", "remove me", "take me off", "unsubscribe", "stop emailing", "no more emails", "opt out", "cease"
  • Finality:       "never contact", "absolutely not", "do not email again", legal/compliance threats
  • Wrong person:   "wrong person", "not the right contact", "I don't handle this", "contact <someone else>", "this isn't my area"
  • No office:      "remote", "no office", "no physical location", "we work remotely", "no local presence"
  • Wrong area:     "wrong city/state/area", "we're not in <area>", "outside <region>", "we don't service <area>"
  • Spam threat:    "report you for spam", "spam complaint", GDPR/CCPA references
  • Frustration:    profanity directed at sender, all-caps refusal, "stop already", "leave us alone"

SAFETY = "safe"  ONLY if ALL of:
  • bucket is "soft_negative" OR "out_of_office"
  • NONE of the unsafe signals above appear
  • Reply does not express any frustration, finality, or rejection of the offer itself
  • The lead has positively signalled openness to a later conversation ("circle back", "ping me in Q3", "currently focused on X, revisit later")
  • You are at least 85% confident the lead is open to being contacted again later

SAFETY = "unsafe"  for anything else. Do not return "unknown" — that bucket is for system errors only.

Examples:
  "Quit" → unsafe (one-word stop)
  "No thanks" → unsafe (hard no)
  "Not right now, ping me in Q3" → safe + soft_negative
  "I'm out until April 30, contact Sarah for urgent matters" → safe + out_of_office
  "We use an internal team for this" → unsafe (rejection, no later opening)
  "Please remove me from your list" → unsafe (opt-out)

Respond ONLY with this JSON shape:
{"safety": "safe" | "unsafe" | "unknown", "bucket": "soft_negative" | "out_of_office" | "other", "reason": "<one short sentence quoting the actual phrase used>"}`;

export async function classifyNurtureSafety(input: {
  replyText: string;
  aiCategory?: string | null;
}): Promise<NurtureSafetyResult> {
  const text = input.replyText?.trim() || "";
  if (!text) {
    return { safety: "unknown", bucket: null, reason: "Reply text is empty" };
  }

  // ─── Layer 0: AI category hard-block ───
  // If the original AI categorizer already flagged this reply as a clear
  // opt-out / wrong-person / dead-mailbox, never re-contact.
  if (input.aiCategory && HARD_BLOCK_AI_CATEGORIES.has(input.aiCategory)) {
    return {
      safety: "unsafe",
      bucket: "other",
      reason: `AI category "${input.aiCategory}" — hard block`,
    };
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
