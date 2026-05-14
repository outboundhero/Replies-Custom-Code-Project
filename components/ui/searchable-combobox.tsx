"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

/**
 * A small Popover-based combobox: a button trigger that pops open a list
 * of options with a sticky search input. Built from scratch instead of
 * stuffing an <Input> inside Radix's <Select> — Select's keyboard-driven
 * typeahead and popper sizing fight with a nested input, which is what
 * caused the dropdown to detach and float to the right of the screen.
 *
 * Self-contained, no third-party deps beyond what's already installed.
 */
export function SearchableCombobox({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches",
  className,
  triggerClassName,
  contentClassName,
  align = "start",
}: {
  value: string;
  onValueChange: (next: string) => void;
  options: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Clear the search box every time the popover opens so the user
  // doesn't see stale text from a previous interaction.
  React.useEffect(() => {
    if (open) {
      setQuery("");
      // Wait one tick so the input is mounted before focusing.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  function pick(next: string) {
    onValueChange(next);
    setOpen(false);
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center justify-between gap-2 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
            triggerClassName,
            className,
          )}
        >
          <span className={cn("truncate text-left", !value && "text-muted-foreground")}>
            {value || placeholder}
          </span>
          <ChevronDown className="size-4 opacity-50 shrink-0" />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={4}
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] min-w-[240px] rounded-md border bg-popover text-popover-foreground shadow-md outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            contentClassName,
          )}
        >
          {/* Sticky search */}
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="size-3.5 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-7 text-xs pl-7"
              />
            </div>
          </div>

          {/* Scrollable list */}
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">{emptyText}</div>
            ) : (
              filtered.map((opt) => {
                const selected = opt === value;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => pick(opt)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-xs text-left hover:bg-accent hover:text-accent-foreground cursor-pointer",
                      selected && "bg-accent/40",
                    )}
                  >
                    <span className="truncate">{opt}</span>
                    {selected && <Check className="size-3.5 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
