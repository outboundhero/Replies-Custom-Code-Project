const AIRTABLE_API = "https://api.airtable.com/v0";

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
    "Content-Type": "application/json",
  };
}

async function withRetry<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) throw error;
      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Retry exhausted");
}

/**
 * Search Airtable for records matching a formula.
 * Returns array of {id, fields} objects.
 */
export async function searchRecords(
  baseId: string,
  tableId: string,
  filterByFormula: string
): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  return withRetry(async () => {
    const url = new URL(`${AIRTABLE_API}/${baseId}/${tableId}`);
    url.searchParams.set("filterByFormula", filterByFormula);

    const res = await fetch(url.toString(), { headers: getHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable search failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.records || [];
  });
}

/**
 * Create a new record in Airtable.
 * Returns the created record's ID.
 */
export async function createRecord(
  baseId: string,
  tableId: string,
  fields: Record<string, unknown>
): Promise<string> {
  return withRetry(async () => {
    const res = await fetch(`${AIRTABLE_API}/${baseId}/${tableId}`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable create failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.id;
  });
}

/**
 * Update an existing record in Airtable.
 */
export async function updateRecord(
  baseId: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>
): Promise<void> {
  return withRetry(async () => {
    const res = await fetch(
      `${AIRTABLE_API}/${baseId}/${tableId}/${recordId}`,
      {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify({ fields }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable update failed (${res.status}): ${body}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Schema + bulk read helpers (used by the Airtable → Supabase backfill)
// ─────────────────────────────────────────────────────────────────────────

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: unknown;
}

export interface AirtableTableSchema {
  id: string;
  name: string;
  primaryFieldId: string;
  description?: string;
  fields: AirtableField[];
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/**
 * List every table in a base and the schema of each one.
 * Calls Airtable's Meta API: GET /v0/meta/bases/{baseId}/tables
 *
 * Requires the PAT to have the `schema.bases:read` scope.
 */
export async function listBaseSchema(baseId: string): Promise<AirtableTableSchema[]> {
  return withRetry(async () => {
    const res = await fetch(`${AIRTABLE_API}/meta/bases/${baseId}/tables`, {
      headers: getHeaders(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable schema fetch failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.tables || [];
  });
}

/**
 * Stream every record from a table, paging through Airtable's `offset`
 * cursor (page size 100). The optional onPage callback fires once per
 * Airtable page so callers can flush each batch straight to a destination
 * without holding the whole table in memory.
 *
 * Returns the full record list as well — callers that don't care about
 * memory pressure can ignore onPage.
 */
export async function listAllRecords(
  baseId: string,
  tableId: string,
  opts?: {
    pageSize?: number;
    onPage?: (records: AirtableRecord[], pageNumber: number) => Promise<void> | void;
  }
): Promise<AirtableRecord[]> {
  const all: AirtableRecord[] = [];
  let offset: string | undefined;
  let pageNumber = 0;
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 100));

  do {
    const url = new URL(`${AIRTABLE_API}/${baseId}/${tableId}`);
    url.searchParams.set("pageSize", String(pageSize));
    if (offset) url.searchParams.set("offset", offset);

    const page = await withRetry(async () => {
      const res = await fetch(url.toString(), { headers: getHeaders() });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Airtable list failed (${res.status}): ${body}`);
      }
      return (await res.json()) as { records: AirtableRecord[]; offset?: string };
    });

    pageNumber++;
    if (opts?.onPage) await opts.onPage(page.records || [], pageNumber);
    all.push(...(page.records || []));
    offset = page.offset;
  } while (offset);

  return all;
}
