/**
 * POST /api/costing/manual — costs for tools no product reports, added by hand. Admin-only.
 *   { action: "save", id?, date, category, vendor, description?, billing_type, amount, currency,
 *     status, invoice_id?, invoice_url?, plan?, interval?, service_from?, service_to?, client? }
 *   { action: "delete", id }
 * Each entry goes through the same checks as a product feed (exact decimal string, etc.).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { checkFeed } from "@/lib/costing/validate";
import { saveManualItem, deleteManualItem } from "@/lib/costing/store";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const b = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!b) return bad("Missing body.");
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  try {
    if (b.action === "delete") {
      if (!s("id").startsWith("manual:")) return bad("Only costs added by hand can be deleted here.");
      return (await deleteManualItem(s("id"))) ? NextResponse.json({ ok: true }) : bad("That cost no longer exists.", 404);
    }
    if (b.action !== "save") return bad("Unknown action.");
    const amount = s("amount").replace(/,/g, "");
    const item: Record<string, unknown> = {
      id: s("id") || "new", date: s("date"), category: s("category"), vendor: s("vendor").toLowerCase(),
      billing_type: s("billing_type"), amount, currency: s("currency").toUpperCase(),
      source: "invoice", status: s("status") === "pending" ? "pending" : "final",
      invoice: { id: s("invoice_id") || "entered-by-hand", ...(s("invoice_url") ? { url: s("invoice_url") } : {}) },
    };
    if (s("description")) item.description = s("description");
    if (item.category === "ai") item.model = s("model") || "unspecified";
    if (s("billing_type") === "subscription") {
      item.subscription = { plan: s("plan") || "Plan", interval: s("interval") === "year" ? "year" : "month", service_from: s("service_from") || s("date"), service_to: s("service_to") || s("date") };
    }
    if (s("client")) item.allocations = [{ dimension: "client", key: s("client").toUpperCase(), amount }];
    const date = s("date");
    const check = checkFeed({
      schema_version: "1.0", product: { id: "added-by-hand", name: "Added by hand" }, period: { from: date, to: date },
      generated_at: new Date().toISOString(), totals: [{ currency: item.currency, amount }], line_items: [item],
    }, { from: date, to: date, slug: null });
    if (!check.ok) return bad(check.errors.map((e) => e.replace(/^line_items\[0\](?: \([^)]*\))?: /, "")).join(" · "));
    const id = await saveManualItem(check.feed.items[0], s("id").startsWith("manual:") ? s("id") : null);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return bad((e as Error).message, 500);
  }
}
