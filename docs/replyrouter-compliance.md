# ReplyRouter Improvements — Compliance Matrix

Source of truth: the client's 15-page "ReplyRouter – Improvements" PDF (30 sections).
This file tracks each section against what is actually shipped, so nothing is lost
across work sessions. **When a section's behavior changes, update its row here.**

Status legend: ✅ done · 🟡 partial · ❌ not started · ⚠️ diverges from spec

| § | Section | Status | Notes / evidence | Gap to close |
|---|---------|--------|------------------|--------------|
| 1 | App Speed & Performance | ✅ | Bootstrap endpoint, app-load prefetch, hover-prefetch instant open, archiving keeps active set small. | — |
| 2 | Active Inbox & Archived DB | ✅ | Archive area searchable by client tag / name / email / lead category / AI category / date / reply content; view/edit/restore. | Verify every search field is wired in `archive/page.tsx`. |
| 3 | Archiving Rules | ✅ | >15 days out of Open Response; never archive Open Response; restore→active + restart clock; cron every other Fri 10pm PT. | — |
| 4 | Initial Inbox Cleanup | ✅ | 147,686 completed replies archived, Open Response kept active, nothing deleted. | — |
| 5 | Known Client Email Detection | ✅ | From/To/CC/BCC match; works with no tag / no lead ID; overrides AI → Meeting-Ready Lead. | — |
| 6 | Complete Email Visibility | ✅ | From/To/CC/BCC in main view, Archive, Send-Reply preview, COT, Data View, Bulk-review cards; One-Off now shows From + To. | — |
| 7 | Reply-All Recipient Logic | ✅ | To = replier; other To → CC; original CC kept; our account excluded; name-or-email display. | — |
| 8 | Client CC & BCC Contacts | ✅ | Positive categories only; up to 6 CC + 2 BCC from client template; editable before send. | — |
| 9 | Live Speed-to-Lead Timer | ✅ | Ticking MM:SS; frozen badge now shows "moved in Nm Ns · by <user>", tooltip shows entered/left Open Response timestamps. | — |
| 10 | Speed-to-Lead Reporting Rules | ✅ | Positive categories only (Meeting-Ready/Follow Up/Interested/Referral Given + legacy alias); timer-stop = categorized_at. | — |
| 11 | Daily Report (5pm PT, Slack) | ✅ | /api/cron/speed-report daily 5pm PT (UTC dual-slot + PT gate + cron_state dedupe) → channel, ⚡ prefix, no tags: avg, % within 15, positives. | Needs SLACK_BOT_TOKEN + channel env configured. |
| 12 | Weekly Report + roundup DM | ✅ | Fridays: weekly report → channel + lead-delivery roundup (leads delivered + 3 metrics) DM'd via SLACK_ROUNDUP_EMAILS. | Existing external roundup (outside this repo) can copy the same block. |
| 13 | Data View (Airtable-style) | ✅ | New `/data-view` under Inbox nav: row-based table, wider/taller rows, readable reply content, filter (search/client/category/AI/date), sort, multi-select + drag-select, row expander for full recipients, bulk category / Send Reply / Change of Target. | Now also: header-click sort, column resize/reorder, inline editing, multi-filter builder, grouping, right-side record panel + composer. |
| 14 | Bulk Action Review Queue | ✅ | Bulk action → review overlay: one card per reply (original reply, proposed category/action/message, sending account, To/CC/BCC, COT options), approve / edit / regenerate / change recipients / decline / skip; progress bar; batch runs only when every card is reviewed; approved run, declined → matching non-send category / Open Response. | — |
| 15 | Send Reply Categories (review) | ✅ | Preview: edit / regenerate / add-AI-instructions / change recipients / decline→non-send / approve+confirm. | — |
| 16 | Reply Navigation | 🟡 | Auto-advance + ~5s "return to previous" done. | Prev/next arrows + keyboard nav (Phase 7). |
| 17 | Individual Reply URLs | ✅ | `?reply=<id>` deep-link opens the exact reply. | — |
| 18 | AI Suggested Lead Categories | 🟡 | Uncertain→Open Response; AI-category filter now in BOTH Master Inbox and Data View. | Decision open: spec lists Meeting-Ready Lead + Unqualified as AI suggestions (Meeting-Ready only via known-client detection today; Primary-Contact manual per user). |
| 19 | Referral Given (suggest, not finalize) | 🟡 | Suggests not finalizes; stays Open Response; excludes OOO/no-longer-employed/etc. | Step 3 "load client-tag reply template" ties to §25 (parked). |
| 20 | Separate Similar Automated Replies | ✅ | Person-No-Longer-Employed / Email-Changed / OOO / Automated distinguished. | — |
| 21 | Out-of-Office Automation | ✅ | Return+1 9am PT; default 7-day requeue; banner. Deliverable written: docs/deliverable-ooo-and-change-of-target.md. | Decision open: also auto-requeue when AI (not a human) categorizes OOO at ingest. |
| 22 | Change of Target | ✅ | All options + dropdown + confirm; inbox modal now shows the original reply. Example email documented in docs/deliverable-ooo-and-change-of-target.md. | "Create/update the lead" ties to deferred §26. |
| 23 | Request for Primary Point of Contact | 🟡 | Category exists (manual). Preview now generates **scenario-specific** replies (property-mgmt / first-name / forwarded / department) via AI, verified against the spec examples. | AI-*suggest* of this category still disabled per your earlier instruction — reconcile with §18/§23 if you want the AI to propose it. |
| 24 | Review Primary Contact Reply | 🟡 | Covered by the Send-Reply preview (review/edit/regenerate/add-context/decline). | "Once contact provided → suggest Referral Given, keep Open Response" chain not built (ties to §25). |
| 25 | Referral Reply Template | ❌ | Parked pending your flow + copy. Spec now clarifies: thank sender + greet referred contact + keep sender copied + client-template contacts + client-tag template + review. Example: "Thank you, Erica. Nice to meet you, Michelle. I'm copying my team…". | Build once confirmed. |
| 26 | Missing Lead ID | ⏸️ | Graceful COT fallback draft shipped. Full create-lead/attach workflow **deferred by user (2026-07-24)** — creating Bison leads has side effects; revisit later. | Deferred. |
| 27 | City Wide Routing (CWSJ/CWSV) | ✅ | Left intact (requirement is "keep existing"). | Confirm untouched. |
| 28 | Master Inbox & Base Client Views | ✅ | Positive categories visible in both; Master surfaces review items; Data View live with AI filter. | — |
| 29 | Confirmation Before Send/Redirect | ✅ | Every send path confirms: Send-Reply preview, COT, Data View composer, and the inbox inline Send Reply / Forward / One-Off (two-click Confirm & Send). | — |
| 30 | Highest-Priority list | — | Meta / cross-references the above. | — |

## Non-code deliverables
- §21 + §22 — DELIVERED: docs/deliverable-ooo-and-change-of-target.md (OOO logic
  write-up + example follow-up email; example Change-of-Target email).
- §25 — the "Spencer example emails" (referral wording) — pending §25 decision.

## Known open decisions
- **§26** — "Create a new lead ID" means creating a lead in Bison, which has side
  effects in the client's workspace. Confirm the approach before building.
- **§23** — scenario-specific primary-contact templates vs one generic; and whether
  AI should suggest this category (§18 says yes; you earlier said manual-only).
- **§21** — default requeue delay when no return date; and next-send = return date
  vs return+1 (spec example uses +1).
