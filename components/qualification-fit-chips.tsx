"use client";

/**
 * Fit chips for the "Find the perfect client" matcher. Shows every near-miss
 * client tag alongside the best match, labelled by which axis fits — location,
 * industry, or both — with the AI's reason on hover.
 */

export interface FitMatch {
  tag: string;
  location: "full" | "partial" | "none";
  industry: "fit" | "excluded" | "na";
  reason: string;
}

/** Short label + colour class for a chip, from its two fit axes. */
function chipStyle(m: FitMatch): { label: string; cls: string } {
  const loc = m.location;
  const ind = m.industry;
  // Full location coverage.
  if (loc === "full") {
    if (ind === "excluded") return { label: "Covers area · industry excluded", cls: "border-amber-300 bg-amber-50 text-amber-800" };
    return { label: "Also covers this area", cls: "border-green-300 bg-green-50 text-green-800" };
  }
  // Same state / region but not the exact city or county.
  if (ind === "fit") return { label: "Industry fits · not exact location", cls: "border-blue-300 bg-blue-50 text-blue-800" };
  if (ind === "excluded") return { label: "Same area · industry excluded", cls: "border-rose-200 bg-rose-50 text-rose-700" };
  return { label: "Same state · not exact location", cls: "border-slate-300 bg-slate-50 text-slate-700" };
}

/**
 * Render the other-client chips (excludes `bestTag`). Only shows candidates with
 * some geographic relevance (full/partial location). `size` tunes density for the
 * inbox drawer ("sm") vs the full Qualification page ("md").
 */
export function QualificationFitChips({ matches, bestTag, size = "md" }: { matches: FitMatch[]; bestTag: string | null; size?: "sm" | "md" }) {
  const others = matches.filter((m) => m.tag !== bestTag && m.location !== "none");
  if (others.length === 0) return null;

  const chip = size === "sm" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-1";
  const heading = size === "sm" ? "text-[9px]" : "text-[11px]";

  return (
    <div className="mt-2.5">
      <p className={`${heading} font-semibold uppercase tracking-wider text-muted-foreground mb-1.5`}>Other clients</p>
      <div className="flex flex-wrap gap-1.5">
        {others.map((m) => {
          const { label, cls } = chipStyle(m);
          return (
            <span key={m.tag} className="group relative inline-flex">
              <span className={`inline-flex items-center gap-1 rounded-md border font-medium cursor-default ${chip} ${cls}`}>
                <span className="font-mono font-bold">{m.tag}</span>
                <span className="opacity-70">· {label}</span>
              </span>
              {/* Hover reason bubble */}
              <span className="pointer-events-none absolute left-0 bottom-full z-20 mb-1 hidden w-64 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-md group-hover:block">
                {m.reason}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
