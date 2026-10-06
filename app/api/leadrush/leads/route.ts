import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import supabase from "@/lib/supabase";
import { LEADRUSH_TAGS, LEAD_COLUMNS, toLeadRushLead, getCategoryHistory } from "@/lib/leadrush";

/**
 * LeadRush lead lookup API — read-only, limited to the OH / DM4PM / UJ clients.
 *
 * Auth: `Authorization: Bearer <LEADRUSH_API_KEY>` or `x-api-key: <LEADRUSH_API_KEY>`
 * (its own key — not the notify secret, not CRON_SECRET).
 *
 *   GET ?id=12345                         one lead by reply_router_lead_id
 *   GET ?email=jane@acme.com[&client=OH]  latest lead for that email (&all=true → every match)
 *   GET ?since=2026-10-01[&until=…]       leads whose reply arrived since a date
 *       [&client=OH,DM4PM][&category=Interested,Meeting Set]
 *       [&updated_since=…]                …or leads changed (e.g. re-categorized) since a date
 *       [&limit=100 (max 200)][&offset=0]
 *
 * Each lead: reply_router_lead_id, client, category, name, email, phone, company,
 * reply_snippet, reply_time, campaign, city, state, address, reply_router_url,
 * ai_category, archived, categorized_at, category_history.
 */

const MAX_LIMIT = 200;

function authorized(req: NextRequest): boolean {
  const key = process.env.LEADRUSH_API_KEY?.trim();
  if (!key) return false;
  const given = (req.headers.get("x-api-key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")).trim();
  const a = Buffer.from(given), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseList(v: string | null): string[] {
  return (v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function parseDate(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function shape(rows: Record<string, unknown>[]) {
  const history = await getCategoryHistory(rows.map((r) => Number(r.id)));
  return rows.map((r) => {
    const id = Number(r.id);
    const recorded = history.get(id) || [];
    return {
      ...toLeadRushLead(r),
      ai_category: (r.ai_categorized_lead_category as string | null) ?? null,
      archived: !!r.archived,
      categorized_at: (r.categorized_at as string | null) ?? null,
      // Recorded changes (kept from 2026-10-06 on). Older leads with no recorded
      // change show their current category as a single entry.
      category_history: recorded.length
        ? recorded
        : [{ category: String(r.lead_category || "Open Response"), changed_at: (r.categorized_at as string) || (r.created_at as string) || null, changed_by: null, source: "current" }],
    };
  });
}

export async function GET(req: NextRequest) {
  if (!process.env.LEADRUSH_API_KEY?.trim()) {
    return NextResponse.json({ error: "LeadRush API is not configured yet." }, { status: 503 });
  }
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const allowed = LEADRUSH_TAGS as readonly string[];
  const clients = parseList(sp.get("client")).map((c) => c.toUpperCase());
  const bad = clients.filter((c) => !allowed.includes(c));
  if (bad.length) return NextResponse.json({ error: `Unknown client: ${bad.join(", ")}. Allowed: ${allowed.join(", ")}` }, { status: 400 });
  const tags = clients.length ? clients : [...allowed];

  try {
    // 1. One lead by Reply Router id.
    const idParam = sp.get("id") || sp.get("reply_router_lead_id");
    if (idParam) {
      const id = Number(idParam);
      if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
      const { data, error } = await supabase.from("replies").select(LEAD_COLUMNS).eq("id", id).in("client_tag", tags).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
      return NextResponse.json({ lead: (await shape([data as Record<string, unknown>]))[0] });
    }

    // 2. By email — latest (default) or every match.
    const email = sp.get("email")?.trim();
    if (email) {
      const all = /^(1|true|yes)$/i.test(sp.get("all") || "");
      const { data, error } = await supabase.from("replies").select(LEAD_COLUMNS)
        .ilike("lead_email", email.replace(/[%_]/g, "\\$&")).in("client_tag", tags)
        .order("reply_time", { ascending: false, nullsFirst: false }).limit(all ? MAX_LIMIT : 1);
      if (error) throw new Error(error.message);
      const leads = await shape((data || []) as Record<string, unknown>[]);
      if (!all) return leads[0] ? NextResponse.json({ lead: leads[0] }) : NextResponse.json({ error: "Lead not found" }, { status: 404 });
      return NextResponse.json({ leads, count: leads.length });
    }

    // 3. List since a date.
    const since = parseDate(sp.get("since"));
    const updatedSince = parseDate(sp.get("updated_since"));
    if (!since && !updatedSince) {
      return NextResponse.json({ error: "Pass id, email, since or updated_since." }, { status: 400 });
    }
    const until = parseDate(sp.get("until"));
    const categories = parseList(sp.get("category"));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || 100));
    const offset = Math.max(0, Number(sp.get("offset")) || 0);
    const dateCol = updatedSince ? "updated_at" : "reply_time";

    let q = supabase.from("replies").select(LEAD_COLUMNS).in("client_tag", tags).gte(dateCol, (updatedSince || since)!);
    if (until) q = q.lt(dateCol, until);
    if (categories.length) q = q.in("lead_category", categories);
    const { data, error } = await q.order(dateCol, { ascending: true }).order("id", { ascending: true }).range(offset, offset + limit); // one extra → hasMore
    if (error) throw new Error(error.message);
    const rows = (data || []) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const leads = await shape(rows.slice(0, limit));
    return NextResponse.json({ leads, count: leads.length, next_offset: hasMore ? offset + limit : null });
  } catch (e) {
    console.error("[api/leadrush/leads]", e);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
}
