/**
 * DM4PM Interested-Reply Subsequence — the 7 step templates (§10), verbatim.
 *
 * Deliberately NOT using `lib/processing/template-resolver.ts`: that resolver
 * fires GPT extraction and uses different token names ({PHONE}, {COMPANY}…).
 * DM4PM variables are pre-confirmed at enrollment, so a plain, deterministic
 * `replaceAll` renderer is correct and side-effect-free.
 *
 * Tokens: {FIRST_NAME} {PHONE_NUMBER} {SENDER_NAME} {NEXT_BUSINESS_DAY_1}
 * {NEXT_BUSINESS_DAY_2}. Greeting rule (§5): no first name → "Hi," (never
 * "Hi there,"). DNC rule (§15): strip {PHONE_NUMBER} + phone CTAs, never ask
 * for a number. Output is plain text (blank line between paragraphs); the send
 * path converts it to HTML via `plainTextToEmailHtml`.
 */

export const DM4PM_STEP_COUNT = 7;

export interface RenderVars {
  /** Confirmed first name, or "" when none was found/confirmed. */
  firstName: string;
  /** Confirmed phone, or "" when none confirmed. */
  phone: string;
  /** Sender display name (first token) of the account actually sending. */
  senderName: string;
  /** CTA business-day labels (steps 2–7). Computed at send time via `ctaDays`. */
  day1: string;
  day2: string;
  /** Do-Not-Call: strip all phone references and never ask for a number. */
  doNotCall: boolean;
}

// ── Raw step bodies (plain text; \n\n = paragraph break) ─────────────────────

// Step 1 has three mutually-exclusive variants selected at render time.
const STEP1_CONFIRMED_PHONE = `Hi {FIRST_NAME},

Wanted to follow up on this.

The main idea behind ScoreBig is helping property management teams consistently add another 5-15 clients per month without relying on the typical paid-lead model.

I was thinking about giving you a call at {PHONE_NUMBER} to talk through it briefly and see if it makes sense to talk more. Would that be okay?

{SENDER_NAME}`;

const STEP1_NO_PHONE = `Hi {FIRST_NAME},

Wanted to follow up on this.

The main idea behind ScoreBig is helping property management teams consistently add another 5-15 clients per month without relying on the typical paid-lead model.

Is there a good phone number to reach you at for a brief call to see if it makes sense to talk more?

{SENDER_NAME}`;

// Do-Not-Call step 1: no phone mention, no number ask (§15).
const STEP1_DNC = `Hi {FIRST_NAME},

Wanted to follow up on this.

The main idea behind ScoreBig is helping property management teams consistently add another 5-15 clients per month without relying on the typical paid-lead model.

Would you be open to going through it briefly to see if it makes sense to talk more?

{SENDER_NAME}`;

// Step 2's phone-ask line is appended only when NOT DNC and no confirmed phone.
const STEP2_HEAD = `Hi {FIRST_NAME},

Wanted to check back on this.

ScoreBig really came from 16+ years in property management and figuring out a better way to consistently add new clients without spending all your time chasing paid leads.

Would you have some time {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} to go through the details and see if it could work for your business?`;
const STEP2_PHONE_ASK = `If you'd prefer a phone call, what's the best number I can reach you at?`;
const STEP2_SIGNOFF = `{SENDER_NAME}`;

const STEP3 = `Hi {FIRST_NAME},

Not sure if you had a chance to think about this.

One reason I wanted to keep following up is we've seen what this can look like when it works. RHB Property Management went from closing around 1-2 clients per month to 15+ per month within 90 days of implementing ScoreBig.

Obviously every business is different, which is why it'd be worth going through the details and seeing whether it could make sense for yours.

Would {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} work?

{SENDER_NAME}`;

const STEP4 = `Hi {FIRST_NAME},

I know I've followed up a few times here.

Still think it'd be worth going through ScoreBig and seeing if there's a fit.

Would {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} work for you?

{SENDER_NAME}`;

const STEP5 = `Hi {FIRST_NAME},

Following up again because if adding another 5-15 property management/HOA clients per month is something you're trying to do, I do think this is worth looking at.

ScoreBig was built specifically around property management rather than being another generic paid-lead service.

Would you be available {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} to go through how it works and see if it would make sense for your business?

{SENDER_NAME}`;

const STEP6 = `Hi {FIRST_NAME},

I know I've followed up quite a bit here lol.

Would {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2} work to go through ScoreBig and see if it makes sense for your business?

If the timing isn't right, no worries either.

{SENDER_NAME}`;

const STEP7 = `Hi {FIRST_NAME},

Wanted to check in one more time before I stop reaching out for now. I don't want to bombard you with emails.

If you're still open to it, I'd like to go through ScoreBig in more detail and see whether helping you add another 5-15 clients per month is realistic for your business.

Would you be available {NEXT_BUSINESS_DAY_1} or {NEXT_BUSINESS_DAY_2}?

If not, no problem. I'll leave you alone for now and may check back in down the road.

{SENDER_NAME}`;

// ── Rendering ────────────────────────────────────────────────────────────────

/** Whether a step's copy references the {NEXT_BUSINESS_DAY_*} CTA days. */
export function stepUsesCtaDays(step: number): boolean {
  return step >= 2 && step <= 7;
}

/** Whether the confirmed phone can be used at all (never under DNC). */
function phoneUsable(v: RenderVars): boolean {
  return !v.doNotCall && !!v.phone.trim();
}

function applyTokens(text: string, v: RenderVars): string {
  // Greeting (§5): substitute the name, or collapse "Hi {FIRST_NAME}," → "Hi,".
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
 * Render one step's email body (plain text). `step` is 1-based (1–7).
 * Throws on an out-of-range step so a scheduling bug can't send an empty email.
 */
export function renderStep(step: number, v: RenderVars): string {
  let raw: string;
  switch (step) {
    case 1:
      raw = v.doNotCall ? STEP1_DNC : phoneUsable(v) ? STEP1_CONFIRMED_PHONE : STEP1_NO_PHONE;
      break;
    case 2: {
      // Append the phone-ask only when we may ask and have no confirmed number.
      const askPhone = !v.doNotCall && !v.phone.trim();
      raw = askPhone ? `${STEP2_HEAD}\n\n${STEP2_PHONE_ASK}\n\n${STEP2_SIGNOFF}` : `${STEP2_HEAD}\n\n${STEP2_SIGNOFF}`;
      break;
    }
    case 3: raw = STEP3; break;
    case 4: raw = STEP4; break;
    case 5: raw = STEP5; break;
    case 6: raw = STEP6; break;
    case 7: raw = STEP7; break;
    default:
      throw new Error(`renderStep: step out of range (${step})`);
  }
  return applyTokens(raw, v);
}
