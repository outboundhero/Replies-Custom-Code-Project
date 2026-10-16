"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ItemView } from "@/lib/costing/types";
import { parseUnits } from "@/lib/costing/decimal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BILLING_OPTIONS, CATEGORY_OPTIONS, CURRENCY_OPTIONS, billingLabel, categoryLabel } from "./format";

type Form = {
  date: string; vendor: string; category: string; description: string; billing_type: string; amount: string; currency: string;
  status: "final" | "pending"; invoice_id: string; invoice_url: string; plan: string; interval: "month" | "year";
  service_from: string; service_to: string; client: string; model: string;
};

const today = () => new Date().toISOString().slice(0, 10);
const NEGATIVE = new Set(["credit", "discount", "refund"]);

function initial(it: ItemView | null): Form {
  if (!it) return { date: today(), vendor: "", category: "saas", description: "", billing_type: "subscription", amount: "", currency: "USD", status: "final", invoice_id: "", invoice_url: "", plan: "", interval: "month", service_from: today(), service_to: "", client: "", model: "" };
  const client = it.allocations?.find((a) => a.dimension === "client")?.key ?? "";
  return {
    date: it.date, vendor: it.vendor, category: it.category, description: it.description ?? "", billing_type: it.billing_type, amount: it.amount,
    currency: it.currency, status: it.status, invoice_id: it.invoice_id === "entered-by-hand" ? "" : it.invoice_id ?? "", invoice_url: it.invoice_url ?? "",
    plan: it.subscription?.plan ?? "", interval: it.subscription?.interval === "year" ? "year" : "month",
    service_from: it.subscription?.service_from ?? it.date, service_to: it.subscription?.service_to ?? "", client, model: it.model ?? "",
  };
}

export function ManualCostDialog({ open, item, onClose, onSaved }: { open: boolean; item: ItemView | null; onClose: () => void; onSaved: () => void }) {
  return open ? <ManualCostForm key={item?.id ?? "new"} item={item} onClose={onClose} onSaved={onSaved} /> : null;
}

function ManualCostForm({ item, onClose, onSaved }: { item: ItemView | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(() => initial(item));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const amt = f.amount.replace(/,/g, "").trim();
  const units = amt ? parseUnits(amt) : null;
  const amountError = !amt ? null : units === null ? "Enter the exact amount, e.g. 49.00 (up to 12 decimals, no symbols)."
    : NEGATIVE.has(f.billing_type) && units > BigInt(0) ? `A ${billingLabel(f.billing_type).toLowerCase()} is entered as a negative amount, e.g. -${amt}.`
    : !NEGATIVE.has(f.billing_type) && units < BigInt(0) ? "Only credits, discounts and refunds can be negative." : null;
  const sub = f.billing_type === "subscription";
  const ready = f.date && f.vendor.trim() && amt && !amountError && (!sub || (f.service_from && f.service_to));

  async function save() {
    setBusy(true);
    const r = await fetch("/api/costing/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", id: item?.id, ...f, amount: amt }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (j.ok) { toast.success(item ? "Cost updated." : "Cost added."); onSaved(); }
    else toast.error(j.error ?? "Couldn't save it.");
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item ? "Edit cost" : "Add a cost"}</DialogTitle>
          <DialogDescription>For a tool no product reports — enter it exactly as billed. Every edit is kept in the history.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vendor" htmlFor="mc-vendor"><Input id="mc-vendor" value={f.vendor} onChange={(e) => set("vendor", e.target.value)} placeholder="e.g. clay, porkbun, slack" /></Field>
          <Field label="Category">
            <Select value={f.category} onValueChange={(v) => set("category", v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{CATEGORY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{categoryLabel(c)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Description" htmlFor="mc-desc" className="sm:col-span-2"><Input id="mc-desc" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Clay Explorer plan — October" /></Field>
          <Field label="Type">
            <Select value={f.billing_type} onValueChange={(v) => set("billing_type", v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{BILLING_OPTIONS.map((b) => <SelectItem key={b} value={b}>{billingLabel(b)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label={sub ? "Charged on" : "Date"} htmlFor="mc-date" hint="The UTC day it was charged."><Input id="mc-date" type="date" value={f.date} onChange={(e) => set("date", e.target.value)} /></Field>
          <Field label="Amount" htmlFor="mc-amt" error={amountError}>
            <Input id="mc-amt" inputMode="decimal" value={f.amount} onChange={(e) => set("amount", e.target.value)} placeholder={NEGATIVE.has(f.billing_type) ? "-10.00" : "49.00"} className="font-mono" />
          </Field>
          <Field label="Currency">
            <Select value={f.currency} onValueChange={(v) => set("currency", v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{CURRENCY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {sub && (
            <>
              <Field label="Plan" htmlFor="mc-plan"><Input id="mc-plan" value={f.plan} onChange={(e) => set("plan", e.target.value)} placeholder="e.g. Explorer" /></Field>
              <Field label="Billed">
                <Select value={f.interval} onValueChange={(v) => set("interval", v as Form["interval"])}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="month">Monthly</SelectItem><SelectItem value="year">Yearly</SelectItem></SelectContent>
                </Select>
              </Field>
              <Field label="Covers from" htmlFor="mc-sf"><Input id="mc-sf" type="date" value={f.service_from} onChange={(e) => set("service_from", e.target.value)} /></Field>
              <Field label="Covers to" htmlFor="mc-st"><Input id="mc-st" type="date" value={f.service_to} onChange={(e) => set("service_to", e.target.value)} /></Field>
            </>
          )}
          {f.category === "ai" && <Field label="AI model" htmlFor="mc-model"><Input id="mc-model" value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="e.g. gpt-4o-mini" /></Field>}
          <Field label="Status">
            <Select value={f.status} onValueChange={(v) => set("status", v as Form["status"])}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="final">Final — on an invoice</SelectItem><SelectItem value="pending">Pending — may still change</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Invoice number" htmlFor="mc-inv" hint="Optional"><Input id="mc-inv" value={f.invoice_id} onChange={(e) => set("invoice_id", e.target.value)} placeholder="e.g. INV-2026-1043" /></Field>
          <Field label="Invoice link" htmlFor="mc-url" hint="Optional"><Input id="mc-url" value={f.invoice_url} onChange={(e) => set("invoice_url", e.target.value)} placeholder="https://…" /></Field>
          <Field label="For one client" htmlFor="mc-client" hint="Optional — a client tag, if this cost is just for them" className="sm:col-span-2">
            <Input id="mc-client" value={f.client} onChange={(e) => set("client", e.target.value)} placeholder="e.g. DBSM" className="uppercase placeholder:normal-case" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!ready || busy}>{busy && <Loader2 className="size-4 animate-spin" />}{item ? "Save changes" : "Add cost"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, htmlFor, hint, error, className, children }: { label: string; htmlFor?: string; hint?: string; error?: string | null; className?: string; children: React.ReactNode }) {
  return (
    <div className={`grid content-start gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor} className="text-xs">{label}{hint && <span className="font-normal text-muted-foreground"> · {hint}</span>}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
