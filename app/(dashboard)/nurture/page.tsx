/**
 * Nurture System — overview. Server-rendered from the precomputed overview
 * snapshot (one Turso read), so the page arrives with every number filled in.
 * The interactive view is ./_ui/overview-view.tsx.
 */
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import "./nurture-system.css";
import { getOverview, overviewPayload } from "@/lib/nurture/overview-snapshot";
import NurtureOverview from "./_ui/overview-view";

// Runs next to Turso (Mumbai): each read is one short hop, not a trip from the US.
export const preferredRegion = "bom1";

export const dynamic = "force-dynamic";
// This request's render time — relative times ("5 min ago") hydrate against it.
const requestTime = () => Date.now();

export default async function NurturePage() {
  // Admin-only (middleware already enforces it; the page reads data directly).
  if ((await getSession())?.role !== "admin") redirect("/");
  let initial: ReturnType<typeof overviewPayload> | null = null;
  let error: string | null = null;
  try { initial = overviewPayload(await getOverview()); }
  catch (e) { error = (e as Error).message; }
  return <NurtureOverview initial={initial} initialError={error} serverNow={requestTime()} />;
}
