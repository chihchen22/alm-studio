import { describe, expect, it } from "vitest";
import type { PlanDoc } from "../plan/planGraph";
import { serializePlan } from "../plan/planEdits";
import { withMarket } from "../plan/planMarket";
import { bookChoices, bookNote, bookOptionText, withBook } from "../plan/planBook";

const SEEDED = [
  "synthetic-2500-commit-v1",
  "synthetic-2500-hedged-v1",
  "synthetic-2500-hqla-v1",
  "synthetic-2500-lcr-v1",
  "synthetic-2500-v1",
  "synthetic-lcr-liabilities-v1",
  "vanilla-book-v1",
];
const LIAB = "synthetic-lcr-liabilities-v1";
const LIAB_COPY = "synthetic-lcr-liabilities-v1--liquidity-funding-demo-v1";
const LCR = "synthetic-2500-lcr-v1";
const LCR_COPY = "synthetic-2500-lcr-v1--liquidity-funding-demo-v1";

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

describe("bookChoices", () => {
  it("offers the base and its own re-tagged copy only", () => {
    const books = [...SEEDED, LIAB_COPY, LCR_COPY];
    expect(bookChoices(LIAB, books, ["liquidity-funding-demo-v1"])).toEqual({
      base: LIAB,
      options: [
        { id: LIAB, hierarchyId: null },
        { id: LIAB_COPY, hierarchyId: "liquidity-funding-demo-v1" },
      ],
    });
  });

  it("recovers the base from a copy and sorts copies by hierarchy id", () => {
    const books = [...SEEDED, LCR_COPY, `${LCR}--risk-demo`];
    const r = bookChoices(LCR_COPY, books, ["risk-demo", "liquidity-funding-demo-v1"]);
    expect(r.base).toBe(LCR);
    expect(r.options.map((o) => o.id)).toEqual([LCR, LCR_COPY, `${LCR}--risk-demo`]);
  });

  it("never offers another book's copy, nor any other seeded id", () => {
    const books = [...SEEDED, "synthetic-2500-commit-v1--liquidity-funding-demo-v1", LCR_COPY];
    const ids = bookChoices(LCR, books, ["liquidity-funding-demo-v1"]).options.map((o) => o.id);
    expect(ids).toEqual([LCR, LCR_COPY]);
    for (const s of SEEDED.filter((x) => x !== LCR)) expect(ids).not.toContain(s);
  });

  it("gives one option and the no-copy note for a book with no stored copy", () => {
    const r = bookChoices("synthetic-2500-v1", SEEDED, ["liquidity-funding-demo-v1"]);
    expect(r.options).toEqual([{ id: "synthetic-2500-v1", hierarchyId: null }]);
    expect(bookNote(r)).toBe(
      "No re-tagged copy of synthetic-2500-v1 is stored; apply a hierarchy to it on Hierarchies and mapping to make one.",
    );
  });

  it("treats a book whose suffix is not a stored hierarchy as its own base", () => {
    const r = bookChoices("a--b", ["a", "a--b"], ["c"]);
    expect(r.base).toBe("a--b");
    expect(r.options).toHaveLength(1);
  });

  it("gives one option, itself, for an unlisted plan book", () => {
    const r = bookChoices("nowhere", SEEDED, ["liquidity-funding-demo-v1"]);
    expect(r.options).toEqual([{ id: "nowhere", hierarchyId: null }]);
  });
});

describe("bookOptionText and bookNote", () => {
  const r = bookChoices(LIAB, [...SEEDED, LIAB_COPY], ["liquidity-funding-demo-v1"]);
  it("marks the base and shows a copy bare", () => {
    expect(bookOptionText(r.options[0]!, r.base)).toBe("synthetic-lcr-liabilities-v1 (base)");
    expect(bookOptionText(r.options[1]!, r.base)).toBe(LIAB_COPY);
  });
  it("counts the copies", () => {
    expect(bookNote(r)).toBe("synthetic-lcr-liabilities-v1 and 1 re-tagged copy");
    const two = bookChoices(LIAB, [...SEEDED, LIAB_COPY, `${LIAB}--risk-demo`], ["liquidity-funding-demo-v1", "risk-demo"]);
    expect(bookNote(two)).toBe("synthetic-lcr-liabilities-v1 and 2 re-tagged copies");
  });
});

describe("withBook", () => {
  const loaded = planOf({
    marketSnapshot: "m",
    positionBook: LIAB,
    routingPolicy: "r",
    dimensionTaxonomy: "liquidity-tags-v1",
    assumptionSets: ["s"],
  });

  it("drops dimensionTaxonomy on a switch and restores the loaded inputs on a switch back", () => {
    const away = withBook(loaded, loaded, LIAB_COPY);
    expect(Object.keys(away.inputs)).toEqual(["marketSnapshot", "positionBook", "routingPolicy", "assumptionSets"]);
    expect(away.inputs.positionBook).toBe(LIAB_COPY);
    const back = withBook(away, loaded, LIAB);
    expect(back.inputs).toEqual(loaded.inputs);
    expect(serializePlan(back)).toBe(serializePlan(loaded));
  });

  it("changes only positionBook on a plan with no taxonomy field, keeping key order", () => {
    const bare = planOf({ marketSnapshot: "m", positionBook: LIAB, routingPolicy: "r", assumptionSets: ["s"] });
    const away = withBook(bare, bare, LIAB_COPY);
    expect(Object.keys(away.inputs)).toEqual(["marketSnapshot", "positionBook", "routingPolicy", "assumptionSets"]);
    expect(away.inputs).toEqual({ marketSnapshot: "m", positionBook: LIAB_COPY, routingPolicy: "r", assumptionSets: ["s"] });
  });

  it("keeps the current market when it switches back to the loaded book", () => {
    const away = withBook(withMarket(loaded, loaded, "tlp-shock-demo-v1"), loaded, LIAB_COPY);
    const back = withBook(away, loaded, LIAB);
    expect(back.inputs.marketSnapshot).toBe("tlp-shock-demo-v1");
    expect(back.inputs).toEqual({ ...loaded.inputs, marketSnapshot: "tlp-shock-demo-v1" });
    expect(Object.keys(back.inputs)).toEqual(Object.keys(loaded.inputs));
  });

  it("leaves the input plan untouched", () => {
    const snapshot = structuredClone(loaded);
    withBook(loaded, loaded, LIAB_COPY);
    expect(loaded).toEqual(snapshot);
  });
});
