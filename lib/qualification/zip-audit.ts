/**
 * CCG ZIP audit — determine ONE confident ZIP for the location a positive lead is
 * actually talking about, then check it against the CCG client's ZIP list
 * (the 5-digit codes in its "Inclusion locations" cell on the Qualification
 * sheet). Scope: client tags starting with "CCG" only, for now.
 *
 *   Reply → AI + web verification → lead-data cross-check → one ZIP
 *     → in the current CCG tag's list?  Passed
 *     → in another CCG tag's list?      Failed + recommend that tag
 *     → not confident enough?           Needs review (never guess)
 *
 * Accuracy rules (deliberate):
 *  - Every ZIP must exist in the US ZIP table (`us_zip`, GeoNames) and agree with
 *    the state/city evidence; the model can't invent or mistype one into a pass.
 *  - Campaign/CRM location is supporting evidence only, never trusted alone.
 *  - The resolver is never shown the client's ZIP list, so it can't be nudged
 *    toward a "passing" answer.
 *
 * Results live in Turso `zip_audit` (one row per reply), separate from the
 * existing location_audit fields.
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { geminiJSON } from "@/lib/gemini";
import { getChurnedTags } from "@/lib/churn";
import { stripQuotedHistory } from "./strip-quoted";

export const MANUAL_REVIEW_MESSAGE =
  "Zip code could not be determined with sufficient confidence. Please manually verify the prospect's location and zip code.";

export const isCcgTag = (tag: string | null | undefined) => /^CCG/i.test(String(tag ?? "").trim());

// ── US ZIP reference ────────────────────────────────────────────────────────
export interface ZipInfo { zip: string; city: string; state: string; county: string | null; lat: number; lng: number }

/** Turso over HTTP occasionally drops a socket ("socket hang up") — retry those. */
async function q(sql: string, args: (string | number)[]) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.execute({ sql, args }); }
    catch (e) {
      if (attempt >= 2 || !/hang up|ECONNRESET|fetch failed|ETIMEDOUT|socket/i.test(String((e as Error)?.message))) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}
const zipCache = new Map<string, ZipInfo | null>();

export async function zipInfo(zip: string): Promise<ZipInfo | null> {
  if (!/^\d{5}$/.test(zip)) return null;
  if (zipCache.has(zip)) return zipCache.get(zip)!;
  const r = await q("SELECT zip, city, state, county, lat, lng FROM us_zip WHERE zip = ?", [zip]);
  const info = (r.rows[0] as unknown as ZipInfo) ?? null;
  zipCache.set(zip, info);
  return info;
}

/** Every ZIP whose place name is this city (GeoNames' primary name per ZIP). */
export async function zipsOfCity(city: string, state: string): Promise<ZipInfo[]> {
  if (!city || !state) return [];
  const r = await q("SELECT zip, city, state, county, lat, lng FROM us_zip WHERE state = ? AND LOWER(city) = LOWER(?)", [state.toUpperCase(), city.trim()]);
  return r.rows as unknown as ZipInfo[];
}

/** Centre of a city (mean of its ZIPs' coordinates), or null if unknown. */
async function cityCentre(city: string, state: string): Promise<{ lat: number; lng: number } | null> {
  const zs = await zipsOfCity(city, state);
  if (!zs.length) return null;
  return { lat: zs.reduce((s, z) => s + z.lat, 0) / zs.length, lng: zs.reduce((s, z) => s + z.lng, 0) / zs.length };
}

export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
export function stateCode(s: string | null | undefined): string {
  const t = String(s ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return STATES[t.toLowerCase()] ?? "";
}

// ── CCG ZIP index (from the Qualification sheet's inclusion cells) ─────────
export interface CcgIndex {
  zipsByTag: Map<string, Set<string>>;   // active CCG tags that HAVE a ZIP list
  tagsByZip: Map<string, string[]>;
  noZipList: Set<string>;                // active CCG tags whose cell has no ZIPs
}
let indexCache: { at: number; idx: CcgIndex } | null = null;

export async function loadCcgZipIndex(force = false): Promise<CcgIndex> {
  if (!force && indexCache && Date.now() - indexCache.at < 5 * 60_000) return indexCache.idx;
  const [{ data, error }, churned, meta] = await Promise.all([
    supabase.from("client_qualifications").select("client_abbreviation, inclusion_locations").ilike("client_abbreviation", "CCG%"),
    getChurnedTags(),
    db.execute("SELECT client_tag, status FROM client_meta WHERE UPPER(client_tag) LIKE 'CCG%'"),
  ]);
  if (error) throw new Error(`client_qualifications: ${error.message}`);
  // Active = not churned (Groups tab / tracker) AND the sheet's Status says
  // Active — e.g. CCGLA is marked Churned on the sheet but not on the Groups tab.
  const status = new Map((meta.rows as unknown as Array<{ client_tag: string; status: string | null }>)
    .map((m) => [String(m.client_tag).toUpperCase(), String(m.status || "").trim().toLowerCase()]));
  const idx: CcgIndex = { zipsByTag: new Map(), tagsByZip: new Map(), noZipList: new Set() };
  for (const r of data || []) {
    const tag = String(r.client_abbreviation || "").trim().toUpperCase();
    if (!tag || churned.has(tag)) continue;
    if (status.get(tag) !== "active") continue; // churned on the sheet, or no longer on the form
    const zips = new Set(String(r.inclusion_locations || "").match(/\b\d{5}\b/g) || []);
    if (!zips.size) { idx.noZipList.add(tag); continue; }
    idx.zipsByTag.set(tag, zips);
    for (const z of zips) idx.tagsByZip.set(z, [...(idx.tagsByZip.get(z) || []), tag]);
  }
  indexCache = { at: Date.now(), idx };
  return idx;
}

// ── ZIP resolver ────────────────────────────────────────────────────────────
export type ZipConfidence = "high" | "medium" | "low";
export interface ZipResolution {
  /** The one ZIP, when the evidence pins down a street address / ZIP. */
  zip: string | null;
  city: string | null;
  state: string | null;
  confidence: ZipConfidence;
  source: "reply" | "web" | "lead data" | "none";
  evidence: string;
  /** City-level evidence only ("we're in Wellington, FL"): every ZIP of that
   *  city. The audit can still decide when they all fall on the same side of
   *  the client's list — without guessing which one. */
  cityZips?: string[];
}

export interface LeadLocationInput {
  replyText: string;          // full reply (quoted history is stripped here)
  companyName?: string | null;
  leadEmail?: string | null;
  website?: string | null;
  crmAddress?: string | null;
  crmCity?: string | null;
  crmState?: string | null;
  googleMapsUrl?: string | null;
  phone?: string | null;
}

/** ZIPs the lead wrote out next to a state ("Nashville, TN 37210"), verified
 *  against the ZIP table. Bare 5-digit numbers are ignored — they're as often a
 *  suite number or part of a phone number. `listed` = ZIPs on a CCG client's
 *  list, accepted even if the reference table lacks them (PO-box ZIPs). */
export async function zipsWrittenInReply(leadMessage: string, listed?: Set<string>): Promise<ZipInfo[]> {
  const found = new Map<string, ZipInfo>();
  const stateNames = Object.keys(STATES).join("|");
  const re = new RegExp(`\\b([A-Z]{2}|${stateNames})\\.?,?\\s+(\\d{5})(?:-\\d{4})?\\b`, "gi");
  for (const m of leadMessage.matchAll(re)) {
    const st = stateCode(m[1]);
    if (!st || !Object.values(STATES).includes(st)) continue;
    const info = await zipInfo(m[2]);
    if (info && info.state === st) found.set(info.zip, info);
    else if (!info && listed?.has(m[2])) found.set(m[2], { zip: m[2], city: "", state: st, county: null, lat: 0, lng: 0 });
  }
  for (const m of leadMessage.matchAll(/\bzip(?:\s*code)?\s*[:#-]?\s*(\d{5})\b/gi)) {
    const info = await zipInfo(m[1]);
    if (info) found.set(info.zip, info);
  }
  return [...found.values()];
}

interface ModelAnswer {
  zip?: string | null; city?: string | null; state?: string | null;
  street_address?: string | null;
  location_level?: "street_address" | "city" | "none";
  basis?: "reply" | "business_listing" | "website" | "lead_data" | "none";
  confidence?: ZipConfidence; evidence?: string;
}

const RESOLVER_SYSTEM = `You determine the physical location (street address and US ZIP code) that a sales prospect is referring to in their email reply.
This decides which local cleaning-company branch receives the lead, so ACCURACY matters more than coverage. Never guess.

Use evidence in this priority:
1. The prospect's own reply: a ZIP, street address, city/state, email signature, or a specific location they mention ("our Brentwood office").
2. Web search: look up the business (company name, website, email domain, address) — its official site, Google Business listing, or directory — to find the street address of the location in question.
3. Lead data (CRM address/city/state, Google Maps link, phone) — supporting evidence ONLY; it may be outdated or a different office.
   If you CONFIRM the lead-data address with a web listing for the SAME business (official site, Google Business, Maps), that is web-verified: set basis "business_listing". Use basis "lead_data" only when nothing on the web confirms it.

Hard rules:
- The location must be the PROSPECT's. Never use the address, website or listings of the company that emailed them (the cleaning company named below / "your office"), even if the prospect says they are near it or a link to it appears in the text.
- Only return a ZIP when you found a specific STREET ADDRESS (or a ZIP written by the prospect / on an official listing for that exact location). If you only know the CITY, set location_level "city", return the city and state, and set zip to null — do NOT pick "the most common ZIP" for a city.
- If the business has several locations and you can't tell which one the prospect means, use location_level "city" (if they're all in one city) or "none".
Respond with ONLY JSON:
{"zip": "12345" or null, "street_address": "full street address you relied on" or null, "city": string|null, "state": "2-letter"|null,
 "location_level": "street_address"|"city"|"none", "basis": "reply"|"business_listing"|"website"|"lead_data"|"none",
 "confidence": "high"|"medium"|"low", "evidence": "one short sentence citing exactly what you found and where"}`;

const rank: Record<ZipConfidence, number> = { low: 0, medium: 1, high: 2 };
const minConf = (a: ZipConfidence, b: ZipConfidence): ZipConfidence => (rank[a] <= rank[b] ? a : b);
const notSure = (evidence: string): ZipResolution => ({ zip: null, city: null, state: null, confidence: "low", source: "none", evidence });

/** The cleaning company that emailed the prospect (our client) — its own
 *  addresses/site must never be taken as the prospect's location. */
const SENDER_BRAND = { name: "Corporate Cleaning Group", domain: "corporatecleaninggroup.com" };

export async function resolveLeadZip(input: LeadLocationInput, listed?: Set<string>): Promise<ZipResolution> {
  const leadMessage = stripQuotedHistory(input.replyText || "");

  // 1. The prospect wrote the ZIP out (with its state) → verified, done.
  const written = await zipsWrittenInReply(leadMessage, listed);
  if (written.length === 1) {
    const z = written[0];
    return { zip: z.zip, city: z.city || null, state: z.state, confidence: "high", source: "reply", evidence: `ZIP ${z.zip} written in the prospect's reply${z.city ? ` (${z.city}, ${z.state})` : ""}` };
  }

  // 2. AI + web search (also settles a reply that lists several ZIPs).
  const user = [
    `Prospect's reply (their own message only):\n"""${leadMessage.slice(0, 2500)}"""`,
    written.length > 1 ? `ZIPs written in the reply: ${written.map((z) => `${z.zip} (${z.city}, ${z.state})`).join("; ")} — decide which one is the location they mean.` : "",
    `Company name: ${input.companyName || "(unknown)"}`,
    `Email: ${input.leadEmail || "(unknown)"}${input.website ? ` · Website: ${input.website}` : ""}`,
    `Lead data (may be stale): address=${input.crmAddress || "-"}; city=${input.crmCity || "-"}; state=${input.crmState || "-"}; maps=${input.googleMapsUrl || "-"}; phone=${input.phone || "-"}`,
    `The company that emailed the prospect (NEVER use its locations): ${SENDER_BRAND.name} (${SENDER_BRAND.domain})`,
  ].filter(Boolean).join("\n");

  let ans: ModelAnswer;
  try {
    ans = await geminiJSON<ModelAnswer>({ system: RESOLVER_SYSTEM, user, withSearch: true, maxTokens: 800 });
  } catch (e) {
    return notSure(`ZIP lookup failed: ${(e as Error).message}`);
  }

  const claimedState = stateCode(ans.state);
  const evidenceBase = ans.evidence || "";
  if (/corporate\s*cleaning\s*group|corporatecleaninggroup/i.test(`${evidenceBase} ${ans.street_address ?? ""}`)) {
    return notSure(`Not confident — the only location found belongs to the cleaning company that emailed them (${evidenceBase})`);
  }
  const fromReply = (() => {
    // "From the reply" only when the prospect actually wrote it: the street
    // number of the cited address, or the city, appears in their message.
    const num = String(ans.street_address ?? "").match(/^\s*(\d+)/)?.[1];
    if (num && leadMessage.includes(num)) return true;
    return ans.location_level === "city" && !!ans.city && leadMessage.toLowerCase().includes(String(ans.city).toLowerCase());
  })();
  const source: ZipResolution["source"] =
    fromReply ? "reply"
      : ans.basis === "business_listing" || ans.basis === "website" || ans.basis === "reply" ? "web"
        : ans.basis === "lead_data" ? "lead data" : "none";
  let conf: ZipConfidence = ans.confidence === "high" || ans.confidence === "medium" ? ans.confidence : "low";
  const notes: string[] = [];
  if (ans.basis === "lead_data" || ans.basis === "none") { conf = "low"; notes.push("based on lead data only"); }
  const crmState = stateCode(input.crmState);

  // 3a. City-level only → every ZIP of that city (the audit decides if they agree).
  const zip = String(ans.zip ?? "").trim().slice(0, 5);
  const hasStreet = !!String(ans.street_address ?? "").trim() && ans.location_level === "street_address";
  if (!/^\d{5}$/.test(zip) || !hasStreet) {
    const otherState = !!crmState && claimedState !== crmState && source !== "reply";
    if (ans.location_level === "city" && ans.city && claimedState && conf !== "low" && !otherState) {
      const zs = await zipsOfCity(ans.city, claimedState);
      if (zs.length === 1) {
        return { zip: zs[0].zip, city: zs[0].city, state: zs[0].state, confidence: conf, source, evidence: `${evidenceBase} (${ans.city} has a single ZIP)` };
      }
      if (zs.length > 1) {
        return { zip: null, city: ans.city, state: claimedState, confidence: conf, source, evidence: `${evidenceBase} (city-level: ${ans.city} has ${zs.length} ZIPs)`, cityZips: zs.map((z) => z.zip) };
      }
    }
    return notSure(`Not confident — ${evidenceBase || "no location evidence found"}${zip ? ` [candidate ${zip}]` : ""}`);
  }

  // 3b. Street-level → verify the ZIP against the reference table + evidence.
  const info = (await zipInfo(zip)) ?? (listed?.has(zip) ? { zip, city: ans.city || "", state: claimedState, county: null, lat: 0, lng: 0 } : null);
  if (!info) return notSure(`Model returned ZIP ${zip}, which doesn't exist`);
  if (claimedState && claimedState !== info.state) { conf = "low"; notes.push(`state mismatch (${claimedState} vs ZIP's ${info.state})`); }
  if (ans.city && claimedState && info.lat) {
    const centre = await cityCentre(ans.city, claimedState);
    if (centre) {
      const d = milesBetween(centre, info);
      if (d > 15) { conf = "low"; notes.push(`ZIP is ${Math.round(d)} mi from ${ans.city}`); }
    }
  }
  // A different state than the lead's record, found only on the web (not in the
  // prospect's own words), is usually another branch of a multi-location
  // business — e.g. "Discount Apparel" resolved to Nashville TN on one lookup
  // and Hattiesburg MS on another. Send it to review rather than decide.
  if (crmState && crmState !== info.state) {
    if (source === "reply") { conf = minConf(conf, "medium"); notes.push(`lead data says ${crmState}`); }
    else { conf = "low"; notes.push(`web places it in ${info.state} but the lead's record says ${crmState} — possibly another branch`); }
  }

  const evidence = [evidenceBase, ans.street_address ? `[${ans.street_address}]` : "", notes.length ? `(${notes.join("; ")})` : ""].filter(Boolean).join(" ");
  if (conf === "low") return { ...notSure(`Not confident — ${evidence} [candidate ${zip}]`), source };
  // Show the address's own city (GeoNames names some ZIPs after a neighbour,
  // e.g. 33071 "Pompano Beach" for a Coral Springs address); it was checked to
  // be within 15 mi above.
  return { zip: info.zip, city: ans.city || info.city || null, state: info.state, confidence: conf, source, evidence };
}

/** Same answer for the audit's purposes: same ZIP, or the same city (city-level). */
function sameAnswer(a: ZipResolution, b: ZipResolution): boolean {
  if (a.zip || b.zip) return a.zip === b.zip;
  if (a.cityZips?.length || b.cityZips?.length) {
    return String(a.city).toLowerCase() === String(b.city).toLowerCase() && a.state === b.state;
  }
  return true; // both not confident
}

/**
 * resolveLeadZip, but an AI-derived answer is only accepted when a SECOND,
 * independent lookup agrees. On real leads a single lookup flipped between
 * different branches of multi-location businesses ~11% of the time; requiring
 * agreement turns those into "Needs review" instead of a wrong verdict.
 * A ZIP the prospect wrote out themselves is deterministic — no second lookup.
 */
export async function resolveLeadZipConfident(input: LeadLocationInput, listed?: Set<string>): Promise<ZipResolution> {
  const first = await resolveLeadZip(input, listed);
  if (first.source === "reply" && first.evidence.includes("written in the prospect's reply")) return first;
  if (!first.zip && !first.cityZips?.length) return first; // already "not confident"
  const second = await resolveLeadZip(input, listed);
  if (sameAnswer(first, second)) return first;
  const show = (r: ZipResolution) => r.zip ?? (r.cityZips?.length ? `${r.city}, ${r.state}` : "no confident answer");
  return {
    zip: null, city: null, state: null, confidence: "low", source: first.source,
    evidence: `Two independent lookups disagreed (${show(first)} vs ${show(second)}) — likely a multi-location business. ${first.evidence}`,
  };
}

// ── Audit ───────────────────────────────────────────────────────────────────
export type ZipVerdict = "Passed" | "Failed" | "Needs review" | "No ZIP list";
export interface ZipAuditResult {
  clientTag: string;
  verdict: ZipVerdict;
  reason: string;
  recommended: string[];          // CCG tags whose ZIP list contains the ZIP
  resolution: ZipResolution | null;
}

export async function auditCcgZip(clientTag: string, resolution: ZipResolution, idx?: CcgIndex): Promise<ZipAuditResult> {
  const tag = clientTag.trim().toUpperCase();
  const index = idx ?? (await loadCcgZipIndex());
  const own = index.zipsByTag.get(tag);
  if (!own) {
    return { clientTag: tag, verdict: "No ZIP list", recommended: [], resolution,
      reason: `${tag} has no ZIP codes in its Inclusion locations cell — add them to the Qualification sheet to enable the ZIP audit.` };
  }
  if (!resolution.zip && resolution.cityZips?.length) {
    // City known, exact ZIP not: decide only if the WHOLE city agrees.
    const all = resolution.cityZips;
    const place = `${resolution.city}, ${resolution.state}`;
    const inOwn = all.filter((z) => own.has(z));
    if (inOwn.length === all.length) {
      return { clientTag: tag, verdict: "Passed", recommended: [], resolution, reason: `Prospect is in ${place}; all ${all.length} of its ZIPs are in ${tag}'s ZIP list.` };
    }
    if (inOwn.length === 0) {
      const owners = [...index.zipsByTag.entries()].filter(([t, set]) => t !== tag && all.every((z) => set.has(z))).map(([t]) => t);
      return { clientTag: tag, verdict: "Failed", recommended: owners, resolution,
        reason: `Prospect is in ${place}; none of its ${all.length} ZIPs are in ${tag}'s ZIP list${owners.length ? ` — they belong to ${owners.join(" / ")}` : ""}.` };
    }
    return { clientTag: tag, verdict: "Needs review", recommended: [], resolution,
      reason: `Prospect is in ${place}, but only ${inOwn.length} of its ${all.length} ZIPs are in ${tag}'s list — the exact ZIP is needed. ${MANUAL_REVIEW_MESSAGE}` };
  }
  if (!resolution.zip) {
    return { clientTag: tag, verdict: "Needs review", recommended: [], resolution, reason: MANUAL_REVIEW_MESSAGE };
  }
  const z = resolution.zip;
  const where = `${resolution.city}, ${resolution.state}`;
  if (own.has(z)) {
    return { clientTag: tag, verdict: "Passed", recommended: [], resolution, reason: `ZIP ${z} (${where}) is in ${tag}'s ZIP list.` };
  }
  const owners = (index.tagsByZip.get(z) || []).filter((t) => t !== tag);
  return {
    clientTag: tag, verdict: "Failed", recommended: owners, resolution,
    reason: owners.length
      ? `ZIP ${z} (${where}) is not in ${tag}'s ZIP list — it belongs to ${owners.join(" / ")}.`
      : `ZIP ${z} (${where}) is not in ${tag}'s ZIP list, and no other active CCG client covers it.`,
  };
}

// ── Storage (Turso) ─────────────────────────────────────────────────────────
let tableReady: Promise<void> | null = null;
export function ensureZipAuditTable(): Promise<void> {
  if (!tableReady) {
    tableReady = db.execute(`CREATE TABLE IF NOT EXISTS zip_audit (
      reply_row_id INTEGER PRIMARY KEY, client_tag TEXT, zip TEXT, city TEXT, state TEXT,
      confidence TEXT, source TEXT, evidence TEXT, verdict TEXT, reason TEXT,
      recommended_tags TEXT, audited_at TEXT, city_zips TEXT
    )`)
      .then(() => db.execute("ALTER TABLE zip_audit ADD COLUMN city_zips TEXT").catch(() => undefined)) // older table
      .then(() => undefined).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

export async function saveZipAudit(replyRowId: number, r: ZipAuditResult): Promise<void> {
  await ensureZipAuditTable();
  const res = r.resolution;
  await db.execute({
    sql: `INSERT OR REPLACE INTO zip_audit (reply_row_id, client_tag, zip, city, state, confidence, source, evidence, verdict, reason, recommended_tags, audited_at, city_zips)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [replyRowId, r.clientTag, res?.zip ?? null, res?.city ?? null, res?.state ?? null, res?.confidence ?? null,
      res?.source ?? null, res?.evidence ?? null, r.verdict, r.reason, JSON.stringify(r.recommended), new Date().toISOString(),
      res?.cityZips?.length ? JSON.stringify(res.cityZips) : null],
  });
}

export async function getZipAudit(replyRowId: number): Promise<(ZipAuditResult & { auditedAt: string }) | null> {
  await ensureZipAuditTable();
  const q = await db.execute({ sql: "SELECT * FROM zip_audit WHERE reply_row_id = ?", args: [replyRowId] });
  const row = q.rows[0] as unknown as Record<string, string | null> | undefined;
  if (!row) return null;
  return {
    clientTag: String(row.client_tag), verdict: row.verdict as ZipVerdict, reason: String(row.reason ?? ""),
    recommended: JSON.parse(String(row.recommended_tags || "[]")),
    resolution: { zip: row.zip, city: row.city, state: row.state, confidence: (row.confidence || "low") as ZipConfidence,
      source: (row.source || "none") as ZipResolution["source"], evidence: String(row.evidence ?? ""),
      cityZips: row.city_zips ? JSON.parse(String(row.city_zips)) : undefined },
    auditedAt: String(row.audited_at),
  };
}

/** Resolve + audit + store for one reply row. No-op (null) for non-CCG tags. */
export async function runCcgZipAudit(replyRowId: number, clientTag: string, input: LeadLocationInput): Promise<ZipAuditResult | null> {
  if (!isCcgTag(clientTag)) return null;
  // The client's own staff on the thread (e.g. @corporatecleaninggroup.com) isn't a prospect.
  if (String(input.leadEmail ?? "").toLowerCase().endsWith(`@${SENDER_BRAND.domain}`)) return null;
  const idx = await loadCcgZipIndex();
  const tag = clientTag.trim().toUpperCase();
  // No ZIP list → nothing to check against; skip the (paid) lookup entirely.
  const resolution = idx.zipsByTag.has(tag) ? await resolveLeadZipConfident(input, new Set(idx.tagsByZip.keys()))
    : { zip: null, city: null, state: null, confidence: "low" as const, source: "none" as const, evidence: "" };
  const result = await auditCcgZip(tag, resolution, idx);
  await saveZipAudit(replyRowId, result);
  return result;
}
