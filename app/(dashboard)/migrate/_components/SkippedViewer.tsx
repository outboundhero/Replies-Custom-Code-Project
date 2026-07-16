"use client";

/**
 * Collapsible viewer + CSV export for the current move run's service-area
 * skipped leads (leads whose city isn't in the client's service area). Reads
 * /api/leads/move/skipped?runId=… and exports via …/skipped/export. Shared by
 * both Move Leads tabs (Cross Instance + Same Instance).
 */
import { useState, useCallback, useEffect } from "react";
import { MapPin, Download, ChevronDown } from "lucide-react";

export interface SkippedRow {
  client_tag: string;
  email: string;
  city: string | null;
  state: string | null;
  source_campaign_name: string;
  reason: string;
}

export function SkippedViewer({ runId, onExport }: { runId: string | null; onExport: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SkippedRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/leads/move/skipped?runId=${encodeURIComponent(runId)}&limit=500`);
      const d = await res.json();
      if (res.ok) { setRows((d.rows as SkippedRow[]) || []); setTotal(d.total ?? 0); }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [runId]);

  useEffect(() => { if (open) load(); }, [open, load]);
  if (!runId) return null;

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-muted/30">
        <MapPin className="size-4 text-amber-600" />
        <span className="font-medium">Skipped — out of service area</span>
        {total != null && <span className="text-xs text-muted-foreground tabular-nums">{total.toLocaleString()} lead{total === 1 ? "" : "s"}</span>}
        <span className="ml-auto flex items-center gap-2">
          {!!total && (
            <span onClick={(e) => { e.stopPropagation(); onExport(); }} className="inline-flex items-center gap-1 px-2 h-7 text-xs rounded border hover:bg-muted/50"><Download className="size-3" /> Export CSV</span>
          )}
          <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <div className="border-t">
          <div className="flex items-center justify-between px-4 py-1.5 text-xs text-muted-foreground">
            <span>{loading ? "Loading…" : `Showing ${rows.length}${total != null && total > rows.length ? ` of ${total.toLocaleString()}` : ""}`}</span>
            <button onClick={load} className="hover:text-foreground">Refresh</button>
          </div>
          <div className="max-h-[40vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card border-y text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-1.5 font-medium">Client</th>
                  <th className="px-3 py-1.5 font-medium">Email</th>
                  <th className="px-3 py-1.5 font-medium">City</th>
                  <th className="px-3 py-1.5 font-medium">State</th>
                  <th className="px-3 py-1.5 font-medium">Campaign</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r, i) => (
                  <tr key={i} className="hover:bg-muted/30">
                    <td className="px-3 py-1 font-mono">{r.client_tag}</td>
                    <td className="px-3 py-1">{r.email}</td>
                    <td className="px-3 py-1">{r.city || <span className="text-muted-foreground/50">—</span>}</td>
                    <td className="px-3 py-1">{r.state || <span className="text-muted-foreground/50">—</span>}</td>
                    <td className="px-3 py-1 text-muted-foreground truncate max-w-[240px]" title={r.source_campaign_name}>{r.source_campaign_name}</td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No leads skipped by the service-area filter yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
