/**
 * The starting copy for Cleaning clients, taken verbatim from Clay's
 * "Clay –> EmailBison" workbook, table "B2B #1 – Client Nurture Campaigns"
 * (columns "Cleaning Outreach Subject Line" and "Cleaning Outreach Template"
 * 1–4), read 2026-10-15. Clay's two location columns are written as the client
 * fields [[SERVICE_AREA]] and [[OFFICE_ADDRESS]]. Timing and threads follow the
 * client's instruction of 2026-10-15 (email 4 after 15 days, decided with the
 * user): email 1 new thread; email 2 two days later in the same thread; email 3
 * three days later in the same thread; email 4 fifteen days later as a new
 * thread with email 1's subject.
 *
 * Used only to fill the Cleaning copy the first time the library is opened.
 * After that the library (lib/onboarding/copy-store.ts) is the source.
 */
import type { CopySequence } from "@/lib/onboarding/copy-model";

export const CLAY_SOURCE = "Clay — Clay –> EmailBison › B2B #1 – Client Nurture Campaigns (read 2026-10-15)";

export const CLEANING_SEED: CopySequence = {
  steps: [
    { waitDays: 0, thread: "new", subject: "{{CITY} cleaning|Cleaning intro|Commercial Cleaning {Introduction|Intro}|Commercial cleaning introduction|Cleaning in the {CITY} area|Question for you|Question about your cleaning setup|Cleaning Question|Thoughts|Cleaning|cleaning|Commercial cleaning|Cleaning for your space|Question about your cleaning setup|Complimentary cleaning quote|{CITY} cleaning|Cleaning service for businesses in the {CITY} area|Your thoughts|Cleaning|cleaning question|cleaning|Curious about your cleaning service setup}", body: "{Hey|Hi} {FIRST_NAME}{{,| –} {wanted to reach out and|{I wanted|wanted} to} introduce myself.|{,| -} {QUESTION}|,}\n\n{I'm|My name is} {SENDER_FIRST_NAME} and {my company provides|we provide}{| commercial| professional} cleaning{| services}{| in {{CITY}|the area}} {&|and} {was curious to know|wanted to {check|know|see}} if {your {office|team} would|you'd} be {interested in|open to} {getting|receiving} a{| complimentary} quote{| for our services| sometime soon}.\n\n{Would you be interested in a conversation about this?|Let me know if {you might be|you're} interested.|{Will you let me know if {you'd be|you're} interested|Interested|Any interest in receiving the cleaning quote{| for your space}}?}{|\n\n{SENDER_FIRST_NAME}}\n\n{|--}\n{SENDER_FULL_NAME}\n[[SERVICE_AREA]]\n{Office|Main {o|O}ffice|HQ|Based in|Headquartered in|Headquarters}: [[OFFICE_ADDRESS]]\n\n{PS -|P.S.} You can{| just} reply with '{no thanks|not interested|not for me|not a fit|remove|unsubscribe|unsub|opt me out|pass|kick rocks|remove me}' and {I’ll remove you|I’ll stop reaching out|I won’t follow up again|I’ll leave you be|I’ll make sure you don’t hear from me again}{|.}" },
    { waitDays: 2, thread: "reply", subject: null, body: "{Hey |Hi |}{FIRST_NAME},\n\n{Wanted to{| briefly} follow up. |}Would you be open to discussing cleaning services{| for your {facility|space}} and getting a{| complimentary} quote{| sometime soon| to know your options}?\n\n{|--}\n{SENDER_FULL_NAME}\n[[OFFICE_ADDRESS]]{|\n\n{PS -|P.S.} You can{| just} reply with \"{no thanks|not interested|not for me|not a fit|remove|unsubscribe|opt me out|pass|kick rocks}\" and {I’ll remove you|I’ll stop reaching out|I won’t follow up again|I’ll leave you be|I’ll make sure you don’t hear from me again}{|.}}" },
    { waitDays: 3, thread: "reply", subject: null, body: "{{{Hey|Hi} |}{FIRST_NAME} {-|–} |}{Would you be able to|Could you|Do you think you'd be able to} {point me to|direct me to} the {point of contact|person} who {handles|oversees|makes decisions regarding} {cleaning|cleaning services|janitorial services|cleaning tasks}{| for your{| {CITY}} location}?{| I understand if not.| If not, no worries.}\n\n{SENDER_FIRST_NAME}{|\n\n}" },
    { waitDays: 15, thread: "new", subject: null, body: "{Hey|Hi} {FIRST_NAME},\n\n{I wanted|Wanted} to introduce myself. {I'm|My name is} {SENDER_FIRST_NAME} and {my company provides|we provide}{| commercial| professional} cleaning{| services}{| in {{CITY}|the area}} {&|and} {was curious to know|wanted to {check|know|see}} if {your {office|team} would|you'd} be open to {getting|receiving} a{| complimentary} quote{| for our services| sometime soon}.\n\n{Let me know if {you might be|you're} interested.|{Will you let me know if you're interested|Interested}?}{|\n\n{SENDER_FIRST_NAME}}\n\n{|--}\n{SENDER_FULL_NAME}\n[[SERVICE_AREA]]\n{Office|Main Office|HQ|Based in}: [[OFFICE_ADDRESS]]\n\n{PS -|P.S.} You can{| just} reply with '{no thanks|not interested|not for me|not a fit|remove|unsubscribe|unsub|opt me out|pass|kick rocks|remove me}' and {I’ll remove you|I’ll stop reaching out|I won’t follow up again|I’ll leave you be|I’ll make sure you don’t hear from me again}{|.}" },
  ],
};
