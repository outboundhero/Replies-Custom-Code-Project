/**
 * POST to OpenAI, waiting and trying again when it says "slow down" (429) or has
 * a server error (5xx), for as long as it asks (retry-after-ms / retry-after),
 * else ~1 s, 3 s, 8 s. Without this, a burst of qualification audits hit the
 * gpt-4o-mini rate limit 147 times between 2026-10-09 and 10-19, and each of
 * those leads was judged on its CRM address instead of what the lead wrote.
 * Anything else — and the last try — is returned as is, for the caller to handle.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (n: number) => [1_000, 3_000, 8_000][Math.min(n, 2)] + Math.floor(Math.random() * 400);

function retryAfterMs(res: Response): number | null {
  const ms = Number(res.headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(res.headers.get("retry-after"));
  if (Number.isFinite(s) && s > 0) return s * 1000;
  return null;
}

export async function openAIFetch(url: string, init: RequestInit, opts: { retries?: number; maxWaitMs?: number } = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  const maxWait = opts.maxWaitMs ?? 10_000;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(backoff(attempt));
      continue;
    }
    if (!RETRYABLE.has(res.status) || attempt >= retries) return res;
    await res.text().catch(() => undefined); // let the connection go before waiting
    await sleep(Math.min(maxWait, retryAfterMs(res) ?? backoff(attempt)));
  }
}
