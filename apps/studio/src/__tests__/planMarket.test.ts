import { describe, expect, it } from "vitest";
import type { PlanDoc } from "../plan/planGraph";
import { marketChoices, marketNote, marketOptionText, withMarket } from "../plan/planMarket";

const BASE = "market-public-2026-03-31";
const SHOCK = "tlp-shock-demo-v1";
const R = [
  { id: BASE },
  { id: SHOCK, derivedFromMarketId: BASE },
  { id: "other-market" },
  { id: "derived-mk-aaa", derivedFromMarketId: "other-market" },
];

function planOf(inputs: Record<string, unknown>): PlanDoc {
  return {
    schemaVersion: "1.1.0",
    planId: "p",
    label: "p",
    authoredBy: "person",
    asOf: "2026-03-31",
    grid: { horizonMonths: 12 },
    inputs,
    stages: [],
    scenarios: [],
    reports: [],
    validationRules: { typeGate: [], routingGate: [] },
  } as unknown as PlanDoc;
}

describe("marketChoices", () => {
  it("offers the base and its own derived copy only", () => {
    expect(marketChoices(BASE, R)).toEqual({
      base: BASE,
      options: [{ id: BASE, derived: false }, { id: SHOCK, derived: true }],
    });
  });

  it("recovers the base from a copy and gives the same options", () => {
    expect(marketChoices(SHOCK, R)).toEqual(marketChoices(BASE, R));
  });

  it("never offers another market's copy, nor an unrelated market", () => {
    const ids = marketChoices(BASE, R).options.map((o) => o.id);
    expect(ids).not.toContain("other-market");
    expect(ids).not.toContain("derived-mk-aaa");
  });

  it("sorts the copies by id", () => {
    const rows = [{ id: BASE }, { id: "zz", derivedFromMarketId: BASE }, { id: "aa", derivedFromMarketId: BASE }];
    expect(marketChoices(BASE, rows).options.map((o) => o.id)).toEqual([BASE, "aa", "zz"]);
  });

  it("gives one option, itself, and the no-copy note for an unlisted plan market", () => {
    const r = marketChoices("x", R);
    expect(r).toEqual({ base: "x", options: [{ id: "x", derived: false }] });
    // Re-expectation: the note now names all three pages that store a derived copy.
    expect(marketNote(r)).toBe("No derived copy of x is stored; derive one on Funding spread shocks, Rate indices or Volatility shocks.");
  });

  it("treats a copy whose base is not listed as its own base", () => {
    const r = marketChoices("orphan", [{ id: "orphan", derivedFromMarketId: "gone" }]);
    expect(r.base).toBe("orphan");
    expect(r.options).toHaveLength(1);
  });
});

describe("marketOptionText and marketNote", () => {
  const r = marketChoices(BASE, R);
  it("marks the base and shows a copy bare", () => {
    expect(marketOptionText(r.options[0]!, r.base)).toBe("market-public-2026-03-31 (base)");
    expect(marketOptionText(r.options[1]!, r.base)).toBe(SHOCK);
  });
  it("counts the copies", () => {
    expect(marketNote(r)).toBe("market-public-2026-03-31 and 1 derived copy");
    const two = marketChoices(BASE, [...R, { id: "tlp-b", derivedFromMarketId: BASE }]);
    expect(marketNote(two)).toBe("market-public-2026-03-31 and 2 derived copies");
  });
});

describe("withMarket", () => {
  const loaded = planOf({ marketSnapshot: BASE, positionBook: "b", routingPolicy: "r", assumptionSets: ["s"] });

  it("changes only marketSnapshot, keeping key order, and leaves the input untouched", () => {
    const snapshot = structuredClone(loaded);
    const away = withMarket(loaded, loaded, SHOCK);
    expect(Object.keys(away.inputs)).toEqual(["marketSnapshot", "positionBook", "routingPolicy", "assumptionSets"]);
    expect(away.inputs).toEqual({ marketSnapshot: SHOCK, positionBook: "b", routingPolicy: "r", assumptionSets: ["s"] });
    expect(loaded).toEqual(snapshot);
  });
});
