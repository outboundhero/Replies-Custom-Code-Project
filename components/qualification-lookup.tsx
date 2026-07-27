"use client";

/**
 * Qualification lookup — searchable client industry/location rules + the
 * "find the perfect client" matcher. Used inside the inbox (as a drawer) so the
 * team can check audits / locations / a client's rules without switching tabs.
 */
import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useDebouncedValue } from "@/lib/use-debounced-value";

interface Client {
  tag: string;
  status: string;
  exclusion_industries: string;
  inclusion_locations: string;
}
interface Section { id: number; name: string; clients: Client[] }
interface MatchResp { match: { tag: string; reason: string } | null; reason: string; alternatives?: string[]; viaCache?: boolean }

export function QualificationLookup() {
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search, 200);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Find-perfect-client
  const [q, setQ] = useState("");
  const [matching, setMatching] = useState(false);
  const [result, setResult] = useState<MatchResp | null>(null);

  useEffect(() => {
    fetch("/api/config/qualification")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setSections(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const clients = useMemo(() => {
    const all: Client[] = [];
    for (const s of sections) for (const c of s.clients) all.push(c);
    // Dedupe by tag (a tag can appear once per section).
    const seen = new Set<string>();
    return all.filter((c) => (seen.has(c.tag) ? false : seen.add(c.tag)));
  }, [sections]);

  const filtered = useMemo(() => {
    const s = debounced.trim().toLowerCase();
    if (!s) return clients;
    return clients.filter(
      (c) => c.tag.toLowerCase().includes(s)
        || (c.exclusion_industries || "").toLowerCase().includes(s)
        || (c.inclusion_locations || "").toLowerCase().includes(s),
    );
  }, [clients, debounced]);

  async function runMatch() {
    const query = q.trim();
    if (!query || matching) return;
    setMatching(true); setResult(null);
    try {
      const res = await fetch("/api/qualification/match", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }),
      });
      setResult(await res.json());
    } catch (e) {
      setResult({ match: null, reason: (e as Error).message });
    } finally { setMatching(false); }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Find perfect client */}
      <div className="border-b bg-primary/[0.03] px-4 py-3">
        <p className="text-[11px] font-semibold mb-1.5">Find the perfect client</p>
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") runMatch(); }} placeholder="e.g. Mt Airy MD, dental" className="h-8 text-xs" />
          <Button size="sm" className="h-8 text-xs shrink-0" onClick={runMatch} disabled={matching || !q.trim()}>{matching ? "…" : "Find"}</Button>
        </div>
        {result && (
          <div className="mt-2 text-xs">
            {result.match ? (
              <div className="rounded border border-green-300 bg-green-50 px-2.5 py-1.5">
                <span className="font-mono font-bold text-green-700">{result.match.tag}</span>
                {result.viaCache && <span className="ml-1 text-[9px] text-green-700/60 bg-green-100 px-1 rounded">cached</span>}
                <p className="mt-0.5 text-green-900 text-[11px]">{result.match.reason}</p>
                {result.alternatives?.length ? <p className="mt-0.5 text-[10px] text-green-700">Also: {result.alternatives.join(", ")}</p> : null}
              </div>
            ) : (
              <div className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-amber-800 text-[11px]">{result.reason}</div>
            )}
          </div>
        )}
      </div>

      {/* Search + client rules */}
      <div className="px-4 py-2.5 border-b">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by client tag, industry, or location…" className="h-8 text-xs" />
        <p className="mt-1 text-[10px] text-muted-foreground">{loading ? "Loading…" : `${filtered.length} client${filtered.length === 1 ? "" : "s"}`}</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.map((c) => {
          const open = expanded === c.tag;
          return (
            <div key={c.tag} className="border-b border-border/50">
              <button onClick={() => setExpanded(open ? null : c.tag)} className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/40">
                <span className="font-mono text-xs font-bold w-16 shrink-0">{c.tag}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${c.status === "Active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{c.status}</span>
                <span className="flex-1 truncate text-[10px] text-muted-foreground">{c.inclusion_locations?.slice(0, 60) || "all locations"}</span>
                <span className="text-[10px] text-muted-foreground">{open ? "▲" : "▼"}</span>
              </button>
              {open && (
                <div className="px-4 pb-3 space-y-2 bg-muted/20">
                  <div>
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">Exclusion Industries</p>
                    <p className="text-[11px] whitespace-pre-wrap bg-white border rounded p-1.5">{c.exclusion_industries || "None"}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">Inclusion Locations</p>
                    <p className="text-[11px] whitespace-pre-wrap bg-white border rounded p-1.5 max-h-40 overflow-y-auto">{c.inclusion_locations || "All locations accepted"}</p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!loading && filtered.length === 0 && <p className="text-center text-xs text-muted-foreground py-8">No clients match.</p>}
      </div>
    </div>
  );
}
