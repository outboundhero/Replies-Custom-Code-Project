/**
 * GET /api/nurture/tags-matching?email=&web= — which client tags' queues hold a
 * contact whose email / website ends with the text. Free-text fallback for the
 * overview filter, run only when the user presses Enter (plain domain endings
 * like ".in" and personal domains like "gmail.com" are answered instantly from
 * the cached per-tag catalogs on the page instead).
 *
 * It scans every pending queue row, so it's guarded: results are cached for
 * 15 min, identical requests share one query, and it holds the system-wide
 * heavy-query lease (one heavy Nurture query at a time anywhere — a search while
 * another is running gets a polite 429).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { activeClientTags } from "@/lib/nurture/overview";
import { acquireHeavyLease, releaseHeavyLease, leaseHolder } from "@/lib/nurture/heavy-lease";

export const dynamic = "force-dynamic";
export const maxDuration = 130;

const TTL_MS = 15 * 60_000;
const cache = new Map<string, { at: number; tags: Record<string, number> }>();
const inflight = new Map<string, Promise<Record<string, number>>>();

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const clean = (v: string | null) => (v || "").replace(/[%_\\]/g, "").trim().toLowerCase().slice(0, 80) || null;
  const email = clean(req.nextUrl.searchParams.get("email"));
  const web = clean(req.nextUrl.searchParams.get("web"));
  if (!email && !web) return NextResponse.json({ tags: {} });
  // Too short to be meaningful — would match nearly everything at full cost.
  if ((email && email.length < 3) || (web && web.length < 3)) {
    return NextResponse.json({ error: "Type at least 3 characters." }, { status: 400 });
  }
  const key = `${email ?? ""}|${web ?? ""}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json({ tags: hit.tags, cached: true });

  let p = inflight.get(key);
  if (!p) {
    if (inflight.size > 0) {
      return NextResponse.json({ error: "Another queue search is still running — try again in a moment." }, { status: 429 });
    }
    const holder = leaseHolder("tags-matching");
    if (!(await acquireHeavyLease(holder, 150_000))) {
      return NextResponse.json({ error: "Another heavy queue job is running — try again in a minute." }, { status: 429 });
    }
    p = (async () => {
      const { tags } = await activeClientTags();
      const { data, error } = await supabase.rpc("nurture_tags_with_suffix", { p_email_suffix: email, p_web_suffix: web, p_tags: tags });
      if (error) throw new Error(error.message);
      const out: Record<string, number> = {};
      for (const r of (data || []) as Array<{ client_tag: string; n: number }>) out[r.client_tag] = Number(r.n);
      cache.set(key, { at: Date.now(), tags: out });
      return out;
    })().finally(() => { inflight.delete(key); void releaseHeavyLease(holder).catch(() => {}); });
    inflight.set(key, p);
  }
  try {
    return NextResponse.json({ tags: await p });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
