/**
 * Copy rules for "Create email campaigns" (onboarding step 2).
 * Run: npx tsx tests/onboarding/campaign-copy.test.ts
 *
 * The snippets are real lines from live campaigns (CGCWP, CVJCIN, JPCA),
 * fetched 2026-10-13.
 */
import assert from "node:assert/strict";
import { localizeSteps, variablesIn, bodyText, type Place } from "../../lib/onboarding/campaign-copy";
import { campaignName, slotOfName, parsePlace, CAMPAIGN_SLOTS } from "../../lib/onboarding/campaign-plan";

const WINNIPEG: Place = { area: "Winnipeg Area", city: "Winnipeg", state: "Manitoba", abbr: "MB" };
const CINCINNATI: Place = { area: "Cincinnati Area", city: "Cincinnati", state: "Ohio", abbr: "OH" };
const BIRMINGHAM: Place = { area: "Central Alabama", city: "Birmingham", state: "Alabama", abbr: "AL" };
const ANAHEIM: Place = { area: "Orange County", city: "Anaheim", state: "California", abbr: "CA" };

const SUBJECT = "{{CITY} cleaning|Cleaning intro|Cleaning in the {CITY} area|Question for you}";
const CGCWP_BODY =
  "{Hey|Hi} {FIRST_NAME}{{,| –} {wanted to reach out and|{I wanted|wanted} to} introduce myself.|{,| -} {QUESTION}|,}<br><br>" +
  "{I'm|My name is} {SENDER_FIRST_NAME} and {my company provides|we provide} cleaning{| in {{CITY}|the area}} {&amp;|and} {was curious to know|wanted to {check|know|see}} if {you'd} be open to a quote.<br><br>" +
  "{|--}<br>{SENDER_FULL_NAME}<br>" +
  "{Commercial Cleaning{| Provider| Service{s|}} {-|in the} {Winnipeg, {MB|Manitoba} area|Winnipeg, Manitoba}|{Winnipeg Area|Winnipeg} Commercial {Cleaners|Cleaning}|{Local |}{Building|Commercial} Cleaning{| Provider| Service{|s}}{ - |{| based} in} {Winnipeg, {MB|Manitoba}}}<br>" +
  "{Office|Main {o|O}ffice|HQ|Based in|Headquartered in|Headquarters}: Winnipeg, {Manitoba|MB}";
const CVJCIN_LINE =
  "{Commercial Cleaning{| Provider| Service{s|}} {-|in the} {Cincinnati Area|Cincinnati, {OH|Ohio} area}|{Cincinnati Area|Cincinnati} Commercial {Cleaners|Cleaning}|{Local |}{Building|Commercial} Cleaning{| Provider| Service{|s}}{ - |{| based} in} {Cincinnati, {OH|Ohio}}}";
const JPCA_LINE =
  "{Commercial Cleaning{| Provider| Service{s|}} {-|in the} {Central Alabama|Birmingham, {AL|Alabama} area}|{Central Alabama|Birmingham} Commercial {Cleaners|Cleaning}|{Local |}{Building|Commercial} Cleaning{| Provider| Service{|s}}{ - |{| based} in} {Birmingham, {AL|Alabama}}}";
const step = (email_body: string, email_subject = SUBJECT) => [{ order: 1, email_subject, email_body }];

// A master used for its own place comes back unchanged.
{
  const r = localizeSteps(step(CGCWP_BODY), WINNIPEG, WINNIPEG);
  assert.deepEqual(r.problems, []);
  assert.equal(r.steps[0].email_body, CGCWP_BODY);
}

// New client: only place words change — subject, variables and spintax stay.
{
  const r = localizeSteps(step(CGCWP_BODY), WINNIPEG, ANAHEIM);
  assert.deepEqual(r.problems, []);
  assert.equal(r.steps[0].email_subject, SUBJECT);
  assert.deepEqual(variablesIn(r.steps[0].email_body), variablesIn(CGCWP_BODY));
  assert.equal(r.steps[0].email_body.replace(/[^{}|]/g, ""), CGCWP_BODY.replace(/[^{}|]/g, ""));
  assert.ok(!/Winnipeg|Manitoba|\bMB\b/.test(r.steps[0].email_body));
  assert.ok(bodyText(r.steps[0].email_body).includes("{Anaheim, {CA|California} area|Anaheim, California}|{Orange County|Anaheim} Commercial"));
  assert.ok(bodyText(r.steps[0].email_body).endsWith("Headquarters}: Anaheim, {California|CA}"));
  // …and swapping back gives the master again, so nothing else was touched.
  assert.equal(localizeSteps(r.steps, ANAHEIM, WINNIPEG).steps[0].email_body, CGCWP_BODY);
}

// One real client's line is reproduced exactly from another's.
assert.equal(localizeSteps(step(CVJCIN_LINE), CINCINNATI, BIRMINGHAM).steps[0].email_body, JPCA_LINE);

// Guards.
{
  const blocked = (r: { problems: string[] }, re: RegExp) => assert.ok(r.problems.some((p) => re.test(p)), r.problems.join(" | ") || "no problem reported");
  // a master whose emails carry a street address would hand it to the new client
  blocked(localizeSteps(step("{Office|HQ}: 234 Aquarius {Drive|Dr.} Suite 106, Birmingham, {Alabama|AL}"), BIRMINGHAM, ANAHEIM), /street address or ZIP/);
  // the master's place isn't what its copy says
  blocked(localizeSteps(step(CGCWP_BODY), { area: "", city: "Toronto", state: "Ontario", abbr: "ON" }, ANAHEIM), /None of the master's place names/);
  // spintax characters or gaps in the new client's names
  blocked(localizeSteps(step(CGCWP_BODY), WINNIPEG, { ...ANAHEIM, city: "Ana{heim|x}" }), /can't contain/);
  blocked(localizeSteps(step(CGCWP_BODY), WINNIPEG, { ...ANAHEIM, city: "" }), /city is missing/);
  blocked(localizeSteps(step(CGCWP_BODY), WINNIPEG, { ...ANAHEIM, abbr: "Cal" }), /abbreviation/);
  // subjects are never edited, so a place name in one can't be handled
  blocked(localizeSteps(step("Office: Winnipeg, {MB|Manitoba}", "Winnipeg cleaning"), WINNIPEG, ANAHEIM), /subject contains/);
}

// The abbreviation only matches as a whole capitalised word; variables are never touched.
{
  const r = localizeSteps(step("Based in Indianapolis, {IN|Indiana}<br>MAIN office — in, In, WIN, INN.<br>{FIRST_NAME} {CITY}"),
    { area: "", city: "Indianapolis", state: "Indiana", abbr: "IN" }, { area: "", city: "Dallas", state: "Texas", abbr: "TX" });
  assert.equal(r.steps[0].email_body, "Based in Dallas, {TX|Texas}<br>MAIN office — in, In, WIN, INN.<br>{FIRST_NAME} {CITY}");
}
// "&" is written as HTML; no area name means "<City> Area"; a new name containing the old one is fine.
assert.ok(localizeSteps(step(CGCWP_BODY), WINNIPEG, { ...ANAHEIM, area: "Dallas & Fort Worth" }).steps[0].email_body.includes("{Dallas &amp; Fort Worth|Anaheim} Commercial"));
assert.ok(localizeSteps(step(CGCWP_BODY), WINNIPEG, { ...ANAHEIM, area: "" }).steps[0].email_body.includes("{Anaheim Area|Anaheim} Commercial"));
assert.deepEqual(localizeSteps(step("Office: York, {PA|Pennsylvania}"), { area: "", city: "York", state: "Pennsylvania", abbr: "PA" }, { area: "", city: "New York", state: "New York", abbr: "NY" }).problems, []);

// Names and sheet locations.
assert.deepEqual(CAMPAIGN_SLOTS.map((s) => campaignName("jpscal", s)), [
  "JPSCAL: Google + Custom (Cleaning Client)", "JPSCAL: Google + Custom [Nurture] (Cleaning Client)",
  "JPSCAL: Outlook (Cleaning Client)", "JPSCAL: Outlook [Nurture] (Cleaning Client)",
  "JPSCAL: SEGs (Cleaning Client)", "JPSCAL: SEGs [Nurture] (Cleaning Client)",
]);
assert.equal(slotOfName("CGCWP: Outlook [Nurture] (Cleaning Client)", "CGCWP")?.nurture, true);
assert.equal(slotOfName("PJR: Outlook (OS Client)", "PJR"), null);
assert.deepEqual(parsePlace("Anaheim, California"), { city: "Anaheim", state: "California", abbr: "CA", sure: true });
assert.deepEqual(parsePlace("2255 Sheridan Blvd. Ste. C #275, Edgewater, CO 80214"), { city: "Edgewater", state: "Colorado", abbr: "CO", sure: true });
assert.equal(parsePlace("315 University Ave Los Gatos, CA 95030")?.sure, false);
assert.equal(parsePlace("United States"), null);

console.log("campaign-copy: all checks passed");
