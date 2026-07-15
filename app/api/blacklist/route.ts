/**
 * POST /api/blacklist
 *
 * Bulk-blacklist a list of emails or domains across one or more Bison instances.
 * Blacklisting is per-instance, so each item is pushed to EACH selected instance
 * separately. The client sends an already-normalized/deduped/pre-filtered list
 * (personal domains + malformed already stripped) and drives this endpoint with a
 * cursor until `done`, so large lists never time out.
 *
 * Item-level roll-up (what the count-only panel shows):
 *   • blacklisted — newly blacklisted on ≥1 selected instance, none errored
 *   • already     — every selected instance already had it (nothing new), none errored
 *   • failed      — ≥1 instance errored (returned in `failures` for a targeted retry)
 *
 * Retries live on the CLIENT (idempotent ops); this route does no internal retry.
 * Admin-gated. Copy-only. No per-item DB logging.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getInstanceConfig, isValidInstance } from "@/lib/bison-instances";
import { blacklistOne } from "@/lib/processing/blacklist-bulk";
import { logActivity } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WINDOW = 300; // items processed per request
const WINDOW_MS = 170_000; // wall-clock budget per request
const INSTANCE_CONCURRENCY = 4;

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { await fn(items[idx]); } catch { /* per-op */ }
      }
    }),
  );
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { kind?: string; instances?: string[]; items?: string[]; cursor?: number | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const kind = body.kind === "domain" ? "domain" : body.kind === "email" ? "email" : null;
  if (!kind) return NextResponse.json({ error: "kind must be 'email' or 'domain'" }, { status: 400 });

  const items = Array.isArray(body.items) ? body.items.filter((x) => typeof x === "string" && x.trim()) : [];
  if (!items.length) return NextResponse.json({ error: "items required" }, { status: 400 });

  const requested = Array.isArray(body.instances) ? body.instances : [];
  const validInstances = requested.filter((k) => isValidInstance(k));
  if (!validInstances.length) return NextResponse.json({ error: "at least one valid instance required" }, { status: 400 });

  // Resolve each instance's config ONCE. A missing token env var → that instance
  // can't be reached; record it and mark its ops as errors instead of aborting.
  const configErrors: string[] = [];
  const cfgs: { key: string; baseUrl: string; token: string }[] = [];
  for (const key of validInstances) {
    try {
      const c = getInstanceConfig(key);
      cfgs.push({ key, baseUrl: c.baseUrl, token: c.token });
    } catch {
      configErrors.push(key);
    }
  }

  const start = Math.max(0, Number(body.cursor) || 0);
  const deadline = Date.now() + WINDOW_MS;

  let blacklisted = 0, already = 0, failed = 0, processed = 0;
  const failures: { item: string; instances: string[] }[] = [];

  let i = start;
  for (; i < items.length; i++) {
    if (i - start >= WINDOW || Date.now() > deadline) break;
    const value = items[i];

    // Fan out across the reachable instances for this item.
    const perInstance: Record<string, "blacklisted" | "already" | "error"> = {};
    await pool(cfgs, INSTANCE_CONCURRENCY, async (cfg) => {
      const r = await blacklistOne({ baseUrl: cfg.baseUrl, token: cfg.token }, kind, value, req.signal);
      perInstance[cfg.key] = r.status;
    });

    // Instances we couldn't configure count as errors for every item.
    const failedInstances = [...configErrors, ...Object.entries(perInstance).filter(([, s]) => s === "error").map(([k]) => k)];
    const anyNew = Object.values(perInstance).some((s) => s === "blacklisted");

    if (failedInstances.length) { failed++; failures.push({ item: value, instances: failedInstances }); }
    else if (anyNew) blacklisted++;
    else already++;
    processed++;
  }

  const done = i >= items.length;
  const nextCursor = done ? null : i;

  if (done) {
    // One summary row per finished run — never per item.
    await logActivity("blacklist", "bulk-run", {
      details: { kind, total: items.length, instances: validInstances, configErrors },
    });
  }

  return NextResponse.json({
    ok: true,
    processed,
    counts: { blacklisted, already, failed },
    failures,
    configErrors,
    nextCursor,
    done,
  });
}
