/**
 * POST /api/costing/products — manage the products Reply Router pulls costs from. Admin-only.
 *   { action: "test",   baseUrl, apiKey, pid? }   check a feed (last 35 days) without saving anything
 *   { action: "add",    name, baseUrl, apiKey }   save it, then pull it straight away
 *   { action: "update", pid, name?, baseUrl?, apiKey? }
 *   { action: "pause" | "resume", pid }
 *   { action: "delete", pid }                     only a product that has never stored a figure
 * Keys are stored encrypted and never sent back — only their last four characters.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { sealKey, keyHint, openKey } from "@/lib/costing/secret";
import { cleanBaseUrl, pullProduct, testFeed } from "@/lib/costing/pull";
import { addProduct, updateProduct, deleteProductIfEmpty, getProductWithKey, ensureCostingTables } from "@/lib/costing/store";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") return bad("Missing action.");
  await ensureCostingTables();
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  try {
    switch (body.action) {
      case "test": {
        let key = s("apiKey");
        let slug: string | null = null;
        if (s("pid")) {
          const p = await getProductWithKey(s("pid"));
          if (!p) return bad("No such product.", 404);
          slug = p.slug;
          if (!key && p.key_sealed) key = openKey(p.key_sealed);
        }
        if (!s("baseUrl") || !key) return bad("Enter the URL and the key.");
        return NextResponse.json(await testFeed(s("baseUrl"), key, slug));
      }
      case "add": {
        const url = cleanBaseUrl(s("baseUrl"));
        if (!url.ok) return bad(url.error);
        if (!s("apiKey")) return bad("Enter the product's costing key.");
        const pid = await addProduct({ name: s("name") || new URL(url.url).hostname, baseUrl: url.url, keySealed: sealKey(s("apiKey")), keyHint: keyHint(s("apiKey")) });
        const pull = await pullProduct(pid, { trigger: "added" });
        return NextResponse.json({ ok: true, pid, pull });
      }
      case "update": {
        const p = await getProductWithKey(s("pid"));
        if (!p || p.kind !== "feed") return bad("No such product.", 404);
        const patch: Parameters<typeof updateProduct>[1] = {};
        if (s("name")) patch.name = s("name");
        if (s("baseUrl")) { const u = cleanBaseUrl(s("baseUrl")); if (!u.ok) return bad(u.error); patch.baseUrl = u.url; }
        if (s("apiKey")) { patch.keySealed = sealKey(s("apiKey")); patch.keyHint = keyHint(s("apiKey")); }
        await updateProduct(p.pid, patch);
        return NextResponse.json({ ok: true });
      }
      case "pause":
      case "resume": {
        const p = await getProductWithKey(s("pid"));
        if (!p || p.kind !== "feed") return bad("No such product.", 404);
        await updateProduct(p.pid, { enabled: body.action === "resume" });
        return NextResponse.json({ ok: true });
      }
      case "delete": {
        const p = await getProductWithKey(s("pid"));
        if (!p || p.kind !== "feed") return bad("No such product.", 404);
        const done = await deleteProductIfEmpty(p.pid);
        if (!done) return bad("This product has stored figures, which are kept permanently — pause it instead.", 409);
        return NextResponse.json({ ok: true });
      }
      default:
        return bad("Unknown action.");
    }
  } catch (e) {
    console.error("[costing/products]", e);
    return bad((e as Error).message, 500);
  }
}
