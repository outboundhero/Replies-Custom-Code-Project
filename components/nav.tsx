"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/sections", label: "Sections & Tags" },
  { href: "/untracked", label: "Untracked Config" },
  { href: "/errors", label: "Error Log" },
];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth", { method: "DELETE" });
    router.push("/login");
  }

  return (
    <aside className="w-56 border-r bg-muted/30 flex flex-col min-h-screen">
      <div className="p-4 border-b">
        <h1 className="font-semibold text-sm tracking-tight">OutboundHero</h1>
        <p className="text-xs text-muted-foreground">Reply Router</p>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {links.map((link) => (
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
