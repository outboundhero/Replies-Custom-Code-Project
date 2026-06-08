/**
 * GET /api/cron/bison-token-probe
 *
 * Diagnostic-only. Calls /api/campaigns?per_page=1 against every Bison
 * instance using whatever tokens production currently has loaded. Returns:
 *
 *   - token prefix (first 6 chars only — never the full secret)
 *   - token length (to spot copy-paste truncation)
 *   - HTTP status from a live probe
 *   - probe round-trip time
 *
 * That tells us instantly whether the env var was actually picked up by
 * the running deployment. Auth: same CRON_SECRET as the other cron jobs.
 */
import { NextRequest, NextResponse } from "next/server";
import { BISON_INSTANCES, getInstanceConfig } from "@/lib/bison-instances";

export const maxDuration = 30;

interface ProbeResult {
  instance: string;
  baseUrl: string;
  tokenPrefix: string;
  tokenLen: number;
  probeStatus: number | null;
  probeTimeMs: number;
  probeError?: string;
}

async function probeOne(key: string): Promise<ProbeResult> {
  let cfg: { baseUrl: string; token: string };
  try {
    cfg = getInstanceConfig(key);
  } catch (e) {
    return {
      instance: key, baseUrl: "", tokenPrefix: "(missing)", tokenLen: 0,
      probeStatus: null, probeTimeMs: 0,
      probeError: (e as Error).message,
    };
  }
  const tokenPrefix = cfg.token.slice(0, 6);
  const tokenLen = cfg.token.length;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  const start = Date.now();
  try {
    const res = await fetch(`${cfg.baseUrl}/api/campaigns?page=1&per_page=1`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: ctrl.signal,
    });
    return {
      instance: key, baseUrl: cfg.baseUrl, tokenPrefix, tokenLen,
      probeStatus: res.status,
      probeTimeMs: Date.now() - start,
    };
  } catch (e) {
    return {
      instance: key, baseUrl: cfg.baseUrl, tokenPrefix, tokenLen,
      probeStatus: null, probeTimeMs: Date.now() - start,
      probeError: (e as Error).message,
    };
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await Promise.all(BISON_INSTANCES.map((i) => probeOne(i.key)));
  return NextResponse.json({ results });
}
