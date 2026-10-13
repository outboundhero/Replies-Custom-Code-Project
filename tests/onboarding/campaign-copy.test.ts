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

// The abbreviation is only swapped beside the city or the state; variables are never touched.
{
  const INDY: Place = { area: "", city: "Indianapolis", state: "Indiana", abbr: "IN" };
  const DALLAS: Place = { area: "", city: "Dallas", state: "Texas", abbr: "TX" };
  const r = localizeSteps(step("Based in Indianapolis, {IN|Indiana}<br>MAIN office — in, In, WIN, INN.<br>Office: Indianapolis, IN<br>{Indiana|IN}<br>{FIRST_NAME} {CITY}"), INDY, DALLAS);
  assert.deepEqual(r.problems, []);
  assert.equal(r.steps[0].email_body, "Based in Dallas, {TX|Texas}<br>MAIN office — in, In, WIN, INN.<br>Office: Dallas, TX<br>{Texas|TX}<br>{FIRST_NAME} {CITY}");
}

// A stray word that happens to be the master's abbreviation is left alone — and the master is refused.
{
  const blocked = (body: string, master: Place, re: RegExp, kept: string) => {
    const r = localizeSteps(step(body), master, ANAHEIM);
    assert.ok(r.problems.some((p) => re.test(p)), `${body} → ${r.problems.join(" | ") || "no problem reported"}`);
    assert.ok(r.steps[0].email_body.includes(kept), `"${kept}" should be untouched in: ${r.steps[0].email_body}`);
  };
  blocked("Is it OK if I send a quote?<br>Tulsa, {OK|Oklahoma}", { area: "", city: "Tulsa", state: "Oklahoma", abbr: "OK" }, /“OK”/, "Is it OK if I send");
  blocked("Our IN-HOUSE team<br>Gary, {IN|Indiana}", { area: "", city: "Gary", state: "Indiana", abbr: "IN" }, /“IN”/, "IN-HOUSE");
  blocked("MD and dental offices<br>Baltimore, {MD|Maryland}", { area: "", city: "Baltimore", state: "Maryland", abbr: "MD" }, /“MD”/, "MD and dental");
  // the state's name inside a longer name is not the state
  blocked("Serving the Kansas City metro<br>Wichita, {KS|Kansas}", { area: "", city: "Wichita", state: "Kansas", abbr: "KS" }, /inside a longer name/, "Kansas City metro");
  blocked("Not West Virginia<br>Richmond, {VA|Virginia}", { area: "", city: "Richmond", state: "Virginia", abbr: "VA" }, /inside a longer name/, "West Virginia");
}

// Nothing of the master may be left in ANY spelling.
{
  const left = (body: string, master: Place = WINNIPEG) => {
    const r = localizeSteps(step(`Office: ${master.city}, {${master.abbr}|${master.state}}<br>${body}`), master, ANAHEIM);
    assert.ok(r.problems.some((p) => /still in the copy|web or email address/.test(p)), `${body} → ${r.problems.join(" | ") || "no problem reported"}`);
  };
  left("Proudly serving WINNIPEG");
  left("the winnipeg team");
  left("based in {MB}");
  left('<a href="https://winnipeg-cleaners.com">site</a>');
  left("near Los&nbsp;Gatos", { area: "", city: "Los Gatos", state: "California", abbr: "CA" });
  left("the St Louis office", { area: "", city: "St. Louis", state: "Missouri", abbr: "MO" });
  left("Coeur d&#39;Alene crews", { area: "", city: "Coeur d’Alene", state: "Idaho", abbr: "ID" });
}

// The master's address, phone or website must not ride along — even on lines the swap never touched.
{
  const r = localizeSteps(step("Shine Cleaning Co<br>123 Main St<br>Winnipeg, {MB|Manitoba}<br>204-555-0101<br>shinecleaning.com"), WINNIPEG, ANAHEIM);
  for (const what of [/street address/, /phone number/, /web or email address/]) assert.ok(r.problems.some((p) => what.test(p)), r.problems.join(" | "));
}

// A master whose names can't be told apart, and an area name its emails never use.
{
  const NYC: Place = { area: "", city: "New York", state: "New York", abbr: "NY" };
  assert.ok(localizeSteps(step("Office: New York, {NY|New York}"), NYC, ANAHEIM).problems.some((p) => /same name/.test(p)));
  assert.ok(localizeSteps(step("{AL|Alabama}"), { area: "Alabama", city: "Mobile", state: "Alabama", abbr: "AL" }, ANAHEIM).problems.some((p) => /area name and state are the same/.test(p)));
  assert.ok(localizeSteps(step("Office: Winnipeg, {MB|Manitoba}"), { ...WINNIPEG, area: "" }, ANAHEIM).problems.some((p) => /don't use an area name/.test(p)));
  assert.deepEqual(localizeSteps(step("Office: Winnipeg, {MB|Manitoba}"), { ...WINNIPEG, area: "" }, { ...ANAHEIM, area: "" }).problems, []);
  // …including when the master's area is there but split by an entity, so only its city part was swapped
  assert.ok(localizeSteps(step("Office: Winnipeg, {MB|Manitoba}<br>Winnipeg&nbsp;Area cleaners"), WINNIPEG, ANAHEIM).problems.some((p) => /don't use an area name/.test(p)));
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
assert.deepEqual(parsePlace("Winnipeg, MB, CA"), { city: "Winnipeg", state: "Manitoba", abbr: "MB", sure: true });
assert.deepEqual(parsePlace("Lancaster, PA, Co"), { city: "Lancaster", state: "Pennsylvania", abbr: "PA", sure: true });
assert.deepEqual(parsePlace("Austin, TX, USA"), { city: "Austin", state: "Texas", abbr: "TX", sure: true });
assert.equal(parsePlace("Dallas, TX and Houston, TX")?.sure, false);
assert.equal(parsePlace("Halifax, Nova Scotia")?.abbr, "NS");
assert.equal(parsePlace("315 University Ave Los Gatos, CA 95030")?.sure, false);
assert.equal(parsePlace("United States"), null);

console.log("campaign-copy: all checks passed");
