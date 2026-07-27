"use client";

/**
 * Warms the inbox prefetch buffer with FRESH data so the first open is instant.
 * Mounted once in the dashboard layout (it persists across client navigations).
 * Prefetches on app load and whenever the user is on a non-inbox page, using the
 * same default view + scoped client the inbox opens with. Skips while on the
 * inbox (it fetches its own fresh data) and respects the buffer's TTL so this
 * never spams requests.
 */
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "@/components/session-provider";
import { prefetchInbox, DEFAULT_VIEW } from "@/lib/inbox-prefetch";

export function InboxPrefetcher() {
  const pathname = usePathname();
  const session = useSession();
  const scoped = session?.allowedClientTags ?? null;
  const defaultClient = scoped && scoped.length === 1 ? scoped[0] : "";

  useEffect(() => {
    if (!session) return;                         // unauthed (shouldn't happen in the dashboard)
    // Only warm the INBOX globally (it's the primary landing page). Data View
    // is heavier and warmed on nav-hover instead, so it never competes with the
    // page you're actually loading.
    if (!pathname?.startsWith("/inbox")) prefetchInbox(DEFAULT_VIEW, defaultClient);
  }, [pathname, session, defaultClient]);

  return null;
}
