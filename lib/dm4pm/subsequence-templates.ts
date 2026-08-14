/**
 * Interested-reply subsequence — the 7 step templates, per client tag.
 *
 * DM4PM copy is verbatim from the DM4PM spec §10; OH copy is verbatim from the
 * OutboundHero spec §9. Deterministic `replaceAll` rendering (no AI) — variables
 * are pre-confirmed at enrollment. Output is plain text (blank line between
 * paragraphs); the send path converts it to HTML.
 *
 * Tokens: {FIRST_NAME} {PHONE_NUMBER} {SENDER_NAME} {NEXT_BUSINESS_DAY_1}
 * {NEXT_BUSINESS_DAY_2}. Greeting rule: no first name → "Hi," (never "Hi there,").
 * DNC: strip {PHONE_NUMBER} + phone CTAs, never ask for a number.
 */

export const SUBSEQUENCE_STEP_COUNT = 7;
/** @deprecated use SUBSEQUENCE_STEP_COUNT */
export const DM4PM_STEP_COUNT = SUBSEQUENCE_STEP_COUNT;

export interface RenderVars {
  firstName: string;   // confirmed first name, or "" for a "Hi," greeting
  phone: string;       // confirmed phone, or ""
  senderName: string;  // sending account's first name
  day1: string;        // CTA business-day labels (steps 2–7)
  day2: string;
  doNotCall: boolean;  // strip phone refs, never ask
}

interface TemplateSet {
  step1Confirmed: string;
  step1NoPhone: string;
  step1Dnc: string;
  step2Head: string;
  step3: string;
  step4: string;
  step5: string;
  step6: string;
  step7: string;
}

// Shared lines (identical across clients).
const STEP2_PHONE_ASK = `If you'd prefer a phone call, what's the best number I can reach you at?`;
const SIGNOFF = `{SENDER_NAME}`;

// ── DM4PM (spec §10) ─────────────────────────────────────────────────────────
const DM4PM: TemplateSet = {
  step1Confirmed: `Hi {FIRST_NAME},

Wanted to follow up on this.

The main idea behind ScoreBig is helping property management teams consistently add another 5-15 clients per month without relying on the typical paid-lead model.

I was thinking about giving you a call at {PHONE_NUMBER} to talk through it briefly and see if it makes sense to talk more. Would that be okay?

{SENDER_NAME}`,
  step1NoPhone: `Hi {FIRST_NAME},

Wanted to follow up on this.

The main idea behind ScoreBig is helping property management teams consistently add another 5-15 clients per month without relying on the typical paid-lead model.

Is there a good phone number to reach you at for a brief call to see if it makes sense to talk more?

{SENDER_NAME}`,
  step1Dnc: `Hi {FIRST_NAME},

Wanted to follow up on this.

The main idea behind ScoreBig is helping property management teams consistently add another 5-15 clients per month without relying on the typical paid-lead model.

Would you be open to going through it briefly to see if it makes sense to talk more?

{SENDER_NAME}`,
  step2Head: `Hi {FIRST_NAME},

Wanted to check back on this.

ScoreBig really came from 16+ years in property management and figuring out a better way to consistently add new clients without spending all your time chasing paid leads.

Would you have some time {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} to go through the details and see if it could work for your business?`,
  step3: `Hi {FIRST_NAME},

Not sure if you had a chance to think about this.

One reason I wanted to keep following up is we've seen what this can look like when it works. RHB Property Management went from closing around 1-2 clients per month to 15+ per month within 90 days of implementing ScoreBig.

Obviously every business is different, which is why it'd be worth going through the details and seeing whether it could make sense for yours.

Would {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} work?

{SENDER_NAME}`,
  step4: `Hi {FIRST_NAME},

I know I've followed up a few times here.

Still think it'd be worth going through ScoreBig and seeing if there's a fit.

Would {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} work for you?

{SENDER_NAME}`,
  step5: `Hi {FIRST_NAME},

Following up again because if adding another 5-15 property management/HOA clients per month is something you're trying to do, I do think this is worth looking at.

ScoreBig was built specifically around property management rather than being another generic paid-lead service.

Would you be available {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} to go through how it works and see if it would make sense for your business?

{SENDER_NAME}`,
  step6: `Hi {FIRST_NAME},

I know I've followed up quite a bit here lol.

Would {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} work to go through ScoreBig and see if it makes sense for your business?

If the timing isn't right, no worries either.

{SENDER_NAME}`,
  step7: `Hi {FIRST_NAME},

Wanted to check in one more time before I stop reaching out for now. I don't want to bombard you with emails.

If you're still open to it, I'd like to go through ScoreBig in more detail and see whether helping you add another 5-15 clients per month is realistic for your business.

Would you be available {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2}?

If not, no problem. I'll leave you alone for now and may check back in down the road.

{SENDER_NAME}`,
};

// ── OutboundHero (spec §9) ───────────────────────────────────────────────────
const OH: TemplateSet = {
  step1Confirmed: `Hi {FIRST_NAME},

Wanted to follow up on this.

We typically help commercial cleaning companies generate 20-40 Quality Leads per month, with a minimum of 20 guaranteed.

I was thinking about giving you a call at {PHONE_NUMBER} to talk through it briefly and see if it makes sense to talk more. Would that be okay?

{SENDER_NAME}`,
  step1NoPhone: `Hi {FIRST_NAME},

Wanted to follow up on this.

We typically help commercial cleaning companies generate 20-40 Quality Leads per month, with a minimum of 20 guaranteed.

Is there a good phone number to reach you at for a brief call to see if it makes sense to talk more?

{SENDER_NAME}`,
  // DNC variant (mirrors DM4PM's approach — no phone mention / no number ask, §14).
  step1Dnc: `Hi {FIRST_NAME},

Wanted to follow up on this.

We typically help commercial cleaning companies generate 20-40 Quality Leads per month, with a minimum of 20 guaranteed.

Would you be open to talking through it briefly to see if it makes sense to talk more?

{SENDER_NAME}`,
  step2Head: `Hi {FIRST_NAME},

Wanted to check back on this.

Would you have some time {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} to talk through the details and see if it could work for your business?`,
  step3: `Hi {FIRST_NAME},

Not sure if you had a chance to think about this.

The goal is really to help you consistently bring on more recurring commercial cleaning accounts. We typically generate 20-40 Quality Leads per month, and then your team handles the conversations, walkthroughs and closing from there.

The first 20 Quality Leads are guaranteed, so you're not taking the risk of paying us and then having us fall short on what we promised.

Would you have some time {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} to talk through how everything works and see if it makes sense for your business?

{SENDER_NAME}`,
  step4: `Hi {FIRST_NAME},

I know I've followed up a few times here.

Still think it'd be worth talking through and seeing if there's a fit.

Would {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} work for you?

{SENDER_NAME}`,
  step5: `Hi {FIRST_NAME},

Following up again because I do think this could make sense if you're looking to grow the commercial cleaning side of the business.

We're typically looking to generate 20-40 Quality Leads per month in your market, with at least 20 guaranteed. The goal is to give your team a consistent flow of businesses interested in commercial cleaning that you can turn into walkthroughs and recurring accounts.

If we don't deliver the minimum, you get your money back.

Would you be available {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} to go through the details and see if this would actually work for your business?

{SENDER_NAME}`,
  step6: `Hi {FIRST_NAME},

I know I've followed up quite a bit here lol.

Would {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} work to talk through everything and see if it makes sense for your business?

If you're not interested right now, no worries either.

{SENDER_NAME}`,
  step7: `Hi {FIRST_NAME},

Wanted to check in one more time before I stop reaching out for now. I don't want to bombard you with emails.

If you're still open to it, I'd like to talk through everything in more detail and see if what we're doing would actually work for your business.

Would you be available {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2}?

If not, no problem. I'll leave you alone for now and may check back in down the road.

{SENDER_NAME}`,
};

const SETS: Record<string, TemplateSet> = { DM4PM, OH };

// ── Rendering ────────────────────────────────────────────────────────────────

export function stepUsesCtaDays(step: number): boolean {
  return step >= 2 && step <= 7;
}

function applyTokens(text: string, v: RenderVars): string {
  let out = v.firstName.trim()
    ? text.replaceAll("{FIRST_NAME}", v.firstName.trim())
    : text.replace("Hi {FIRST_NAME},", "Hi,").replaceAll("{FIRST_NAME}", "");
  out = out
    .replaceAll("{PHONE_NUMBER}", v.phone.trim())
    .replaceAll("{SENDER_NAME}", v.senderName.trim())
    .replaceAll("{NEXT_BUSINESS_DAY_1}", v.day1)
    .replaceAll("{NEXT_BUSINESS_DAY_2}", v.day2);
  return out;
}

/**
 * Render one step's email body (plain text) for a client tag. `step` is 1-based
 * (1–7). Throws on an unknown tag or out-of-range step so a bug can't send an
 * empty or wrong-client email.
 */
export function renderStep(tag: string, step: number, v: RenderVars): string {
  const set = SETS[(tag || "").toUpperCase()];
  if (!set) throw new Error(`renderStep: no template set for tag "${tag}"`);
  const phoneUsable = !v.doNotCall && !!v.phone.trim();

  let raw: string;
  switch (step) {
    case 1:
      raw = v.doNotCall ? set.step1Dnc : phoneUsable ? set.step1Confirmed : set.step1NoPhone;
      break;
    case 2: {
      const askPhone = !v.doNotCall && !v.phone.trim();
      raw = askPhone ? `${set.step2Head}\n\n${STEP2_PHONE_ASK}\n\n${SIGNOFF}` : `${set.step2Head}\n\n${SIGNOFF}`;
      break;
    }
    case 3: raw = set.step3; break;
    case 4: raw = set.step4; break;
    case 5: raw = set.step5; break;
    case 6: raw = set.step6; break;
    case 7: raw = set.step7; break;
    default:
      throw new Error(`renderStep: step out of range (${step})`);
  }
  return applyTokens(raw, v);
}
