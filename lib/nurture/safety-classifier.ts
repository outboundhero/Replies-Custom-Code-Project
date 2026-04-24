/**
 * Nurture-safety classifier — strict rules for whether a replied lead can
 * be safely re-emailed in a nurture campaign after the 45-day waiting period.
 *
 * Decision: "safe" | "unsafe" | "unknown"
 *   - safe   = soft negative / timing reply, OR out-of-office, AND still the
 *              right person, AND no remote/wrong-area/do-not-contact signals
 *   - unsafe = wrong person, remote/no office, wrong area, do-not-contact,
 *              blacklist/unsubscribe/removal request, or any compliance risk
 *   - unknown = ambiguous — treat as exclusion (do not nurture)
 *
 * Following the spec's safety principle: when in doubt, classify unsafe.
 */

export type NurtureSafety = "safe" | "unsafe" | "unknown";

export interface NurtureSafetyResult {
  safety: NurtureSafety;
  reason: string;
}

/**
 * Hard-rule prefilter from existing AI category — these categories never get nurtured.
 * Returns null if the category alone doesn't decide it (then GPT classifier runs).
 */
const UNSAFE_CATEGORIES = new Set([
  "Wrong Person",
  "Do Not Contact",
  "Mailbox No Longer Active",
  "Change Of Target",
]);

const POTENTIALLY_SAFE_CATEGORIES = new Set([
  "Not Interested",
  "Out Of Office",
  "Follow Up",
  "Open Response",
]);

const SYSTEM_PROMPT = `You are a strict B2B email-nurture safety classifier. Given a lead's reply text, decide whether they can be safely re-emailed in a nurture campaign 45 days later.

DECISION = "safe" if ALL of these are true:
1. The reply is a soft negative or timing-based response (e.g. "not right now", "no thanks", "internal team handles it", "maybe later", "bad timing", "circle back later") OR a pure out-of-office auto-reply.
2. The lead is still the right contact at the company (they did NOT redirect us to someone else, did NOT say "wrong person", did NOT say "I don't handle this").
3. They did NOT mention being remote / no physical office / wrong location / wrong city / wrong state / outside the service area.
4. They did NOT ask to be removed, unsubscribed, blacklisted, or stop being contacted.
5. There is NO compliance, legal, or company-wide stop-contact signal.

DECISION = "unsafe" if ANY of these appear:
- "wrong person", "not the right contact", "I don't handle this", "please contact <someone else>" → wrong person
- "remote", "no office", "no physical location", "we don't have an office in <area>" → remote/no office
- "wrong city", "wrong state", "wrong area", "we're not in <area>", "outside <region>" → wrong area
- "do not contact", "remove me", "unsubscribe", "stop emailing", "take me off", "company-wide", "no one at <company> wants" → opt-out / blacklist
- ANY explicit refusal of contact (legal/compliance risk)
- The reply is a hard "no" with finality (not just timing) → treat as unsafe

DECISION = "unknown" only when the reply is too ambiguous to tell. Treat unknown as exclusion downstream — when in doubt, classify "unknown".

Respond ONLY with JSON: {"safety": "safe" | "unsafe" | "unknown", "reason": "<one sentence citing the language used>"}`;

/**
 * Classify a single reply. Uses a hard-rule prefilter on existing AI category,
 * then GPT-4o-mini for borderline cases.
 */
export async function classifyNurtureSafety(input: {
  aiCategory: string | null;
  replyText: string;
}): Promise<NurtureSafetyResult> {
  // Rule 1: Hard-unsafe AI categories shortcut
  if (input.aiCategory && UNSAFE_CATEGORIES.has(input.aiCategory)) {
    return {
      safety: "unsafe",
      reason: `AI category "${input.aiCategory}" is a do-not-nurture category`,
    };
  }

  // Rule 2: If category isn't in either bucket, treat as unknown (strict default)
  if (input.aiCategory && !POTENTIALLY_SAFE_CATEGORIES.has(input.aiCategory)) {
    return {
      safety: "unknown",
      reason: `AI category "${input.aiCategory}" is not in the safe-to-nurture list`,
    };
  }

  // Rule 3: Empty reply → unknown
  if (!input.replyText?.trim()) {
    return { safety: "unknown", reason: "Reply text is empty" };
  }

  // Rule 4: GPT classification on the reply text
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
            content: `AI category from previous classifier: "${input.aiCategory || "Unknown"}"

Lead's reply:
"""
${input.replyText.slice(0, 3000)}
"""`,
          },
        ],
      }),
    });

    if (!response.ok) {
      return { safety: "unknown", reason: `Classifier API error (${response.status})` };
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw) as { safety?: string; reason?: string };

    const safetyRaw = (parsed.safety || "").toLowerCase().trim();
    let safety: NurtureSafety = "unknown";
    if (safetyRaw === "safe") safety = "safe";
    else if (safetyRaw === "unsafe") safety = "unsafe";

    return {
      safety,
      reason: parsed.reason || "No reason provided",
    };
  } catch (error) {
    return { safety: "unknown", reason: `Classifier failed: ${(error as Error).message}` };
  }
}
