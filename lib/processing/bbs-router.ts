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
 *
 * The decision is stored per reply row (Turso `bbs_route`) so every later path
 * — the inbox / Data View composer, Sync Template, Reallocate — uses the lead's
 * route instead of BBS's generic client_config (which is the Nefi route).
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { logActivity } from "@/lib/errors";
import { zipInfo, stateCode } from "@/lib/qualification/zip-audit";

export const BBS_TAGS = ["BBS"];
export const isBbsTag = (tag: string | null | undefined) => BBS_TAGS.includes(String(tag ?? "").trim().toUpperCase());
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

// Same text as BBS's template in client_config (Clients page): names everyone
// CC'd (Mitch is on both routes) and signs off as the Utah team.
const NEFI_TEMPLATE = `Hi {FIRST_NAME},

I'm CC'ing my bosses Jake, Mitch, and Nefi since you're interested in {CONTEXT} for {COMPANY}.

Jake, Mitch, or Nefi, can you please take it from here? Looks like a good number to call is {PHONE}.

Best,

{SENDER_NAME}

BluMont Building Services - Utah
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

/** Every BluMont address on either route — the client's own team, for
 *  known-client detection (a reply with Junior on it is BluMont too). */
export const BBS_CONTACT_EMAILS: string[] = [...new Set(
  [NEFI_CC, JUNIOR_CC].flatMap((c) => [c.cc_email_1, c.cc_email_2, c.cc_email_3]).map((e) => e.toLowerCase()),
)];

/** Both BBS CC routes, for reporting (e.g. GET /api/config/clients/BBS). The
 *  route is chosen per lead by routeLeadBbs: Junior only on an explicit Junior
 *  assignment; Nefi otherwise (including "Not Sure"). */
export function bbsRoutes() {
  const list = (c: Record<string, string>) =>
    [1, 2, 3].map((i) => ({ name: c[`cc_name_${i}`], email: c[`cc_email_${i}`] })).filter((x) => x.email);
  return [
    { route: "Nefi", region: "Northern Utah (also the default when the region is unclear)", cc: list(NEFI_CC), bcc: [], reply_template: NEFI_TEMPLATE },
    { route: "Junior", region: "Nevada / Arizona / Southern Utah", cc: list(JUNIOR_CC), bcc: [], reply_template: JUNIOR_TEMPLATE },
  ];
}

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

/** CC fields + reply template for a route. Junior only on an explicit Junior
 *  assignment; Nefi otherwise (including "Not Sure"). */
export function bbsRouteFields(assignment: BbsAssignment) {
  const isJunior = assignment === "Junior";
  return { ...(isJunior ? JUNIOR_CC : NEFI_CC), reply_template: isJunior ? JUNIOR_TEMPLATE : NEFI_TEMPLATE };
}

// ── Deterministic region from the lead's address ───────────────────────────
// Clear-cut cases never go to the AI: any Nevada / Arizona address → Junior; a
// Utah ZIP in a Northern-Utah county → Nefi, in Washington / Iron county
// (St. George, Cedar City) → Junior. Anything else falls through to the AI.
const NEFI_UT_COUNTIES = new Set(["utah", "davis", "tooele", "salt lake", "summit"]);
const JUNIOR_UT_COUNTIES = new Set(["washington", "iron"]);
const STATE_NAME = { NV: "Nevada", AZ: "Arizona", UT: "Utah" } as Record<string, string>;

function mapsQuery(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url.replace(/ /g, "+"));
    return (u.searchParams.get("q") || u.searchParams.get("query") || "").replace(/\+/g, " ");
  } catch { return ""; }
}

/** "…, North Las Vegas, NV 89032" → { state: "NV", zip: "89032" } — only the
 *  state at the END of an address (so "Nevada City, CA" or "Utah Ave" don't count). */
function stateFromAddress(text: string): { state: string; zip: string | null } | null {
  const m = text.trim().match(/,\s*([A-Za-z]{2}|nevada|arizona|utah)\.?\s*(\d{5})?(?:-\d{4})?\s*(?:,\s*(?:usa|us|united states))?\s*$/i);
  if (!m) return null;
  const state = stateCode(m[1]);
  return state ? { state, zip: m[2] || null } : null;
}

export async function bbsRegionFromLocation(loc: {
  address?: string | null; city?: string | null; state?: string | null; googleMapsUrl?: string | null;
}): Promise<{ assignment: "Nefi" | "Junior"; reason: string } | null> {
  const candidates = [loc.address, mapsQuery(loc.googleMapsUrl), [loc.city, loc.state].filter(Boolean).join(", ")]
    .map((s) => String(s ?? "").trim()).filter(Boolean);
  let state = "", county = "", where = "";
  for (const text of candidates) {
    const hit = stateFromAddress(text);
    if (!hit) continue;
    const z = hit.zip ? await zipInfo(hit.zip).catch(() => null) : null;
    // Trust the ZIP's county only when it's in the state the address names.
    if (z && z.state === hit.state) { state = z.state; county = String(z.county || ""); where = `${z.city}, ${z.state} ${z.zip}`; break; }
    if (!state) { state = hit.state; where = text; }
  }
  if (!state) { const s = stateCode(loc.state); if (s) { state = s; where = `state field "${loc.state}"`; } }
  if (!state) return null;

  if (state === "NV" || state === "AZ") {
    return { assignment: "Junior", reason: `Address is in ${STATE_NAME[state]} (${where}).` };
  }
  if (state === "UT" && county) {
    const c = county.toLowerCase().replace(/\s+county$/, "");
    if (NEFI_UT_COUNTIES.has(c)) return { assignment: "Nefi", reason: `Address is in ${county} County, Northern Utah (${where}).` };
    if (JUNIOR_UT_COUNTIES.has(c)) return { assignment: "Junior", reason: `Address is in ${county} County, Southern Utah (${where}).` };
  }
  return null;
}

export async function routeLeadBbs(input: {
  companyName: string;
  address: string | null;
  city: string | null;
  state: string | null;
  googleMapsUrl: string | null;
  phone: string | null;
  replyText: string;
}): Promise<BbsRouteResult> {
  const fixed = await bbsRegionFromLocation(input).catch(() => null);
  if (fixed) return { ...fixed, ...bbsRouteFields(fixed.assignment) };

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
  return {
    assignment,
    reason: parsed.reason || "No reason provided",
    ...bbsRouteFields(assignment),
  };
}

// ── Per-row storage (Turso bbs_route) ───────────────────────────────────────
let tableReady: Promise<void> | null = null;
function ensureBbsRouteTable(): Promise<void> {
  if (!tableReady) {
    tableReady = db.execute(`CREATE TABLE IF NOT EXISTS bbs_route (
      reply_row_id INTEGER PRIMARY KEY, assignment TEXT NOT NULL, reason TEXT, routed_at TEXT
    )`).then(() => undefined).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

export async function saveBbsRoute(replyRowId: number, r: { assignment: BbsAssignment; reason: string }): Promise<void> {
  await ensureBbsRouteTable();
  await db.execute({
    sql: `INSERT INTO bbs_route (reply_row_id, assignment, reason, routed_at) VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(reply_row_id) DO UPDATE SET assignment = excluded.assignment, reason = excluded.reason, routed_at = excluded.routed_at`,
    args: [replyRowId, r.assignment, r.reason],
  });
}

export async function getStoredBbsRoute(replyRowId: number): Promise<{ assignment: BbsAssignment; reason: string } | null> {
  await ensureBbsRouteTable();
  const r = await db.execute({ sql: "SELECT assignment, reason FROM bbs_route WHERE reply_row_id = ?", args: [replyRowId] });
  const row = r.rows[0];
  return row ? { assignment: row.assignment as BbsAssignment, reason: String(row.reason ?? "") } : null;
}

/**
 * The lead's BBS route: the stored decision, or (none stored / `force`) route it
 * now from the row's address + reply and store it. `force` is Sync Template /
 * Reallocate — re-run the routing so the operator gets the current answer.
 */
export async function resolveBbsRouteForRow(
  replyRowId: number,
  opts: { force?: boolean; via?: string } = {},
): Promise<BbsRouteResult> {
  if (!opts.force) {
    const stored = await getStoredBbsRoute(replyRowId);
    if (stored) return { ...stored, ...bbsRouteFields(stored.assignment) };
  }
  const { data: row, error } = await supabase
    .from("replies")
    .select("lead_email, company_name, address, city, state, google_maps_url, phone, reply_we_got")
    .eq("id", replyRowId).single();
  if (error || !row) throw new Error(`BBS routing: reply ${replyRowId} not found`);
  const route = await routeLeadBbs({
    companyName: String(row.company_name || ""),
    address: row.address ? String(row.address) : null,
    city: row.city ? String(row.city) : null,
    state: row.state ? String(row.state) : null,
    googleMapsUrl: row.google_maps_url ? String(row.google_maps_url) : null,
    phone: row.phone ? String(row.phone) : null,
    replyText: String(row.reply_we_got || ""),
  });
  await saveBbsRoute(replyRowId, route);
  await logActivity("inbox", "bbs-routed", {
    client_tag: "BBS",
    lead_email: row.lead_email ? String(row.lead_email) : undefined,
    details: { reply_row_id: replyRowId, assignment: route.assignment, reason: route.reason, via: opts.via || "inbox" },
  });
  return route;
}
