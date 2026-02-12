/**
 * Send data to a Clay webhook with retry logic.
 * Clay failures do NOT block the Airtable write — they are logged as errors.
 */
export async function sendToClayWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      const body = await res.text();
      throw new Error(`Clay webhook failed (${res.status}): ${body}`);
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
