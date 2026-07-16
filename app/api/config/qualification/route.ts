import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { withCache, nsVersion } from "@/lib/server-cache";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const result = await withCache(`config:qualification:v${nsVersion("config")}`, 60_000, async () => {
    // Two Turso reads + two Supabase reads, all independent → run concurrently
    // (was 4 sequential round trips across two backends). Project only the
    // columns the merge uses instead of select("*").
    const [sections, tags, statusRes, qualRes] = await Promise.all([
      db.execute("SELECT id, name, airtable_base_id FROM sections ORDER BY id"),
      db.execute("SELECT tag, section_id FROM client_tags ORDER BY tag"),
      supabase.from("client_status").select("client_abbreviation, status, synced_at"),
      supabase.from("client_qualifications").select("client_abbreviation, exclusion_industries, inclusion_locations, synced_at"),
    ]);
    const statuses = statusRes.data;
    const qualifications = qualRes.data;

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

    return sections.rows.map((s) => ({
      id: s.id,
      name: s.name,
      airtable_base_id: s.airtable_base_id,
      clients: tagsBySection.get(s.id as number) || [],
    }));
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/config/qualification] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch qualification config" }, { status: 500 });
  }
}
