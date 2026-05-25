import { logActivity, logError } from "@/lib/errors";
import { getInstanceConfig } from "@/lib/bison-instances";
// Re-export the pure helpers so server-side callers can keep importing
// from this module. Browser-side callers must import from
// @/lib/processing/personal-domains directly — this file pulls in db.
import { PROTECTED_DOMAINS, extractDomain, isPersonalDomain } from "./personal-domains";
export { PROTECTED_DOMAINS, extractDomain, isPersonalDomain };

const BLACKLIST_TRIGGERS = [
  "don't have a physical office",
  "don't have an office",
  "do not have an office",
  "do not have a physical office",
  "we all work remote",
  "we are fully remote",
  "no office to clean",
  "remove our company",
  "remove us",
  "remove my company",
  "take us off",
  "remove all of my company",
  "remove my business",
  "remove my firm",
  "take my firm off",
  "unsubscribe us",
  "unsubscribe everyone",
  "take everyone off",
  "take everyone out of",
  "remove everyone from",
  "remove us all",
  "stop emails to my company",
  "stop emailing us",
  "unsub us all",
  "end all emails to us",
  "pause emails to us",
  "pause all emails to my company",
  "pause all emails to my business",
  "stop all emails to us",
  "remove all of us from",
  "unsub all of my company",
  "unsubscribe all of my company",
  "remove this domain from",
  "unsubscribe my company",
  "end emails to my company",
  "you have been reported to the ftc",
  "you are in violation of the can spam act due to",
  "violation of the can-spam act",
  "can-spam violation due to",
  "anti-spam legislation violation due to",
  "violation of the canadian anti-spam legislation",
  "hault communication to us",
  "final warning to take us off",
  "last warning to remove us",
  "final warning to remove us",
  "final warning to remove my company",
  "final warning to take us off",
  "do not contact us anymore",
  "do not send anything further",
  "delete my company's info",
  "delete my business from",
  "delete my company from",
  "delete my company's email from",
  "delete our info",
  "please remove us",
  "take us off your list",
  "remove me and my team",
  "don't contact us again",
  "take us off your distribution",
  "unsubscribe us from your",
  "remove my email and company",
  "unsubscribe my entire org",
  "we don't want to receive these",
  "stop reaching out to us",
  "no more emails to my company please",
  "remove this company from your list",
  "cease communication with us",
  "cease all emails to our team",
  "cease all emails to my company",
  "cease all emails to our company",
  "stop sending these to us",
  "i've asked you before—remove us",
  "take this domain off your list",
  "unsubscribe our organization",
  "blacklist this domain",
  "this is your final notice",
  "cease all further contact",
  "this is harassment",
  "report filed with authorities",
  "stop contacting our team",
  "we're not interested — remove us",
  "we've asked multiple times",
  "we've asked you multiple times",
  "remove everyone at this domain",
  "unsubscribe our domain",
  "take our entire company off",
  "take this company off your drip",
  "please delete all our emails",
  "opt us out",
  "we opt out",
  "we never opted in",
  "stop soliciting us",
  "do not solicit our business",
  "remove us",
  "stop all outreach",
  "you are violating privacy laws",
  "remove our company from your list",
  "stop emailing our company",
  "unsubscribe our entire team",
  "take our organization off your list",
  "remove our whole company",
  "do not contact our company again",
  "cease contact with our team",
  "unsubscribe all users at our domain",
  "end communications with our organization",
  "do not email our staff",
  "remove all our users",
  "stop contacting anyone here",
  "stop marketing to our company",
  "unsubscribe our domain entirely",
  "get our company off your list",
  "unsubscribe this organization",
  "take this company off your system",
  "permanently remove our company",
  "remove every contact at our company",
  "delete our company from your outreach",
  "we do not wish to be contacted as a company",
  "remove every user at this domain",
  "do not email us or our staff again",
  "unsubscribe our business",
  "unsubscribe the whole company",
  "unsubscribe the team",
  "your emails are unwelcome at our",
];

// PROTECTED_DOMAINS now lives in ./personal-domains (re-exported above).

/**
 * Check if the reply body or subject contains any blacklist trigger phrase.
 */
export function shouldBlacklistDomain(subject: string, body: string): string | null {
  const combined = `${subject} ${body}`.toLowerCase();
  return BLACKLIST_TRIGGERS.find((trigger) => combined.includes(trigger)) || null;
}

// extractDomain + isPersonalDomain now live in ./personal-domains (re-exported above).

/**
 * Blacklist a domain via the Bison API for a specific instance, and log
 * the activity. Non-blocking — errors are logged but don't throw.
 *
 * `instanceKey` is required because each Bison instance has its own
 * blacklist. Blacklisting a domain on outboundhero does not blacklist
 * it on facilityreach — the operator must call this once per instance
 * if they want it banned everywhere. (For now we only blacklist on the
 * instance the lead came from, which is the right answer for the
 * inbox/auto-categorizer flow.)
 */
export async function blacklistDomain(
  instanceKey: string,
  fromEmail: string,
  matchedPhrase: string,
  workflow: string,
  opts?: { client_tag?: string; section_name?: string }
): Promise<void> {
  const domain = extractDomain(fromEmail);
  if (!domain) return;
  if (PROTECTED_DOMAINS.has(domain)) return;

  try {
    const { baseUrl, token } = getInstanceConfig(instanceKey);
    const res = await fetch(`${baseUrl}/api/blacklisted-domains`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ domain }),
    });

    if (!res.ok) {
      const body = await res.text();
      // 422 "already been taken" = domain already blacklisted — treat as success
      if (res.status === 422 && body.includes("already been taken")) {
        // Still log activity so dashboard shows it was already blacklisted
        await logActivity(workflow, "domain-already-blacklisted", {
          client_tag: opts?.client_tag,
          section_name: opts?.section_name,
          lead_email: fromEmail,
          details: { domain, matched_phrase: matchedPhrase, bison_instance: instanceKey },
        });
        return;
      }
      throw new Error(`Blacklist API failed (${res.status}): ${body}`);
    }

    await logActivity(workflow, "domain-blacklisted", {
      client_tag: opts?.client_tag,
      section_name: opts?.section_name,
      lead_email: fromEmail,
      details: { domain, matched_phrase: matchedPhrase, bison_instance: instanceKey },
    });
  } catch (error) {
    await logError(workflow, "blacklist", (error as Error).message, {
      domain,
      from_email: fromEmail,
      matched_phrase: matchedPhrase,
      bison_instance: instanceKey,
    });
  }
}

/**
 * Blacklist an email address via the Bison API for a specific instance.
 * Called when AI categorizes a reply as "Do Not Contact".
 * Non-blocking — errors are logged but don't throw.
 */
export async function blacklistEmail(
  instanceKey: string,
  email: string,
  workflow: string,
  opts?: { client_tag?: string; section_name?: string }
): Promise<void> {
  if (!email) return;

  try {
    const { baseUrl, token } = getInstanceConfig(instanceKey);
    const res = await fetch(`${baseUrl}/api/blacklisted-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 422 && body.includes("already been taken")) {
        await logActivity(workflow, "email-already-blacklisted", {
          client_tag: opts?.client_tag,
          section_name: opts?.section_name,
          lead_email: email,
          details: { email, bison_instance: instanceKey },
        });
        return;
      }
      throw new Error(`Email blacklist API failed (${res.status}): ${body}`);
    }

    await logActivity(workflow, "email-blacklisted", {
      client_tag: opts?.client_tag,
      section_name: opts?.section_name,
      lead_email: email,
      details: { email, bison_instance: instanceKey },
    });
  } catch (error) {
    await logError(workflow, "email-blacklist", (error as Error).message, {
      email,
      bison_instance: instanceKey,
    });
  }
}
