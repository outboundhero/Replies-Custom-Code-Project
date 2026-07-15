"use client";

/**
 * One tab of the Blacklist section, parameterized by `kind` ("email" | "domain").
 * Paste a list → normalize/dedupe/pre-filter client-side → pick instances (all 4
 * default) → drive the windowed /api/blacklist endpoint with 3× retry + abort,
 * accumulating item-level counts into the top progress panel.
 *
 *   • Domain tab skips personal/free domains (never blacklist gmail.com etc.).
 *   • Email tab allows a single personal address (john@gmail.com); skips malformed.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Ban, Loader2 } from "lucide-react";
import { BISON_INSTANCES, isValidInstance } from "@/lib/bison-instances-shared";
import { isPersonalDomain } from "@/lib/processing/personal-domains";
import BlacklistProgressPanel, { type BlacklistProgress } from "./BlacklistProgressPanel";

const INSTANCE_ACCENT: Record<string, string> = {
  outboundhero: "data-[on=true]:bg-emerald-600", facilityreach: "data-[on=true]:bg-sky-600",
  cleaningoutbound: "data-[on=true]:bg-amber-600", outboundclean: "data-[on=true]:bg-violet-600",
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^mailto:/, "").replace(/^https?:\/\//, "");
  if (d.includes("@")) d = d.split("@").pop() || "";
  d = d.split("/")[0];        // strip any path
  d = d.replace(/:\d+$/, ""); // strip port
  d = d.replace(/^www\./, "");
  d = d.replace(/\.+$/, "");   // strip trailing dots
  return d;
}
const isValidDomain = (d: string) => /^[^\s@]+\.[^\s@]+$/.test(d);

interface Failure { item: string; instances: string[] }

export default function BlacklistTab({ kind }: { kind: "email" | "domain" }) {
  const [text, setText] = useState("");
  const [instances, setInstances] = useState<Set<string>>(new Set(BISON_INSTANCES.map((i) => i.key)));
  const [progress, setProgress] = useState<BlacklistProgress | null>(null);
  const [running, setRunning] = useState(false);

  const abortRef = useRef(false);
  const abortCtlRef = useRef<AbortController | null>(null);
  const failuresRef = useRef<Failure[]>([]);

  // ── Parse / normalize / dedupe / pre-filter (pure) ──
  const parsed = useMemo(() => {
    const raw = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    const seen = new Set<string>();
    const sendable: string[] = [];
    let skippedPersonal = 0, skippedMalformed = 0;
    for (const tok of raw) {
      let key: string;
      let category: "send" | "personal" | "malformed";
      if (kind === "domain") {
        const d = normalizeDomain(tok);
        if (!d || !isValidDomain(d)) { key = tok.toLowerCase(); category = "malformed"; }
        else if (isPersonalDomain(d)) { key = d; category = "personal"; }
        else { key = d; category = "send"; }
      } else {
        key = tok.toLowerCase();
        category = EMAIL_RE.test(key) ? "send" : "malformed";
      }
      if (seen.has(key)) continue;
      seen.add(key);
      if (category === "send") sendable.push(key);
      else if (category === "personal") skippedPersonal++;
      else skippedMalformed++;
    }
    return { sendable, skippedPersonal, skippedMalformed };
  }, [text, kind]);

  const skippedTotal = parsed.skippedPersonal + parsed.skippedMalformed;

  const stop = useCallback(() => { abortRef.current = true; abortCtlRef.current?.abort(); }, []);
  const abortableSleep = useCallback((ms: number) => new Promise<void>((resolve) => {
    if (abortRef.current) return resolve();
    const t = setTimeout(resolve, ms);
    abortCtlRef.current?.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  }), []);

  interface WindowData {
    processed: number;
    counts: { blacklisted: number; already: number; failed: number };
    failures: Failure[]; configErrors: string[]; nextCursor: number | null; done: boolean;
  }

  const postWithRetry = useCallback(async (
    items: string[], insts: string[], cursor: number,
  ): Promise<{ ok: boolean; data?: WindowData; error?: string }> => {
    const MAX = 3;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      if (abortRef.current) return { ok: false, error: "stopped" };
      try {
        const res = await fetch("/api/blacklist", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, instances: insts, items, cursor }),
          signal: abortCtlRef.current?.signal,
        });
        if (res.ok) return { ok: true, data: await res.json() };
        const err = await res.json().catch(() => ({}));
        // Hard 4xx (not 429) won't get better on retry — surface immediately.
        if (res.status !== 429 && res.status < 500) return { ok: false, error: err.error || `HTTP ${res.status}` };
      } catch { if (abortRef.current) return { ok: false, error: "stopped" }; }
      if (attempt < MAX) await abortableSleep(Math.min(20000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400));
    }
    return { ok: false, error: "failed after 3 retries" };
  }, [kind, abortableSleep]);

  const runBlacklist = useCallback(async (items: string[], insts: string[], skipped: number) => {
    abortRef.current = false;
    abortCtlRef.current = new AbortController();
    failuresRef.current = [];
    setRunning(true);
    setProgress({
      status: "running", kind, instances: insts, total: items.length, processed: 0,
      blacklisted: 0, already: 0, skipped, failed: 0, configErrors: [],
    });

    let cursor: number | null = 0;
    let configErrors: string[] = [];
    let fatal: string | null = null;
    while (cursor != null) {
      if (abortRef.current) break;
      const r = await postWithRetry(items, insts, cursor);
      if (!r.ok) { if (r.error !== "stopped") fatal = r.error || "failed"; break; }
      const d = r.data!;
      configErrors = d.configErrors || [];
      failuresRef.current.push(...(d.failures || []));
      setProgress((p) => p && {
        ...p,
        processed: p.processed + d.processed,
        blacklisted: p.blacklisted + d.counts.blacklisted,
        already: p.already + d.counts.already,
        failed: p.failed + d.counts.failed,
        configErrors,
      });
      cursor = d.done ? null : d.nextCursor;
    }

    const hadFailures = failuresRef.current.length > 0 || configErrors.length > 0 || !!fatal;
    setProgress((p) => p && { ...p, status: hadFailures ? "error" : "done" });
    setRunning(false);
    if (fatal) toast.error(fatal);
  }, [kind, postWithRetry]);

  const start = () => {
    if (running) return;
    if (!parsed.sendable.length) { toast.error(`Nothing to blacklist — paste some ${kind === "domain" ? "domains" : "emails"}.`); return; }
    if (!instances.size) { toast.error("Select at least one instance."); return; }
    runBlacklist(parsed.sendable, [...instances], skippedTotal);
  };

  const retryFailed = () => {
    const failed = failuresRef.current;
    if (!failed.length) return;
    const items = [...new Set(failed.map((f) => f.item))];
    const insts = [...instances].filter(isValidInstance);
    if (!insts.length) { toast.error("Select at least one instance to retry."); return; }
    runBlacklist(items, insts, 0);
  };

  const toggleInstance = (key: string) => {
    setInstances((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { if (next.size > 1) next.delete(key); } else next.add(key);
      return next;
    });
  };

  const noun = kind === "domain" ? "domains" : "emails";

  return (
    <div className="space-y-4">
      {progress && (
        <div className="sticky top-2 z-20">
          <BlacklistProgressPanel
            progress={progress}
            running={running}
            onStop={stop}
            onClose={() => setProgress(null)}
            onRetry={retryFailed}
            failedCount={progress.failed}
          />
        </div>
      )}

      <div className="rounded-xl border bg-card p-4 space-y-4">
        {/* Input */}
        <div>
          <label className="text-sm font-medium">Paste {noun}</label>
          <p className="text-xs text-muted-foreground mb-2">Comma, space, or newline separated. Duplicates are removed automatically.</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder={kind === "domain" ? "acme.com, badactor.io\ncompetitor.co" : "someone@acme.com\nno-reply@badactor.io"}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <span><span className="font-semibold text-foreground">{parsed.sendable.length.toLocaleString()}</span> to blacklist</span>
            {parsed.skippedPersonal > 0 && <span className="text-amber-700">· {parsed.skippedPersonal.toLocaleString()} personal skipped</span>}
            {parsed.skippedMalformed > 0 && <span className="text-amber-700">· {parsed.skippedMalformed.toLocaleString()} malformed skipped</span>}
          </div>
        </div>

        {/* Instances */}
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">Instances · all selected by default</p>
          <div className="flex flex-wrap gap-1.5">
            {BISON_INSTANCES.map((inst) => {
              const on = instances.has(inst.key);
              return (
                <button
                  key={inst.key}
                  data-on={on}
                  onClick={() => toggleInstance(inst.key)}
                  className={`px-2.5 h-8 text-xs rounded-md border transition-colors ${on ? `text-white ${INSTANCE_ACCENT[inst.key] || "data-[on=true]:bg-foreground"}` : "hover:bg-muted/50 text-muted-foreground"}`}
                >
                  {inst.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Action */}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={start}
            disabled={running || parsed.sendable.length === 0}
            className="inline-flex items-center gap-2 px-4 h-9 rounded-md bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
            {running ? "Blacklisting…" : `Blacklist ${parsed.sendable.length ? parsed.sendable.length.toLocaleString() + " " : ""}${noun}`}
          </button>
          {parsed.sendable.length === 0 && skippedTotal > 0 && (
            <span className="text-xs text-muted-foreground">All {skippedTotal.toLocaleString()} {noun} were skipped (personal/malformed) — nothing to send.</span>
          )}
        </div>
      </div>
    </div>
  );
}
