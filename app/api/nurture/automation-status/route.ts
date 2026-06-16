/**
 * GET /api/nurture/automation-status
 *
 * Fast, Turso-only health view for the Nurture Automation tab. One round-trip
 * (parallel reads of cached tables — no Bison, no Supabase RPC), 60s cache.
 *
 * Per non-churned client: its group + B2B/B2C instances, auto on/off (opt-out),
 * and a campaign-existence MATRIX — for each instance it needs (B2B + B2C) ×
 * each ESP (google/outlook/segs): does a canonical [Nurture] (Cleaning Client)
 * campaign exist there for THIS exact tag? Flags which clients need campaigns
 * created, and where. Grouped by Section.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import db from "@/lib/db";
import { isCanonicalNurtureCampaign, detectCampaignEsp, type Esp } from "@/lib/nurture/esp";
import { getAllClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";
import type { BisonInstanceKey } from "@/lib/bison-instances-shared";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ESPS: Esp[] = ["google", "outlook", "segs"];
const rankStatus = (s: string) => (s === "active" ? 0 : s === "paused" ? 1 : s === "draft" ? 2 : s === "archived" ? 4 : 3);

interface Cell { state: "ok" | "missing"; status?: string; draft?: boolean }

let cache: { ts: number; data: unknown } | null = null;
const TTL_MS = 60 * 1000;

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  if (!fresh && cache && Date.now() - cache.ts < TTL_MS) {
    return NextResponse.json({ ...(cache.data as object), cached: true });
  }

  const [tagRows, cfgRows, instances, churned, campRows] = await Promise.all([
    db.execute("SELECT ct.tag, ct.section_id, s.name AS section_name FROM client_tags ct JOIN sections s ON ct.section_id = s.id"),
    db.execute("SELECT client_tag, auto_nurture_disabled, auto_nurture_last_run_at FROM client_config"),
    getAllClientInstances(),
    getChurnedTags(),
    db.execute("SELECT name, status, client_tag, bison_instance, synced_at FROM nurture_campaigns_cache"),
  ]);

  // Index canonical campaigns: TAG -> esp -> instance -> best status.
  const byTag = new Map<string, Map<Esp, Map<string, string>>>();
  let syncedAt: string | null = null;
  for (const r of campRows.rows) {
    const name = String(r.name || "");
    const tag = String(r.client_tag || "").toUpperCase();
    const inst = String(r.bison_instance || "");
    const status = String(r.status || "");
    if (r.synced_at && (!syncedAt || String(r.synced_at) > syncedAt)) syncedAt = String(r.synced_at);
    if (!tag || !inst || !isCanonicalNurtureCampaign(name)) continue;
    const esp = detectCampaignEsp(name);
    if (!esp) continue;
    if (!byTag.has(tag)) byTag.set(tag, new Map());
    const espMap = byTag.get(tag)!;
    if (!espMap.has(esp)) espMap.set(esp, new Map());
    const instMap = espMap.get(esp)!;
    const cur = instMap.get(inst);
    if (!cur || rankStatus(status) < rankStatus(cur)) instMap.set(inst, status);
  }

  const cfgByTag = new Map<string, { disabled: number; lastRun: string | null }>();
  for (const r of cfgRows.rows) {
    cfgByTag.set(String(r.client_tag).toUpperCase(), {
      disabled: Number(r.auto_nurture_disabled) || 0,
      lastRun: (r.auto_nurture_last_run_at as string) ?? null,
    });
  }

  type ClientOut = {
    clientTag: string; group: number | null; b2b: BisonInstanceKey | null; b2c: BisonInstanceKey | null;
    autoOn: boolean; lastRunAt: string | null; mappingMissing: boolean;
    matrix: Record<string, Record<Esp, Cell>>; configured: boolean;
    missingCells: Array<{ instance: string; esp: Esp }>;
  };
  const sections = new Map<number, { id: number; name: string; clients: ClientOut[] }>();

  for (const r of tagRows.rows) {
    const tag = String(r.tag);
    const TAG = tag.toUpperCase();
    if (churned.has(TAG)) continue; // hide churned (mirror hub)
    const inst = instances.get(TAG);
    const cfg = cfgByTag.get(TAG);
    const autoOn = (cfg?.disabled ?? 0) !== 1;
    const neededInstances = inst ? Array.from(new Set([inst.b2b, inst.b2c])) : [];
    const espMap = byTag.get(TAG);

    const matrix: Record<string, Record<Esp, Cell>> = {};
    const missingCells: Array<{ instance: string; esp: Esp }> = [];
    for (const instance of neededInstances) {
      matrix[instance] = {} as Record<Esp, Cell>;
      for (const esp of ESPS) {
        const status = espMap?.get(esp)?.get(instance);
        if (status) matrix[instance][esp] = { state: "ok", status, draft: status === "draft" };
        else { matrix[instance][esp] = { state: "missing" }; missingCells.push({ instance, esp }); }
      }
    }
    const configured = neededInstances.length > 0 && missingCells.length === 0;

    const sid = Number(r.section_id);
    if (!sections.has(sid)) sections.set(sid, { id: sid, name: String(r.section_name || "—"), clients: [] });
    sections.get(sid)!.clients.push({
      clientTag: tag, group: inst?.group ?? null, b2b: inst?.b2b ?? null, b2c: inst?.b2c ?? null,
      autoOn, lastRunAt: cfg?.lastRun ?? null, mappingMissing: !inst,
      matrix, configured, missingCells,
    });
  }

  // Sort: within each section, danger rows (autoOn && !configured) first, then by tag.
  const sectionList = [...sections.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of sectionList) {
    s.clients.sort((a, b) => {
      const da = a.autoOn && !a.configured ? 0 : 1;
      const dbb = b.autoOn && !b.configured ? 0 : 1;
      if (da !== dbb) return da - dbb;
      return a.clientTag.localeCompare(b.clientTag);
    });
  }

  const data = { sections: sectionList, syncedAt, cached: false };
  cache = { ts: Date.now(), data };
  return NextResponse.json(data);
}
