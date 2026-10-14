/**
 * Browser side of a background Send Reply (lib/send-jobs.ts): after the server
 * has taken the send, ask it every second or so how the send went, until it
 * says "sent" or "failed" — or until it is clear no answer is coming.
 */

export type SendOutcome =
  | { status: "sent" }
  | { status: "failed"; error: string }
  | { status: "unknown"; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForSend(jobId: string, opts: { intervalMs?: number; maxMs?: number } = {}): Promise<SendOutcome> {
  const { intervalMs = 1200, maxMs = 150_000 } = opts;
  const until = Date.now() + maxMs;
  // Email Bison takes a second or more to send, so the first look is a little later.
  let wait = 900;
  while (Date.now() < until) {
    await sleep(wait);
    wait = intervalMs;
    try {
      const res = await fetch("/api/inbox/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send-status", jobIds: [jobId] }),
      });
      if (res.status === 401) return { status: "unknown", error: "your login expired before the send reported back" };
      const d = (await res.json().catch(() => null)) as { jobs?: { id: string; status: string; error: string | null }[] } | null;
      const job = d?.jobs?.find((j) => j.id === jobId);
      if (!job || job.status === "sending") continue;
      if (job.status === "sent") return { status: "sent" };
      if (job.status === "failed") return { status: "failed", error: job.error || "Send failed" };
      return { status: "unknown", error: job.error || "the send never reported back" };
    } catch {
      // A blip asking — the send itself is unaffected. Ask again.
    }
  }
  return { status: "unknown", error: "no answer yet" };
}
