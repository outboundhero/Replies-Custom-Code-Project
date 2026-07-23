"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface NavLink {
  href: string;
  label: string;
  adminOnly?: boolean;
}
interface NavGroup {
  label: string;
  children: NavLink[];
}
type NavItem = NavLink | NavGroup;
function isGroup(i: NavItem): i is NavGroup {
  return (i as NavGroup).children !== undefined;
}

const items: NavItem[] = [
  { href: "/", label: "Dashboard", adminOnly: true },
  { href: "/clients", label: "Clients" },
  { href: "/sections", label: "Sections & Tags", adminOnly: true },
  { href: "/untracked", label: "Untracked Config", adminOnly: true },
  {
    label: "Inbox",
    children: [
      { href: "/inbox", label: "Inbox (Beta)" },
      { href: "/archive", label: "Archive", adminOnly: true },
    ],
  },
  { href: "/nurture", label: "Nurture", adminOnly: true },
  { href: "/migrate", label: "Move Leads", adminOnly: true },
  { href: "/blacklist", label: "Blacklist", adminOnly: true },
  { href: "/webhooks", label: "Webhook Activity", adminOnly: true },
  { href: "/qualification", label: "Qualification" },
  { href: "/errors", label: "Error Log", adminOnly: true },
  { href: "/users", label: "User Management", adminOnly: true },
];

export function Nav({
  initialRole = null,
  initialEmail = null,
  initialAllowedClientTags = null,
}: {
  initialRole?: string | null;
  initialEmail?: string | null;
  initialAllowedClientTags?: string[] | null;
} = {}) {
  const pathname = usePathname();
  const router = useRouter();
  // Seeded from the server render (dashboard layout) so the correct link set is
  // present on the very first paint — no `role=null` flash, no admin-link pop-in.
  const [role] = useState<string | null>(initialRole);
  const [email] = useState<string | null>(initialEmail);
  // Scoped users (allowed_client_tags non-empty) get an inbox-only nav —
  // no Clients, no Qualification. Mirrors the middleware's hard block.
  const [isScoped] = useState(
    Array.isArray(initialAllowedClientTags) && initialAllowedClientTags.length > 0
  );

  async function handleLogout() {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.push("/login");
  }

  const canSee = (link: NavLink) => {
    if (role === "admin") return true;
    // Scoped inbox managers only ever see /inbox.
    if (isScoped) return link.href === "/inbox";
    return !link.adminOnly;
  };

  const linkClass = (active: boolean) =>
    cn(
      "block px-3 py-2 rounded-md text-sm transition-colors",
      active ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground hover:text-foreground"
    );

  return (
    <aside className="w-56 border-r bg-muted/30 flex flex-col min-h-screen">
      <div className="p-4 border-b">
        <h1 className="font-semibold text-sm tracking-tight">OutboundHero</h1>
        <p className="text-xs text-muted-foreground">Reply Router</p>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {items.map((item) => {
          if (isGroup(item)) {
            const kids = item.children.filter(canSee);
            if (!kids.length) return null;
            return <NavGroupEl key={item.label} label={item.label} kids={kids} pathname={pathname} linkClass={linkClass} />;
          }
          if (!canSee(item)) return null;
          return (
            <Link key={item.href} href={item.href} className={linkClass(pathname === item.href)}>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-2 border-t">
        {email && (
          <p className="px-3 py-1 text-[10px] text-muted-foreground truncate">
            {email}
            <span className="ml-1 capitalize">({role?.replace("_", " ")})</span>
          </p>
        )}
        <button
          onClick={handleLogout}
          className="w-full px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors text-left"
        >
          Sign Out
        </button>
      </div>
    </aside>
  );
}

function NavGroupEl({
  label, kids, pathname, linkClass,
}: {
  label: string;
  kids: NavLink[];
  pathname: string;
  linkClass: (active: boolean) => string;
}) {
  const anyActive = kids.some((k) => pathname === k.href);
  // Open by default (Inbox (Beta) shown); stays open while a child is active.
  const [open, setOpen] = useState(true);
  const isOpen = open || anyActive;
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors",
          anyActive ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted"
        )}
      >
        <span>{label}</span>
        <svg
          className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform duration-200", isOpen ? "" : "-rotate-90")}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {/* grid-rows 0fr↔1fr animates height smoothly without a fixed max-height. */}
      <div className={cn("grid transition-all duration-200 ease-in-out", isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="overflow-hidden">
          <div className="ml-3 mt-1 pl-2 border-l border-border space-y-1">
            {kids.map((k) => (
              <Link key={k.href} href={k.href} className={linkClass(pathname === k.href)}>
                {k.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
