"use client";

/**
 * Blacklist section — bulk-blacklist emails or domains across the 4 Bison
 * instances. Two in-page tabs (Email / Domain), each a <BlacklistTab>. The
 * counts-only progress panel lives at the top of the active tab.
 */
import { useState } from "react";
import BlacklistTab from "./_components/BlacklistTab";

type Tab = "email" | "domain";

export default function BlacklistPage() {
  const [tab, setTab] = useState<Tab>("email");

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Blacklist</h1>
        <p className="text-sm text-muted-foreground">
          Bulk-blacklist emails or domains across the selected Bison instances. Already-blacklisted entries are skipped automatically.
        </p>
      </div>

      <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
        <button
          onClick={() => setTab("email")}
          className={`px-3.5 h-8 text-sm font-medium rounded-md transition-colors ${tab === "email" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Email Blacklist
        </button>
        <button
          onClick={() => setTab("domain")}
          className={`px-3.5 h-8 text-sm font-medium rounded-md transition-colors ${tab === "domain" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Domain Blacklist
        </button>
      </div>

      {/* Keyed so switching tabs resets each tab's own state/run. */}
      {tab === "email" ? <BlacklistTab key="email" kind="email" /> : <BlacklistTab key="domain" kind="domain" />}
    </div>
  );
}
