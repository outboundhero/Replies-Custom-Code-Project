"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, ExternalLink, Pencil, Receipt, Search, Trash2 } from "lucide-react";
import type { ItemView } from "@/lib/costing/types";
import { formatDecimal, formatUnits } from "@/lib/costing/decimal";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money, billingLabel, categoryLabel, vendorLabel, sourceLabel, metricLabel, dateLabel, qty, lineUnits } from "./format";
import { Chip, Empty } from "./parts";

const PAGE = 20;
const dec = (s: string | undefined) => (s ? formatDecimal(s, { grouping: true }) ?? s : "");

export function ItemsTable({ items, truncated, currency, filtered, onEdit, onDelete }: {
  items: ItemView[]; truncated: boolean; currency: string; filtered: boolean;
  onEdit: (it: ItemView) => void; onDelete: (it: ItemView) => void;
}) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((i) => [i.product, i.vendor, vendorLabel(i.vendor), i.category, i.service, i.model, i.description, i.id, i.invoice_id, i.billing_type]
      .some((v) => v && String(v).toLowerCase().includes(s)));
  }, [items, q]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const pg = Math.min(page, pages - 1);
  const rows = shown.slice(pg * PAGE, pg * PAGE + PAGE);

  function exportCsv() {
    const head = ["date", "product", "item_id", "category", "vendor", "service", "model", "description", "billing_type", "amount", "currency", "counted_amount", "source", "status", "invoice_id", "invoice_url"];
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const fmt = (u: string) => formatUnits(BigInt(u)); // exact, no thousands separators
    const lines = [head.join(","), ...shown.map((i) => [i.date, i.product, i.id, i.category, i.vendor, i.service, i.model, i.description, i.billing_type, i.amount, i.currency, fmt(i.units), i.source, i.status, i.invoice_id, i.invoice_url].map(esc).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `costs-${currency}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!items.length) {
    return <Empty icon={<Receipt className="size-5" />} title="No line items">{filtered ? "Nothing matches these filters." : "Nothing was billed in this range."}</Empty>;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search vendor, model, invoice, id…" className="h-8 pl-8 text-xs" />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{shown.length.toLocaleString()} item{shown.length === 1 ? "" : "s"}{truncated ? " (newest 3,000)" : ""}</span>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={exportCsv}><Download className="size-3.5" />CSV</Button>
        </div>
      </div>

      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-y bg-muted/40 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <th className="w-8 py-2 pl-5" />
              <th className="py-2 pr-3 font-medium">Date</th>
              <th className="py-2 pr-3 font-medium">Product</th>
              <th className="py-2 pr-3 font-medium">What</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const k = `${i.pid}|${i.id}`;
              const isOpen = open === k;
              const share = i.units !== i.full_units;
              return (
                <Fragment key={k}>
                  <tr onClick={() => setOpen(isOpen ? null : k)} className={cn("cursor-pointer border-b transition-colors hover:bg-muted/40", isOpen && "bg-muted/40")}>
                    <td className="py-2.5 pl-5 text-muted-foreground">{isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</td>
                    <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums text-muted-foreground">{dateLabel(i.date, true)}</td>
                    <td className="max-w-36 truncate py-2.5 pr-3 font-medium">{i.product}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="font-medium">{vendorLabel(i.vendor)}</span>
                        {(i.model || i.service) && <span className="truncate text-muted-foreground">· {i.model ?? i.service}</span>}
                        <Chip className="ml-0.5">{categoryLabel(i.category)}</Chip>
                        {i.billing_type !== "usage" && <Chip tone={["credit", "discount", "refund"].includes(i.billing_type) ? "green" : i.billing_type === "subscription" ? "indigo" : "sky"}>{billingLabel(i.billing_type)}</Chip>}
                      </div>
                      {i.description && <div className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">{i.description}</div>}
                    </td>
                    <td className="py-2.5 pr-3">{i.status === "pending" ? <Chip tone="amber" title="The provider may still revise this figure">Pending</Chip> : <Chip tone="green">Final</Chip>}</td>
                    <td className="whitespace-nowrap py-2.5 pr-5 text-right">
                      <span className={cn("font-semibold tabular-nums", BigInt(i.units) < BigInt(0) && "text-emerald-700 dark:text-emerald-400")}>{money(i.units, currency)}</span>
                      {share && <div className="text-[10px] text-muted-foreground">share of {money(i.full_units, currency)}</div>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b bg-muted/20">
                      <td />
                      <td colSpan={5} className="py-4 pr-5"><ItemDetail i={i} currency={currency} onEdit={onEdit} onDelete={onDelete} /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Page {pg + 1} of {pages}</span>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pg === 0} onClick={() => setPage(pg - 1)}>Previous</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemDetail({ i, currency, onEdit, onDelete }: { i: ItemView; currency: string; onEdit: (it: ItemView) => void; onDelete: (it: ItemView) => void }) {
  const manual = i.id.startsWith("manual:");
  return (
    <div className="space-y-4 text-xs">
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      <div className="space-y-2">
        <Meta label="Amount as billed" value={<span className="font-mono">{i.amount} {i.currency}</span>} />
        <Meta label="Source" value={sourceLabel(i.source)} />
        {i.service && <Meta label="Service" value={i.service} />}
        {i.invoice_id && i.invoice_id !== "entered-by-hand" && (
          <Meta label="Invoice" value={i.invoice_url ? <a href={i.invoice_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">{i.invoice_id}<ExternalLink className="size-3" /></a> : i.invoice_id} />
        )}
        {i.subscription && (
          <Meta label="Subscription" value={`${i.subscription.plan ?? "Plan"} · ${i.subscription.interval === "year" ? "yearly" : "monthly"}${i.subscription.seats ? ` · ${qty(i.subscription.seats)} seat${qty(i.subscription.seats) === "1" ? "" : "s"}` : ""}${i.subscription.service_from ? ` · covers ${dateLabel(i.subscription.service_from, true)} – ${dateLabel(i.subscription.service_to ?? i.subscription.service_from, true)}` : ""}`} />
        )}
        <Meta label="Type" value={billingLabel(i.billing_type)} />
        {manual && (
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => onEdit(i)}><Pencil className="size-3" />Edit</Button>
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive" onClick={() => onDelete(i)}><Trash2 className="size-3" />Delete</Button>
          </div>
        )}
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Usage</div>
        {i.usage?.length ? (
          <table className="w-full">
            <tbody>
              {i.usage.map((u, n) => {
                const line = u.unit_price ? lineUnits(u.quantity, u.unit_price, u.price_per) : null;
                const per = !u.price_per || qty(u.price_per) === "1" ? "each" : `per ${qty(u.price_per)}`;
                return (
                  <tr key={n} className="border-b align-top last:border-0">
                    <td className="py-1.5 pr-2">{metricLabel(u.metric)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{qty(u.quantity)}{u.unit ? ` ${u.unit}` : ""}</td>
                    <td className="py-1.5 text-right text-muted-foreground">
                      {u.unit_price && <div>@ {qty(u.unit_price)} {per}</div>}
                      {line !== null && <div className="font-medium tabular-nums text-foreground/80">= {money(line, i.currency)}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="text-muted-foreground">Not itemised.</p>}
      </div>
      <div className="space-y-3">
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Split</div>
          {i.allocations?.length ? (
            <ul className="space-y-1">
              {i.allocations.map((a, n) => (
                <li key={n} className="flex justify-between gap-3"><span><span className="text-muted-foreground">{a.dimension}:</span> {a.key === "unattributed" ? "Unattributed" : a.key}</span><span className="font-mono tabular-nums">{dec(a.amount)}</span></li>
              ))}
            </ul>
          ) : <p className="text-muted-foreground">Not split by client or feature.</p>}
        </div>
        {i.attributes && Object.keys(i.attributes).length > 0 && (
          <div className="flex flex-wrap gap-1.5">{Object.entries(i.attributes).map(([k, v]) => <Chip key={k}>{k}: {String(v)}</Chip>)}</div>
        )}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-[11px] text-muted-foreground">
      <span>Item id <span className="font-mono text-foreground/80">{i.id}</span></span>
      <span>Last changed {dateLabel(i.updated_at.slice(0, 10), true)}, {i.updated_at.slice(11, 16)} UTC</span>
      <span>Shown in {currency}, exactly as billed — never converted or rounded</span>
    </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0">{value}</span>
    </div>
  );
}
