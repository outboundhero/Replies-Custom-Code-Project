/**
 * GET /api/onboarding/template — the standard onboarding task template (the rows
 * the Template editor manages and that new clients clone from). Auto-seeds the
 * default template on first read so the editor is never empty.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { withCache, setCached, nsVersion } from "@/lib/server-cache";
import { listTemplate, seedDefaultTemplate } from "@/lib/onboarding/store";

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const key = `onboarding:template:v${nsVersion("onboarding")}`;
    // ?fresh=1 — the editor reloading after its own save (see GET /api/onboarding).
    if (req.nextUrl.searchParams.get("fresh") === "1") {
      const data = await listTemplate();
      setCached(key, data);
      return NextResponse.json(data);
    }
    const data = await withCache(key, 30_000, async () => {
      await seedDefaultTemplate(); // no-op once seeded
      return listTemplate();
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/onboarding/template] GET failed:", error);
    return NextResponse.json({ error: "Failed to load template" }, { status: 500 });
  }
}
