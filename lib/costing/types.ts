/** Shapes the Costing page reads (browser-safe). Amounts are exact counts of 1e-12 units, as strings. */

export type Group = "day" | "week" | "month";
export type StatusFilter = "all" | "final" | "pending";

export interface CostingFilters {
  from: string;
  to: string;
  group: Group;
  product?: string | null;   // pid
  category?: string | null;
  vendor?: string | null;
  model?: string | null;
  client?: string | null;    // allocation key, dimension "client"
  feature?: string | null;   // allocation key, dimension "feature"
  status?: StatusFilter;
  currency?: string | null;
}

export interface Period { key: string; label: string; from: string; to: string }

export interface BreakdownRow { key: string; label: string; units: string; pending: string; items: number }

export interface ItemView {
  pid: string;
  product: string;
  id: string;
  date: string;
  category: string;
  vendor: string;
  service: string | null;
  model: string | null;
  description: string | null;
  billing_type: string;
  amount: string;        // as the product sent it
  units: string;         // what counts here (the item amount, or its client/feature share when filtered)
  full_units: string;    // the whole item amount
  currency: string;
  source: string;
  status: "final" | "pending";
  invoice_id: string | null;
  invoice_url: string | null;
  usage: Array<{ metric: string; quantity: string; unit?: string; unit_price?: string; price_per?: string }> | null;
  subscription: { plan?: string; interval?: string; seats?: string; service_from?: string; service_to?: string } | null;
  allocations: Array<{ dimension: string; key: string; amount: string }> | null;
  attributes: Record<string, string | number | boolean> | null;
  updated_at: string;
}

export interface ProductCard {
  pid: string;
  name: string;
  slug: string | null;
  kind: "feed" | "manual";
  enabled: boolean;
  base_url: string | null;
  key_hint: string | null;
  environment: string | null;
  notes: string | null;
  health: "ok" | "error" | "never" | "paused" | "manual";
  last_ok_at: string | null;
  last_pull_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  stored_items: number;
  first_date: string | null;
  last_date: string | null;
  range_units: string;      // in the selected currency, this range
  range_items: number;
}

export interface Warning { kind: "duplicate-invoice" | "feed-error" | "stale"; title: string; detail: string; pids: string[] }

export interface CostingDashboard {
  filters: Required<Omit<CostingFilters, "product" | "category" | "vendor" | "model" | "client" | "feature" | "currency">> & {
    product: string | null; category: string | null; vendor: string | null; model: string | null; client: string | null; feature: string | null; currency: string | null;
  };
  currency: string | null;                     // the currency everything below is in
  currencies: Array<{ currency: string; units: string; items: number }>;
  totals: { all: string; final: string; pending: string; items: number; pendingItems: number; days: number } | null;
  previous: { all: string; from: string; to: string } | null;   // the same length of time just before
  periods: Period[];
  series: { byProduct: Array<Record<string, string>>; byCategory: Array<Record<string, string>> };
  seriesKeys: { products: Array<{ key: string; label: string }>; categories: Array<{ key: string; label: string }> };
  breakdowns: Record<"product" | "category" | "vendor" | "model" | "client" | "feature", BreakdownRow[]>;
  items: ItemView[];
  itemsTruncated: boolean;
  options: { products: Array<{ key: string; label: string }>; categories: string[]; vendors: string[]; models: string[]; clients: string[]; features: string[] };
  products: ProductCard[];
  warnings: Warning[];
  lastRefreshedAt: string | null;
  generatedAt: string;
}
