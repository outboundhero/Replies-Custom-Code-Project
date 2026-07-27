/**
 * Returns only the LEAD's own new message from a reply, stripping the quoted
 * history / forwarded original email underneath.
 *
 * Why this matters for qualification: a reply's quoted history contains OUR
 * client's original outbound email — including the client's own signature,
 * website, address and "commercial cleaning & janitorial" wording. If the
 * enrichment / industry audit reads that quoted block it can mistake the
 * CLIENT's identity for the LEAD's (e.g. flag a flooring company as a
 * "janitorial competitor", or borrow the client's office address). Determining
 * the lead's company/industry/location from ONLY their new message fixes that.
 */
export function stripQuotedHistory(text: string): string {
  if (!text) return "";
  const t = text.replace(/\r\n/g, "\n");

  // Cut at the FIRST quoted-reply / forwarded-message marker. Emails vary wildly
  // in whitespace (inline "   On … wrote:  > …" with spaces, or real newlines),
  // so these do NOT require a leading newline.
  const markers: RegExp[] = [
    /\bOn\s.{0,160}?\bwrote:/i,                  // "On Thu, Jul 23, 2026 at 4:25 PM X <e> wrote:"
    /-{2,}\s*Original Message\s*-{2,}/i,         // "-----Original Message-----"
    /-{2,}\s*Forwarded message\s*-{2,}/i,
    /\bFrom:\s.{0,200}?\b(?:Sent|Date):\s/i,     // Outlook header block
    /_{5,}/,                                      // Outlook underscores separator
    /Begin forwarded message:/i,
    /Sent from my /i,                            // mobile sig — keep nothing after it
    /(?:^|\s)>\s?\S/,                             // first quoted (">") line/span
  ];

  let cut = t.length;
  for (const re of markers) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }

  const head = t.slice(0, cut).trim();
  // Never return empty — if the reply *starts* with a marker, keep the original.
  return head || t.trim();
}
