/**
 * GET /api/cron/bison-probe?secret=X&instance=outboundhero&q=test@example.com
 *
 * Diagnostic: calls Bison's /api/leads search endpoint directly and returns
 * the RAW response — status, rate-limit headers, timing, body snippet — so we
 * can see exactly what Bison is returning (e.g. a 429 with Retry-After).
 */
import { NextRequest, NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/bison-instances";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instance = req.nextUrl.searchParams.get("instance") || "outboundhero";
  const q = req.nextUrl.searchParams.get("q") || "test@example.com";

  let baseUrl: string, token: string;
  try { ({ baseUrl, token } = getInstanceConfig(instance)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const url = `${baseUrl}/api/leads?search=${encodeURIComponent(q)}&per_page=10`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    const ms = Date.now() - t0;
    const headers: Record<string, string> = {};
    for (const [k, v] of res.headers.entries()) {
      if (/ratelimit|retry-after|x-ratelimit|throttle|x-request/i.test(k)) headers[k] = v;
    }
    const body = (await res.text()).slice(0, 600);
    return NextResponse.json({
      instance, url: url.replace(token, "***"),
      status: res.status, statusText: res.statusText, ms,
      rateLimitHeaders: headers,
      bodySnippet: body,
    });
  } catch (e) {
    return NextResponse.json({ instance, error: (e as Error).message, ms: Date.now() - t0 }, { status: 502 });
  }
}
