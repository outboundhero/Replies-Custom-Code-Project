/**
 * Presence identity: maps a signed-in user's email → { name, color } for the
 * real-time "who's viewing this lead" indicators in the inbox.
 *
 * The four named teammates get their explicitly-requested colors; every OTHER
 * account still gets a stable, distinct color (deterministic from the email) so
 * anyone viewing a lead is always visible. Pure/browser-safe — no server deps.
 */

export interface PresenceProfile {
  name: string;
  color: string; // hex
}

// Reserved colors for the four named teammates — do NOT reuse these in the
// auto-assigned fallback palette, so a named user's color is unmistakable.
const RED = "#ef4444";
const PINK = "#ec4899";
const GREEN = "#22c55e";
const BLUE = "#3b82f6";

/**
 * Explicit email → profile map for the named teammates.
 * Jhimmie / Angie are the two `awojobi…@gmail.com` accounts — best-guess
 * mapping (Olujimi→Jhimmie=Green, Anjola→Angie=Blue). If they turn out
 * reversed, swap the two colors on these two lines and nothing else changes.
 */
const PRESENCE_PROFILES: Record<string, PresenceProfile> = {
  "spencer@outboundhero.co": { name: "Spencer", color: RED },
  "madison@outboundhero.co": { name: "Madison", color: PINK },
  "awojobiolujimi@gmail.com": { name: "Jhimmie", color: GREEN },
  "awojobianjola@gmail.com": { name: "Angie", color: BLUE },
};

// Distinct fallback palette for everyone else. Deliberately excludes the four
// reserved hues above so named users never collide with auto-assigned ones.
const FALLBACK_PALETTE = [
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#f97316", // orange
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#84cc16", // lime
  "#e11d48", // rose
  "#0ea5e9", // sky
  "#d946ef", // fuchsia
];

// Stable string hash (djb2) → palette index. Deterministic across sessions and
// machines so the same account always gets the same color for everyone.
function hashEmail(email: string): number {
  let h = 5381;
  for (let i = 0; i < email.length; i++) h = ((h << 5) + h + email.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function titleCaseLocalPart(email: string): string {
  const local = (email.split("@")[0] || email).replace(/[._-]+/g, " ").trim();
  if (!local) return email;
  return local
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function getPresenceProfile(email: string | null | undefined): PresenceProfile {
  const key = (email || "").trim().toLowerCase();
  if (key && PRESENCE_PROFILES[key]) return PRESENCE_PROFILES[key];
  if (!key) return { name: "Someone", color: FALLBACK_PALETTE[0] };
  return {
    name: titleCaseLocalPart(key),
    color: FALLBACK_PALETTE[hashEmail(key) % FALLBACK_PALETTE.length],
  };
}
