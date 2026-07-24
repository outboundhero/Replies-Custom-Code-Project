# Deliverables — Out-of-Office logic & Change-of-Target email (§21 / §22)

Client-facing explanation of how these two automations work today, with example
emails. Written 2026-07-24 against the live implementation.

---

## 1. Out-of-Office — how the current logic works (§21)

**Detection.** When a reply arrives, the AI reads it. A temporary away/vacation
autoreply ("I am traveling and will return on July 28") is categorized
**Out Of Office** — kept distinct from Person No Longer Employed, Email Address
Changed, and generic automated replies (§20).

**Scheduling.** When a reply is set to Out Of Office in ReplyRouter:

1. The AI extracts the **return date** from the reply text.
2. The original cold email is queued to re-send on the **day after** the stated
   return date, at **9:00 AM Pacific** — so we never email before the person is
   back, and it lands first thing in their morning.
   *Example: "out of office until July 28" → next eligible send date July 29.*
3. If **no clear return date** is found, the contact is still requeued with a
   **default 7-day delay** — no lead is ever dropped.
4. The reply's panel shows the schedule: *"Out of office — next eligible send
   date: Tue, Jul 29 (9:00 AM PT)."*

**The re-send.** A background job runs every 2 minutes. When a queued item comes
due, it re-sends the lead's **original first cold email** — same thread, same
sending account — with a short intro line. After it sends, the panel shows
*"Original cold email was re-sent on …"*.

**Cancellation.** If the team re-categorizes the reply off Out Of Office before
the date arrives, the scheduled re-send is cancelled automatically. Approving a
manual reply to the lead also cancels it — the lead never gets both.

### Example follow-up email (actual current format)

> **Subject:** Re: (the original campaign subject — same thread)
>
> Looks like you are back, so I am sending the initial email again.
>
> *(the lead's original first cold email, reproduced in full below the intro)*

**Note / open decision:** today the requeue is armed when the category is set
inside ReplyRouter. Replies the AI auto-labels Out Of Office at ingest (without
a human touching them) are *not* auto-requeued — turning that on is a one-line
change but would enable automatic re-sends at volume, so it's left off pending
your call.

---

## 2. Change of Target — the current email (§22)

**Flow.** Selecting Change Of Target never auto-sends. The AI extracts **every**
alternative contact from the reply (including reconstructing emails written
with a missing "@"), the review shows the original reply, the recommended
contact, all other options in a dropdown, the destination, the sending account,
and the proposed message — all editable — and nothing sends until confirmed.

### Example Change-of-Target email (actual current format)

Sent to the NEW contact, from the same account that ran the original campaign,
re-using the original cold email's subject:

> **Subject:** (the original cold email's subject)
>
> Hi Sarah,
>
> We received your email from John Smith — here's the email we sent them:
>
> ---
>
> *(the original cold email body, exactly as first sent)*
>
> ---
>
> Let me know,
>
> Spencer

### Untracked fallback (no linked campaign — §26 partial)

When the reply isn't linked to a campaign (so the original cold email can't be
attached), the review offers an editable generic re-pitch instead:

> Hi Sarah,
>
> John Smith passed your details along to me. I'd love to share how we can
> help — would you be open to a quick chat?
>
> Best,
>
> Spencer
