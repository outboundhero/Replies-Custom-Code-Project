import { cn } from "@/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

export function initials(name?: string | null, email?: string | null): string {
  const n = String(name || "").trim();
  if (n) return n.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (String(email || "?").trim()[0] || "?").toUpperCase();
}

// Split the stored comma-joined name/email strings back into paired recipients.
function pairRecipients(names?: string | null, emails?: string | null): { name: string; email: string }[] {
  const es = String(emails || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ns = String(names || "").split(",").map((s) => s.trim());
  if (!es.length) return ns.filter(Boolean).map((name) => ({ name, email: "" }));
  return es.map((email, i) => ({ name: ns[i] || "", email }));
}

function Row({ label, name, email, accent }: { label: string; name?: string | null; email?: string | null; accent?: boolean }) {
  const people = pairRecipients(name, email);
  if (!people.length) return null;
  return (
    <div className="flex items-start gap-2.5 px-3 py-1.5">
      <span className="w-7 shrink-0 pt-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">{label}</span>
      <div className="flex flex-wrap gap-1 min-w-0">
        {people.map((p, i) => (
          <span
            key={i}
            className={cn(
              "inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 text-[11px] leading-tight max-w-full",
              accent ? "bg-primary/5" : "bg-muted/50"
            )}
          >
            {p.name ? <span className="font-medium text-foreground truncate">{p.name}</span> : null}
            {p.email ? <span className="text-muted-foreground truncate">{p.email}</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Compact From / To / CC / BCC card, shared by the inbox + archive detail. */
export function EmailParticipants({ detail }: { detail: AnyRow }) {
  return (
    <div className="rounded-lg border bg-white divide-y divide-border/40 overflow-hidden">
      <Row label="From" name={detail.from_name} email={detail.from_email || detail.lead_email} accent />
      <Row label="To" name={detail.to_name} email={detail.to_email} />
      <Row label="CC" name={detail.prospect_cc_name} email={detail.prospect_cc_email} />
      <Row label="BCC" name={detail.prospect_bcc_name} email={detail.prospect_bcc_email} />
    </div>
  );
}
