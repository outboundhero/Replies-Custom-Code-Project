/**
 * Airtable Automation script — push a marked lead to GoHighLevel.
 *
 * NOT part of the app build. Paste this into an Airtable Automation in EACH
 * client base (JPPS, JPKC), after setting GHL_TOKEN + GHL_LOCATION_ID below.
 *
 * ── Automation setup ────────────────────────────────────────────────────────
 * 1. Trigger: "When a record matches conditions"
 *      Table: Master Inbox (Table)
 *      Condition: "Lead Category" is any of →
 *        Interested, Meeting-Ready Lead, Follow Up, Referral Given,
 *        Not Interested, Not Interested (Send Reply)
 * 2. Action: "Run a script". In the script's left "Input variables" panel add
 *    (name → field from the trigger record):
 *      leadEmail    → Lead Email
 *      firstName    → First Name
 *      lastName     → Last Name
 *      leadName     → Lead Name
 *      companyName  → Company Name
 *      phone        → Phone
 *      enrichedPhone→ Enriched Phone Number   (optional fallback phone)
 *      city         → City
 *      state        → State
 *      address      → Address
 *      leadCategory → Lead Category
 * 3. Paste this script; set the two constants below to THIS base's GHL creds.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ── Set per base (JPPS vs JPKC) ──
const GHL_TOKEN = "PASTE_THIS_BASE_GHL_PRIVATE_INTEGRATION_TOKEN"; // e.g. pit-xxxxxxxx
const GHL_LOCATION_ID = "PASTE_THIS_BASE_GHL_LOCATION_ID";

const PUSH_CATEGORIES = [
  "Interested", "Meeting-Ready Lead", "Follow Up",
  "Referral Given", "Not Interested", "Not Interested (Send Reply)",
];

function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith("+")) {
    const d = s.slice(1).replace(/\D/g, "");
    return d.length >= 8 && d.length <= 15 ? "+" + d : null;
  }
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null; // ambiguous → omit (contact still created)
}

const cfg = input.config();

// Defensive: only push the configured categories (in case the trigger widens).
const category = String(cfg.leadCategory || "").trim();
if (!PUSH_CATEGORIES.some((c) => c.toLowerCase() === category.toLowerCase())) {
  console.log("Lead Category '" + category + "' is not a push category — skipping.");
  return;
}

const email = String(cfg.leadEmail || "").trim();
if (!email) { console.log("No email on record — skipping."); return; }

let firstName = String(cfg.firstName || "").trim();
let lastName = String(cfg.lastName || "").trim();
if (!firstName && !lastName && cfg.leadName) {
  const parts = String(cfg.leadName).trim().split(/\s+/);
  firstName = parts[0] || "";
  lastName = parts.slice(1).join(" ");
}

const tags = ["OutboundHero"];
if (category) tags.unshift(category);

const body = { locationId: GHL_LOCATION_ID, email, source: "OutboundHero", tags };
if (firstName) body.firstName = firstName;
if (lastName) body.lastName = lastName;
const phone = normalizePhone(cfg.phone) || normalizePhone(cfg.enrichedPhone);
if (phone) body.phone = phone;
if (cfg.companyName) body.companyName = String(cfg.companyName);
if (cfg.address) body.address1 = String(cfg.address);
if (cfg.city) body.city = String(cfg.city);
if (cfg.state) body.state = String(cfg.state);

const res = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + GHL_TOKEN.trim(),
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify(body),
});

const out = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log("GHL upsert FAILED " + res.status + ": " + JSON.stringify(out));
  throw new Error("GHL upsert failed (" + res.status + ")");
}
console.log("GHL upsert OK " + res.status + " · contactId=" + (out.contact && out.contact.id) + " · " + email);
