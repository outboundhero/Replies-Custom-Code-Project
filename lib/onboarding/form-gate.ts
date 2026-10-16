/**
 * When a client's Onboarding Form counts as "in" (OutboundHero's rule, 2026-10-16): its row on the
 * Onboarding Form Responses tab has the client tag in column A AND the Onboarding Call date in
 * column D. Until then the steps that build from the form — "Set up in Reply Router" and the
 * campaigns — wait, and the client's onboarding pages say so. Nothing else stands in for the form.
 *
 * Only the onboarding flow uses this: the hourly qualification sync and the client page keep
 * reading every row (plenty of live clients' rows have no Onboarding Call date).
 */
import { withCache, setCached } from "@/lib/server-cache";
import { fetchOnboardingFormDetails, type OnboardingFormDetails } from "@/lib/google-sheets";

export type FormState = "in" | "no-row" | "no-call-date" | "no-column" | "unread";
export interface FormGate {
  state: FormState;
  ready: boolean;
  /** The client's answers — only when the form is in. */
  form?: OnboardingFormDetails;
  /** Why it isn't in yet (null when it is). */
  message: string | null;
}

const CACHE_KEY = "onboarding:form-details";

/** The gate for one client. `fresh` reads the sheet now (and refreshes the shared cache the steps read). */
export async function onboardingFormGate(tag: string, fresh = false): Promise<FormGate> {
  const T = tag.trim().toUpperCase();
  let all: Map<string, OnboardingFormDetails>;
  try {
    if (fresh) { all = await fetchOnboardingFormDetails(); setCached(CACHE_KEY, all); }
    else all = await withCache(CACHE_KEY, 60_000, fetchOnboardingFormDetails);
  } catch {
    return { state: "unread", ready: false, message: "Couldn't read the Onboarding Form just now — try again in a moment." };
  }
  return gateFor(T, all.get(T));
}

export function gateFor(tag: string, form: OnboardingFormDetails | undefined): FormGate {
  const rule = `It counts once its row on the Onboarding Form Responses tab has ${tag} in column A and the Onboarding Call date in column D.`;
  if (!form) return { state: "no-row", ready: false, message: `Waiting for ${tag}'s Onboarding Form — there's no row for ${tag} yet. ${rule}` };
  if (form.onboardingCall === null) return { state: "no-column", ready: false, message: `The Onboarding Form has no "Onboarding Call" column any more, so it can't tell whether ${tag}'s form is in.` };
  if (!form.onboardingCall.trim()) return { state: "no-call-date", ready: false, message: `Waiting for ${tag}'s Onboarding Form — its row has no Onboarding Call date (column D) yet. ${rule}` };
  return { state: "in", ready: true, form, message: null };
}
