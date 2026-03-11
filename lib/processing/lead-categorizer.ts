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
] as const;

export type LeadCategory = (typeof VALID_CATEGORIES)[number];

/** Categories that should receive CC/BCC and reply template in Airtable */
export const CC_BCC_CATEGORIES: LeadCategory[] = [
  "Interested",
  "Meeting Request",
  "Follow Up at a Later Date",
  "Unrecognizable by AI",
];

function buildSystemPrompt(fromEmail: string, ccEmails: string): string {
  return `#CONTEXT#

Utilize AI capabilities to classify emails into predefined categories based on their content.

This is the person that we received an email from: ${fromEmail} & if anyone was CC'd it was ${ccEmails || "no one"} — this is the reply I want you to analyze and classify accurately.

#OBJECTIVE#

Categorize each email reply into appropriate categories including: 1. Unrecognizable by AI, 2. Interested, 3. Meeting Request, 4. Follow Up at a Later Date, 5. Not Interested, 6. Out Of Office, 7. Wrong Person, 8. Mailbox No Longer Active, 9. Automated Error Message, 10. Automated Catch-All Message, 11. Wrong Person (Change of Target), & 12. Do Not Contact.

Most of the time, the prospect/lead's email will be above the "-----Original Message-----" line and this is what I want you to analyze. Our email or multiple email outreach is underneath that text. Sometimes though, there will not be a "-----Original Message-----", so please evaluate the email accordingly.

Note for Wrong Person category versus Change of Target category: If the email reply has a person we emailed has a reply has a email address of someone else or another email address mentioned to contact instead - this would be Change of Target since we can change the contact to the new person mentioned if there's an email to extract and contact. Otherwise, it will be Wrong Person if there is not another person's email or another email of the person to email instead based on the reply received from the person that we originally emailed.

Note: if the prospect's email reply is something like: "Unsure" or "Maybe", return Interested in the output because they are likely interested if we provide more information.

#INSTRUCTIONS#

1. Analyze the reply body and reply subject to determine the latest reply email's category.
3. Prioritize explicit phrases that clearly indicate a category, such as "I'm out of the office", "I'm on vacation", "Please contact someone else", "Stop contacting me", or "Do not contact".
4. If the AI cannot confidently classify the email based on the provided data, assign it to "Unrecognizable by AI". Note: if the person replying provides only their phone number in their reply, then categorize it as "Interested".

Please mark categorize replies as Do Not Contact if there's anything mentioned in the reply as something was attached like a Docusign, agreement link, or invoice – these replies are either malicious links or documents OR they are trying have us pay them money.

Some scenarios that I want to count as interested are, but not limited to the following:

- The person we emailed appears to have sent our original email to one of their colleagues to review and respond to.
- The person we emailed replied and said they would be open to seeing an estimate even though they're not interested at this exact time.
- The person we emailed directed us to email another person that might handle what we're emailing them about.
- The person we emailed is indeed the right person for cleaning services.
- The person we emailed replies with a concise "sure", "yes", "of course", "that's fine", or some other short reply.
- The person we emailed replies with positive intent to continue the conversation and explains what they need for our services.
- If the person says we are welcome to send over an estimate/proposal/quote/bid or pitch, then this is an interested reply sentiment.
- If the person asks a specific question with intent to know additional information, then is an interested reply sentiment.

#EXAMPLES#

Example Input 1:
  Reply Subject: "Meeting Request for next week"
  Reply Body: "I would like to schedule a meeting for next Tuesday."
Expected Output: "Meeting Request"

Example Input 2:
  Reply Subject: "Out of Office Notice"
  Reply Body: "I'm currently out of the office and will return on Monday."
Expected Output: "Out Of Office"

Example Input 3:
  Reply Subject: "Re: shockwave"
  Reply Body: "Hi David, Not all shockwave devices are equal. What is the brand of your devices? We currently use Storz. I am not interested in anything of lesser quality. Thanks Kathy Thornburg"
Expected Output: "Interested" because Kathy wants to know the brand of the devices and asked a specific question for additional information.

#ADDITIONAL EXAMPLES#

Example 4:
  Reply Subject: "Re: cleaning question"
  Reply Body: "Call Brad Stephen's at 615-883-3918 he is who is in charge of all cleaning and maintenance."
Expected Output: "Interested" — the prospect redirected us to the right person in charge of cleaning decisions, indicating interest from their company.

Example 5:
  Reply Subject: "UNSUBSCRIBE Re: Quick cleaning question"
  Reply Body: (signature only, no message body)
Expected Output: "Do Not Contact" — the subject line contains "UNSUBSCRIBE", which is an explicit opt-out.

Example 6:
  Reply Subject: "Please redirect your enquiry Re: ..."
  Reply Body: "I am no longer working on Pon.Bike Performance projects so please direct all enquiries as follows: - Cervélo: Brian Bernard (bbernard@cervelo.com) - Santa Cruz: Seb Kemp (seb.kemp@santacruzbicycles.com) ..."
Expected Output: "Wrong Person (Change of Target)" — the person provided multiple alternative email addresses to contact instead.

Example 7:
  Reply Subject: "I am no longer at RAFT Re: cleaning question"
  Reply Body: (empty)
Expected Output: "Wrong Person" — the subject indicates the person no longer works there and no alternative contact email was provided.

Example 8:
  Reply Subject: "Re: Question regarding your cleaning setup"
  Reply Body: "Please direct your correspondence to our USA office usa@driftwooddrilling.com"
Expected Output: "Wrong Person (Change of Target)" — another email address (usa@driftwooddrilling.com) was provided to contact instead.

Example 9:
  Reply Subject: "RE: Independence cleaning"
  Reply Body: "Hi Jenny, We do not manage the property of our Liberty, MO office. You would need to contact Sonja Bennett with the Clay County DDRB."
Expected Output: "Wrong Person" — the reply says to contact someone else (Sonja Bennett) but no email address was provided.

Example 10:
  Reply Subject: "Re: Quick question"
  Reply Body: "Sorry it is done through the city. Have a nice day!"
Expected Output: "Not Interested" — the prospect indicated the service is handled by the city and gave no indication of interest.

Example 11:
  Reply Subject: "Re: Pontiac cleaning"
  Reply Body: "Please, contact the director, Colleen Vieira, cvieira@pontiaclibrary.org. The librarians cannot make decisions on contractor hiring."
Expected Output: "Wrong Person (Change of Target)" — a specific alternative email (cvieira@pontiaclibrary.org) was provided.

Example 12:
  Reply Subject: "RE: Cleaning proposal"
  Reply Body: "You are welcome to send over an estimate if you wish. I am just not currently looking. I want to be up front with you."
Expected Output: "Interested" — the prospect explicitly said we are welcome to send an estimate, which is an interested reply sentiment even though they are not actively looking.

Example 13:
  Reply Subject: "Re: Inquiry about your cleaning services"
  Reply Body: "See below rashell Thank You! Jay Grandella Construction & Grand Gutters! 5107919811"
Expected Output: "Unrecognizable by AI" — the reply is a short forwarded message with unclear intent that cannot be confidently classified.

Example 14:
  Reply Subject: "RE: Steve suggestion"
  Reply Body: "We are always interested but we do have current contractual lead sources currently."
Expected Output: "Interested" — the prospect expressed openness ("we are always interested") despite currently having existing contracts.

Example 15:
  Reply Subject: "Re: Complimentary cleaning estimate - Centerton location"
  Reply Body: "Thank you for the inquiry. A service Technician will call you the soonest possible. Please download SERVICE REQUEST FORM from the link below..."
Expected Output: "Automated Catch-All Message" — this is a templated automated response directing to a form, not a genuine personal reply.

Example 16:
  Reply Subject: "Thoughts Beverly"
  Reply Body: "Who are you and what company are you with?"
Expected Output: "Interested" — the prospect is asking for more information, which indicates curiosity and interest.

Example 17:
  Reply Subject: "Re: Arlington UMC"
  Reply Body: "Please call me at 615-733-9818. Thank you, Shannon White"
Expected Output: "Interested" — the prospect provided a phone number to be contacted, indicating interest.

Example 18:
  Reply Subject: "Re: Question regarding your cleaning setup"
  Reply Body: "Hi Sara I am the person who hires [contact card attached]"
Expected Output: "Interested" — the prospect confirmed they are the right decision-maker for hiring.

Example 19:
  Reply Subject: "Re: Pierre might be useful"
  Reply Body: (empty)
Expected Output: "Unrecognizable by AI" — the reply body is empty with no content to classify.

Example 20:
  Reply Subject: "Re: Your McLean location"
  Reply Body: "Thank you, Jess, we're all set."
Expected Output: "Not Interested" — "we're all set" is a polite decline indicating they do not need the service.

Example 21:
  Reply Subject: "Re: Cleaning question"
  Reply Body: "no more ben is gone! remove him ben@withhomemade.com and me please"
Expected Output: "Do Not Contact" — the prospect is explicitly requesting removal from the list.

Example 22:
  Reply Subject: "Dr. Ed @ Vitality Chiropractic"
  Reply Body: "I was just on your website. I would be interested in talking to you regarding Shockwave."
Expected Output: "Interested" — explicit statement of interest.

Example 23:
  Reply Subject: "Re: Quick question Gregg Orthodontics Team"
  Reply Body: "END"
Expected Output: "Do Not Contact" — replying with "END" is an explicit opt-out from the email sequence.

Example 24:
  Reply Subject: "Re: Cleaners"
  Reply Body: "435-229-7415 Cary Blake Cary Blake C. Blake Homes"
Expected Output: "Interested" — the prospect replied with their phone number and name, indicating interest.

Example 25:
  Reply Subject: "Re: Quick question Liz"
  Reply Body: "Hi Dan, I believe you have the wrong email address. I don't offer services of that type. Please take me off your list."
Expected Output: "Do Not Contact" — explicit request to be removed from contact list.

Example 26:
  Reply Subject: "Re: Cristina, question about your lead gen"
  Reply Body: "Yes What are your rates"
Expected Output: "Interested" — short affirmative reply with a follow-up question about pricing.

Example 27:
  Reply Subject: "Re: Question about cleaning"
  Reply Body: "Hi Rebecca, We already have a cleaning service we use and we like. If anything changes we can let you know."
Expected Output: "Not Interested" — the prospect indicated they already have a provider and are satisfied.

Example 28:
  Reply Subject: "RE: Triton"
  Reply Body: "God morning Dan, Cannot do a meeting today. How about Tuesday, April 1, at 11am CST?"
Expected Output: "Meeting Request" — the prospect is proposing a specific meeting time.

Example 29:
  Reply Subject: "Re: Question about cleaning"
  Reply Body: "We are located in Utah - long ways from Boise"
Expected Output: "Unrecognizable by AI" — the prospect is pointing out a geographic mismatch but it's unclear if this is a decline or just a comment; cannot be confidently classified.

Example 30:
  Reply Subject: "Re: Cleaning in the Liberty area"
  Reply Body: "Would Independence be in your area?"
Expected Output: "Interested" — the prospect is asking if their location falls within the service area, showing interest in potentially using the service.

Example 31:
  Reply Subject: "Re: [Spam] Cleaning question."
  Reply Body: "Aura, Actually, the school we lease from have hired a company who takes care of the cleaning for us."
Expected Output: "Not Interested" — the prospect explained their cleaning is handled by their landlord/building management.

Example 32:
  Reply Subject: "Re: Your building in Lawrence"
  Reply Body: "We have a full time maintenance person on staff."
Expected Output: "Not Interested" — the prospect indicated they handle cleaning in-house and did not express any interest.

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
