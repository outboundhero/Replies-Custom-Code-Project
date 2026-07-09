/**
 * Gemini API wrapper for the qualification audits.
 *
 * Uses gemini-2.5-flash (with automatic fallback to gemini-flash-latest /
 * gemini-2.0-flash if the primary is unavailable for the key) plus optional
 * Google Search grounding — the grounding surfaces Maps/web results so the model
 * can verify a company's real industry and resolve/measure locations instead of
 * guessing from raw text. Transient 429/5xx are retried per model.
 *
 * Two helpers:
 *   geminiText  — raw text out (used internally)
 *   geminiJSON  — parses a JSON object out of the response (tolerant of the
 *                 ```json fences the model adds when grounding is on, since
 *                 responseMimeType:"application/json" can't be combined with
 *                 the google_search tool).
 *
 * Key comes from GEMINI_API_KEY (env). temperature 0 + thinkingBudget 0 for
 * deterministic, fast classification.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
// Tried in order if the primary is unavailable (404 / not-found / not-supported)
// for the current key/project, so one model going away can't break the audits.
// `gemini-flash-latest` always points at a live flash and is verified to work
// with Search grounding on our key. (gemini-2.0-flash is intentionally NOT here
// — it 404s with the google_search tool on our key.)
const FALLBACK_MODELS = ["gemini-flash-latest"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GeminiOpts {
  system?: string;
  user: string;
  withSearch?: boolean;
  maxTokens?: number;
  model?: string;
}

export async function geminiText(opts: GeminiOpts): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  // Caller-pinned model → no fallback; otherwise primary + fallbacks.
  const models = opts.model ? [opts.model] : [GEMINI_MODEL, ...FALLBACK_MODELS];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generationConfig: Record<string, any> = {
    temperature: 0,
    maxOutputTokens: opts.maxTokens || 1024,
    // Disable "thinking" — these are deterministic classification calls and
    // thinking tokens would otherwise eat into maxOutputTokens / latency.
    thinkingConfig: { thinkingBudget: 0 },
  };
  // responseMimeType JSON can't be combined with the google_search tool, so
  // only force JSON mode when NOT grounding.
  if (!opts.withSearch) generationConfig.responseMimeType = "application/json";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: Record<string, any> = {
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    generationConfig,
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  if (opts.withSearch) body.tools = [{ google_search: {} }];
  const payload = JSON.stringify(body);

  let lastErr = "";
  for (const model of models) {
    // Retry the SAME model a couple times on transient errors (429 / 5xx),
    // then fall through to the next model on model-availability errors.
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: payload },
        );
      } catch (e) {
        lastErr = `Gemini network error (${model}): ${(e as Error).message}`;
        if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
        break; // network flakiness → try the next model
      }
      if (res.ok) {
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return parts.map((p: any) => p?.text || "").join("").trim();
      }
      const text = (await res.text()).slice(0, 300);
      lastErr = `Gemini ${res.status} (${model}): ${text}`;
      if (res.status === 429 || res.status >= 500) { if (attempt < 2) { await sleep(800 * (attempt + 1)); continue; } break; }
      // 404 / model-not-found / not-supported → stop retrying this model, try the next.
      if (res.status === 404 || /not found|not supported|unsupported|does not exist/i.test(text)) break;
      // Any other client error (400 bad request, 401/403 auth) → switching models won't help.
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || "Gemini: all models failed");
}

/** Extract the first balanced JSON object/array from a (possibly fenced) string. */
function extractJson(raw: string): string {
  let s = raw.trim();
  // strip ```json ... ``` fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[{[]/);
  if (start === -1) return s;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start);
}

export async function geminiJSON<T = unknown>(opts: GeminiOpts): Promise<T> {
  const raw = await geminiText(opts);
  return JSON.parse(extractJson(raw)) as T;
}
