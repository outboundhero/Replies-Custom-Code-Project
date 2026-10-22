/**
 * Onboarding Form service-area text → places, and the diff between two versions
 * (lib/service-area-changes/area-text.ts). Shapes below are taken from real cells.
 * Run: npx tsx tests/service-area/area-text.test.ts
 */
import { areaItems, diffAreaText } from "../../lib/service-area-changes/area-text";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, x: unknown = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗ FAIL:", n, typeof x === "string" ? x : JSON.stringify(x)); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), n, { got: a, want: b });
const keys = (t: string) => [...areaItems(t).keys()].sort();
const labels = (xs: { label: string }[]) => xs.map((x) => x.label);

console.log("reading the text");
{
  eq(keys("texas: alvin, angleton, Lake Jackson"), ["city:TX:alvin", "city:TX:angleton", "city:TX:lake jackson"], "“state: a, b” — cities in that state");
  eq(keys("new york: bronx, brooklyn, new york"), ["city:NY:bronx", "city:NY:brooklyn", "city:NY:new york"], "a city named like its state stays a city in a state list");
  eq(keys("07109\n07922\n07003"), ["zip:07003", "zip:07109", "zip:07922"], "one ZIP per line");
  eq(keys("Schaumburg 60159-60162, 60169"), ["city::schaumburg", "zip:60159", "zip:60160", "zip:60161", "zip:60162", "zip:60169"], "ZIP range expanded, city kept");
  eq(keys("Houston, TX\nDallas, tx"), ["city:TX:dallas", "city:TX:houston"], "“City, ST” → the city in that state (code in any case)");
  eq(keys("Manhattan, Brooklyn, New York, Queens"), ["city::brooklyn", "city::manhattan", "city::new york", "city::queens"], "a state's name among cities is a city (never swallowed as a state)");
  eq(keys("New York, NY"), ["city:NY:new york"], "“New York, NY” is the city");
  eq(keys("Washington, DC"), ["city:DC:washington"], "“Washington, DC” is the city");
  eq(keys("Portland, OR\nSalem, or"), ["city:OR:portland", "city:OR:salem"], "Oregon's code isn't read as the word “or”");
  eq(keys("1. Houston\n2) Dallas\n- Austin"), ["city::austin", "city::dallas", "city::houston"], "list numbers and bullets aren't part of the name");
  eq(keys("60601 - 60603"), ["zip:60601", "zip:60602", "zip:60603"], "a spaced ZIP range is still a range");
  eq(keys("Texas: Houston\nPhoenix, AZ"), ["city:AZ:phoenix", "city:TX:houston"], "a city's own state beats the block's");
  eq(keys("Texas: Houston\n\nPhoenix"), ["city::phoenix", "city:TX:houston"], "a state label covers its own block, not the next one");
  eq(keys("| City | State |\n|---|---|\n| Katy | Texas |\n| Sugar Land | TX |"), ["city:TX:katy", "city:TX:sugar land"], "a city / state table with no ZIP column");
  const ex = areaItems("All of Ohio except Cincinnati, OH and Dayton");
  eq([...ex.values()].map((x) => [x.key, !!x.excluded]), [["city::ohio", false], ["ex:city:OH:cincinnati", true], ["ex:city::dayton", true]], "“except …” places are kept apart as exclusions");
  eq(keys("houston, tx"), ["city:TX:houston"], "a lower-case code on its own is still the state");
  eq(keys("Washington DC"), ["city:DC:washington"], "“City ST” in one item");
  eq(keys("Ohio, Kentucky, Indiana"), ["state:IN", "state:KY", "state:OH"], "a list of states");
  eq(keys("OH, KY, IN"), ["state:IN", "state:KY", "state:OH"], "a list of state codes");
  eq(keys("Dallas or Fort Worth in the metro"), ["city::dallas or ft worth in the"], "prose: “or”/“in” inside a name aren't states");
  const jph = areaItems("In Alabama, counties: Madison, Limestone\nCities: Florence, Muscle Shoals, and Scottsboro");
  eq([...jph.keys()].sort(), ["city:AL:florence", "city:AL:muscle shoals", "city:AL:scottsboro", "county:AL:limestone", "county:AL:madison"], "“In Alabama, counties:” → AL counties; the state carries to the next list");
  eq(keys("| ZIP Code | City/Town | State |\n| -------- | --------- | ----- |\n| 80132 | Monument | Colorado |\n| 80133 | Palmer Lake | Colorado |"),
    ["city:CO:monument", "city:CO:palmer lake", "zip:80132", "zip:80133"], "markdown ZIP / city / state table");
  eq(keys("texas: alvin\nZip Code        City         County\n77083        HOUSTON        HARRIS\n77406        RICHMOND        FORT BEND"),
    ["city:TX:alvin", "city:TX:houston", "city:TX:richmond", "zip:77083", "zip:77406"], "space-aligned ZIP table in a state's block");
  eq(keys("texas: alvin\n\n77083        HOUSTON        HARRIS"), ["city::houston", "city:TX:alvin", "zip:77083"], "after a blank line the block's state no longer applies");
  eq(keys("All of Las Vegas, North Las Vegas and Henderson (Las Vegas Valley)"), ["city::henderson", "city::las vegas", "city::north las vegas"], "“All of …” and a bracketed note");
  eq(keys("Fairfield & New Haven County"), ["city::fairfield", "county::new haven"], "a county by name");
  eq(keys("Chicago: Norridge 60656, Jefferson Park 60630"), ["city::chicago", "city::jefferson park", "city::norridge", "zip:60630", "zip:60656"], "“Chicago: Norridge 60656” — neighbourhoods with ZIPs");
  eq(keys("N/A"), [], "a placeholder names nothing");
  eq(keys(""), [], "empty");
}

console.log("what changed");
{
  const before = "louisiana: abita springs, covington, mandeville, slidell, metairie";
  const d = diffAreaText(before, "louisiana: abita springs, covington, metairie, new orleans");
  eq([labels(d.removed), labels(d.added)], [["Mandeville, LA", "Slidell, LA"], ["New Orleans, LA"]], "two taken out, one added");
  const same = diffAreaText(before, "Louisiana:   Metairie, Abita Springs,Covington,  Mandeville , SLIDELL");
  eq([same.removed.length, same.added.length], [0, 0], "re-ordered, re-spaced, re-cased → no change");
  const split = diffAreaText("Indianapolis, Carmel Fishers Greenwood", "Indianapolis, Carmel, Fishers, Greenwood");
  eq([split.removed.length, split.added.length], [0, 0], "a comma-less run split into names → no change");
  const joined = diffAreaText("Carmel, Fishers, Greenwood", "Carmel Fishers Greenwood");
  eq([joined.removed.length, joined.added.length], [0, 0], "…and joined back → no change");
  const partial = diffAreaText("Indianapolis, Carmel Fishers Greenwood", "Indianapolis, Carmel, Fishers");
  ok(partial.removed.length === 1 && partial.added.length === 2, "split AND a name dropped → still reported (not hidden as a re-write)", partial);
  const z = diffAreaText("07109\n07922\n07003", "07109\n07003\n07005");
  eq([labels(z.removed), labels(z.added)], [["07922"], ["07005"]], "ZIP list: one out, one in");
  const st = diffAreaText("Ohio, Kentucky, Indiana", "Ohio, Indiana");
  eq(labels(st.removed), ["Kentucky"], "a state taken out");
  const moved = diffAreaText("texas: houston, dallas", "oklahoma: houston\ntexas: dallas");
  eq([labels(moved.removed), labels(moved.added)], [["Houston, TX"], ["Houston, OK"]], "same name under another state is a different place");
  const still = diffAreaText("texas: angleton, alvin\n77515        ANGLETON        BRAZORIA", "texas: alvin\n77515        ANGLETON        BRAZORIA");
  eq([still.removed.length, still.added.length], [0, 0], "a name still in the cell elsewhere (its ZIP table) isn't taken out");
  const withState = diffAreaText("Houston, Katy, Sugar Land", "Texas: Houston, Katy, Sugar Land");
  eq([withState.removed.length, withState.added.length], [0, 0], "writing the state on the list (or taking it off) isn't a change");
  const withCode = diffAreaText("Houston, Katy", "Houston, TX, Katy, TX");
  eq([withCode.removed.length, withCode.added.length], [0, 0], "…nor is adding “, TX” to each city");
  const nyc = diffAreaText("Manhattan, Brooklyn, New York, Queens", "Manhattan, Brooklyn, Queens");
  eq([labels(nyc.removed), nyc.added.length], [["New York"], 0], "taking “New York” out of the boroughs is reported as just that");
  const exc = diffAreaText("Ohio except Cincinnati, OH", "Ohio except Cincinnati, OH and Dayton, OH");
  eq([labels(exc.removed), exc.added.length], [["Dayton, OH (now excluded)"], 0], "a newly excluded place counts as taken out");
  const unexc = diffAreaText("Ohio except Cincinnati, OH and Dayton, OH", "Ohio except Cincinnati, OH");
  eq([unexc.removed.length, labels(unexc.added)], [0, ["Dayton, OH (no longer excluded)"]], "…and one no longer excluded as put back");
  const renum = diffAreaText("1. Houston\n2. Dallas", "1. Dallas\n2. Houston");
  eq([renum.removed.length, renum.added.length], [0, 0], "re-numbering a list isn't a change");
  const typo = diffAreaText("Portgage, Dunning", "Portage, Dunning");
  eq([labels(typo.removed), labels(typo.added)], [["Portgage"], ["Portage"]], "a spelling fix shows as out + in (a person sees it)");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
