import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunPlan, ScenarioLibrary } from "@alm/engine";
import { geometry, knotsFor, pictureFor } from "../scenarios/shockPicture";
import { addLibraryScenario, removeScenario, setDefaultSet, setScenarioSet } from "../scenarios/scenarioEdits";
import { libraryCards, planCards, rateSpecText } from "../scenarios/scenarioCards";
import { ShockPicture } from "../charts/ShockPicture";
import { planDoc } from "./fixtures/run";

const LIBS: ScenarioLibrary[] = [
  { schemaVersion: "1.0.0", id: "regulatory-grid-v1", label: "grid", scenarios: [
    { id: "S0", label: "Base", rateSpec: { kind: "base" } },
    { id: "S200", label: "+200", rateSpec: { kind: "parallel", shockBp: 200 } },
  ] },
  { schemaVersion: "1.0.0", id: "steepener-v1", label: "steep", scenarios: [{ id: "STEEP100", label: "Steepener", rateSpec: { kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 } }] },
  { schemaVersion: "1.0.0", id: "ramp-200-12m-v1", label: "ramp", scenarios: [{ id: "R200", label: "Ramp", rateSpec: { kind: "parallel", shockBp: 200 }, timing: { kind: "ramp", months: 12 } }] },
];
const PLAN: RunPlan = planDoc("plan-x", []);

describe("shock pictures", () => {
  it("draws only the stated knots", () => {
    expect(knotsFor({ kind: "parallel", shockBp: -100 })).toEqual([{ x: 0, bp: -100 }, { x: "end", bp: -100 }]);
    expect(knotsFor({ kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 })).toEqual([{ x: 0, bp: 0 }, { x: 5, bp: 0 }, { x: "end", bp: 100 }]);
    expect(knotsFor({ kind: "custom", shocks: [{ tenorYears: 1, shockBp: 50 }, { tenorYears: 10, shockBp: 100 }] }))
      .toEqual([{ x: 0, bp: 50 }, { x: 1, bp: 50 }, { x: 10, bp: 100 }, { x: "end", bp: 100 }]);
  });
  it("places the curve end at the right edge with no number, and gives it no tick (the words sit above the plot)", () => {
    const g = geometry([{ x: 0, bp: 0 }, { x: 5, bp: 0 }, { x: "end", bp: 100 }]);
    expect(g.points).toEqual([{ x: 0, y: 100 }, { x: 80, y: 100 }, { x: 100, y: 0 }]);
    expect(g.xTicks.map((t) => t.text)).toEqual(["0Y", "5Y"]);
    const kn = geometry(knotsFor({ kind: "custom", shocks: [{ tenorYears: 1, shockBp: 25 }, { tenorYears: 5, shockBp: 50 }, { tenorYears: 10, shockBp: -25 }] }));
    expect(kn.xTicks).toEqual([{ x: 0, text: "0Y" }, { x: 8, text: "1Y" }, { x: 40, text: "5Y" }, { x: 80, text: "10Y" }]);
  });
  it("refuses a ramp with the compile error named", () => {
    expect(pictureFor(LIBS[2]!.scenarios[0]!)).toEqual({ kind: "refused", reason: "refused at compile: ScenarioNotExecutableError (ramp timing over 12 months is typed, not executed)" });
  });
  it("refuses an environment scenario with the compile error named", () => {
    // Re-expectation: environment text names the mapping.
    expect(pictureFor({ id: "E1", rateSpec: { kind: "base" }, environment: { unemploymentPath: [0.042] } }))
      .toEqual({ kind: "refused", reason: "refused at compile: ScenarioNotExecutableError (environment paths are refused; map a macro path in the assumption set)" });
  });
  it("keeps a custom first knot at 0Y without a second 0Y knot, and centres a flat base on the zero line", () => {
    expect(knotsFor({ kind: "custom", shocks: [{ tenorYears: 0, shockBp: -25 }, { tenorYears: 2, shockBp: 10 }] }))
      .toEqual([{ x: 0, bp: -25 }, { x: 2, bp: 10 }, { x: "end", bp: 10 }]);
    const g = geometry(knotsFor({ kind: "base" }));
    expect(g.points).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(g.zeroY).toBe(0);
    const neg = geometry(knotsFor({ kind: "parallel", shockBp: -100 }));
    expect(neg.points).toEqual([{ x: 0, y: 100 }, { x: 100, y: 100 }]);
    expect(neg.zeroY).toBe(0);
  });
});

describe("scenario edits", () => {
  it("adds a library ref once and removes by index", () => {
    const p = addLibraryScenario(PLAN, "steepener-v1#STEEP100");
    expect(p.scenarios).toEqual([{ ref: "regulatory-grid-v1#S0" }, { ref: "steepener-v1#STEEP100" }]);
    expect(addLibraryScenario(p, "steepener-v1#STEEP100")).toBe(p);
    expect(removeScenario(p, 1, LIBS).scenarios).toEqual([{ ref: "regulatory-grid-v1#S0" }]);
    expect(PLAN.scenarios).toEqual([{ ref: "regulatory-grid-v1#S0" }]);
  });
  it("inlines a ref to give it a set and keeps inputs.assumptionSets in step", () => {
    const p = setScenarioSet(addLibraryScenario(PLAN, "regulatory-grid-v1#S200"), 1, "stack-0123456789ab", LIBS);
    expect(p.scenarios[1]).toEqual({ id: "S200", label: "+200", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: "stack-0123456789ab" });
    expect(p.inputs.assumptionSets).toEqual(["demo-behavioral-v1", "stack-0123456789ab"]);
    const q = setScenarioSet(p, 1, null, LIBS);
    expect(q.scenarios[1]).toEqual({ id: "S200", label: "+200", rateSpec: { kind: "parallel", shockBp: 200 } });
    expect(q.inputs.assumptionSets).toEqual(["demo-behavioral-v1"]);
    expect(setDefaultSet(PLAN, "stack-0123456789ab").inputs.assumptionSets).toEqual(["stack-0123456789ab"]);
    expect(Object.keys(p)).toEqual(Object.keys(PLAN));
  });
  it("treats a null set on a library ref as a no-op and leaves the input plan untouched", () => {
    const before = JSON.stringify(PLAN);
    expect(setScenarioSet(PLAN, 0, null, LIBS)).toBe(PLAN);
    const p = setScenarioSet(PLAN, 0, "liq", LIBS);
    expect(JSON.stringify(PLAN)).toBe(before);
    expect(Object.keys(p.inputs)).toEqual(Object.keys(PLAN.inputs));
    expect(p.scenarios).toEqual([{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "liq" }]);
  });
});

describe("scenario cards", () => {
  it("describes each scenario in words and says where its set comes from", () => {
    const p = setScenarioSet(addLibraryScenario(PLAN, "regulatory-grid-v1#S200"), 1, "liq", LIBS);
    const cards = planCards(p, LIBS);
    expect(cards.map((c) => [c.id, c.source, c.setText])).toEqual([
      ["S0", "library ref regulatory-grid-v1#S0", "plan default: demo-behavioral-v1"],
      ["S200", "inline copy of regulatory-grid-v1#S200", "liq"],
    ]);
    expect(cards.map((c) => [c.ref, c.refKnown])).toEqual([
      ["regulatory-grid-v1#S0", true],
      ["regulatory-grid-v1#S200", true],
    ]);
    expect(rateSpecText({ kind: "parallel", shockBp: 200 })).toBe("Parallel +200bp, all tenors");
    expect(rateSpecText({ kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 })).toBe("Twist: 0bp at 0Y, 0 at 5Y, +100bp at the longest curve tenor");
    expect(libraryCards(p, LIBS).map((c) => c.id)).toEqual(["STEEP100", "R200"]);
  });
  it("writes a negative parallel, a custom vector and the base in words", () => {
    expect(rateSpecText({ kind: "parallel", shockBp: -100 })).toBe("Parallel -100bp, all tenors");
    expect(rateSpecText({ kind: "custom", shocks: [{ tenorYears: 1, shockBp: 50 }, { tenorYears: 10, shockBp: 100 }] }))
      .toBe("Custom: +50bp at 1Y, +100bp at 10Y, flat beyond");
    expect(rateSpecText({ kind: "base" })).toBe("Base curve, no shock");
  });
  it("refuses the picture of an unknown ref", () => {
    const p: RunPlan = { ...PLAN, scenarios: [{ ref: "nope-v1#X" }] };
    const [card] = planCards(p, LIBS);
    expect(card!.id).toBe("X");
    expect(card!.index).toBe(0);
    expect(card!.picture).toEqual({ kind: "refused", reason: 'unknown scenario ref "nope-v1#X"' });
    expect([card!.ref, card!.refKnown]).toEqual(["nope-v1#X", false]);
  });
  it("gives a plain inline scenario no ref", () => {
    const p: RunPlan = { ...PLAN, scenarios: [{ id: "MINE", label: "Mine", rateSpec: { kind: "parallel", shockBp: 50 } }] };
    const [card] = planCards(p, LIBS);
    expect([card!.source, card!.ref, card!.refKnown]).toEqual(["inline", null, true]);
  });
  it("says validate refuses a plan that names no default set", () => {
    const p: RunPlan = { ...PLAN, inputs: { ...PLAN.inputs, assumptionSets: [] } };
    expect(planCards(p, LIBS)[0]!.setText).toBe("plan default: none stated, validate refuses the plan until a default set is named");
  });
  it("gives a library card no plan index", () => {
    expect(libraryCards(PLAN, LIBS).map((c) => [c.index, c.source, c.ref, c.refKnown])).toEqual([
      [null, "library ref regulatory-grid-v1#S200", "regulatory-grid-v1#S200", true],
      [null, "library ref steepener-v1#STEEP100", "steepener-v1#STEEP100", true],
      [null, "library ref ramp-200-12m-v1#R200", "ramp-200-12m-v1#R200", true],
    ]);
  });
});

describe("ShockPicture", () => {
  it("draws the knots as an SVG line with the ticks and a knot table", () => {
    const html = renderToStaticMarkup(createElement(ShockPicture, { picture: pictureFor(LIBS[1]!.scenarios[0]!), label: "Steepener" }));
    expect(html).toContain("<svg");
    expect(html).toContain('points="0,100 80,100 100,0"');
    expect(html).toContain('stroke="var(--series-1)"');
    expect(html).toContain('stroke="var(--ink-2)"');
    expect(html).toContain('vector-effect="non-scaling-stroke"');
    expect(html).toContain('preserveAspectRatio="none"');
    expect(html).toContain("longest curve tenor");
    expect(html).toContain("<table");
    expect(html).toContain('<tr><th scope="row">0Y</th><td class="num">0</td></tr><tr><th scope="row">5Y</th><td class="num">0</td></tr><tr><th scope="row">longest curve tenor</th><td class="num">100</td></tr>');
  });
  it("prints the right edge's words in the top row, clear of the tenor labels under the plot", () => {
    const html = renderToStaticMarkup(createElement(ShockPicture, { picture: pictureFor(LIBS[1]!.scenarios[0]!), label: "Steepener" }));
    expect(html).toContain('<div class="plot-top"><span>bp shift by tenor</span><span>right edge: longest curve tenor</span></div>');
    const ticks = html.slice(html.indexOf('<div class="plot-cats"'), html.indexOf("<details"));
    expect(ticks).toContain(">5Y</span>");
    expect(ticks).not.toContain("longest curve tenor");
  });
  it("shows a refusal as its reason and draws no SVG", () => {
    const html = renderToStaticMarkup(createElement(ShockPicture, { picture: pictureFor(LIBS[2]!.scenarios[0]!), label: "Ramp" }));
    expect(html).not.toContain("<svg");
    expect(html).toContain('<span class="status status-unobs">Refused</span>');
    expect(html).toContain("refused at compile: ScenarioNotExecutableError (ramp timing over 12 months is typed, not executed)");
  });
});
