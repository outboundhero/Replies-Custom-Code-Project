"use client";

/**
 * Target Campaigns — operator picks the destination nurture campaign per
 * (instance, ESP) for this client. The route engine (Route-all / Auto-route /
 * auto-push) sends ONLY to these chosen campaigns, and sending is GATED until
 * the operator confirms the map. Leads route by lane: business-email leads →
 * the client's B2B instance, personal-email leads → its B2C instance.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { toast } from "sonner";
import { InstanceBadge } from "@/components/instance-badge";
import { Check, ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { ESP_LABEL, detectCampaignEsp, isCanonicalNurtureCampaign, type Esp } from "@/lib/nurture/esp";

// Inline tag extractor — do NOT import from lib/processing/tag-resolver here:
// that module pulls in lib/db (the server-only Turso client), which crashes the
// browser bundle. Same "TAG: rest" logic.
const extractTagFromCampaignName = (name: string | null | undefined): string => {
  if (!name || typeof name !== "string") return "";
  const m = name.match(/^(.*?):/);
  return m ? m[1].trim() : "";
};

interface Campaign { id: number; name: string; status: string; client_tag: string | null; bison_instance: string; total_leads?: number }
interface MapEntry { bison_instance: string; esp: Esp; campaign_id: number; campaign_name: string | null; lane: string | null }

const ESPS: Esp[] = ["outlook", "google", "segs"];
const LANE_LABEL: Record<string, string> = { b2b: "Business (B2B)", b2c: "Personal (B2C)" };

export default function TargetCampaigns({
  clientTag, campaigns, onConfirmedChange, onSendingEnabled,
}: {
  clientTag: string;
  campaigns: Campaign[];
  onConfirmedChange?: (confirmedAt: string | null) => void;
  // Called after confirm has (a) saved the map, (b) attached inboxes +
  // activated the mapped campaigns. The parent uses this to kick off the
  // "route all ready" drain so leads land in now-live campaigns.
  onSendingEnabled?: () => void;
}) {
  const [instances, setInstances] = useState<{ group: number; b2b: string; b2c: string } | null>(null);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  // selection: `${instance}::${esp}` -> campaignId (0 = none)
  const [sel, setSel] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/nurture/campaign-map?clientTag=${encodeURIComponent(clientTag)}`)
      .then((r) => r.json())
      .then((d) => {
        setInstances(d.instances || null);
        setConfirmedAt(d.confirmedAt || null);
        onConfirmedChange?.(d.confirmedAt || null);
        const m = new Map<string, number>();
        for (const e of (d.entries || []) as MapEntry[]) m.set(`${e.bison_instance}::${e.esp}`, e.campaign_id);
        setSel(m);
        setDirty(false);
      })
      .finally(() => setLoading(false));
  }, [clientTag, onConfirmedChange]);
  useEffect(() => { load(); }, [load]);

  // Candidate campaigns for a given (instance, esp): the canonical nurture
  // campaigns — name must contain "[Nurture]" AND "(Cleaning Client)" — present
  // in THAT instance for this exact client + ESP. Archived ones ARE included
  // (status is shown in the label); only the legacy "(Nurture)" parenthetical
  // variants that lack the "(Cleaning Client)" marker are filtered out.
  const optionsFor = useCallback((instance: string, esp: Esp) => {
    return campaigns.filter((c) =>
      c.bison_instance === instance &&
      (extractTagFromCampaignName(c.name) || "").toUpperCase() === clientTag.toUpperCase() &&
      detectCampaignEsp(c.name) === esp &&
      isCanonicalNurtureCampaign(c.name),
    );
  }, [campaigns, clientTag]);

  const lanes = useMemo(() => {
    if (!instances) return [] as Array<{ lane: "b2b" | "b2c"; instance: string }>;
    const out: Array<{ lane: "b2b" | "b2c"; instance: string }> = [{ lane: "b2b", instance: instances.b2b }];
    if (instances.b2c !== instances.b2b) out.push({ lane: "b2c", instance: instances.b2c });
    return out;
  }, [instances]);

  // How many cells are mappable (have ≥1 candidate) and how many are chosen.
  const { mappable, chosen } = useMemo(() => {
    let mappable = 0, chosen = 0;
    for (const { instance } of lanes) for (const esp of ESPS) {
      if (optionsFor(instance, esp).length > 0) {
        mappable++;
        if (sel.get(`${instance}::${esp}`)) chosen++;
      }
    }
    return { mappable, chosen };
  }, [lanes, sel, optionsFor]);

  function setCell(instance: string, esp: Esp, campaignId: number) {
    setSel((m) => { const n = new Map(m); if (campaignId) n.set(`${instance}::${esp}`, campaignId); else n.delete(`${instance}::${esp}`); return n; });
    setDirty(true);
  }

  async function save(confirm: boolean, enableSending: boolean = false) {
    setSaving(true);
    const entries: MapEntry[] = [];
    for (const { lane, instance } of lanes) for (const esp of ESPS) {
      const id = sel.get(`${instance}::${esp}`);
      if (!id) continue;
      const c = campaigns.find((x) => x.id === id && x.bison_instance === instance);
      entries.push({ bison_instance: instance, esp, campaign_id: id, campaign_name: c?.name ?? null, lane });
    }
    try {
      const res = await fetch("/api/nurture/campaign-map", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTag, entries, confirm }),
      });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "Save failed"); return; }
      setConfirmedAt(d.confirmedAt || null);
      onConfirmedChange?.(d.confirmedAt || null);
      setDirty(false);
      if (!confirm) { toast.success("Saved (not confirmed — sending stays disabled)."); return; }

      // CONFIRM-ONLY ("Confirm draft"): mark the map confirmed so it counts as
      // confirmed everywhere (auto-push cron, route-all, the Automation-tab bulk
      // Enable / Auto button) — but do NOT start sending now. Enable it later.
      if (!enableSending) {
        toast.success(`Confirmed ${entries.length} target campaign${entries.length === 1 ? "" : "s"} — sending not started (enable from here or the Automation tab).`);
        return;
      }

      // CONFIRM + ENABLE: map saved + confirmed. Hand off to the parent, which
      // runs the full route ready leads → attach inboxes → activate flow with a
      // persistent progress panel.
      toast.success(`Confirmed ${entries.length} target campaign${entries.length === 1 ? "" : "s"} — enabling sending…`);
      onSendingEnabled?.();
    } finally { setSaving(false); }
  }

  if (loading) return <div className="rounded-lg border bg-card p-4 h-28 animate-pulse" />;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Target campaigns</p>
          <span className="text-[11px] text-muted-foreground">leads route by lane → instance → ESP</span>
        </div>
        {confirmedAt && !dirty
          ? <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700"><ShieldCheck className="size-3.5" /> Confirmed</span>
          : <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700"><ShieldAlert className="size-3.5" /> {dirty ? "Unsaved changes" : "Not confirmed · sending disabled"}</span>}
      </div>

      {!instances ? (
        <div className="px-4 py-5 text-sm text-muted-foreground">No group mapping for <span className="font-mono">{clientTag}</span> — run the group sheet sync so we know which B2B/B2C instances to route to.</div>
      ) : (
        <div className="p-4 space-y-4">
          {lanes.map(({ lane, instance }) => (
            <div key={instance} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">{LANE_LABEL[lane]}</span>
                <InstanceBadge instance={instance} size="xs" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {ESPS.map((esp) => {
                  const opts = optionsFor(instance, esp);
                  const key = `${instance}::${esp}`;
                  const val = sel.get(key) ?? 0;
                  return (
                    <div key={esp} className="rounded-md border px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">{ESP_LABEL[esp]}</p>
                      {opts.length === 0 ? (
                        <p className="text-xs text-rose-600">no campaign — create in {instance}</p>
                      ) : (
                        <select
                          value={val}
                          onChange={(e) => setCell(instance, esp, Number(e.target.value))}
                          className="w-full text-xs h-8 rounded border bg-white px-2"
                        >
                          <option value={0}>— none —</option>
                          {opts.map((c) => (
                            <option key={c.id} value={c.id}>{c.status === "active" ? "● " : c.status === "draft" ? "○ " : "· "}{c.name} ({c.status})</option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="flex items-center gap-3 pt-1">
            <span className="text-xs text-muted-foreground">{chosen}/{mappable} cells mapped</span>
            <div className="ml-auto flex gap-2">
              <button disabled={saving} onClick={() => save(false)} className="px-3 h-8 text-xs rounded-md border hover:bg-muted/50 disabled:opacity-50">Save draft</button>
              <button disabled={saving || chosen === 0} onClick={() => save(true, false)} title="Mark the map confirmed without sending — you can enable later from here or the Automation tab" className="inline-flex items-center gap-1.5 px-3 h-8 text-xs rounded-md border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                {saving ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3" />} Confirm draft
              </button>
              <button disabled={saving || chosen === 0} onClick={() => save(true, true)} className="inline-flex items-center gap-1.5 px-3 h-8 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Confirm & enable sending
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
