/**
 * Nurture System — one client tag. Server-rendered from the precomputed
 * overview snapshot (one Turso read), so header, panels, pipeline, target
 * campaigns and analytics arrive filled in, together with the queue's first
 * page as cached by the last stats run. The interactive view is
 * ../../_ui/client-view.tsx.
 */
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import "../../nurture-system.css";
import { getOverview, clientPayload, getCachedFirstQueuePage } from "@/lib/nurture/overview-snapshot";
import type { QueueContact } from "../../_ui/queue-cache";
import NurtureClientView from "../../_ui/client-view";

// Runs next to Turso (Mumbai): each read is one short hop, not a trip from the US.
export const preferredRegion = "bom1";

export const dynamic = "force-dynamic";
// This request's render time — relative times ("5 min ago") hydrate against it.
const requestTime = () => Date.now();

export default async function NurtureClientPage({ params }: { params: Promise<{ clientTag: string }> }) {
  // Admin-only (middleware already enforces it; the page reads data directly).
  if ((await getSession())?.role !== "admin") redirect("/");
  const raw = (await params).clientTag || "";
  let tag = raw;
  try { tag = decodeURIComponent(raw); } catch { /* already decoded */ }
  tag = tag.trim();
  let initial: ReturnType<typeof clientPayload> = null;
  let error: string | null = null;
  const [ov, firstPage] = await Promise.all([getOverview().catch((e: Error) => e), getCachedFirstQueuePage(tag)]);
  if (ov instanceof Error) error = ov.message;
  else {
    initial = clientPayload(ov, tag);
    if (!initial) error = `${tag} isn't an active client (churned or unknown).`;
  }
  const initialQueue = initial && firstPage
    ? { total: firstPage.total, contacts: firstPage.contacts as QueueContact[], at: new Date(firstPage.computedAt).getTime() }
    : null;
  return <NurtureClientView tag={initial?.client.tag ?? tag} initial={initial} initialError={error} initialQueue={initialQueue} serverNow={requestTime()} />;
}
