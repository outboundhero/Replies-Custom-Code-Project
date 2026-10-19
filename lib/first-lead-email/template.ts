/**
 * The email a client gets when their very first lead lands in their lead tracking sheet
 * (wording from OutboundHero, 2026-10-19). Variables: first name, the lead's email, the GIF
 * (embedded in the email, not attached) and the client's lead tracking sheet link. Single-brace
 * placeholders like {your name} belong to the suggested reply and stay as they are.
 */

export const FIRST_LEAD_SUBJECT = "Important: First Set of Leads - Instructions";
export const GIF_CID = "move-to-cc@outboundhero";

export interface FirstLeadVars {
  firstName: string;
  leadEmail: string;
  sheetUrl: string;
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "label"; text: string }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "gif" }
  | { kind: "sheet"; before: string; after: string }
  | { kind: "lead" }
  | { kind: "signature"; lines: string[] };

function blocks(v: FirstLeadVars): Block[] {
  return [
    { kind: "p", text: `Hi ${v.firstName},` },
    { kind: "p", text: "Please confirm once you've read this entire email." },
    { kind: "p", text: "We've sent the first interested lead with more incoming:" },
    { kind: "lead" },
    { kind: "p", text: "Let me know if any leads delivered need to be resent." },
    { kind: "p", text: "Please take action using the instructions below." },
    { kind: "label", text: "Note:" },
    { kind: "p", text: "Clients report 1 out of 7 leads we send over end up in our client's spam/junk folder even with the domain whitelisting completed due to various reasons. This is not an issue as this won't impact the existing conversation with each lead because it will not end up in their spam/junk folder since they've already replied or emailed us directly. However, it is critical to check your spam/junk folder at least once or twice a day. For every lead that ends up in spam/junk, please always move the email thread to your primary inbox and out of the spam/junk folder." },
    { kind: "p", text: "Please take action accordingly in the email threads from the leads sent from our email accounts using the following instructions." },
    { kind: "p", text: "I foresee that most of the time, we'll be able to get a phone number for your leads. If you don't get a phone number in the introduction email we CC you on, please spend 1-2 minutes searching for a direct phone to the company (located in your area) that we connected you with." },
    { kind: "p", text: "However, you'll be expected to do some digging to find the company's phone number if it's not explicitly mentioned in the email from our account or in the lead's original response (sometimes in their email signature or mentioned in their email back to our account)." },
    { kind: "label", text: "Todo for each lead:" },
    {
      kind: "ol",
      items: [
        "Please always call the phone number mentioned in our intro message and/or located in the lead's email signature at least 2x with a voicemail on the second dial if the lead doesn't answer. Do this before sending an email reply, this is important to get the highest ROI on our services.",
        "If the lead doesn't answer the phone, please reply back to all leads included (use REPLY ALL) to the email thread and move the email account from our accounts to CC (Our email accounts always have cleaning/janitorial related website domain endings) & move the primary leads to Primary.",
        "We recommend following up with every lead at least once 2-3 business days after your initial email and warm call — but clients getting the absolute highest ROI from our services follow up 6 times every 2-3 business days & then notify us on every lead in their service area that didn't convert past the lead introduction from us.",
      ],
    },
    { kind: "p", text: "Suggested reply template to send after attempting to warm call the interested lead (important to use – please always leave manual date/time slots for the prospect to confirm):" },
    {
      kind: "quote",
      text: [
        "\"Hi Stephanie, it's nice to meet you.",
        "",
        "{ask any questions necessary here}",
        "",
        "Are you available at any of the following times below?",
        "- {day of week 1}, {date 1} at {time 1}, {time 2}, or {time 3}",
        "- {day of week 2}, {date 2} at {time 2}, {time 2}, or {time 3}",
        "",
        "Or if it’s easier, you can also schedule in a time that works for you using my calendar link below:",
        "{your calendar booking link}",
        "",
        "Looking forward to connecting!",
        "",
        "{your name}",
        "",
        "{company}",
        "{phone}\"",
      ].join("\n"),
    },
    { kind: "p", text: "As an example: I've attached a quick GIF on how to move one of our email accounts (Lila in the example below) to CC and move the primary lead to the reply to primary person (the lead) — required!:" },
    { kind: "gif" },
    { kind: "p", text: "Remember, we need you to consistently take action within 5–15 minutes of receiving the lead from us during your team's work hours using the instructions above. This is important." },
    {
      kind: "sheet",
      before: "I've also created a Google Sheet for lead tracking purposes:",
      after: " – Please report both all valid, invalid, & undetermined leads in both the Status & Notes columns on the far right of the sheet – this is required and expected to be up-to-date by the end of the day on every Friday at 5 p.m. local time. (You may need to access the document with a personal Gmail account if your main email account is not a Google account; we know that Outlook email accounts typically cannot access the Google Sheet).",
    },
    { kind: "p", text: "Important note: we also push the leads that aren't technically meeting-ready/quote-ready yet to the Google Tracking Sheet as well to give you full visibility – these will fall under \"Interested\" and \"Follow Up\" – feel free to help us take action on those leads as well if you'd like, it would only help us both. If your email is not in CC email 1, then you're not missing the email in your inbox – this is commonly asked." },
    { kind: "p", text: "Let me know if you have any questions." },
    { kind: "p", text: "Again, please confirm once you've read this." },
    { kind: "p", text: "Thank you," },
    { kind: "signature", lines: ["Madison Herzog", "OutboundHero", "Company Phone: (509) 800-7013"] },
  ];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const P = "margin:0 0 14px 0;";
const FONT = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f2328;";

export function renderFirstLeadEmail(v: FirstLeadVars, opts: { testBanner?: string } = {}): { subject: string; html: string; text: string } {
  const html: string[] = [];
  const text: string[] = [];
  if (opts.testBanner) {
    html.push(`<div style="${P}padding:10px 12px;border:1px solid #f0b429;background:#fff8e1;border-radius:6px;font-size:13px;">${esc(opts.testBanner)}</div>`);
    text.push(`[${opts.testBanner}]`, "");
  }
  for (const b of blocks(v)) {
    switch (b.kind) {
      case "p":
        html.push(`<p style="${P}">${esc(b.text)}</p>`);
        text.push(b.text, "");
        break;
      case "label":
        html.push(`<p style="${P}font-weight:bold;">${esc(b.text)}</p>`);
        text.push(b.text, "");
        break;
      case "lead":
        html.push(`<p style="${P}margin-top:-8px;"><a href="mailto:${esc(v.leadEmail)}" style="color:#1a73e8;font-weight:bold;">${esc(v.leadEmail)}</a></p>`);
        if (text[text.length - 1] === "") text.pop(); // directly under "…with more incoming:", as written
        text.push(v.leadEmail, "");
        break;
      case "ol":
        html.push(`<ol style="margin:0 0 14px 0;padding-left:22px;">${b.items.map((i) => `<li style="margin:0 0 8px 0;">${esc(i)}</li>`).join("")}</ol>`);
        b.items.forEach((i, n) => text.push(`${n + 1}. ${i}`));
        text.push("");
        break;
      case "quote":
        html.push(`<div style="${P}padding:12px 16px;border-left:3px solid #c9ced6;background:#f6f8fa;border-radius:4px;">${esc(b.text).replace(/\n/g, "<br>")}</div>`);
        text.push(b.text, "");
        break;
      case "gif":
        html.push(`<p style="${P}"><img src="cid:${GIF_CID}" width="640" alt="How to move our email account to CC and reply to the lead" style="display:block;width:100%;max-width:640px;height:auto;border:1px solid #d0d7de;border-radius:6px;" /></p>`);
        text.push("(The GIF showing how to move our email account to CC is in the email.)", "");
        break;
      case "sheet":
        html.push(`<p style="${P}">${esc(b.before)} <a href="${esc(v.sheetUrl)}" style="color:#1a73e8;">${esc(v.sheetUrl)}</a>${esc(b.after)}</p>`);
        text.push(`${b.before} ${v.sheetUrl}${b.after}`, "");
        break;
      case "signature":
        html.push(`<p style="${P}">${b.lines.map(esc).join("<br>")}</p>`);
        text.push(...b.lines);
        break;
    }
  }
  return {
    subject: FIRST_LEAD_SUBJECT,
    html: `<!doctype html><html><body style="margin:0;padding:0;"><div style="${FONT}max-width:680px;padding:4px 2px;">${html.join("\n")}</div></body></html>`,
    text: text.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n",
  };
}

/** "Laura Boccadoro" → "Laura"; "Swanbrook Manor … Team (General Email)" → "Swanbrook"; nothing → "there". */
export function firstNameOf(name: string | null | undefined): string {
  const clean = String(name || "").replace(/\(General Email\)/gi, "").replace(/\s+/g, " ").trim();
  const first = clean.split(" ")[0] || "";
  return /^[\p{L}][\p{L}'’.-]*$/u.test(first) ? first : "there";
}
