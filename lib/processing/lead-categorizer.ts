const VALID_CATEGORIES = [
  "Unrecognizable by AI",
  "Interested",
  "Meeting Request",
  "Follow Up at a Later Date",
  "Not Interested",
  "Out Of Office",
  "Wrong Person",
  "Mailbox No Longer Active",
  "Automated Error Message",
  "Automated Catch-All Message",
  "Wrong Person (Change of Target)",
  "Do Not Contact",
  // New: lead has redirected us to someone else (with enough info to act)
  "Referral Given",
  // New: lead said they passed our email along internally (no contact info)
  "Internally Forwarded",
] as const;

export type LeadCategory = (typeof VALID_CATEGORIES)[number];

/** Categories that should receive CC/BCC and reply template in Airtable */
export const CC_BCC_CATEGORIES: LeadCategory[] = [
  "Interested",
  "Meeting Request",
  "Follow Up at a Later Date",
  "Unrecognizable by AI",
];

/** Maps AI category → Lead Category (overrides "Open Response") */
const LEAD_CATEGORY_MAP: Partial<Record<LeadCategory, string>> = {
  "Out Of Office": "Out Of Office",
  "Do Not Contact": "Do Not Contact",
  "Mailbox No Longer Active": "Mailbox No Longer Active",
  "Automated Error Message": "Automated Reply",
  "Automated Catch-All Message": "Automated Reply",
  "Referral Given": "Referral Given",
  "Internally Forwarded": "Internally Forwarded",
};

export function getLeadCategory(aiCategory: LeadCategory | null): string {
  if (aiCategory && LEAD_CATEGORY_MAP[aiCategory]) {
    return LEAD_CATEGORY_MAP[aiCategory]!;
  }
  return "Open Response";
}

function buildSystemPrompt(fromEmail: string, ccEmails: string): string {
  return `#CONTEXT#

Utilize AI capabilities to classify emails into predefined categories based on their content.

This is the person that we received an email from: ${fromEmail} & if anyone was CC'd it was ${ccEmails || "no one"} — this is the reply I want you to analyze and classify accurately.

#OBJECTIVE#

Categorize each email reply into ONE of these categories:
1. Unrecognizable by AI
2. Interested
3. Meeting Request
4. Follow Up at a Later Date
5. Not Interested
6. Out Of Office
7. Wrong Person
8. Mailbox No Longer Active
9. Automated Error Message
10. Automated Catch-All Message
11. Wrong Person (Change of Target)
12. Do Not Contact
13. Referral Given
14. Internally Forwarded

Most of the time, the prospect/lead's email will be above the "-----Original Message-----" line and this is what I want you to analyze. Our email or multiple email outreach is underneath that text. Sometimes though, there will not be a "-----Original Message-----", so please evaluate the email accordingly.

#REFERRAL / FORWARD / WRONG-PERSON DECISION TREE#

Use this exact decision tree when the lead is redirecting us to someone else:

A. Is the redirect coming from an AUTOMATED email (an autoresponder template, "no longer with the company" auto-reply, mass form-letter, etc.)?
   - YES, and it provides an alternative email address → "Wrong Person (Change of Target)"
   - YES, and it does NOT provide an alternative email address → "Wrong Person"
   - NO (this is a human-written reply) → continue to B.

B. Did the human lead give us enough info to act on the referral? Specifically, ANY of:
   • A full name AND last name of the right contact, OR
   • A full email address of the right contact, OR
   • A phone number for the right contact, OR
   • CC'd the right person on this very reply (look at the "CC'd" list above — if any non-our address appears that the lead added, that's a CC referral).
   → "Referral Given"

C. Did the human lead just say they "forwarded" / "passed it along" / mentioned only a first name of someone internal, with no full contact info and no CC?
   → "Internally Forwarded"

D. Otherwise (human says they're not the right person but gives no useful info) → "Wrong Person"

CRITICAL: "Wrong Person (Change of Target)" is RESERVED for AUTOMATED emails only. If a human types out the redirect themselves, it is NEVER "Wrong Person (Change of Target)" — it is "Referral Given", "Internally Forwarded", or "Wrong Person" per the tree above.

#OTHER NOTES#

Note: if the prospect's email reply is something like: "Unsure" or "Maybe", return Interested in the output because they are likely interested if we provide more information.

#INSTRUCTIONS#

1. Analyze the reply body and reply subject to determine the latest reply email's category.
2. Prioritize explicit phrases that clearly indicate a category, such as "I'm out of the office", "I'm on vacation", "Please contact someone else", "Stop contacting me", or "Do not contact".

3. OPT-OUT KEYWORDS — if the reply body OR subject contains ANY of the following words/phrases (case-insensitive, substring match), categorize as "Do Not Contact" regardless of any other content in the reply:

   Standard opt-out phrases:
   "STOP", "QUIT", "END", "NO MORE", "NO MORE EMAILS", "REMOVE ME", "remove me",
   "remove my email", "take me off", "take my email off", "take my email out",
   "unsubscribe", "unsubscribe me", "end outreach", "stop outreach",
   "halt outreach", "kick rocks", "add to blacklist"

   QA codewords — these are testing signals; ALWAYS treat as Do Not Contact even
   though they look like food/animal words and have no opt-out meaning in English:
   "HOT DOG", "PINEAPPLE", "TACO", "BANANA", "WAFFLE", "PIZZA", "BURRITO",
   "PICKLE", "HAMBURGER", "MEATBALL", "NACHO", "PRETZEL", "MUFFIN", "POTATO",
   "DONUT", "NOODLE", "PENGUIN", "LLAMA", "OTTER", "KAZOO"

   These keywords override every other rule including the referral / forward /
   wrong-person decision tree. If a reply contains "BANANA" the answer is
   "Do Not Contact" — full stop.

4. If the AI cannot confidently classify the email based on the provided data, assign it to "Unrecognizable by AI". Note: if the person replying provides only their phone number in their reply (and is the lead themselves, not redirecting), then categorize it as "Interested".

Please categorize replies as Do Not Contact if there's anything mentioned in the reply as something was attached like a Docusign, agreement link, or invoice – these replies are either malicious links or documents OR they are trying to have us pay them money.

Some scenarios that count as Interested:
- The person we emailed replied and said they would be open to seeing an estimate even though they're not interested at this exact time.
- The person we emailed is indeed the right person for our service.
- The person we emailed replies with a concise "sure", "yes", "of course", "that's fine", or some other short affirmative.
- The person we emailed replies with positive intent and explains what they need.
- If the person says we are welcome to send over an estimate/proposal/quote/bid or pitch.
- If the person asks a specific question with intent to know additional information.

NOTE: if the lead points us to a colleague WITHOUT staying engaged themselves, that is "Referral Given" or "Internally Forwarded" (per the decision tree above), NOT "Interested". "Interested" requires the lead themselves to keep the conversation open.

#EXAMPLES#

Example 1:
  Reply Subject: "Meeting Request for next week"
  Reply Body: "I would like to schedule a meeting for next Tuesday."
Expected Output: "Meeting Request"

Example 2:
  Reply Subject: "Out of Office Notice"
  Reply Body: "I'm currently out of the office and will return on Monday."
Expected Output: "Out Of Office"

Example 3:
  Reply Subject: "Re: shockwave"
  Reply Body: "Hi David, Not all shockwave devices are equal. What is the brand of your devices? We currently use Storz. I am not interested in anything of lesser quality. Thanks Kathy Thornburg"
Expected Output: "Interested" — Kathy is asking a specific question for additional information.

Example 4 — REFERRAL GIVEN (full name + phone):
  Reply Subject: "Re: cleaning question"
  Reply Body: "Call Brad Stephens at 615-883-3918 — he is in charge of all cleaning and maintenance."
Expected Output: "Referral Given" — full name + phone number for the right contact, human-written.

Example 5:
  Reply Subject: "UNSUBSCRIBE Re: Quick cleaning question"
  Reply Body: (signature only, no message body)
Expected Output: "Do Not Contact" — explicit opt-out in subject.

Example 6 — REFERRAL GIVEN (multiple full emails, human-written):
  Reply Subject: "Please redirect your enquiry Re: ..."
  Reply Body: "I am no longer working on Pon.Bike Performance projects so please direct all enquiries as follows: Cervélo: Brian Bernard (bbernard@cervelo.com); Santa Cruz: Seb Kemp (seb.kemp@santacruzbicycles.com) ..."
Expected Output: "Referral Given" — human-written, multiple full names + emails. (NOT "Wrong Person (Change of Target)" — that's automated only.)

Example 7:
  Reply Subject: "I am no longer at RAFT Re: cleaning question"
  Reply Body: (empty)
Expected Output: "Wrong Person" — subject says they're no longer there, no alternative contact provided.

Example 8 — REFERRAL GIVEN (full email, human-written):
  Reply Subject: "Re: Question regarding your cleaning setup"
  Reply Body: "Please direct your correspondence to our USA office usa@driftwooddrilling.com"
Expected Output: "Referral Given" — full email address of the right contact.

Example 9 — INTERNALLY FORWARDED (just first name, no contact info):
  Reply Subject: "RE: Independence cleaning"
  Reply Body: "Hi Jenny, We do not manage that property. You would need to contact Sonja with the Clay County DDRB."
Expected Output: "Internally Forwarded" — first name only, no email/phone, no CC.

Example 10:
  Reply Subject: "Re: Quick question"
  Reply Body: "Sorry it is done through the city. Have a nice day!"
Expected Output: "Not Interested"

Example 11 — REFERRAL GIVEN (full name + email, human-written):
  Reply Subject: "Re: Pontiac cleaning"
  Reply Body: "Please contact the director, Colleen Vieira, cvieira@pontiaclibrary.org. The librarians cannot make decisions on contractor hiring."
Expected Output: "Referral Given" — full name + email for the right contact.

Example 12:
  Reply Subject: "RE: Cleaning proposal"
  Reply Body: "You are welcome to send over an estimate if you wish. I am just not currently looking."
Expected Output: "Interested" — explicitly welcomes an estimate.

Example 13:
  Reply Subject: "Re: Inquiry about your cleaning services"
  Reply Body: "See below rashell Thank You! Jay Grandella Construction & Grand Gutters! 5107919811"
Expected Output: "Unrecognizable by AI"

Example 14:
  Reply Subject: "RE: Steve suggestion"
  Reply Body: "We are always interested but we do have current contractual lead sources currently."
Expected Output: "Interested"

Example 15:
  Reply Subject: "Re: Complimentary cleaning estimate"
  Reply Body: "Thank you for the inquiry. A service Technician will call you the soonest possible. Please download SERVICE REQUEST FORM from the link below..."
Expected Output: "Automated Catch-All Message"

Example 16:
  Reply Subject: "Thoughts Beverly"
  Reply Body: "Who are you and what company are you with?"
Expected Output: "Interested"

Example 17:
  Reply Subject: "Re: Arlington UMC"
  Reply Body: "Please call me at 615-733-9818. Thank you, Shannon White"
Expected Output: "Interested" — phone number from the LEAD themselves, not a referral redirect.

Example 18:
  Reply Subject: "Re: Question regarding your cleaning setup"
  Reply Body: "Hi Sara I am the person who hires [contact card attached]"
Expected Output: "Interested"

Example 19:
  Reply Subject: "Re: Pierre might be useful"
  Reply Body: (empty)
Expected Output: "Unrecognizable by AI"

Example 20:
  Reply Subject: "Re: Your McLean location"
  Reply Body: "Thank you, Jess, we're all set."
Expected Output: "Not Interested"

Example 21:
  Reply Subject: "Re: Cleaning question"
  Reply Body: "no more ben is gone! remove him ben@withhomemade.com and me please"
Expected Output: "Do Not Contact"

Example 22:
  Reply Subject: "Dr. Ed @ Vitality Chiropractic"
  Reply Body: "I was just on your website. I would be interested in talking to you regarding Shockwave."
Expected Output: "Interested"

Example 23:
  Reply Subject: "Re: Quick question Gregg Orthodontics Team"
  Reply Body: "END"
Expected Output: "Do Not Contact"

Example 24:
  Reply Subject: "Re: Cleaners"
  Reply Body: "435-229-7415 Cary Blake C. Blake Homes"
Expected Output: "Interested" — the LEAD is giving us their own number to call, not redirecting.

Example 25:
  Reply Subject: "Re: Quick question Liz"
  Reply Body: "Hi Dan, I believe you have the wrong email address. I don't offer services of that type. Please take me off your list."
Expected Output: "Do Not Contact"

Example 26:
  Reply Subject: "Re: rates"
  Reply Body: "Yes What are your rates"
Expected Output: "Interested"

Example 27:
  Reply Subject: "Re: Question about cleaning"
  Reply Body: "Hi Rebecca, We already have a cleaning service we like. If anything changes we can let you know."
Expected Output: "Not Interested"

Example 28:
  Reply Subject: "RE: Triton"
  Reply Body: "Cannot do a meeting today. How about Tuesday, April 1, at 11am CST?"
Expected Output: "Meeting Request"

Example 29:
  Reply Subject: "Re: Question about cleaning"
  Reply Body: "We are located in Utah - long ways from Boise"
Expected Output: "Unrecognizable by AI"

Example 30:
  Reply Subject: "Re: Cleaning in the Liberty area"
  Reply Body: "Would Independence be in your area?"
Expected Output: "Interested"

Example 31:
  Reply Subject: "Re: [Spam] Cleaning question."
  Reply Body: "Actually, the school we lease from has hired a company who takes care of the cleaning for us."
Expected Output: "Not Interested"

Example 32:
  Reply Subject: "Re: Your building in Lawrence"
  Reply Body: "We have a full time maintenance person on staff."
Expected Output: "Not Interested"

Example 33 — INTERNALLY FORWARDED (passed it along, no specifics):
  Reply Subject: "Re: cleaning question"
  Reply Body: "Forwarded this to our facilities team. They'll reach out if interested."
Expected Output: "Internally Forwarded" — said they forwarded internally, no contact info, no CC.

Example 34 — REFERRAL GIVEN via CC:
  Reply Subject: "Re: cleaning question"
  Reply Body: "Adding John on this — he handles facilities."
  CC'd on this reply: "john.smith@acme.com"
Expected Output: "Referral Given" — they CC'd the right person directly on the reply.

Example 35 — WRONG PERSON (CHANGE OF TARGET) — automated:
  Reply Subject: "Automatic reply: cleaning question"
  Reply Body: "I am no longer with Acme Corp. For all matters please contact admin@acme.com. This is an automated response."
Expected Output: "Wrong Person (Change of Target)" — automated reply with an alternative email.

Example 36 — WRONG PERSON — automated, no alternative:
  Reply Subject: "Automatic reply"
  Reply Body: "I have left the company. This mailbox is no longer monitored."
Expected Output: "Wrong Person" — automated, no alternative contact provided.

Example 37 — QA codeword (food):
  Reply Subject: "RE: Quick cleaning question"
  Reply Body: "BANANA"
Expected Output: "Do Not Contact" — QA opt-out codeword.

Example 38 — Standard opt-out keyword:
  Reply Subject: "Re: Cleaning"
  Reply Body: "QUIT"
Expected Output: "Do Not Contact" — explicit one-word opt-out.

Example 39 — Opt-out phrase embedded in a sentence:
  Reply Subject: "Re: Service inquiry"
  Reply Body: "Please take my email off your list and end outreach. Thank you."
Expected Output: "Do Not Contact" — contains "take my email off" and "end outreach".

#OUTPUT FORMAT#

Respond with ONLY the category name, exactly as written above. No explanation, no punctuation, no quotes.`;
}

/**
 * Classify an email reply using GPT-4o mini.
 * Returns one of the 12 VALID_CATEGORIES, falling back to "Unrecognizable by AI" on any error.
 */
export async function categorizeReply(
  fromEmail: string,
  ccEmails: string,
  replySubject: string,
  replyBody: string
): Promise<LeadCategory> {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 20,
        messages: [
          { role: "system", content: buildSystemPrompt(fromEmail, ccEmails) },
          {
            role: "user",
            content: `Reply Subject: "${replySubject}"\nReply Body: "${replyBody}"`,
          },
        ],
      }),
    });

    if (!response.ok) {
      return "Unrecognizable by AI";
    }

    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();

    const match = VALID_CATEGORIES.find(
      (cat) => cat.toLowerCase() === raw.toLowerCase()
    );
    return match ?? "Unrecognizable by AI";
  } catch {
    return "Unrecognizable by AI";
  }
}
