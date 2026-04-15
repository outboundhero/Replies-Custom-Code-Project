import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import db from "@/lib/db";
import supabase from "@/lib/supabase";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    // Get all client tags with their sections from Turso
    const sections = await db.execute("SELECT * FROM sections ORDER BY id");
    const tags = await db.execute("SELECT * FROM client_tags ORDER BY tag");

    // Get qualification data from Supabase
    const { data: statuses } = await supabase.from("client_status").select("*");
    const { data: qualifications } = await supabase.from("client_qualifications").select("*");

    const statusMap = new Map((statuses || []).map((s) => [s.client_abbreviation, s]));
    const qualMap = new Map((qualifications || []).map((q) => [q.client_abbreviation, q]));

    // Build merged response grouped by section
    const tagsBySection = new Map<number, Array<{
      tag: string;
      status: string;
      exclusion_industries: string;
      inclusion_locations: string;
      synced_at: string | null;
    }>>();

    for (const t of tags.rows) {
      const sectionId = t.section_id as number;
      const tag = t.tag as string;
      const status = statusMap.get(tag);
      const qual = qualMap.get(tag);

      if (!tagsBySection.has(sectionId)) tagsBySection.set(sectionId, []);
      tagsBySection.get(sectionId)!.push({
        tag,
        status: status?.status || "Unknown",
        exclusion_industries: qual?.exclusion_industries || "",
        inclusion_locations: qual?.inclusion_locations || "",
        synced_at: qual?.synced_at || status?.synced_at || null,
      });
    }

    const result = sections.rows.map((s) => ({
      id: s.id,
      name: s.name,
      airtable_base_id: s.airtable_base_id,
      clients: tagsBySection.get(s.id as number) || [],
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/config/qualification] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch qualification config" }, { status: 500 });
  }
}
