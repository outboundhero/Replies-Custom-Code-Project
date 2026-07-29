"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QualificationFitChips, type FitMatch } from "@/components/qualification-fit-chips";

interface ClientQualification {
  tag: string;
  status: string;
  exclusion_industries: string;
  inclusion_locations: string;
  synced_at: string | null;
}

interface SectionData {
  id: number;
  name: string;
  airtable_base_id: string;
  clients: ClientQualification[];
}

export default function QualificationPage() {
  const [sections, setSections] = useState<SectionData[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedTag, setExpandedTag] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  // "Find perfect client" matcher — separate Location (required) + Industry (optional)
  const [matchLocation, setMatchLocation] = useState("");
  const [matchIndustry, setMatchIndustry] = useState("");
  const [matching, setMatching] = useState(false);
  interface MatchResp { match: { tag: string; reason: string; matched?: string } | null; matches?: FitMatch[]; reason: string; alternatives?: string[]; viaCache?: boolean; aiUsed?: boolean; candidatesConsidered?: number }
  const [matchResult, setMatchResult] = useState<MatchResp | null>(null);

  async function runMatch() {
    const location = matchLocation.trim();
    const industry = matchIndustry.trim();
    if (!location || matching) return;
    setMatching(true); setMatchResult(null);
    try {
      const res = await fetch("/api/qualification/match", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location, industry }),
      });
      // Read as text first — a platform timeout/crash returns an HTML/plaintext
      // error page, not JSON, so res.json() would throw "Unexpected token".
      const text = await res.text();
      let d: (MatchResp & { error?: string }) | null = null;
      try { d = JSON.parse(text); } catch { d = null; }
      if (res.ok && d && !d.error) setMatchResult(d);
      else setMatchResult({ match: null, reason: d?.error || (res.status === 504 ? "The lookup timed out — please try again." : "Lookup failed, please try again.") });
    } catch (e) {
      setMatchResult({ match: null, reason: (e as Error).message });
    } finally {
      setMatching(false);
    }
  }

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/config/qualification");
      if (res.redirected || res.status === 401) { window.location.href = "/login"; return; }
      if (res.ok) { setSections(await res.json()); setFetchError(null); }
      else setFetchError(`Failed to load data (${res.status})`);
    } catch (err) {
      setFetchError(`Network error: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync/sheets", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setSyncResult(`Synced ${data.statusCount} client statuses, ${data.qualificationCount} qualification rules`);
        loadData();
      } else {
        setSyncResult(`Sync failed: ${data.error}`);
      }
    } catch {
      setSyncResult("Sync failed: network error");
    } finally {
      setSyncing(false);
    }
  }

  // Find the latest synced_at across all clients
  const lastSynced = sections
    .flatMap((s) => s.clients)
    .reduce<string | null>((latest, c) => {
      if (!c.synced_at) return latest;
      if (!latest || c.synced_at > latest) return c.synced_at;
      return latest;
    }, null);

  // Filter by search
  const filtered = sections
    .map((s) => ({
      ...s,
      clients: s.clients.filter(
        (c) =>
          c.tag.toLowerCase().includes(search.toLowerCase()) ||
          c.exclusion_industries.toLowerCase().includes(search.toLowerCase()) ||
          c.inclusion_locations.toLowerCase().includes(search.toLowerCase())
      ),
    }))
    .filter((s) => s.clients.length > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Qualification Config</h2>
          <p className="text-sm text-muted-foreground">
            Client exclusion industries and inclusion locations synced from Google Sheets
          </p>
          {lastSynced && (
            <p className="text-xs text-muted-foreground mt-1">
              Last synced: {new Date(lastSynced).toLocaleString()}
            </p>
          )}
        </div>
        <Button onClick={handleSync} disabled={syncing}>
          {syncing ? "Syncing..." : "Sync from Google Sheets"}
        </Button>
      </div>

      {/* ── Find the perfect client for a location + industry ── */}
      <Card className="border-primary/20 bg-gradient-to-br from-primary/[0.03] to-transparent">
        <CardContent className="pt-5">
          <div className="flex items-center gap-2 mb-1">
            <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M12 21s-6-5.686-6-10a6 6 0 1 1 12 0c0 4.314-6 10-6 10z" /><circle cx="12" cy="11" r="2" /></svg>
            <h3 className="text-sm font-semibold">Find Best Fit Client</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-3">Enter a <span className="font-medium">location</span> (required) and optionally an <span className="font-medium">industry</span>. Industry is only sent to the AI when you fill it in. Matches against every client&apos;s location + industry rules.</p>
          <div className="flex flex-col sm:flex-row gap-2 max-w-2xl">
            <div className="flex-1">
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">Location <span className="text-rose-500">*</span></label>
              <Input
                placeholder="e.g. Mt Airy, MD"
                value={matchLocation}
                onChange={(e) => setMatchLocation(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runMatch(); }}
                className="h-10"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">Industry <span className="text-muted-foreground/60">(optional)</span></label>
              <Input
                placeholder="e.g. dental"
                value={matchIndustry}
                onChange={(e) => setMatchIndustry(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runMatch(); }}
                className="h-10"
              />
            </div>
            <Button onClick={runMatch} disabled={matching || !matchLocation.trim()} className="h-10 px-5 shrink-0 sm:self-end">
              {matching ? "Finding…" : "Find client"}
            </Button>
          </div>

          {matchResult && (
            <div className="mt-3 max-w-2xl">
              {matchResult.match ? (
                <div className="rounded-lg border border-green-300 bg-green-50 px-4 py-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-green-700 font-medium">Best match:</span>
                    <span className="inline-flex items-center rounded-md bg-green-600 px-2.5 py-1 text-sm font-mono font-bold text-white">{matchResult.match.tag}</span>
                    {matchResult.viaCache && <span className="text-[10px] text-green-700/70 bg-green-100 px-1.5 py-0.5 rounded">cached</span>}
                  </div>
                  <p className="mt-2 text-sm text-green-900 leading-relaxed">{matchResult.match.reason}</p>
                  {matchResult.match.matched && (
                    <p className="mt-1.5 text-xs text-green-800/90">
                      <span className="font-semibold uppercase tracking-wider text-[10px] text-green-700/70">Matched rule</span>{" "}
                      <span className="font-mono bg-green-100/70 rounded px-1.5 py-0.5">{matchResult.match.matched}</span>
                    </p>
                  )}
                  {matchResult.matches && <div className="[&_.text-muted-foreground]:text-green-700/70"><QualificationFitChips matches={matchResult.matches} bestTag={matchResult.match.tag} /></div>}
                </div>
              ) : (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                  <p className="text-sm text-amber-800">{matchResult.reason}</p>
                  {matchResult.matches && matchResult.matches.some((m) => m.location !== "none") && (
                    <QualificationFitChips matches={matchResult.matches} bestTag={null} />
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {syncResult && (
        <div className={`rounded-md border px-4 py-3 text-sm ${syncResult.includes("failed") ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-green-200 bg-green-50 text-green-700"}`}>
          {syncResult}
        </div>
      )}

      {fetchError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {fetchError}
        </div>
      )}

      <Input
        placeholder="Search by tag, industry, or location..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />

      {filtered.map((section) => (
        <Card key={section.id}>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <CardTitle className="text-base">{section.name}</CardTitle>
              <span className="font-mono text-xs text-muted-foreground">{section.airtable_base_id}</span>
              <Badge variant="secondary" className="ml-auto">{section.clients.length} clients</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {section.clients.map((client) => (
              <div key={client.tag} className="border rounded-md overflow-hidden">
                <div
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/40 text-sm"
                  onClick={() => setExpandedTag(expandedTag === client.tag ? null : client.tag)}
                >
                  <span className="font-mono font-medium w-20 shrink-0">{client.tag}</span>
                  <Badge
                    variant={client.status === "Active" ? "default" : "secondary"}
                    className={client.status === "Active" ? "bg-green-600" : ""}
                  >
                    {client.status}
                  </Badge>
                  <div className="flex-1 truncate text-xs text-muted-foreground">
                    {client.exclusion_industries
                      ? `Excludes: ${client.exclusion_industries.slice(0, 80)}${client.exclusion_industries.length > 80 ? "..." : ""}`
                      : "No exclusions"}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {expandedTag === client.tag ? "\u25B2" : "\u25BC"}
                  </span>
                </div>

                {expandedTag === client.tag && (
                  <div className="border-t bg-muted/20 px-4 py-4 space-y-4">
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                        Exclusion Industries & Keywords
                      </p>
                      {client.exclusion_industries ? (
                        <p className="text-sm bg-white border rounded p-2 whitespace-pre-wrap">
                          {client.exclusion_industries}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">No exclusion industries defined</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                        Inclusion Locations
                      </p>
                      {client.inclusion_locations ? (
                        <p className="text-sm bg-white border rounded p-2 whitespace-pre-wrap">
                          {client.inclusion_locations}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">No inclusion locations defined — all locations accepted</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      {filtered.length === 0 && !fetchError && (
        <p className="text-sm text-muted-foreground text-center py-12">
          {sections.length === 0 ? 'No data yet. Click "Sync from Google Sheets" to load.' : "No matches found."}
        </p>
      )}
    </div>
  );
}
