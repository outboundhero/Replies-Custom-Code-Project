/**
 * Pure, dependency-free helpers for working with personal-mailbox domains.
 *
 * Lives in its own module (no Turso, no Supabase, no API clients) so it's
 * safe to import from "use client" components — domain-blacklist.ts pulls
 * in @/lib/errors → @/lib/db (Turso), which crashes the browser bundle
 * with `URL_INVALID: undefined` because TURSO_DATABASE_URL is server-only.
 */

/** Personal/free email mailbox providers — never blacklist these. */
export const PROTECTED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ca", "ymail.com", "rocketmail.com",
  "aol.com", "aim.com", "outlook.com", "hotmail.com", "hotmail.ca", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "att.net", "currently.com", "comcast.net", "xfinity.com",
  "verizon.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "spectrum.net",
  "frontier.com", "frontiernet.net", "optonline.net", "roadrunner.com", "rr.com", "twc.com",
  "centurylink.net", "q.com", "embarqmail.com", "earthlink.net", "juno.com", "netzero.net",
  "peoplepc.com", "myway.com", "gmx.com", "gmx.us", "mail.com", "email.com", "inbox.com",
  "usa.net", "zoho.com", "protonmail.com", "proton.me", "pm.me", "fastmail.com", "fastmail.fm",
  "hushmail.com", "hush.com", "hey.com", "pobox.com", "lycos.com", "excite.com", "cs.com",
  "vfemail.net", "duck.com", "relay.firefox.com", "mailfence.com", "startmail.com",
  "tutanota.com", "tutamail.com", "mailbox.org", "posteo.net", "runbox.com", "safe-mail.net",
  "lavabit.com", "iname.com", "consultant.com", "accountant.com", "engineer.com",
  "executive.com", "dr.com", "writeme.com", "programmer.net", "linuxmail.org", "rogers.com",
  "bell.net", "sympatico.ca", "shaw.ca", "telus.net", "videotron.ca",
]);

export function extractDomain(email: string): string | null {
  const parts = (email || "").split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

/**
 * True if the given email or bare domain is a free / personal mailbox provider.
 * Used by the inbox UI + the blacklist mutate route to refuse blacklisting
 * gmail.com, outlook.com, etc.
 */
export function isPersonalDomain(emailOrDomain: string): boolean {
  if (!emailOrDomain) return false;
  const domain = emailOrDomain.includes("@")
    ? extractDomain(emailOrDomain)
    : emailOrDomain.trim().toLowerCase();
  return !!domain && PROTECTED_DOMAINS.has(domain);
}
