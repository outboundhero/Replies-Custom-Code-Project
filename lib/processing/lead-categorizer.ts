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
