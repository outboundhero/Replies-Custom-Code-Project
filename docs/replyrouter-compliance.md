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
| 6 | Complete Email Visibility | 🟡 | Main reply view + Archive + Send-Reply preview + COT show From/To/CC/BCC. | Data View + Bulk-review queue don't exist yet (§13/§14). |
| 7 | Reply-All Recipient Logic | ✅ | To = replier; other To → CC; original CC kept; our account excluded; name-or-email display. | — |
| 8 | Client CC & BCC Contacts | ✅ | Positive categories only; up to 6 CC + 2 BCC from client template; editable before send. | — |
| 9 | Live Speed-to-Lead Timer | ✅ | Ticking MM:SS in Open Response; freezes with "moved in Nm Ns"; past-standard shown. | — |
| 10 | Speed-to-Lead Reporting Rules | ❌ | Timing columns captured; report aggregation not built. | Phase 5. |
| 11 | Daily Report (5pm PT, Slack) | ❌ | — | Phase 5. |
| 12 | Weekly Report + roundup DM | ❌ | — | Phase 5 (Spencer/Madison/Nick). |
| 13 | Data View (Airtable-style) | ❌ | — | Phase 6. |
| 14 | Bulk Action Review Queue | ❌ | — | Phase 6. |
| 15 | Send Reply Categories (review) | ✅ | Preview: edit / regenerate / add-AI-instructions / change recipients / decline→non-send / approve+confirm. | — |
| 16 | Reply Navigation | 🟡 | Auto-advance + ~5s "return to previous" done. | Prev/next arrows + keyboard nav (Phase 7). |
| 17 | Individual Reply URLs | ✅ | `?reply=<id>` deep-link opens the exact reply. | — |
| 18 | AI Suggested Lead Categories | 🟡 | Categorizer overhaul: uncertain→Open Response; new categories added; filterable in Master Inbox. | Filterable in Data View pending (§13). |
| 19 | Referral Given (suggest, not finalize) | 🟡 | Suggests not finalizes; stays Open Response; excludes OOO/no-longer-employed/etc. | Step 3 "load client-tag reply template" ties to §25 (parked). |
| 20 | Separate Similar Automated Replies | ✅ | Person-No-Longer-Employed / Email-Changed / OOO / Automated distinguished. | — |
| 21 | Out-of-Office Automation | ✅ | Extract return date; requeue at return+1 (9am PT); default 7-day requeue when no date (no longer skipped); banner shows next eligible send date. | Written OOO explanation + example email deliverable still owed. |
| 22 | Change of Target | ✅ | Extracts all options, dropdown, preselect first, confirm, name-or-email. | Example COT email deliverable pending. |
| 23 | Request for Primary Point of Contact | 🟡 | Category exists (manual). Preview now generates **scenario-specific** replies (property-mgmt / first-name / forwarded / department) via AI, verified against the spec examples. | AI-*suggest* of this category still disabled per your earlier instruction — reconcile with §18/§23 if you want the AI to propose it. |
| 24 | Review Primary Contact Reply | 🟡 | Covered by the Send-Reply preview (review/edit/regenerate/add-context/decline). | "Once contact provided → suggest Referral Given, keep Open Response" chain not built (ties to §25). |
| 25 | Referral Reply Template | ❌ | Parked pending your flow + copy. Spec now clarifies: thank sender + greet referred contact + keep sender copied + client-template contacts + client-tag template + review. Example: "Thank you, Erica. Nice to meet you, Michelle. I'm copying my team…". | Build once confirmed. |
| 26 | Missing Lead ID | ⏸️ | Graceful COT fallback draft shipped. Full create-lead/attach workflow **deferred by user (2026-07-24)** — creating Bison leads has side effects; revisit later. | Deferred. |
| 27 | City Wide Routing (CWSJ/CWSV) | ✅ | Left intact (requirement is "keep existing"). | Confirm untouched. |
| 28 | Master Inbox & Base Client Views | 🟡 | Positive categories visible in both; Master surfaces review items. | Data View visibility pending (§13). |
| 29 | Confirmation Before Send/Redirect | ✅ | Send-Reply + COT show category/reply/To/CC/BCC/account/draft/action + confirm. | — |
| 30 | Highest-Priority list | — | Meta / cross-references the above. | — |

## Non-code deliverables still owed
- §21 — written explanation of current OOO logic + example follow-up email.
- §22 — example of the current Change-of-Target email.
- §25 — the "Spencer example emails" (referral wording).

## Known open decisions
- **§26** — "Create a new lead ID" means creating a lead in Bison, which has side
  effects in the client's workspace. Confirm the approach before building.
- **§23** — scenario-specific primary-contact templates vs one generic; and whether
  AI should suggest this category (§18 says yes; you earlier said manual-only).
- **§21** — default requeue delay when no return date; and next-send = return date
  vs return+1 (spec example uses +1).
