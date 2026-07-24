# ReplyRouter – Improvements (client spec, verbatim reference)

Faithful transcription of the client's 15-page PDF (30 sections). This is the
**source of truth**; see `replyrouter-compliance.md` for build status. Do not
paraphrase requirements away — quote this file when implementing.

## 1. App Speed and Performance
Keep ReplyRouter consistently fast. Improve dashboard/inbox load; preload active
inbox; keep filtering/nav/categorization/reply actions fast; **do not load
historical/archived data with the active inbox**; load archived only when opened
or searched; keep the active DB as small as possible.

## 2. Active Inbox and Archived Database
Two areas: Active Inbox + Archived Database (accessible inside ReplyRouter, must
not affect active performance). Search archived by: client tag, contact name,
email, lead category, AI Suggested Lead Category, date, reply content. Archived
replies remain stored, searchable, viewable, editable, restorable to Open
Response. Restoring returns it to the active inbox immediately.

## 3. Archiving Rules
Open Response stays active regardless of age; never archive while Open Response;
eligible after >15 days OUTSIDE Open Response; auto-archive; complete cleanup
**every other Friday 10:00pm PT**; restore→active immediately; re-categorize
restarts the 15-day clock. Preserve: original reply, final category, AI category,
client tag, from name+email, To/CC/BCC recipients, contact names, dates, assigned
team member, actions taken, reply history.

## 4. Initial Inbox Cleanup
Store all current records in Archived DB; remove completed replies from active;
keep Open Response active; delete nothing.

## 5. Known Client Email Detection
Use approved contacts in Clients section. If a known client email appears in
From/To/CC/BCC → categorize as **Meeting-Ready Lead**. Works even when client tag
missing, lead ID missing, or AI suggests another category. Overrides AI.

## 6. Complete Email Visibility
Show From name, From email, all To emails, all CC emails, all BCC emails (when
available) in: main reply view, Data View, One-off Reply, Send Reply, Change of
Target, Bulk-review queue, Archived DB. Never show only the sender.

## 7. Reply-All Recipient Logic
Primary To = the person who sent the latest reply (never replace them). Other
prospects originally in To → move to outgoing CC (preserve names+emails).
Prospects originally in CC → keep in outgoing CC. Structure: To = replier; CC =
other prospects from To or CC.
**Example** — thread From: Erica; To: Spencer, Michelle; CC: Robert →
Reply-All: To: Erica; CC: Michelle and Robert.
Contact names: use identified name; if none confident, use email as display name;
a missing name must never block the reply.

## 8. Client CC and BCC Contacts
For positive categories (Meeting-Ready Lead, Follow Up, Interested, Referral
Given) auto-add client contacts from the client template (template defines which,
priority, CC vs BCC). Support up to 6 CC + BCC when needed. Final list = replier +
other relevant prospects from To/CC + client-template contacts + configured BCC.
Always show To/CC/BCC + names + emails; allow add/remove/change before approval.

## 9. Live Speed-to-Lead Timer
Live ticking timer while in Open Response (MM:SS, updates without refresh).
Standard 15 min; past 15 show how far past. Timer only in Open Response. On leave:
stop, save final time, show "Moved to X in Nm Ns". Completed record shows current
category, entered/left Open Response times, total time, team member.

## 10. Speed-to-Lead Reporting Rules
Daily/weekly average reports use positive categories: Meeting-Ready Lead, Follow
Up, Interested, Referral Given (Referral Given separate from Meeting-Ready).

## 11. Daily Speed-to-Lead Report
Every day 5:00pm PT → #inbox-management-team, no tags, begins with ⚡. Include:
avg speed-to-lead, % within 15 min, # positive leads that day.

## 12. Weekly Speed-to-Lead Report
End of week → #inbox-management-team, no tags, ⚡. Include weekly avg, % within 15,
total positive. Also add these to the existing weekly lead-delivery roundup DM'd
to Spencer, Madison, Nick (roundup keeps leads-delivered + adds the 3 metrics).

## 13. Data View
Airtable-style: row-based, wider/taller rows, readable content, filtering,
sorting, multi-select, drag-select, bulk category / bulk Send Reply / bulk Change
of Target. Process many without opening each record.

## 14. Bulk Action Review Queue
Bulk actions do NOT execute immediately. Select → choose bulk action → enter
review queue → each reply gets a review card → every item reviewed before batch
runs. Card shows original reply, proposed category, proposed action, proposed
message, sending account, To/CC/BCC, available COT contacts. User can approve /
edit / regenerate / change recipients / decline / return to Open Response. Batch
waits for all; approved run immediately; declined → Open Response or correct
non-send category.

## 15. Send Reply Categories
Any "(Send Reply)" category requires review before sending (e.g. Not Interested
(Send Reply), Interested (Send Reply), Request for Primary Point of Contact (Send
Reply)). User can approve / edit / regenerate / **add AI instructions** / change
recipients / decline. If declined: don't send, remove Send Reply action, return to
matching non-send category (Not Interested (Send Reply)→Not Interested, etc.).

## 16. Reply Navigation
After an action: auto-open next reply (don't return to list); add prev/next
arrows; keyboard nav if possible; ~5s "Previous reply processed – Return to
Previous Reply".

## 17. Individual Reply URLs
Every reply has a permanent URL (share, open directly, reference in Slack, return
later).

## 18. AI Suggested Lead Categories
AI suggests uncertain categories instead of finalizing; uncertain stay Open
Response. Add/improve: Meeting-Ready Lead, Follow Up, Interested, Referral Given,
Change of Target, Person No Longer Employed, Email Address Changed, Out of Office,
Automated Reply, Request for Primary Point of Contact, Do Not Contact, Unqualified,
Not Interested. Filterable in Master Inbox and Data View.

## 19. Referral Given
Do NOT auto-finalize. Applies only when someone provides a new contact / gives the
correct person's email / adds the correct person to the thread / makes an actual
introduction. Workflow: (1) keep in Open Response, (2) show Referral Given as AI
suggestion, (3) load the correct client-tag reply template, (4) require manual
confirmation, (5) keep final category Referral Given. Separate from Meeting-Ready
(pushed to sheet as Referral Given). Positive for reporting. NOT referral: OOO,
no-longer-employed, email changes, automated support, change-of-target, "contact
another dept" w/o a contact, "forwarded internally" w/o contact info.

## 20. Separate Similar Automated Replies
Distinguish Person No Longer Employed vs Email Address Changed vs Out of Office vs
Automated Reply — don't group them.

## 21. Out-of-Office Automation
Extract return date; requeue contact after return date; **use a default delay when
no return date is available**; avoid emailing before return; **show the next
scheduled send date**.
**Example** — "out of office until July 28" → show: Out of Office · Contact will
be requeued after July 28 · **Next eligible send date: July 29**.
Also provide: written explanation of current OOO logic + example follow-up email.

## 22. Change of Target
Extract ALL replacement emails; display every option; preselect recommended/first;
allow choosing another; use name (or email as display name); show what it will do;
require confirmation. Review shows original reply, recommended contact, other
options, selected recipient, sending account, proposed message.
**Example** — "contact Sarah at sarah@… or Mike at mike@…" → Recommended: Sarah;
Other: Mike; Action: create/update the lead and redirect outreach to Sarah.
Also provide an example of the current Change-of-Target email.

## 23. Request for Primary Point of Contact
Category: Request for Primary Point of Contact (Send Reply). Use when another
person/org controls the service but not enough contact info given (tenant/property
mgmt; landlord picks vendor; forwarded internally; mentions admin w/o email;
first-name-only "Bob handles this"; another dept/corporate/city w/o contact;
"someone else handles it" not in thread). Goal: get the actual primary contact's
email. **Scenario-specific generated replies** (see PDF): property-management,
first-name-only, forwarded-internally, department — each has distinct wording.

## 24. Review the Primary Contact Reply Before Sending
Always show generated reply before sending. Approve/edit/regenerate/add-context/
correction-instructions/change-recipient/decline. If declined: don't send, ask
what to change, regenerate with that context, allow edits, send only after
approval. Once contact provided: suggest Referral Given, keep Open Response until
confirmed, allow edits, keep final Referral Given, send contact to client.

## 25. Referral Reply Template
For a confirmed referral: thank the original sender; greet the referred contact;
keep original sender copied when appropriate; add client-template contacts;
preserve relevant prospects from original To/CC; use correct client-tag template;
require final review.
**Example** — "Thank you, Erica. Nice to meet you, Michelle. I'm copying my team
in case you're open to discussing the services we provide."

## 26. Missing Lead ID
A missing lead ID must never prevent processing. For an untracked reply:
**create a new lead ID; attach the reply to the new lead**; use sender/recipient
info; preserve the thread; preserve To/CC/BCC; allow Send Reply / Change of Target
/ categorization; **send from the correct original sender account**. When a new
email is selected via Change of Target, **that email becomes the lead being
worked**.
**Example workflow** — receive untracked reply → (1) create new lead ID, (2)
attach the email thread, (3) identify original sending account, (4) allow
categorize/redirect, (5) preserve Reply-All recipients.

## 27. City Wide Routing
Keep existing routing for CWSJ / CWSV: route to correct market; apply correct
template by city/state; reallocate San Jose ↔ Silicon Valley when appropriate.

## 28. Master Inbox and Base Client Views
Positive categories (Meeting-Ready, Follow Up, Interested, Referral Given) visible
in BOTH views. Master Inbox = review items (Referral suggestions, Change of Target,
Person No Longer Employed, Email Address Changed, Request for Primary Point of
Contact, other uncertain). Base Client = client visibility, positive tracking,
speed-to-lead reporting.

## 29. Confirmation Before Sending or Redirecting
Before send/redirect, show: selected category, original reply, primary To, all CC,
all BCC, names+emails, sending account, draft email, exact action. User can
confirm/edit/regenerate/add-instructions/change-recipients/decline.

## 30. Highest-Priority Improvements
(Cross-references §1–§29 — the client's prioritized checklist.)
