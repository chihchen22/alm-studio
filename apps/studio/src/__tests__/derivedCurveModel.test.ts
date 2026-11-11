// apps/studio/src/__tests__/derivedCurveModel.test.ts
/**
 * Market > Derived curves: the pure model behind the screen. Expected values are restated by
 * hand from the plan's Task 8 interfaces, never read from the model.
 */
import { describe, expect, it } from "vitest";
import {
  activeSetupIdOf, addRow, baseOptions, cellProblems, curveFromState, curveIdProblem, defaultDerivedCurve, defaultDerivedCurveFor, defaultState, defaultStateFor,
  FILL_RACE_SENTENCE, fillOutcome, fillProblem, gridTenors, removeRow, setCell, setFields, spreadSentence, stateFromCurve,
} from "../market/derivedCurveModel";

const SENT = { from: "sofr-main", minus: "platform-default" };
const OPTIONS = [{ value: "platform-default", text: "Platform default curve" }, { value: "sofr-main", text: "SOFR OIS" }];

describe("derivedCurveModel: defaults and the block", () => {
  it("the default curve is derived-1, New derived curve, on the platform default, at 1, 3, 6 and 12 months at 0 bp", () => {
    expect(defaultDerivedCurve()).toEqual({
      id: "derived-1", label: "New derived curve", base: "platform-default",
      spreads: [{ tenorMonths: 1, spreadBp: 0 }, { tenorMonths: 3, spreadBp: 0 }, { tenorMonths: 6, spreadBp: 0 }, { tenorMonths: 12, spreadBp: 0 }],
    });
    expect("source" in defaultDerivedCurve()).toBe(false);
  });

  it("curveFromState of the default state equals defaultDerivedCurve()", () => {
    expect(curveFromState(defaultState())).toEqual(defaultDerivedCurve());
    expect("source" in curveFromState(defaultState())).toBe(false);
  });

  it("reads typed cells as numbers and a stored curve back as it was", () => {
    const s = setCell(defaultState(), defaultState().rows[1]!.key, { spreadText: " -12.5 " });
    expect(curveFromState(s).spreads[1]).toEqual({ tenorMonths: 3, spreadBp: -12.5 });
    const stored = { id: "sofr-3m", label: "SOFR 3M", base: "sofr-main", spreads: [{ tenorMonths: 3, spreadBp: 8 }], source: SENT };
    expect(curveFromState(stateFromCurve(stored))).toEqual(stored);
  });

  // The server is the one authority on estimatedOnDefault, and ignores a posted one.
  it("the editor never sends estimatedOnDefault: a stamped curve opens and saves back without it", () => {
    const stamped = { id: "sofr-3m", label: "SOFR 3M", base: "platform-default", spreads: [{ tenorMonths: 3, spreadBp: 8 }], source: SENT, estimatedOnDefault: 1 as const };
    const { estimatedOnDefault: _e, ...unstamped } = stamped;
    void _e;
    expect(curveFromState(stateFromCurve(stamped))).toEqual(unstamped);
    expect("estimatedOnDefault" in curveFromState(defaultState())).toBe(false);
  });

  it("the spread sentence, verbatim", () => {
    expect(spreadSentence).toBe("The spread is added to index resets only. Mortgages, client rates, new business and discounting read the base curve.");
  });
});

describe("derivedCurveModel: base options", () => {
  it("the platform default first, then each setup by label, valued by the setup's own id", () => {
    expect(baseOptions([{ id: "sofr-main", label: "SOFR OIS" }])).toEqual([
      { value: "platform-default", text: "Platform default curve" },
      { value: "sofr-main", text: "SOFR OIS" },
    ]);
    expect(baseOptions([])).toEqual([{ value: "platform-default", text: "Platform default curve" }]);
  });

  it("marks the active setup's option (active), and only that one (M2)", () => {
    expect(baseOptions([{ id: "sofr-main", label: "SOFR OIS", active: true }, { id: "ust", label: "", active: false }])).toEqual([
      { value: "platform-default", text: "Platform default curve" },
      { value: "sofr-main", text: "SOFR OIS (active)" },
      { value: "ust", text: "ust" },
    ]);
  });

  it("a new curve sits on the active setup when one is active, else on the platform default (M2)", () => {
    expect(activeSetupIdOf([{ setupId: "ust", active: false }, { setupId: "sofr-main", active: true }])).toBe("sofr-main");
    expect(activeSetupIdOf([{ setupId: "ust", active: false }])).toBeNull();
    expect(activeSetupIdOf([])).toBeNull();
    expect(defaultDerivedCurveFor("sofr-main")).toEqual({ ...defaultDerivedCurve(), base: "sofr-main" });
    expect(defaultDerivedCurveFor(null)).toEqual(defaultDerivedCurve());
    expect(curveFromState(defaultStateFor("sofr-main"))).toEqual({ ...defaultDerivedCurve(), base: "sofr-main" });
    expect(defaultStateFor(null)).toEqual(defaultState());
    // The no-active default stays as specified.
    expect(defaultDerivedCurve().base).toBe("platform-default");
  });
});

describe("derivedCurveModel: the fill guard (M1)", () => {
  it("a fill of a curve minus itself is refused in words; two different curves are not", () => {
    const sentence = "Pick two different curves: a curve minus itself is zero at every tenor.";
    expect(fillProblem("platform-default", "platform-default")).toBe(sentence);
    expect(fillProblem("sofr-main", "sofr-main")).toBe(sentence);
    expect(fillProblem("sofr-main", "platform-default")).toBeNull();
  });
});

describe("derivedCurveModel: the fill", () => {
  const estimate = { ok: true as const, spreads: [{ tenorMonths: 1, spreadBp: 4.5 }, { tenorMonths: 3, spreadBp: 6 }, { tenorMonths: 6, spreadBp: 7.25 }, { tenorMonths: 12, spreadBp: 9 }] };

  it("a fill writes the estimated spreads, records its source by id, and names the menus by their option text", () => {
    const s = defaultState();
    const out = fillOutcome(s, s.version, estimate, SENT, OPTIONS);
    expect(curveFromState(out.state)).toEqual({ ...defaultDerivedCurve(), spreads: estimate.spreads, source: SENT });
    expect(out.lines).toEqual(["Filled 4 rows: SOFR OIS minus Platform default curve."]);
    // A menu value no option holds is named verbatim.
    expect(fillOutcome(s, s.version, estimate, { from: "gone", minus: "platform-default" }, OPTIONS).lines).toEqual(["Filled 4 rows: gone minus Platform default curve."]);
  });

  it("a fill then a cell edit drops source", () => {
    const s = defaultState();
    const filled = fillOutcome(s, s.version, estimate, SENT, OPTIONS).state;
    expect(curveFromState(filled).source).toEqual(SENT);
    const edited = setCell(filled, filled.rows[0]!.key, { spreadText: "5" });
    expect("source" in curveFromState(edited)).toBe(false);
    // Adding or removing a row is a grid edit too.
    expect("source" in curveFromState(addRow(filled))).toBe(false);
    expect("source" in curveFromState(removeRow(filled, filled.rows[3]!.key))).toBe(false);
    // The id, label and base are not cells: the source stays.
    expect(curveFromState(setFields(filled, { label: "SOFR 3M" })).source).toEqual(SENT);
  });

  it("a fill that lands after a cell or row change replaces nothing and says so (ruling R10)", () => {
    const s = defaultState();
    const started = s.version;
    for (const moved of [setCell(s, s.rows[0]!.key, { spreadText: "1" }), addRow(s), removeRow(s, s.rows[0]!.key)]) {
      const out = fillOutcome(moved, started, estimate, SENT, OPTIONS);
      expect(out.state).toBe(moved);
      expect(out.lines).toEqual(["The spreads grid changed while the spreads were estimated; nothing was replaced."]);
      expect(FILL_RACE_SENTENCE).toBe(out.lines[0]);
    }
  });

  it("an id, label or base typed while the estimate runs does not cancel the fill, and is kept (ruling R10)", () => {
    const s = defaultState();
    const started = s.version;
    for (const patch of [{ id: "other" }, { label: "SOFR 3M" }, { base: "sofr-main" }]) {
      const named = setFields(s, patch);
      const out = fillOutcome(named, started, estimate, SENT, OPTIONS);
      expect(curveFromState(out.state).spreads).toEqual(estimate.spreads);
      expect(out.state).toMatchObject(patch);
      expect(out.lines).toEqual(["Filled 4 rows: SOFR OIS minus Platform default curve."]);
    }
  });

  it("a refused estimate leaves the grid and prints the refusals one per line", () => {
    const s = defaultState();
    const refusals = ["row 4 (12 months): the estimated spread of 1200 bp is beyond the 1000 bp a derived curve carries", '"from" names curve setup "x", which workspace "w" does not hold'];
    const out = fillOutcome(s, s.version, { ok: false, refusals }, SENT, OPTIONS);
    expect(out.state).toBe(s);
    expect(out.lines).toEqual(refusals);
  });
});

describe("derivedCurveModel: cells and names", () => {
  it("names a cell that cannot be read, by row, and gives the grid's tenors only when every tenor reads", () => {
    const s = defaultState();
    expect(cellProblems(s)).toEqual([]);
    expect(gridTenors(s)).toEqual([1, 3, 6, 12]);
    const bad = setCell(setCell(s, s.rows[1]!.key, { tenorText: "3.5" }), s.rows[2]!.key, { spreadText: "" });
    expect(cellProblems(bad)).toEqual(["Row 2, tenor: type a whole number of months.", "Row 3, spread: type a number of basis points."]);
    expect(gridTenors(bad)).toBeNull();
    expect(gridTenors(addRow(s))).toBeNull();
  });

  it("the curve id follows the slot rule", () => {
    expect(curveIdProblem("sofr-3m.v2_a")).toBeNull();
    expect(curveIdProblem("")).toBe("Name the curve: 1 to 70 letters, digits, dots, underscores or hyphens.");
    expect(curveIdProblem("has space")).not.toBeNull();
    expect(curveIdProblem("x".repeat(71))).not.toBeNull();
  });
});
