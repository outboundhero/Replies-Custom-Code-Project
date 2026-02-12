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
    if (nameLower === "company phone") result.phone = value || "";
    if (nameLower === "linkedin url") result.linkedin = value || "";
    if (name === "City") result.city = value || "";
    if (name === "State") result.state = value || "";
    if (nameLower === "google maps url") result.google_maps_url = value || "";
    if (nameLower === "address") result.address = value || "";
  }

  return result;
}
