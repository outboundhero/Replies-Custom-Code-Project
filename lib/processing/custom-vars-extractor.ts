import type { ExtractedCustomVars } from "@/lib/types";

/**
 * Extract custom variables from lead.custom_variables object.
 * The object has numeric string keys with {name, value} entries.
 */
export function extractCustomVars(
  customVars: Record<string, { name: string; value: string }> | undefined
): ExtractedCustomVars {
  const result: ExtractedCustomVars = {
    phone: "",
    linkedin: "",
    city: "",
    state: "",
    google_maps_url: "",
    address: "",
  };

  if (!customVars) return result;

  for (const key in customVars) {
    const { name, value } = customVars[key] || {};
    if (!name) continue;

    const nameLower = name.toLowerCase();
    // Junk scraped values (e.g. "there") aren't phone numbers — a real one has
    // at least 7 digits. Keeps them out of the Phone field, sheets and {PHONE}.
    if (nameLower === "company phone") result.phone = (value || "").replace(/\D/g, "").length >= 7 ? value : "";
    if (nameLower === "linkedin url") result.linkedin = value || "";
    if (nameLower === "city") result.city = value || "";
    if (nameLower === "state") result.state = value || "";
    if (nameLower === "google maps url") result.google_maps_url = value || "";
    if (nameLower === "address") result.address = value || "";
  }

  return result;
}
