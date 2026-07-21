"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface NavLink {
  href: string;
  label: string;
  adminOnly?: boolean;
}

const links: NavLink[] = [
  { href: "/", label: "Dashboard", adminOnly: true },
  { href: "/clients", label: "Clients" },
  { href: "/sections", label: "Sections & Tags", adminOnly: true },
  { href: "/untracked", label: "Untracked Config", adminOnly: true },
  { href: "/inbox", label: "Inbox (Beta)" },
  { href: "/nurture", label: "Nurture", adminOnly: true },
  { href: "/migrate", label: "Move Leads", adminOnly: true },
  { href: "/blacklist", label: "Blacklist", adminOnly: true },
  { href: "/webhooks", label: "Webhook Activity", adminOnly: true },
  { href: "/qualification", label: "Qualification" },
  { href: "/errors", label: "Error Log", adminOnly: true },
  { href: "/users", label: "User Management", adminOnly: true },
];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [role, setRole] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  // Scoped users (allowed_client_tags non-empty) get an inbox-only nav —
  // no Clients, no Qualification. Mirrors the middleware's hard block.
  const [isScoped, setIsScoped] = useState(false);

  useEffect(() => {
    fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "session" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setRole(d.role);
          setEmail(d.email);
          setIsScoped(Array.isArray(d.allowedClientTags) && d.allowedClientTags.length > 0);
        }
      })
      .catch(() => {});
  }, []);

  async function handleLogout() {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.push("/login");
  }

  const visibleLinks = links.filter((link) => {
    if (role === "admin") return true;
    // Scoped inbox managers only see /inbox — every other link is hidden,
    // even the ones non-scoped inbox managers can normally visit.
    if (isScoped) return link.href === "/inbox";
    return !link.adminOnly;
  });

  return (
    <aside className="w-56 border-r bg-muted/30 flex flex-col min-h-screen">
      <div className="p-4 border-b">
        <h1 className="font-semibold text-sm tracking-tight">OutboundHero</h1>
        <p className="text-xs text-muted-foreground">Reply Router</p>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {visibleLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "block px-3 py-2 rounded-md text-sm transition-colors",
              pathname === link.href
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted text-muted-foreground hover:text-foreground"
            )}
          >
            {link.label}
          </Link>
        ))}
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
