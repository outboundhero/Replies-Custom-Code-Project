import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import supabase from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const mode = req.nextUrl.searchParams.get("mode"); // "counts" or default (leads)
    const clientTag = req.nextUrl.searchParams.get("client_tag");
    const category = req.nextUrl.searchParams.get("category");
    const workflow = req.nextUrl.searchParams.get("workflow");
    const search = req.nextUrl.searchParams.get("search");

    // Mode: client_tags — return distinct client tags for the filter dropdown
    if (mode === "client_tags") {
      const { data, error } = await supabase
        .from("replies")
        .select("client_tag");
      if (error) throw new Error(error.message);
      const tags = [...new Set((data || []).map((r) => r.client_tag).filter(Boolean))].sort();
      return NextResponse.json({ tags });
    }

    // Mode: counts — return category counts only (lightweight)
    if (mode === "counts") {
      let query = supabase
        .from("replies")
        .select("lead_category");

      if (clientTag) query = query.eq("client_tag", clientTag);
      if (workflow) query = query.eq("workflow", workflow);
      if (search) query = query.or(`lead_email.ilike.%${search}%,company_name.ilike.%${search}%,lead_name.ilike.%${search}%`);

      const { data, error } = await query;
      if (error) throw new Error(error.message);

      // Count by category
      const counts: Record<string, number> = {};
      let total = 0;
      for (const row of data || []) {
        const cat = row.lead_category || "Open Response";
        counts[cat] = (counts[cat] || 0) + 1;
        total++;
      }
      return NextResponse.json({ counts, total });
    }

    // Default mode: fetch leads for a specific category (or all if none specified)
    let query = supabase
      .from("replies")
      .select("id, workflow, lead_email, lead_name, company_name, client_tag, ai_categorized_lead_category, lead_category, reply_status, industry_audit, location_audit, created_at, reply_id")
      .order("created_at", { ascending: false });

    if (clientTag) query = query.eq("client_tag", clientTag);
    if (category) query = query.eq("lead_category", category);
    if (workflow) query = query.eq("workflow", workflow);
    if (search) query = query.or(`lead_email.ilike.%${search}%,company_name.ilike.%${search}%,lead_name.ilike.%${search}%`);

    // Supabase default limit is 1000 — use range for larger sets
    query = query.range(0, 4999);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return NextResponse.json({ replies: data || [] });
  } catch (error) {
    console.error("[api/inbox] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch inbox" }, { status: 500 });
  }
}
