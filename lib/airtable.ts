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
