/**
 * Small badge that labels a row with the Bison workspace (instance) it
 * belongs to. Used across the Inbox, Nurture, Errors, and Activity views
 * so every Bison-derived row is unambiguously traceable to its instance.
 *
 * Browser-safe: pulls only from bison-instances-shared, no env/db.
 */

"use client";

import { getInstanceLabel, isValidInstance, DEFAULT_INSTANCE } from "@/lib/bison-instances-shared";

const COLOR_BY_KEY: Record<string, string> = {
  outboundhero:     "bg-blue-50 text-blue-800 border-blue-200",
  outboundclean:    "bg-emerald-50 text-emerald-800 border-emerald-200",
  cleaningoutbound: "bg-amber-50 text-amber-800 border-amber-200",
  facilityreach:    "bg-violet-50 text-violet-800 border-violet-200",
};

const UNKNOWN_COLOR = "bg-gray-50 text-gray-700 border-gray-200";

export function InstanceBadge({
  instance,
  size = "sm",
  className = "",
  title,
}: {
  instance: string | null | undefined;
  size?: "xs" | "sm";
  className?: string;
  title?: string;
}) {
  // null / missing → fall back to the default instance display
  const key = instance && isValidInstance(instance) ? instance : DEFAULT_INSTANCE;
  const label = getInstanceLabel(key);
  const color = COLOR_BY_KEY[key] ?? UNKNOWN_COLOR;
  const sz = size === "xs" ? "text-[9px] px-1 py-0" : "text-[10px] px-1.5 py-0.5";

  return (
    <span
      className={`inline-flex items-center gap-1 font-medium rounded border ${sz} ${color} ${className}`}
      title={title ?? `Bison workspace: ${label}`}
    >
      <span className="w-1 h-1 rounded-full bg-current opacity-60" />
      {label}
    </span>
  );
}
