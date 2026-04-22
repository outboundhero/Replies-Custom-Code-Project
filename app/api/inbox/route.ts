import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { getView, type InboxView } from "@/lib/inbox-views";

const BATCH_SIZE = 1000;

/** Fetch ALL rows for a lightweight column query by paginating through batches */
async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => ReturnType<typeof supabase.from>,
): Promise<T[]> {
  const allRows: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await (buildQuery(offset, offset + BATCH_SIZE - 1) as any);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return allRows;
}

/** Apply a view's filter rules to a Supabase query builder */
function applyView(q: any, view: InboxView | null): any {
  if (!view) return q;

  // "Does not contain" filters — use NOT ILIKE
  for (const term of view.replyExcludes || []) {
    q = q.not("reply_we_got", "ilike", `%${term}%`);
  }
  for (const term of view.leadEmailExcludes || []) {
    q = q.not("lead_email", "ilike", `%${term}%`);
  }
  for (const term of view.toEmailExcludes || []) {
    q = q.not("to_email", "ilike", `%${term}%`);
  }
  for (const term of view.emailSubjectExcludes || []) {
    q = q.not("email_subject", "ilike", `%${term}%`);
  }

  // AI category OR group — must match at least one
  if (view.aiCategoryAny && view.aiCategoryAny.length > 0) {
    const orParts = view.aiCategoryAny.map((rule) => {
      if (rule.equals !== undefined) return `ai_categorized_lead_category.eq.${rule.equals}`;
      if (rule.contains !== undefined) return `ai_categorized_lead_category.ilike.%${rule.contains}%`;
      return null;
    }).filter(Boolean).join(",");
    if (orParts) q = q.or(orParts);
  }

  return q;
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const mode = req.nextUrl.searchParams.get("mode");
    const clientTag = req.nextUrl.searchParams.get("client_tag");
    const category = req.nextUrl.searchParams.get("category");
    const workflow = req.nextUrl.searchParams.get("workflow");
    const search = req.nextUrl.searchParams.get("search");
    const view = getView(req.nextUrl.searchParams.get("view"));

    // Mode: client_tags — return distinct client tags
    if (mode === "client_tags") {
      const data = await fetchAllRows<{ client_tag: string }>((from, to) => {
        let q = supabase.from("replies").select("client_tag").range(from, to);
        return q as any;
      });
      const tags = [...new Set(data.map((r) => r.client_tag).filter(Boolean))].sort();
      return NextResponse.json({ tags });
    }

    // Mode: counts — return category counts (paginate to get ALL rows)
    if (mode === "counts") {
      const data = await fetchAllRows<{ lead_category: string }>((from, to) => {
        let q = supabase.from("replies").select("lead_category").range(from, to);
        if (clientTag) q = q.eq("client_tag", clientTag);
        if (workflow) q = q.eq("workflow", workflow);
        if (search) q = q.or(`lead_email.ilike.%${search}%,company_name.ilike.%${search}%,lead_name.ilike.%${search}%`);
        q = applyView(q, view);
        return q as any;
      });

      const counts: Record<string, number> = {};
      let total = 0;
      for (const row of data) {
        const cat = row.lead_category || "Open Response";
        counts[cat] = (counts[cat] || 0) + 1;
        total++;
      }
      return NextResponse.json({ counts, total });
    }

    // Default mode: fetch leads for a specific category
    const data = await fetchAllRows<Record<string, unknown>>((from, to) => {
      let q = supabase
        .from("replies")
        .select("id, workflow, lead_email, lead_name, company_name, client_tag, ai_categorized_lead_category, lead_category, reply_status, industry_audit, location_audit, created_at, reply_id")
        .order("created_at", { ascending: false })
        .range(from, to);
      if (clientTag) q = q.eq("client_tag", clientTag);
      if (category) q = q.eq("lead_category", category);
      if (workflow) q = q.eq("workflow", workflow);
      if (search) q = q.or(`lead_email.ilike.%${search}%,company_name.ilike.%${search}%,lead_name.ilike.%${search}%`);
      q = applyView(q, view);
      return q as any;
    });

    return NextResponse.json({ replies: data });
  } catch (error) {
    console.error("[api/inbox] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch inbox" }, { status: 500 });
  }
}
