/**
 * Gemini API wrapper for the qualification audits.
 *
 * Uses gemini-2.5-flash with optional Google Search grounding — the grounding
 * surfaces Maps/web results so the model can verify a company's real industry
 * and resolve/measure locations instead of guessing from raw text.
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
  const model = opts.model || GEMINI_MODEL;

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

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return parts.map((p: any) => p?.text || "").join("").trim();
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
