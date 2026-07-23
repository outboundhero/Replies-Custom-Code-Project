import { Nav } from "@/components/nav";
import { getSession } from "@/lib/auth";
import { SessionProvider } from "@/components/session-provider";
import { InboxPrefetcher } from "@/components/inbox-prefetcher";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read the session server-side (cookie + local HMAC verify — no network) so
  // the nav renders the correct links on the first paint instead of fetching
  // the role after mount. Middleware already guarantees an authed session here.
  const raw = await getSession();
  const session = raw
    ? { email: raw.email, role: raw.role, allowedClientTags: raw.allowedClientTags ?? null }
    : null;

  return (
    <SessionProvider value={session}>
      <div className="flex min-h-screen">
        <Nav
          initialRole={session?.role ?? null}
          initialEmail={session?.email ?? null}
          initialAllowedClientTags={session?.allowedClientTags ?? null}
        />
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
      {/* Prefetch fresh inbox data on app load so the first open is instant. */}
      <InboxPrefetcher />
    </SessionProvider>
  );
}
