/**
 * BBS-only AI lead router.
 *
 * For the BBS client (BluMont Building Services), classify each qualifying lead
 * into either "Nefi" (Northern Utah region) or "Junior" (Nevada / Arizona /
 * Southern Utah region) based on the company's location, then return the
 * matching CC config + reply template. Mitch is CC'd on both routes.
 *
 * The trigger is enforced in tracked.ts — this module assumes the caller has
 * already checked the client tag and AI category.
 */

export const BBS_TAGS = ["BBS"];
export const BBS_TRIGGER_CATEGORIES = ["interested", "meeting request", "follow up at a later date"];

export type BbsAssignment = "Nefi" | "Junior" | "Not Sure";

export interface BbsRouteResult {
  assignment: BbsAssignment;
  reason: string;
  cc_name_1: string;
  cc_email_1: string;
  cc_name_2: string;
  cc_email_2: string;
  cc_name_3: string;
  cc_email_3: string;
  reply_template: string;
}

const NEFI_TEMPLATE = `Hi {FIRST_NAME},

I'm CC'ing my bosses Jake and Nefi since you're interested in {CONTEXT} for {COMPANY}.

Jake or Nefi, can you please take it from here? Looks like a good number to call is {PHONE}

Best,

BluMont Building Services - Utah and Nevada
Our Phone: (801) 783-6923`;

const JUNIOR_TEMPLATE = `Hi {FIRST_NAME},

I'm CC'ing my bosses Junior, Jake, and Mitch since you're interested in {CONTEXT} for {COMPANY}.

Junior, Jake, or Mitch, can you please take it from here? Looks like a good number to call is {PHONE}.

Best,

{SENDER_NAME}

BluMont Building Services - Arizona & Nevada
Our Phone: (801) 783-6923`;

// Mitch Banner is CC'd on BOTH routes.
const MITCH_CC = { cc_name_3: "Mitch Banner", cc_email_3: "mitch@blumontservices.com" };

const NEFI_CC = {
  cc_name_1: "Jake Hamilton",
  cc_email_1: "jake@blumontservices.com",
  cc_name_2: "Nefi at BluMont Building Services",
  cc_email_2: "nefi@blumontservices.com",
  ...MITCH_CC,
};

const JUNIOR_CC = {
  cc_name_1: "Jake Hamilton",
  cc_email_1: "jake@blumontservices.com",
  cc_name_2: "Junior at BluMont Building Services",
  cc_email_2: "junior@blumontservices.com",
  ...MITCH_CC,
};

const SYSTEM_PROMPT = `#CONTEXT#
You are an AI-powered web researcher. Determine whether a company should be assigned to "Nefi" or "Junior" based on the company's location information provided in the input fields and any referenced Google Maps URL.
Nefi = Salt Lake City and Northern Utah region (Utah County, Davis County, Tooele County, Salt Lake County, Summit County)
Junior = all of Nevada, all of Arizona, and Southern Utah (Washington County / St. George area)

#OBJECTIVE#
- Extract the company's location (city, state, county) from the provided inputs and linked Google Maps page if present.
- Classify the company as either "Nefi" or "Junior" strictly according to the region rules above.
- Return a concise JSON result.

#INSTRUCTIONS#
1. Parse the input fields exactly as provided (company, address, city, state, google maps url, phone, reply text).
2. Analyze the reply text for any mention of a specific office location.
3. Determine county when possible from the address and city/state. If county is not explicitly given, infer it from city/state knowledge.
4. Classification rules (apply in this order):
   - If state is Nevada (NV) → "Junior".
   - If state is Arizona (AZ) → "Junior".
   - Else if state is Utah (UT):
     - If county is one of [Utah, Davis, Tooele, Salt Lake, Summit] → "Nefi".
     - If county is Washington → "Junior".
     - If county unknown but city is in Northern Utah metros around Salt Lake City (Salt Lake City, Provo, Orem, Lehi, Draper, Sandy, Park City, Bountiful, Layton, Tooele, etc.) → "Nefi".
     - If city is in Southern Utah (St. George, Cedar City, etc.) → "Junior".
   - If state unknown but the company is clearly in Las Vegas / any Nevada locality, or in Arizona (Phoenix, Tucson, Scottsdale, Mesa, Tempe, etc.) → "Junior".
   - If ambiguous after best-effort extraction → "Not Sure" with reasons.
5. Output a single JSON object: {"assignment": "Nefi" | "Junior" | "Not Sure", "reason": "<short explanation citing city/county/state>"}
6. Constraints:
   - Do not infer beyond what is visible in the inputs.
   - Prefer county-based classification when available; otherwise use city/state heuristics above.
   - Only return "Not Sure" if you cannot determine the assignment with 90%+ confidence.`;

export async function routeLeadBbs(input: {
  companyName: string;
  address: string | null;
  city: string | null;
  state: string | null;
  googleMapsUrl: string | null;
  phone: string | null;
  replyText: string;
}): Promise<BbsRouteResult> {
  const userMessage = `Company: "${input.companyName}"
Office Address: "${input.address || ""}"
Location: "${input.city || ""}, ${input.state || ""}"
Google Maps URL: "${input.googleMapsUrl || ""}"
Phone: "${input.phone || ""}"

Lead's reply text (analyze first part for office location mentions):
"""
${input.replyText.slice(0, 2000)}
"""`;

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
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI BBS routing failed: ${response.status}`);
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(raw) as { assignment?: string; reason?: string };

  const assignmentRaw = (parsed.assignment || "").trim();
  let assignment: BbsAssignment = "Not Sure";
  if (assignmentRaw.toLowerCase() === "junior") assignment = "Junior";
  else if (assignmentRaw.toLowerCase() === "nefi") assignment = "Nefi";

  // Junior route ONLY for explicit Junior. Nefi or Not Sure → Nefi route.
  const isJunior = assignment === "Junior";
  const cc = isJunior ? JUNIOR_CC : NEFI_CC;
  const template = isJunior ? JUNIOR_TEMPLATE : NEFI_TEMPLATE;

  return {
    assignment,
    reason: parsed.reason || "No reason provided",
    ...cc,
    reply_template: template,
  };
}
