# Costing feed — spec for product endpoints (v1.0)

ReplyRouter's **Costing** section shows exactly what every product costs to run.
Each product exposes one read-only endpoint that returns its costs for a date
range in the format below. ReplyRouter pulls it on a schedule, **stores every
figure permanently**, and shows daily, weekly, monthly and custom-range totals,
broken down by product, category, vendor, AI model, client and feature.

Two principles:

- **Exact, never approximate.** Every amount is the exact figure the provider
  billed (or will bill), as a decimal string, never rounded, never estimated,
  never prorated. Totals in ReplyRouter must reconcile to the provider's invoices.
- **Dynamic.** A product lists only the costs it actually has, as line items.
  There is no fixed set of fields per tool — no AI means no AI items; a hosting
  bill is just a hosting item.

---

## 1. The endpoint

```
GET {product base URL}/api/costing?from=2026-10-01&to=2026-10-09
Authorization: Bearer <COSTING_API_KEY>
```

| Rule | Detail |
|---|---|
| `from`, `to` | UTC calendar dates, `YYYY-MM-DD`, **both inclusive**. No params → month-to-date. Max range 92 days (`400` beyond that). |
| Auth | One secret key per product (`COSTING_API_KEY` env var), sent as a Bearer token. Wrong/missing key → `401`. The key is registered in ReplyRouter with the product's URL. |
| Response | `200`, `Content-Type: application/json`, the document in §2. |
| Speed | Under ~10s. Read from a stored daily cost table — don't call provider APIs or scan raw logs on every request. |
| Stable | Same range → same answer until the provider revises a figure. Item `id`s never change. |
| Errors | `400 { "error": "…" }` bad range · `401` bad key · `500 { "error": "…" }` anything else. ReplyRouter keeps the last good data and shows the error. |

ReplyRouter pulls every product daily (and on **Refresh** in the UI), re-pulling
the **last 35 days** each time: providers finalise usage and invoices late, and a
re-pull replaces earlier figures for the same `id` (the change is logged — §7).

---

## 2. Response document

```jsonc
{
  "schema_version": "1.0",
  "product": { "id": "lead-database", "name": "Lead Database", "environment": "production" },
  "period": { "from": "2026-10-01", "to": "2026-10-09" },   // echo of the request
  "generated_at": "2026-10-09T20:15:00Z",

  // Exact sum of line_items[].amount per currency (no conversion between currencies).
  "totals": [ { "currency": "USD", "amount": "40.0595" }, { "currency": "INR", "amount": "52.20" } ],

  "line_items": [
    // ── AI: one item per UTC day × vendor × model (× feature, optional) ──────
    {
      "id": "2026-10-08:openai:gpt-4o-mini:enrichment",
      "date": "2026-10-08",
      "category": "ai",
      "vendor": "openai",
      "service": "chat.completions",
      "model": "gpt-4o-mini",
      "description": "Company enrichment summaries",
      "billing_type": "usage",
      "amount": "3.36750000",
      "currency": "USD",
      "source": "provider_api",              // OpenAI Costs API (exact billed amount)
      "status": "final",
      "usage": [
        { "metric": "requests",            "quantity": "5210" },
        { "metric": "input_tokens",        "quantity": "9450000", "unit_price": "0.15",  "price_per": "1000000" },
        { "metric": "cached_input_tokens", "quantity": "1200000", "unit_price": "0.075", "price_per": "1000000" },
        { "metric": "output_tokens",       "quantity": "3100000", "unit_price": "0.60",  "price_per": "1000000" }
      ],
      "allocations": [
        { "dimension": "client", "key": "DBSM",         "amount": "1.20412500" },
        { "dimension": "client", "key": "CCGEN",        "amount": "0.84937500" },
        { "dimension": "client", "key": "unattributed", "amount": "1.31400000" }   // sums exactly to the item amount
      ]
    },

    // ── Subscription: the exact charge, on the day it was charged ───────────
    {
      "id": "vercel:inv_8F2KQ1:pro-plan",
      "date": "2026-10-01",
      "category": "hosting",
      "vendor": "vercel",
      "description": "Vercel Pro plan — October",
      "billing_type": "subscription",
      "amount": "20.00",
      "currency": "USD",
      "source": "invoice",
      "status": "final",
      "invoice": { "id": "inv_8F2KQ1", "url": "https://vercel.com/…/invoices/inv_8F2KQ1" },
      "subscription": { "plan": "Pro", "interval": "month", "seats": "1",
                        "service_from": "2026-10-01", "service_to": "2026-10-31" }
    },

    // ── Metered infrastructure usage from the provider's usage/billing API ──
    {
      "id": "2026-10-08:vercel:function-duration",
      "date": "2026-10-08",
      "category": "hosting",
      "vendor": "vercel",
      "service": "functions",
      "billing_type": "usage",
      "amount": "1.6920",
      "currency": "USD",
      "source": "provider_api",
      "status": "pending",                   // provider may still revise; becomes final when the invoice closes
      "usage": [ { "metric": "compute_gb_hours", "quantity": "9.4", "unit_price": "0.18", "price_per": "1" } ],
      "attributes": { "region": "sin1" }
    },

    // ── Taxes, fees, credits, discounts: their own items ────────────────────
    {
      "id": "supabase:inv_00231:pro-plan",
      "date": "2026-10-03",
      "category": "database",
      "vendor": "supabase",
      "billing_type": "subscription",
      "amount": "25.00",
      "currency": "USD",
      "source": "invoice",
      "status": "final",
      "invoice": { "id": "inv_00231" },
      "subscription": { "plan": "Pro", "interval": "month", "service_from": "2026-10-03", "service_to": "2026-11-02" }
    },
    {
      "id": "supabase:inv_00231:credit",
      "date": "2026-10-03",
      "category": "database",
      "vendor": "supabase",
      "billing_type": "credit",
      "amount": "-10.00",                    // credits / discounts are negative
      "currency": "USD",
      "source": "invoice",
      "status": "final",
      "invoice": { "id": "inv_00231" },
      "description": "Compute credit"
    },
    {
      "id": "google-workspace:inv_7781:tax",
      "date": "2026-10-01",
      "category": "email_infrastructure",
      "vendor": "google-workspace",
      "billing_type": "tax",
      "amount": "52.20",
      "currency": "INR",                     // billed in INR → reported in INR, not converted
      "source": "invoice",
      "status": "final",
      "invoice": { "id": "inv_7781" },
      "description": "GST 18%"
    }
  ]
}
```

A product with nothing but a hosting plan is just as valid — one subscription item.
A range with no costs returns `"line_items": []` and `"totals": []`.

---

## 3. Exactness rules

1. **Amounts are decimal strings**, e.g. `"3.36750000"`, exactly as the source gives
   them — never rounded, never truncated, up to **12 decimal places**. Same for
   `quantity`, `unit_price`, `price_per`. JSON numbers are not accepted (they
   become floating point and lose precision).
2. **Never compute amounts with floating point** in the product either: keep money
   in an integer of the smallest unit you need (e.g. 1e-9 of a dollar) or a
   decimal library, from the provider response to the JSON.
3. **Source of every figure** (`source`):
   - `invoice` — the line on a provider invoice (subscriptions, seats, taxes, credits).
   - `provider_api` — the provider's billing / cost / usage API (e.g. OpenAI Costs
     API, Anthropic Cost API, Vercel usage API, Google Cloud billing export).
   - `metered` — your own exact metering where the provider bills exactly
     quantity × published price and offers no cost API (e.g. tokens logged from
     each API response × the model's price). Allowed only when that product
     calculation reproduces the provider's charge exactly.
   No estimates, forecasts or prorated figures — ever.
4. **Status** (`status`): `final` once the provider won't change it (invoice
   issued / billing period closed), otherwise `pending`. ReplyRouter shows pending
   figures separately until they turn final; a re-pull replaces them.
5. **Subscriptions are recorded when charged**, for the exact charged amount,
   dated the charge day — not spread or prorated. `service_from`/`service_to` say
   which period it pays for.
6. **Credits, discounts, refunds** are their own items with a negative `amount`
   (`billing_type`: `credit` / `discount` / `refund`). **Taxes and fees** are their
   own items (`tax` / `fee`). Item amounts for one invoice must sum to that
   invoice's total.
7. **Currency as billed.** Report each item in the currency it was charged in. No
   conversion by the product — ReplyRouter keeps per-currency totals.
8. **One owner per bill.** A bill shared by several products (e.g. one Supabase
   project) is reported by exactly one product. To show how it's shared, add
   `allocations` with dimension `product` whose amounts sum exactly to the bill.
9. **Totals reconcile exactly.** `totals[].amount` = exact sum of the items in that
   currency; each dimension's allocations = exact item amount (put any remainder
   on key `unattributed`). ReplyRouter rejects a feed that doesn't add up.

---

## 4. Field reference

### Envelope

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | `"1.0"`. Later versions only add fields. |
| `product.id` | yes | Stable slug (lowercase, `-`) — the product's identity in ReplyRouter. Never change it. |
| `product.name` | yes | Display name. |
| `product.environment` | no | Defaults to `production`. |
| `period.from` / `period.to` | yes | Echo of the request. |
| `generated_at` | yes | ISO timestamp of this answer. |
| `totals[]` | yes | `{ currency, amount }` per currency present (empty if no items). |
| `line_items[]` | yes | May be empty. |
| `notes` | no | Free text shown on the product card. |

### Line item

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique within the product and **stable forever** (it's the storage key). Usage: `{date}:{vendor}:{model or service}[:{feature}]`. Invoice lines: `{vendor}:{invoice id}:{line}`. |
| `date` | yes | UTC day the cost was incurred (usage) or charged (subscription, invoice line). |
| `category` | yes | See §5. Unknown categories are allowed and shown as-is. |
| `vendor` | yes | Lowercase slug of who bills it: `openai`, `anthropic`, `google`, `vercel`, `supabase`, `turso`, `aws`, `apollo`, … |
| `service` | no | Finer split inside the vendor: `chat.completions`, `embeddings`, `functions`, `bandwidth`, `compute add-on`, … |
| `model` | when `category` = `ai` | Exact model id as billed: `gpt-4o-mini`, `gpt-4.1`, `claude-sonnet-4-5`, `gemini-2.5-flash`, `text-embedding-3-small`. |
| `description` | no | Human label. |
| `billing_type` | yes | `usage` · `subscription` · `one_time` · `tax` · `fee` · `credit` · `discount` · `refund`. |
| `amount` | yes | Exact decimal string; negative only for `credit` / `discount` / `refund`. |
| `currency` | yes | ISO 4217 of the charge. |
| `source` | yes | `invoice` · `provider_api` · `metered` (§3.3). |
| `status` | yes | `final` · `pending` (§3.4). |
| `invoice` | when `source` = `invoice` | `{ id, url? }` — traceable to the bill. |
| `usage[]` | recommended for `usage` items | What was consumed (§6). Strings, like amounts. |
| `subscription` | for `subscription` items | `{ plan, interval: "month" \| "year", seats?, service_from, service_to }`. |
| `allocations[]` | no | `{ dimension, key, amount }` — exact split of this item (§7). |
| `attributes` | no | Flat extras (`region`, `instance`, `project_id`, …) — shown as tags, never summed. |

---

## 5. Categories (recommended set — open-ended)

| Category | Typical vendors | Typical items |
|---|---|---|
| `ai` | openai, anthropic, google, mistral | Chat/completions, embeddings, image, audio, batch |
| `hosting` | vercel, railway, render, aws, cloudflare | Plan fees, function compute, bandwidth, build minutes |
| `database` | supabase, turso, neon, mongodb | Plan fees, compute add-ons, storage, egress |
| `storage` | aws-s3, cloudflare-r2 | Stored GB, requests, egress |
| `email_infrastructure` | bison, google-workspace, microsoft-365 | Sending inboxes, domains, warmup, seats |
| `data` | apollo, zoominfo, clay, google-maps | Lead/enrichment credits, lookups |
| `api` | emailguard, twilio, zerobounce | Pay-per-call third-party APIs |
| `saas` | slack, airtable, close, notion | Seat/plan subscriptions |
| `monitoring` | sentry, betterstack | Error tracking, uptime |
| `other` | — | Anything else |

---

## 6. Usage metrics

`usage[]` entries: `{ metric, quantity, unit?, unit_price?, price_per? }`, all
values as strings. `unit_price` is the price per `price_per` units (e.g. `"0.15"`
per `"1000000"` tokens). Use these names where they apply so ReplyRouter can
compare products; invent snake_case names for anything else.

**AI** — one item per UTC day × vendor × model (optionally × feature):

| Metric | Meaning |
|---|---|
| `requests` | API calls |
| `input_tokens` | Prompt tokens at the normal input rate (**excluding** cached) |
| `cached_input_tokens` | Prompt tokens at the cached-input rate |
| `output_tokens` | Completion tokens at the output rate (**including** reasoning tokens where billed as output) |
| `reasoning_tokens` | Informational (already inside `output_tokens`) — no price |
| `batch_input_tokens` / `batch_output_tokens` | Batch-API tokens |
| `embedding_tokens` | Embedding tokens |
| `images` / `audio_input_seconds` / `audio_output_seconds` | Media models |

For a `metered` AI item, `amount` must equal exactly Σ(quantity × unit_price ÷
price_per) over the priced metrics.

**Exact per-product AI costs:** give each product its own OpenAI **project**
(Anthropic **workspace**, Google Cloud **project**) and API key. The provider's
cost API then returns each product's exact billed amount on its own — no shared
key, no splitting.

**Infrastructure examples:** `compute_gb_hours`, `invocations`, `bandwidth_gb`,
`build_minutes`, `storage_gb_month`, `egress_gb`, `rows_read`, `rows_written`.
**Email / data / API examples:** `inboxes`, `domains`, `seats`, `credits`,
`lookups`, `verifications`, `emails_sent`.

---

## 7. Allocations (cost per client, feature, product)

`allocations[]` entries: `{ dimension, key, amount }`.

| Dimension | Key example | Use |
|---|---|---|
| `client` | `DBSM` (ReplyRouter client tag, uppercase) | What each client costs, across all products |
| `feature` | `reply-categorizer`, `enrichment` | Which part of the product spent it |
| `product` | `replyrouter` | How a shared bill is split (§3.8) |
| `workflow` / `campaign` / `user` | any | Optional extra splits |

Per dimension, allocation amounts sum **exactly** to the item amount; whatever
can't be attributed goes on key `unattributed`. Allocate where it's measured
(e.g. each AI call logged with its client and exact cost); skip it where it isn't
(a flat plan).

---

## 8. What ReplyRouter does with it

- **Stores every item permanently** (its own database, not the shared inbox
  database), keyed by product + `id`, with amounts kept as exact integers of
  1e-12 per currency unit — so every sum is exact. When a re-pull changes an
  item's amount or status, the old and new values are kept in a change log.
- **Views:** daily, weekly (Mon–Sun, UTC), monthly (calendar month, UTC) and any
  custom range; per product, category, vendor, model, client, feature; pending vs
  final; per currency. Amounts are displayed exactly (trailing zeros trimmed,
  at least 2 decimals) — never rounded.
- **Checks on every pull:** schema, exact totals, allocation sums, stable ids; a
  failing feed is rejected (the last good data stays) and the error is shown.

---

## 9. Implementation checklist (for a product team)

1. Get exact figures at the source: provider cost/usage APIs, invoices, and — only
   where the provider bills quantity × price with no cost API — exact metering of
   every call (tokens from each API response's `usage` block, client, feature).
2. Store them per UTC day in your own small cost table (as exact decimals or
   integers), refreshing from the provider daily; mark items `final` once closed.
3. List subscription charges, taxes, fees and credits from invoices as their own items.
4. Build `GET /api/costing` per §1, returning §2: strings for every number,
   totals per currency, stable ids.
5. Test: totals and allocations add up exactly; ids are stable across calls; an
   empty range returns empty arrays; nothing is a JSON float.
6. Give ReplyRouter the base URL and the key.

### TypeScript types

```ts
type Decimal = string;                              // exact decimal, e.g. "3.36750000"

export interface CostingFeed {
  schema_version: "1.0";
  product: { id: string; name: string; environment?: string };
  period: { from: string; to: string };             // YYYY-MM-DD, inclusive, UTC
  generated_at: string;                             // ISO timestamp
  totals: Array<{ currency: string; amount: Decimal }>;
  line_items: CostLineItem[];
  notes?: string;
}

export interface CostLineItem {
  id: string;
  date: string;                                     // YYYY-MM-DD, UTC
  category: string;                                 // ai | hosting | database | … (open)
  vendor: string;
  service?: string;
  model?: string;                                   // required when category = "ai"
  description?: string;
  billing_type: "usage" | "subscription" | "one_time" | "tax" | "fee" | "credit" | "discount" | "refund";
  amount: Decimal;
  currency: string;                                 // ISO 4217
  source: "invoice" | "provider_api" | "metered";
  status: "final" | "pending";
  invoice?: { id: string; url?: string };
  usage?: Array<{ metric: string; quantity: Decimal; unit?: string; unit_price?: Decimal; price_per?: Decimal }>;
  subscription?: { plan: string; interval: "month" | "year"; seats?: Decimal; service_from: string; service_to: string };
  allocations?: Array<{ dimension: string; key: string; amount: Decimal }>;
  attributes?: Record<string, string | number | boolean>;
}
```
