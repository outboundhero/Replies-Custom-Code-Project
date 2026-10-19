/**
 * First lead email: wording, variables, MIME (GIF embedded, not attached), the recipient lock and
 * the first-lead rules. Run: npx tsx tests/first-lead-email/email.test.ts  (sends nothing)
 */
import { renderFirstLeadEmail, firstNameOf, FIRST_LEAD_SUBJECT, GIF_CID } from "../../lib/first-lead-email/template";
import { buildMime, checkRecipients, TEST_RECIPIENTS } from "../../lib/gmail-send";
import { decideFirstLead } from "../../lib/first-lead-email";
import { MOVE_TO_CC_GIF_BASE64 } from "../../lib/first-lead-email/gif";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, x: unknown = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗ FAIL:", n, typeof x === "string" ? x.slice(0, 400) : JSON.stringify(x).slice(0, 400)); } };
const throws = (f: () => unknown, re: RegExp) => { try { f(); return false; } catch (e) { return re.test((e as Error).message); } };

console.log("The email");
const vars = { firstName: "Laura", leadEmail: "lboccadoro@newhavenpridecenter.org", sheetUrl: "https://docs.google.com/spreadsheets/d/abc123/edit" };
const m = renderFirstLeadEmail(vars);
ok(m.subject === "Important: First Set of Leads - Instructions" && FIRST_LEAD_SUBJECT === m.subject, "subject");
ok(m.text.startsWith("Hi Laura,\n\nPlease confirm once you've read this entire email."), "greeting + first line", m.text.slice(0, 80));
ok(m.text.includes("We've sent the first interested lead with more incoming:\nlboccadoro@newhavenpridecenter.org"), "the lead's email under the line");
ok(m.text.includes("I've also created a Google Sheet for lead tracking purposes: https://docs.google.com/spreadsheets/d/abc123/edit – Please report"), "the sheet link");
ok(!/\{\{/.test(m.text + m.html) && !/GIF!/.test(m.text + m.html), "no {{variables}} left");
ok(["{ask any questions necessary here}", "{day of week 1}, {date 1} at {time 1}, {time 2}, or {time 3}", "{your calendar booking link}", "{your name}", "{company}", "{phone}\""].every((t) => m.text.includes(t)), "the client's own placeholders kept as written");
ok(!m.text.includes("follow-up follow-up") && m.text.includes("from our services follow up 6 times every 2-3 business days"), "typo fixed: follow up 6 times");
ok(!/\.\.(\s|$)/.test(m.text), "no double full stops");
ok(m.text.trimEnd().endsWith("Madison Herzog\nOutboundHero\nCompany Phone: (509) 800-7013"), "signature");
ok(m.html.includes(`src="cid:${GIF_CID}"`) && (m.html.match(/<img /g) ?? []).length === 1, "the GIF sits in the email at {{GIF!}}");
ok(m.html.indexOf("cid:") > m.html.indexOf("Lila in the example below") && m.html.indexOf("cid:") < m.html.indexOf("Remember, we need you"), "…exactly where {{GIF!}} was");
ok((m.html.match(/<li /g) ?? []).length === 3, "the 3 to-do items are a numbered list");
ok(m.html.includes("&quot;Hi Stephanie, it&#39;s nice") || m.html.includes("&quot;Hi Stephanie, it's nice"), "the suggested reply is quoted");
const evil = renderFirstLeadEmail({ firstName: "<b>x</b>", leadEmail: "a@b.com\"><script>", sheetUrl: "javascript:alert(1)" });
ok(!evil.html.includes("<script>") && !evil.html.includes("<b>x</b>"), "variables are escaped in the HTML");
const t = renderFirstLeadEmail(vars, { testBanner: "TEST for SCAS — the real email goes to a@x.com." });
ok(t.html.includes("TEST for SCAS") && t.text.startsWith("[TEST for SCAS"), "test banner only on tests");

console.log("\nFirst name");
ok(firstNameOf("Laura Boccadoro") === "Laura" && firstNameOf("Swanbrook Manor Apartment Homes Team (General Email)") === "Swanbrook", "first word of the name");
ok(firstNameOf("") === "there" && firstNameOf(null) === "there" && firstNameOf("info@acme.com") === "there" && firstNameOf("(General Email)") === "there", "nothing usable → 'there'");
ok(firstNameOf("José García") === "José" && firstNameOf("O'Neil Smith") === "O'Neil", "accents and apostrophes kept");

console.log("\nMIME — embedded, not attached");
const mime = buildMime({ fromEmail: "madison@outboundhero.co", fromName: "Madison Herzog", to: ["sankalp@outreachify.io"], bcc: ["admin@outreachify.io"], subject: m.subject, html: m.html, text: m.text, inline: [{ cid: GIF_CID, filename: "move-to-cc.gif", contentType: "image/gif", base64: MOVE_TO_CC_GIF_BASE64 }], allowAnyRecipient: false });
const head = mime.split("\r\n\r\n")[0];
ok(/^From: Madison Herzog <madison@outboundhero\.co>$/m.test(head) && /^To: sankalp@outreachify\.io$/m.test(head) && /^Bcc: admin@outreachify\.io$/m.test(head) && /^Subject: Important: First Set of Leads - Instructions$/m.test(head), "headers", head);
ok(/Content-Type: multipart\/alternative; boundary="alt-/.test(head) && /Content-Type: multipart\/related; boundary="rel-/.test(mime), "text + (html + image) as alternatives");
ok(new RegExp(`Content-ID: <${GIF_CID}>\\r\\nContent-Disposition: inline; filename="move-to-cc.gif"`).test(mime) && !/Content-Disposition: attachment/.test(mime), "the GIF is inline, never an attachment");
const part = (type: string) => { const i = mime.indexOf(`Content-Type: ${type}`); const s = mime.indexOf("\r\n\r\n", i) + 4; const e = mime.indexOf("\r\n--", s); return mime.slice(s, e).replace(/\r\n/g, ""); };
ok(Buffer.from(part("text/html"), "base64").toString("utf8") === m.html, "HTML part decodes exactly");
ok(Buffer.from(part("text/plain"), "base64").toString("utf8") === m.text, "text part decodes exactly");
ok(Buffer.from(part("image/gif"), "base64").equals(Buffer.from(MOVE_TO_CC_GIF_BASE64, "base64")), "GIF part decodes to the same image");
ok(mime.split("\r\n").every((l) => l.length <= 998), "no line over the 998-character limit");
const gifBytes = Buffer.from(MOVE_TO_CC_GIF_BASE64, "base64");
ok(gifBytes.subarray(0, 6).toString() === "GIF89a" && gifBytes.length < 1.2 * 1048576 && Buffer.byteLength(mime) < 2 * 1048576, `the whole email is light (${(Buffer.byteLength(mime) / 1048576).toFixed(2)} MB)`);
ok(/^Subject: =\?UTF-8\?B\?/m.test(buildMime({ fromEmail: "madison@outboundhero.co", fromName: "Madison", to: ["sankalp@outreachify.io"], subject: "Leads – today", html: "x", text: "x", allowAnyRecipient: false })), "non-ASCII subject encoded");

console.log("\nThe recipient lock");
ok(throws(() => checkRecipients({ to: ["client@acme.com"], allowAnyRecipient: false }), /switched off — refused: client@acme\.com/), "switched off: a client address is refused");
ok(throws(() => checkRecipients({ to: ["sankalp@outreachify.io"], bcc: ["client@acme.com"], allowAnyRecipient: false }), /refused: client@acme\.com/), "…even hidden in BCC");
ok(checkRecipients({ to: TEST_RECIPIENTS, allowAnyRecipient: false }).length === 2, "the two test addresses are allowed");
ok(throws(() => checkRecipients({ to: ["a@b.com\r\nBcc: x@y.com"], allowAnyRecipient: true }), /isn't an email address/), "header injection refused");
ok(throws(() => checkRecipients({ to: [], allowAnyRecipient: true }), /No recipient/), "no recipient refused");
ok(checkRecipients({ to: ["client@acme.com"], bcc: ["boss@acme.com"], allowAnyRecipient: true }).length === 2, "switched on: client addresses allowed");

console.log("\nFirst lead or not");
const NOW = "2026-10-19T15:00:00.000Z";
const ago = (min: number) => new Date(Date.parse(NOW) - min * 60000).toISOString();
const row = (email: string, min: number | null, name = "Laura Boccadoro") => ({ lead_email: email, lead_name: name, pushed_to_sheet_at: min === null ? null : ago(min) });
let d = decideFirstLead("NEWCO", [row("lead1@a.com", 0)], ["Lead Email", "lead1@a.com"], NOW);
ok(d.first?.lead_email === "lead1@a.com" && !d.existingReason, "brand-new client, one lead → first");
d = decideFirstLead("NEWCO", [row("lead2@a.com", 1), row("lead1@a.com", 4)], ["Lead Email", "LEAD1@a.com", "lead2@a.com"], NOW);
ok(d.first?.lead_email === "lead1@a.com" && !d.existingReason, "two leads in the same burst → first, the earliest of them (case-insensitive)");
d = decideFirstLead("OLDCO", [row("new@a.com", 0), row("old@a.com", 60 * 24 * 30)], ["Lead Email", "new@a.com", "old@a.com"], NOW);
ok(!d.first && /already pushed leads for OLDCO before \(old@a\.com on /.test(d.existingReason ?? ""), "a lead pushed a month ago → not first", d);
d = decideFirstLead("OLDCO", [row("new@a.com", 0), row("old@a.com", null)], ["Lead Email", "new@a.com"], NOW);
ok(!d.first && /already pushed/.test(d.existingReason ?? ""), "an old push with no time → not first");
d = decideFirstLead("HANDCO", [row("new@a.com", 0)], ["Lead Email", "new@a.com", "typed-in@client.com", ""], NOW);
ok(!d.first && /sheet already had 1 lead in it \(e\.g\. typed-in@client\.com\)/.test(d.existingReason ?? ""), "the sheet already had a lead someone added → not first", d);
d = decideFirstLead("NEWCO", [row("lead1@a.com", 31)], ["Lead Email", "lead1@a.com"], NOW);
ok(!d.first, "just outside the 30-minute burst counts as before");
d = decideFirstLead("NEWCO", [row("lead1@a.com", 0)], null, NOW);
ok(d.first?.lead_email === "lead1@a.com", "no sheet to read: decided from Reply Router's history alone");
d = decideFirstLead("NEWCO", [], ["Lead Email"], NOW);
ok(!d.first && !d.existingReason, "nothing pushed → nothing to send");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
