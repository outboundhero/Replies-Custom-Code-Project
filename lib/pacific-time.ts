/** Current hour (0–23) in US Pacific time — DST-aware (PST/PDT). Vercel crons
 *  run in UTC, so "8 AM Pacific" is scheduled at both candidate UTC hours and
 *  the route checks this to run exactly once at the intended local time. */
export function pacificHour(d: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(d));
}
