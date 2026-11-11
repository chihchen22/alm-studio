// apps/studio/src/__tests__/guidedBehavior.test.ts
/**
 * The guided Behavior step's effective model per family and per position (S2a spec point 5). The book, the set and the
 * published defaults are written here by hand; every expected source (set, book, none), badge and saved binding follows
 * from those inputs by the rule stated in guided/behavior.ts, worked out here, never read back from familyRows.
 */
import { describe, expect, it } from "vitest";
import type { AssumptionSet, PortfolioSpec } from "@alm/engine";
import { choiceKey, familyRows, guidedSetsToDetach, nextGuidedSetId, noRoleSentence, rolesOf, setFromChoices, type PublishedModel } from "../guided/behavior";

const CPR_DEFAULT = { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 };
const CPR_FAST = { ...CPR_DEFAULT, maxCpr: 80 };
const BETA_DEFAULT = { betaMin: 0.45, betaMax: 0.8, k: 0.55, m: 4.0, lambda: 1 };
const DECAY_IB = { closureSteady: 1 } as unknown as Record<string, unknown>;

const MODELS: PublishedModel[] = [
  { key: "prepayment/mortgage", role: "prepayment", label: "CPR", instrumentTypes: ["mortgage"], overlay: { kind: "prepay", model: "four-factor-cpr", params: CPR_DEFAULT }, modelVersion: "published-default-v1", preview: "", source: "" },
  { key: "decay/nmd-b", role: "decay", label: "Decay", instrumentTypes: ["nmd-b"], overlay: { kind: "nmd-decay", params: DECAY_IB as never }, modelVersion: "published-default-v1", preview: "", source: "" },
  { key: "repricing/nmd-b", role: "repricing", label: "Beta", instrumentTypes: ["nmd-b"], overlay: { kind: "deposit-beta", params: BETA_DEFAULT }, modelVersion: "published-default-v1", preview: "", source: "" },
];

/** Two mortgages (one tagged "jumbo", one on faster prepayment values), a savings deposit with no blocks, a loan. */
const BOOK = {
  id: "b", label: "B", asOf: "2026-03-31",
  coa: {
    schemaVersion: "1.0.0",
    nodes: [],
    families: [
      { id: "mort", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "n1" },
      { id: "sav", label: "Savings", side: "liability", instrumentType: "nmd-b", coaNodeId: "n2" },
      { id: "loan", label: "Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "n3" },
    ],
  },
  positions: [
    { id: "m1", familyId: "mort", coaNodeId: "n1", dimensions: { segment: "jumbo" }, terms: { type: "mortgage", label: "Jumbo pool", cprParams: CPR_DEFAULT } },
    { id: "m2", familyId: "mort", coaNodeId: "n1", dimensions: { segment: "conforming" }, terms: { type: "mortgage", label: "Conforming pool", cprParams: CPR_FAST } },
    { id: "s1", familyId: "sav", coaNodeId: "n2", terms: { type: "nmd-b", label: "Savings" } },
    { id: "l1", familyId: "loan", coaNodeId: "n3", terms: { type: "fixed-loan", label: "Loan" } },
  ],
} as unknown as PortfolioSpec;

describe("roles and families", () => {
  it("only the instrument types with a published default get a choice; the rest say what applies", () => {
    expect(rolesOf("mortgage")).toEqual(["prepayment"]);
    expect(rolesOf("nmd")).toEqual(["decay"]);
    expect(rolesOf("nmd-b")).toEqual(["decay", "repricing"]);
    expect(rolesOf("fixed-loan")).toEqual([]);
    expect(rolesOf("floating-loan")).toEqual([]);
    expect(noRoleSentence("fixed-loan")).toMatch(/^Contractual cash flows/);
  });

  it("with no set: each mortgage runs on its own block, one badged default and one not; savings has nothing to run", () => {
    const rows = familyRows(BOOK, null, MODELS);
    const mort = rows[0]!.roles[0]!;
    expect(mort.positions.map((p) => [p.id, p.effective.source, p.effective.isDefault])).toEqual([["m1", "book", true], ["m2", "book", false]]);
    expect(mort.summary).toBe("Mixed: 1 on its own position values, equal to the published default; 1 on its own position values.");
    expect(mort.options).toEqual(["book", "default"]);
    expect(mort.initial).toBe("book");
    const sav = rows[1]!;
    expect(sav.roles.map((r) => [r.role, r.positions[0]!.effective.source, r.options.join(","), r.initial])).toEqual([
      ["decay", "none", "default", "default"],
      ["repricing", "none", "default", "default"],
    ]);
    expect(rows[2]!.roles).toEqual([]);
    expect(rows[0]!.tags).toEqual({ segment: ["jumbo", "conforming"] });
  });

  it("a set binding on the jumbo tag covers m1 only; m2 falls back to its own block", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0", id: "s", label: "S",
      bindings: [
        { familyId: "mort", overlay: { kind: "prepay", model: "four-factor-cpr", params: CPR_FAST }, modelVersion: "fitted-v3", selector: { segment: "jumbo" } },
        { familyId: "loan", overlay: { kind: "cd-rollover", renewalProbability: 0.5, offeredSpreadBp: 10, termMonths: 12 }, modelVersion: "cd-v1" },
        { familyId: "gone", overlay: { kind: "nmd-decay", params: DECAY_IB as never }, modelVersion: "x" },
      ],
    };
    const rows = familyRows(BOOK, set, MODELS);
    const mort = rows[0]!.roles[0]!;
    expect(mort.positions.map((p) => [p.id, p.effective.source, p.effective.modelVersion, p.effective.isDefault])).toEqual([
      ["m1", "set", "fitted-v3", false],
      ["m2", "book", null, false],
    ]);
    expect(mort.positions[0]!.effective.selector).toEqual({ segment: "jumbo" });
    expect(mort.options).toEqual(["set", "book", "default"]);
    expect(mort.initial).toBe("set");
    expect(rows[2]!.otherBindings.map((b) => b.modelVersion)).toEqual(["cd-v1"]);
  });
});

describe("saving the choices", () => {
  it("default binds the published values, book binds nothing, set keeps its bindings; foreign families are dropped", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0", id: "s", label: "S",
      bindings: [
        { familyId: "loan", overlay: { kind: "cd-rollover", renewalProbability: 0.5, offeredSpreadBp: 10, termMonths: 12 }, modelVersion: "cd-v1" },
        { familyId: "gone", overlay: { kind: "nmd-decay", params: DECAY_IB as never }, modelVersion: "x" },
      ],
    };
    const rows = familyRows(BOOK, set, MODELS);
    const saved = setFromChoices({ id: "guided-x-1", label: "Guided" }, rows, set, {
      [choiceKey("mort", "prepayment")]: { kind: "book" },
      [choiceKey("sav", "decay")]: { kind: "default" },
      [choiceKey("sav", "repricing")]: { kind: "default" },
    });
    expect(saved).toEqual({
      schemaVersion: "1.0.0", id: "guided-x-1", label: "Guided",
      bindings: [
        { familyId: "sav", overlay: { kind: "nmd-decay", params: { closureSteady: 1 } }, modelVersion: "published-default-v1" },
        { familyId: "sav", overlay: { kind: "deposit-beta", params: BETA_DEFAULT }, modelVersion: "published-default-v1" },
        { familyId: "loan", overlay: { kind: "cd-rollover", renewalProbability: 0.5, offeredSpreadBp: 10, termMonths: 12 }, modelVersion: "cd-v1" },
      ],
    });
  });

  it("a default narrowed to one tag writes the selector", () => {
    const rows = familyRows(BOOK, null, MODELS);
    const saved = setFromChoices({ id: "g", label: "G" }, rows, null, { [choiceKey("mort", "prepayment")]: { kind: "default", tag: { dimension: "segment", value: "jumbo" } } });
    expect(saved.bindings[0]).toEqual({ familyId: "mort", overlay: { kind: "prepay", model: "four-factor-cpr", params: CPR_DEFAULT }, modelVersion: "published-default-v1", selector: { segment: "jumbo" } });
  });

  it("a family the chart declares with no position gets no row and no binding", () => {
    const withEmpty = { ...BOOK, coa: { ...BOOK.coa, families: [...BOOK.coa.families, { id: "mbs", label: "MBS", side: "asset", instrumentType: "mortgage", coaNodeId: "n9" }] } } as unknown as PortfolioSpec;
    const rows = familyRows(withEmpty, null, MODELS);
    expect(rows.map((r) => r.familyId)).toEqual(["mort", "sav", "loan"]);
    const saved = setFromChoices({ id: "g", label: "G" }, rows, null, {});
    expect(saved.bindings.map((b) => b.familyId)).toEqual(["sav", "sav"]);
  });

  it("refuses a choice the row does not offer", () => {
    const rows = familyRows(BOOK, null, MODELS);
    expect(() => setFromChoices({ id: "g", label: "G" }, rows, null, { [choiceKey("sav", "decay")]: { kind: "book" } })).toThrow(/Savings, Deposit decay: "book" is not a choice here/);
  });

  it("names the next free set id per workspace", () => {
    expect(nextGuidedSetId("ws-example-bank", [])).toBe("guided-example-bank-1");
    expect(nextGuidedSetId("ws-example-bank", ["guided-example-bank-1", "guided-example-bank-2"])).toBe("guided-example-bank-3");
  });
});

describe("older guided sets leave the block on a save (fix round 1, L6)", () => {
  it("detaches this workspace's earlier guided sets only, never another workspace's or a non-guided set", () => {
    const attached = ["guided-my-analysis-1", "guided-my-analysis-2", "guided-my-analysis-2-1", "demo-behavioral-v1", "guided-my-analysis-3"];
    expect(guidedSetsToDetach("ws-my-analysis", attached, "guided-my-analysis-3")).toEqual(["guided-my-analysis-1", "guided-my-analysis-2"]);
  });
});
