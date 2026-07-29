"use client";

/**
 * "Find Best Fit Client" — embedded inline in the inbox lead record (below the
 * audit). Auto-populates location + industry from the lead's audit-resolved
 * fields (reply-first) and runs the matcher, so the recommended client shows on
 * the lead without opening the Rules drawer. Clicking the best-fit tag (or a
 * near-miss chip) prefills reallocation. Reuses POST /api/qualification/match.
 */
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { QualificationFitChips, type FitMatch } from "@/components/qualification-fit-chips";

interface MatchResp {
  match: { tag: string; reason: string; matched?: string } | null;
  matches?: FitMatch[];
  reason: string;
  viaCache?: boolean;
}

export function InboxBestFit({
  leadKey, initialLocation, initialIndustry, onPick,
}: {
  leadKey: string | number;
  initialLocation: string;
  initialIndustry: string;
  onPick: (tag: string) => void;
}) {
  const [location, setLocation] = useState(initialLocation);
  const [industry, setIndustry] = useState(initialIndustry);
  const [matching, setMatching] = useState(false);
  const [result, setResult] = useState<MatchResp | null>(null);

  async function run(loc: string, ind: string) {
    const location = loc.trim();
    if (!location || matching) return;
    setMatching(true); setResult(null);
    try {
      const res = await fetch("/api/qualification/match", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location, industry: ind.trim() }),
      });
      const text = await res.text();
      let d: MatchResp | null = null;
      try { d = JSON.parse(text); } catch { d = null; }
      setResult(res.ok && d ? d : { match: null, reason: "Lookup failed, please try again." });
    } catch (e) {
      setResult({ match: null, reason: (e as Error).message });
    }
    setMatching(false);
  }

  // Reset + auto-run when a different lead opens (uses the Turso match cache, so
  // repeat lookups cost no AI credits).
  useEffect(() => {
    setLocation(initialLocation); setIndustry(initialIndustry); setResult(null);
    if (initialLocation.trim()) run(initialLocation, initialIndustry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadKey]);

  return (
    <div className="rounded border bg-white px-4 py-3 space-y-2">
      <p className="text-xs font-medium">Find Best Fit Client</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={location} onChange={(e) => setLocation(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") run(location, industry); }} placeholder="Location (required)" className="h-7 text-[11px] flex-1 min-w-[140px]" />
        <Input value={industry} onChange={(e) => setIndustry(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") run(location, industry); }} placeholder="Industry (optional)" className="h-7 text-[11px] flex-1 min-w-[120px]" />
        <Button size="sm" className="h-7 text-[11px] shrink-0" onClick={() => run(location, industry)} disabled={matching || !location.trim()}>{matching ? "…" : "Find"}</Button>
      </div>
      {result && (result.match ? (
        <div className="rounded border border-green-300 bg-green-50 px-2.5 py-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-green-700 font-medium">Best fit:</span>
            <button onClick={() => onPick(result.match!.tag)} className="inline-flex items-center rounded bg-green-600 px-2 py-0.5 text-xs font-mono font-bold text-white hover:bg-green-700" title="Use this tag for reallocation">{result.match.tag}</button>
            {result.viaCache && <span className="text-[9px] text-green-700/60 bg-green-100 px-1 rounded">cached</span>}
          </div>
          <p className="mt-1 text-[11px] text-green-900 leading-relaxed">{result.match.reason}</p>
          {result.match.matched && <p className="mt-0.5 text-[10px] text-green-800/90">Matched rule: <span className="font-mono bg-green-100/70 rounded px-1">{result.match.matched}</span></p>}
          {result.matches && <QualificationFitChips matches={result.matches} bestTag={result.match.tag} size="sm" />}
        </div>
      ) : (
        <div className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          {result.reason}
          {result.matches && result.matches.some((m) => m.location !== "none") && <QualificationFitChips matches={result.matches} bestTag={null} size="sm" />}
        </div>
      ))}
    </div>
  );
}
