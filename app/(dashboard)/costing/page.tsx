import { Suspense } from "react";
import { CostingPage } from "./_ui/costing-page";

// Rendered per request so "today" (UTC) is always today's date, never the build's.
export const dynamic = "force-dynamic";

const utcToday = () => new Date().toISOString().slice(0, 10);

export default function Page() {
  const todayIso = utcToday();
  return (
    <Suspense fallback={<div className="mx-auto h-40 w-full max-w-[1400px] animate-pulse rounded-2xl border bg-muted/30" />}>
      <CostingPage todayIso={todayIso} />
    </Suspense>
  );
}
