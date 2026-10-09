/**
 * Queue-tab filters, validated + normalised once for every queue endpoint
 * (page / remove-all-matching). Text filters drop LIKE wildcards so user input
 * can never widen a match; source + domain are whitelisted.
 */
export const QUEUE_SOURCES = ["seq", "soft", "ooo", "other", "legacy"] as const;
export type QueueSource = typeof QUEUE_SOURCES[number];

export interface QueueFilters {
  search: string | null;
  emailSuffix: string | null;
  webSuffix: string | null;
  source: QueueSource | null;
  tld: string | null;
  overlapOnly: boolean;
}

const clean = (v: unknown, max = 120): string | null => {
  const s = String(v ?? "").replace(/[%_\\]/g, "").trim().slice(0, max);
  return s ? s : null;
};

export function parseQueueFilters(src: URLSearchParams | Record<string, unknown>): QueueFilters {
  const get = (k: string) => (src instanceof URLSearchParams ? src.get(k) : (src as Record<string, unknown>)[k]);
  const source = String(get("source") ?? "").trim();
  let tld = String(get("tld") ?? "").trim().toLowerCase();
  if (tld && !tld.startsWith(".")) tld = "." + tld;
  return {
    search: clean(get("search")),
    emailSuffix: clean(get("email"), 80)?.toLowerCase() ?? null,
    webSuffix: clean(get("web"), 80)?.toLowerCase() ?? null,
    source: (QUEUE_SOURCES as readonly string[]).includes(source) ? (source as QueueSource) : null,
    tld: /^\.[a-z0-9-]{1,24}$/.test(tld) ? tld : null,
    overlapOnly: ["1", "true", "yes"].includes(String(get("overlap") ?? "").toLowerCase()),
  };
}

/** One nurture_queue_page row → the queue API's contact shape. */
export function toQueueContact(r: Record<string, unknown>) {
  return {
    email: r.email as string, name: [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || null,
    company: (r.company as string) ?? null, website: (r.website as string) ?? null, tld: (r.tld as string) ?? null,
    source: r.source as string, esp: r.esp as string, espResolved: !!r.esp_resolved,
    triggerAt: r.trigger_at as string, eligibleAt: r.eligible_at as string,
    isEligible: !!r.is_eligible, isReady: !!r.is_ready,
    rows: Number(r.row_count) || 1, overlapTags: (r.overlap_tags as string[]) || [],
  };
}

export function toRpcArgs(f: QueueFilters) {
  return {
    p_search: f.search, p_email_suffix: f.emailSuffix, p_web_suffix: f.webSuffix,
    p_source: f.source, p_tld: f.tld, p_overlap_only: f.overlapOnly,
  };
}
