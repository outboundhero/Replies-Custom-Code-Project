/**
 * Service-area removal rules (lib/service-area-changes/places.ts). Run: npx tsx tests/service-area/places.test.ts
 * Addresses below are shapes seen on real Bison leads (custom variables city / state / address).
 */
import {
  parsePlaces, parseAddress, signalsOf, classify, normCity, usStateCode, searchTermFor, removalDate, pacificMidnight,
  inputFromCustomVars, mergeSignals, isIsoDate, type Place, type ZipFacts, type CityStates,
} from "../../lib/service-area-changes/places";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, x: unknown = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗ FAIL:", n, typeof x === "string" ? x : JSON.stringify(x)); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), n, { got: a, want: b });

console.log("parsing what's typed");
{
  const c = parsePlaces("city", "Wheaton, IL\nNaperville IL\nSt. Louis, MO\nSpringfield\nwheaton, il\nSalt Lake City UT\nMount Washington\nAurora, Illinois\nMount Washington, KY");
  eq(c.places.map((p) => p.key), ["city:IL:wheaton", "city:IL:naperville", "city:MO:st louis", "city:UT:salt lake city", "city:IL:aurora", "city:KY:mt washington"], "cities parse, duplicates folded");
  ok(c.errors.length === 2 && /Springfield/.test(c.errors[0]) && /Mount Washington/.test(c.errors[1]), "a city without its state is refused — and “Mount Washington” isn't read as Mount, WA", c.errors);
  ok(parsePlaces("city", "Naperville Illinois").errors.length === 1, "without a comma the state must be a 2-letter code");
  const s = parsePlaces("state", "IL, texas; New York\nZZ");
  eq(s.places.map((p) => p.state), ["IL", "TX", "NY"], "states by code or name");
  ok(s.errors.length === 1 && /ZZ/.test(s.errors[0]), "unknown state refused");
  const z = parsePlaces("zip", "60187, 60188-1234\n6018\nabcde");
  eq(z.places.map((p) => p.zip), ["60187", "60188"], "ZIPs, ZIP+4 trimmed");
  eq(z.errors.length, 2, "bad ZIPs refused");
  eq(usStateCode("Ill."), "IL", "AP abbreviation Ill.");
  eq(usStateCode("Calif."), "CA", "AP abbreviation Calif.");
  eq(usStateCode("Ilinois"), "", "a misspelling isn't a state");
  eq(usStateCode("il"), "IL", "lower-case code");
  eq(usStateCode("District of Columbia"), "DC", "DC by name");
}

console.log("addresses");
{
  eq(parseAddress("7741 W 87th Pl, Bridgeview, IL 60455"), { zip: "60455", state: "IL", city: "Bridgeview" }, "street, city, ST zip");
  eq(parseAddress("Salt Lake City, Utah, United States"), { state: "UT", city: "Salt Lake City" }, "city, state name, country");
  eq(parseAddress("Wheaton, Illinois"), { state: "IL", city: "Wheaton" }, "city, state name");
  eq(parseAddress("(No Address Available)"), {}, "placeholder text ignored");
  eq(parseAddress("1300 Champion Forest Ct, Wheaton, IL 60187-4401, USA"), { zip: "60187", state: "IL", city: "Wheaton" }, "ZIP+4 and USA");
  eq(parseAddress("123 Main St Wheaton IL 60187"), { zip: "60187", state: "IL" }, "no commas: state + ZIP, no city guess");
  eq(parseAddress("Wheaton IL"), { state: "IL", city: "Wheaton" }, "city + code in one part");
  eq(parseAddress("100 King St W, Toronto, ON M5X 1A9, Canada"), {}, "Canadian address: nothing US");
  eq(parseAddress("Kansas City, MO 64105"), { zip: "64105", state: "MO", city: "Kansas City" }, "Kansas City, MO");
  eq(parseAddress("Drop-off at the side door in"), {}, "a trailing lower-case word isn't a state");
  eq(parseAddress("PO Box 60187"), {}, "a PO box number isn't a ZIP");
  eq(signalsOf({ zip: "2886" }).signals.zips, ["02886"], "a 4-digit ZIP field gets its leading zero back");
}

console.log("city names");
{
  eq(normCity("St. Louis"), normCity("Saint Louis"), "St. = Saint");
  eq(normCity("Fort Worth"), normCity("Ft Worth"), "Fort = Ft");
  eq(normCity("Coeur d'Alene"), normCity("Coeur dAlene"), "apostrophes");
  ok(normCity("Kansas City") !== normCity("Kansas"), "Kansas City isn't Kansas");
}

const P = (type: "city" | "state" | "zip", t: string): Place[] => parsePlaces(type, t).places;
const wheaton = P("city", "Wheaton, IL");
const cls = (input: Parameters<typeof signalsOf>[0], places: Place[], z?: ZipFacts, cs?: CityStates) => classify(signalsOf(input).signals, places, z, cs);

console.log("deciding — cities");
{
  eq(cls({ city: "Wheaton", state: "Illinois" }, wheaton).cls, "match", "Wheaton, Illinois → in");
  eq(cls({ city: "Wheaton", state: "Illinois", address: "623 S Naperville Rd, Wheaton, IL 60187" }, wheaton).cls, "match", "all signals agree → in");
  eq(cls({ city: "Wheaton", state: "Maryland" }, wheaton).cls, "out", "Wheaton, MD isn't Wheaton, IL");
  eq(cls({ city: "Naperville", state: "Illinois" }, wheaton).cls, "out", "another IL city → not affected");
  eq(cls({ city: "Wheaton" }, wheaton).cls, "check", "no state → needs checking");
  eq(cls({ city: "Wheaton", state: "Illinois", address: "10 Main St, Naperville, IL 60540" }, wheaton).cls, "check", "city and address disagree → needs checking");
  eq(cls({ city: "Wheaton", state: "Illinois", replyState: "Texas" }, wheaton).cls, "check", "reply says another state → needs checking");
  eq(cls({ state: "Illinois" }, wheaton).cls, "out", "state only → not tied to one city, not listed");
  eq(cls({ state: "Texas" }, wheaton).cls, "out", "state only, other state → not affected");
  eq(cls({}, wheaton).cls, "noloc", "nothing → no location");
  eq(cls({ address: "(No Address Available)" }, wheaton).cls, "noloc", "placeholder address → no location");
  eq(cls({ city: "Saint Louis", state: "MO" }, P("city", "St. Louis, MO")).cls, "match", "Saint Louis matches St. Louis");
  const z: ZipFacts = new Map([["60187", { city: "Wheaton", state: "IL" }]]);
  eq(cls({ zip: "60187" }, wheaton, z).cls, "check", "ZIP of the city but no city field → needs checking");
  eq(cls({ city: "Springfield", state: "MO" }, P("city", "Springfield, IL")).cls, "out", "Springfield MO isn't Springfield IL");
  const zf: ZipFacts = new Map([["60187", { city: "Wheaton", state: "IL" }], ["60540", { city: "Naperville", state: "IL" }]]);
  eq(cls({ city: "Wheaton", state: "IL", address: "1 Main St, Wheaton, IL 60540" }, wheaton, zf).cls, "check", "Wheaton with a Naperville ZIP → needs checking");
  eq(cls({ city: "Wheaton", state: "IL", address: "1 Main St, Wheaton, IL 60187" }, wheaton, zf).cls, "match", "Wheaton with a Wheaton ZIP → in");
  eq(cls({ city: "Wheaton", state: "N/A" }, wheaton).cls, "check", "placeholder state = no state → needs checking");
  eq(cls({ city: "Wheaton", state: "Unknown" }, wheaton).reason, "City is Wheaton, but its state isn't known", "“Unknown” is no state");
  eq(cls({ city: "Wheaton", state: "Ill." }, wheaton).cls, "match", "Ill. reads as IL");
  eq(cls({ city: "Wheaton", state: "Ilinois" }, wheaton).cls, "check", "an unreadable state → needs checking, never hidden");
  eq(cls({ state: "N/A" }, wheaton).cls, "noloc", "only a placeholder → no location");
}

console.log("deciding — states");
{
  const il = P("state", "IL");
  eq(cls({ city: "Chicago", state: "Illinois" }, il).cls, "match", "IL lead → in");
  eq(cls({ city: "Chicago", state: "IL" }, il).cls, "match", "IL written as code → in");
  eq(cls({ state: "Illinois", address: "5 Main St, Gary, IN 46402" }, il).cls, "check", "state field IL, address IN → needs checking");
  eq(cls({ city: "Gary", state: "Indiana" }, il).cls, "out", "IN lead → not affected");
  eq(cls({ state: "Ontario" }, il).cls, "out", "province isn't 'no state' and isn't IL");
  const z: ZipFacts = new Map([["60187", { city: "Wheaton", state: "IL" }]]);
  eq(cls({ zip: "60187" }, il, z).cls, "match", "ZIP alone tells the state → in");
  eq(cls({ city: "Chicago" }, il).cls, "out", "city with no state isn't assumed to be in IL");
  const zf2: ZipFacts = new Map([["75001", { city: "Addison", state: "TX" }], ["60187", { city: "Wheaton", state: "IL" }]]);
  eq(cls({ city: "Chicago", state: "IL", zip: "75001" }, il, zf2).cls, "check", "IL state with a Texas ZIP → needs checking");
  eq(cls({ city: "Chicago", state: "IL", zip: "60187" }, il, zf2).cls, "match", "IL state with an IL ZIP → in");
  eq(cls({ city: "Chicago", state: "Ilinois" }, il).cls, "out", "unreadable state, no ZIP → can't place it in IL");

  // With the US ZIP table's cities: the lead's city has to agree with the state.
  const cs: CityStates = new Map([
    ["chicago", new Set(["IL"])], ["gary", new Set(["IN"])], ["springfield", new Set(["IL", "MO", "MA"])], ["st louis", new Set(["MO"])],
  ]);
  const inS = P("state", "IN");
  eq(cls({ city: "Gary", state: "IN" }, inS, undefined, cs).cls, "match", "Gary, IN with IN removed → in");
  const chiIn = cls({ city: "Chicago", state: "IN" }, inS, undefined, cs);
  eq([chiIn.cls, chiIn.reason], ["check", "State is IN, but its city (chicago) isn't a city in IN"], "Chicago with state IN → needs checking, not pre-ticked");
  eq(cls({ city: "Midtown", state: "IN" }, inS, undefined, cs).cls, "match", "a city we don't know can't disagree → in");
  const chiOnly = cls({ city: "Chicago" }, il, undefined, cs);
  eq([chiOnly.cls, chiOnly.reason], ["check", "No state on this lead — its city, chicago, is a city in IL"], "city only, a city in the removed state → listed to check");
  eq(cls({ city: "Springfield" }, il, undefined, cs).cls, "check", "a city name found in several states incl. the removed one → listed to check");
  eq(cls({ city: "Chicago" }, P("state", "TX"), undefined, cs).cls, "out", "city only, not a city in the removed state → not affected");
  eq(cls({ city: "Chicago", state: "Ilinois" }, il, undefined, cs).cls, "check", "unreadable state, city in IL → listed to check");
  eq(cls({ city: "Saint Louis", state: "MO" }, P("state", "MO"), undefined, cs).cls, "match", "Saint Louis read as St. Louis against the table");
  eq(cls({ city: "Chicago", state: "IL" }, il, undefined, cs).cls, "match", "Chicago, IL with IL removed → still in");
}

console.log("deciding — ZIPs");
{
  const zp = P("zip", "60187").map((p) => ({ ...p, city: "Wheaton", state: "IL", cityZipCount: 2 }));
  const zpBig = P("zip", "78701").map((p) => ({ ...p, city: "Austin", state: "TX", cityZipCount: 47 }));
  eq(cls({ address: "515 S Wheaton Ave, Wheaton, IL 60187" }, zp).cls, "match", "address ZIP → in");
  eq(cls({ zip: "60187", state: "Illinois" }, zp).cls, "match", "ZIP field → in");
  eq(cls({ address: "1 Main St, Wheaton, IL 60189" }, zp).cls, "out", "other ZIP in the same city → not affected");
  eq(cls({ city: "Wheaton", state: "Illinois" }, zp).cls, "check", "same small city (2 ZIPs), no ZIP → needs checking");
  eq(cls({ city: "Austin", state: "Texas" }, zpBig).cls, "out", "Austin (47 ZIPs), no ZIP → not listed (no real sign it's in 78701)");
  eq(cls({ city: "Austin", state: "Texas", address: "1 Main St, Austin, TX 78701" }, zpBig).cls, "match", "Austin lead with ZIP 78701 → in");
  eq(cls({ state: "Illinois" }, zp).cls, "out", "state only → not listed for a ZIP");
  eq(cls({ zip: "60187", city: "Wheaton", replyCity: "Carol Stream", state: "IL" }, zp).cls, "check", "ZIP matches but two different cities → needs checking");
  eq(cls({ zip: "60187", state: "Texas" }, zp).cls, "check", "ZIP of IL with a TX state → needs checking");
  eq(cls({ zip: "60187", address: "1 Main St, Wheaton, IL 60189" }, zp).cls, "check", "two different ZIPs → needs checking");
  eq(cls({ zip: "60187", city: "Naperville", state: "IL" }, zp).cls, "check", "ZIP of Wheaton but the city says Naperville → needs checking");
  eq(cls({ zip: "60187", state: "IL", replyState: "Texas" }, zp).cls, "check", "ZIP with two different states → needs checking");
  eq(cls({ zip: "60187", state: "Ilinois" }, zp).cls, "check", "ZIP with an unreadable state → needs checking");
  const zNoFacts = P("zip", "99999");
  eq(cls({ zip: "99999", state: "IL", replyState: "TX" }, zNoFacts).cls, "check", "unknown ZIP with two states → needs checking");
}

console.log("several places at once, and merging");
{
  const many = [...P("city", "Wheaton, IL"), ...P("state", "TX")];
  eq(cls({ city: "Austin", state: "Texas" }, many).place, "state:TX", "the place that matched is reported");
  eq(cls({ city: "Wheaton", state: "IL" }, many).place, "city:IL:wheaton", "the city entry matched");
  const a = signalsOf(inputFromCustomVars([{ name: "City", value: "Wheaton" }, { name: "State", value: "Illinois" }])).signals;
  const b = signalsOf({ replyCity: "Chicago", replyState: "Illinois" }).signals;
  eq(classify(a, wheaton).cls, "match", "Bison custom variables read case-insensitively");
  eq(classify(mergeSignals(a, b), wheaton).cls, "check", "a reply naming another city turns it into needs checking");
}

console.log("search terms + dates");
{
  eq(searchTermFor(P("city", "St. Louis, MO")[0]), "Louis", "St. Louis searched by its main word");
  eq(searchTermFor(P("city", "Salt Lake City, UT")[0]), "Salt", "longest word (first of equals)");
  eq(searchTermFor(P("state", "IL")[0]), "Illinois", "state searched by name");
  eq(searchTermFor(P("zip", "60187")[0]), "60187", "ZIP searched as is");
  eq(removalDate("2026-10-01"), "2026-10-06", "notice Oct 1 → removal Oct 6");
  eq(removalDate("2026-10-29"), "2026-11-03", "across a month end");
  eq(pacificMidnight("2026-10-06").toISOString(), "2026-10-06T07:00:00.000Z", "PDT midnight");
  eq(pacificMidnight("2026-12-01").toISOString(), "2026-12-01T08:00:00.000Z", "PST midnight");
  eq(pacificMidnight("2026-11-01").toISOString(), "2026-11-01T07:00:00.000Z", "the day DST ends starts in PDT");
  eq(pacificMidnight("2027-03-14").toISOString(), "2027-03-14T08:00:00.000Z", "the day DST starts begins in PST");
  ok(isIsoDate("2026-10-21") && !isIsoDate("2026-02-31") && !isIsoDate("2026-13-01") && !isIsoDate("10/21/2026"), "only real YYYY-MM-DD dates");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
