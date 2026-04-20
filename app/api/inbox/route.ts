import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import supabase from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const page = Number(req.nextUrl.searchParams.get("page") || "1");
    const limit = Number(req.nextUrl.searchParams.get("limit") || "50");
    const clientTag = req.nextUrl.searchParams.get("client_tag");
    const category = req.nextUrl.searchParams.get("category");
    const workflow = req.nextUrl.searchParams.get("workflow");
    const search = req.nextUrl.searchParams.get("search");

    let query = supabase
      .from("replies")
      .select("id, workflow, lead_email, lead_name, company_name, client_tag, ai_categorized_lead_category, lead_category, reply_status, industry_audit, location_audit, created_at, reply_id", { count: "exact" })
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (clientTag) query = query.eq("client_tag", clientTag);
    if (category) query = query.eq("lead_category", category);
    if (workflow) query = query.eq("workflow", workflow);
    if (search) query = query.or(`lead_email.ilike.%${search}%,company_name.ilike.%${search}%,lead_name.ilike.%${search}%`);

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);

    return NextResponse.json({ replies: data, total: count, page, limit });
  } catch (error) {
    console.error("[api/inbox] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch inbox" }, { status: 500 });
  }
}
