/**
 * The opt-in deposit moving-average warmup.
 *
 * The option feeds every deposit a FLAT 36-month history at r0 and,
 * in an EVE scenario, re-levels it by the scenario's shock at tenor 0
 * (srp31_shock(name, 0) / 100: parallel +-2.00, short +-3.00, steepener -1.95,
 * flattener +2.40 percent). These tests pin the resolver that turns the run
 * option into one history per scenario, and the factory seam that hands a
 * history to the two deposit constructors. Expected values are restated by
 * hand, never imported from the module under test.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  NMD_B_TERMS_DEFAULTS,
  NMD_TERMS_DEFAULTS,
  NMDBeta,
  NMDeposit,
  buildWarmupSOFR1M,
  DeterministicRatePath,
  type RatePath,
} from "@alm/kernel";
import { loadMarket } from "../../run/__tests__/fixtures";
import { buildBaseCurve } from "../../scenario";
import type { Scenario } from "../../contracts/scenario";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { nmdWarmupConfigError, nmdWarmupOf, resolveNmdWarmup } from "../warmup";

const R0_PCT = 3.7111877541;
const s = (id: string, rateSpec: Scenario["rateSpec"], mode: "static" | "dynamic" = "static"): Scenario => ({
  id,
  label: id,
  rateSpec,
  assumptionSetId: "AS",
  newBusiness: mode === "static" ? { mode: "static", rules: [] } : ({ mode: "dynamic", rules: [] } as unknown as Scenario["newBusiness"]),
});

const SCENARIOS: Scenario[] = [
  s("S0", { kind: "base" }),
  s("P200", { kind: "parallel", shockBp: 200 }),
  s("P-100", { kind: "parallel", shockBp: -100 }),
  s("SRP-SUP", { kind: "custom", shocks: [{ tenorYears: 0.083333, shockBp: 293.8 }, { tenorYears: 30, shockBp: 1.6 }] }),
  s("SRP-STEEP", { kind: "custom", shocks: [{ tenorYears: 0.083333, shockBp: -190 }, { tenorYears: 30, shockBp: 200 }] }),
];

describe("resolveNmdWarmup (Task 16)", () => {
  it("builds one flat history per scenario: base at r0, parallel re-levelled by shockBp/100, custom by the stated shift", () => {
    const w = resolveNmdWarmup(
      { kind: "flat-at-r0", months: 36, shiftPctByScenario: { "SRP-SUP": 3.0, "SRP-STEEP": -1.95 } },
      SCENARIOS,
      R0_PCT,
    );
    expect(w.byScenario.get("S0")).toEqual(new Array(36).fill(R0_PCT));
    expect(w.byScenario.get("P200")).toEqual(new Array(36).fill(R0_PCT + 2.0));
    expect(w.byScenario.get("P-100")).toEqual(new Array(36).fill(R0_PCT - 1.0));
    expect(w.byScenario.get("SRP-SUP")).toEqual(new Array(36).fill(R0_PCT + 3.0));
    expect(w.byScenario.get("SRP-STEEP")).toEqual(new Array(36).fill(R0_PCT - 1.95));
    expect(w.unshifted).toEqual(new Array(36).fill(R0_PCT));
    expect(w.record).toEqual({
      kind: "flat-at-r0",
      months: 36,
      levelPct: R0_PCT,
      shiftPctByScenario: { S0: 0, P200: 2, "P-100": -1, "SRP-SUP": 3, "SRP-STEEP": -1.95 },
    });
    // Request order is the record's key order.
    expect(Object.keys((w.record as { shiftPctByScenario: Record<string, number> }).shiftPctByScenario)).toEqual(SCENARIOS.map((x) => x.id));
  });

  it("an explicit shift wins over the parallel rule", () => {
    const w = resolveNmdWarmup({ kind: "flat-at-r0", months: 24, shiftPctByScenario: { P200: 1.5 } }, SCENARIOS.slice(0, 3), R0_PCT);
    expect(w.byScenario.get("P200")).toEqual(new Array(24).fill(R0_PCT + 1.5));
  });

  it("refuses a custom scenario with no stated shift, naming the scenario and the field", () => {
    expect(() => resolveNmdWarmup({ kind: "flat-at-r0", months: 36 }, SCENARIOS, R0_PCT)).toThrow(
      /scenario "SRP-SUP".*nmdWarmup\.shiftPctByScenario/,
    );
  });

  it("refuses a bad kind, a non-integer or non-positive months, and a non-finite shift", () => {
    expect(() => resolveNmdWarmup({ kind: "kernel" } as never, SCENARIOS.slice(0, 1), R0_PCT)).toThrow(/nmdWarmup\.kind/);
    expect(() => resolveNmdWarmup({ kind: "flat-at-r0", months: 0 }, SCENARIOS.slice(0, 1), R0_PCT)).toThrow(/nmdWarmup\.months/);
    expect(() => resolveNmdWarmup({ kind: "flat-at-r0", months: 2.5 }, SCENARIOS.slice(0, 1), R0_PCT)).toThrow(/nmdWarmup\.months/);
    expect(() =>
      resolveNmdWarmup({ kind: "flat-at-r0", months: 36, shiftPctByScenario: { S0: Number.NaN } }, SCENARIOS.slice(0, 1), R0_PCT),
    ).toThrow(/nmdWarmup\.shiftPctByScenario/);
  });

  it("refuses months above 600 in a plain sentence naming nmdWarmup.months; 600 itself is accepted", () => {
    expect(nmdWarmupConfigError({ kind: "flat-at-r0", months: 601 }, "nmdWarmup")).toBe(
      "nmdWarmup.months must be at most 600 months (50 years), got 601",
    );
    expect(() => resolveNmdWarmup({ kind: "flat-at-r0", months: 100_000 }, SCENARIOS.slice(0, 1), R0_PCT)).toThrow(
      /nmdWarmup\.months must be at most 600 months/,
    );
    expect(nmdWarmupConfigError({ kind: "flat-at-r0", months: 600 }, "nmdWarmup")).toBeUndefined();
  });

  it("nmdWarmupOf leaves an empty shiftPctByScenario out and copies a non-empty one", () => {
    expect(nmdWarmupOf({ kind: "flat-at-r0", months: 36, shiftPctByScenario: {} })).toStrictEqual({ kind: "flat-at-r0", months: 36 });
    const stated = { "SRP-SUP": 3 };
    const copy = nmdWarmupOf({ kind: "flat-at-r0", months: 36, shiftPctByScenario: stated });
    expect(copy).toStrictEqual({ kind: "flat-at-r0", months: 36, shiftPctByScenario: { "SRP-SUP": 3 } });
    expect((copy as { shiftPctByScenario?: unknown }).shiftPctByScenario).not.toBe(stated);
    expect(nmdWarmupOf({ kind: "flat-at-r0", months: 36 })).toStrictEqual({ kind: "flat-at-r0", months: 36 });
  });

  it("refuses a scenario whose new business is not static runoff", () => {
    expect(() =>
      resolveNmdWarmup({ kind: "flat-at-r0", months: 36 }, [s("S0", { kind: "base" }), s("D1", { kind: "parallel", shockBp: 100 }, "dynamic")], R0_PCT),
    ).toThrow(/static-runoff scenarios only; scenario "D1" has new-business mode "dynamic"/);
  });
});

describe("makeInstrument nmdWarmup seam (Task 16)", () => {
  // The fixture market's forward path rises above a flat r0 history, so r - MA leaves zero and the warmup is read.
  let path: RatePath;
  beforeAll(async () => {
    path = new DeterministicRatePath(buildBaseCurve(await loadMarket()), 360);
  });
  const flat = new Array<number>(36).fill(R0_PCT);
  const nmd = { ...NMD_TERMS_DEFAULTS, id: "D", notional: 1_000_000, maturityMonths: 360 };
  const nmdb = { ...NMD_B_TERMS_DEFAULTS, id: "B", notional: 1_000_000, maturityMonths: 360, nmdParams: { ...NMD_B_TERMS_DEFAULTS.nmdParams, regimeAlpha: 1.0 } };

  it("absent, an nmd and an nmd-b position generate exactly what the kernel default warmup gives", () => {
    expect(makeInstrument(nmd).generateCashflows(path)).toEqual(new NMDeposit(nmd, buildWarmupSOFR1M()).generateCashflows(path));
    expect(makeInstrument(nmdb).generateCashflows(path)).toEqual(new NMDBeta(nmdb, buildWarmupSOFR1M()).generateCashflows(path));
  });

  it("present, both deposit constructors take the given history, and the cash flows move", () => {
    const a = makeInstrument(nmd, { nmdWarmup: flat }).generateCashflows(path);
    expect(a).toEqual(new NMDeposit(nmd, flat).generateCashflows(path));
    expect(a).not.toEqual(makeInstrument(nmd).generateCashflows(path));
    const b = makeInstrument(nmdb, { nmdWarmup: flat }).generateCashflows(path);
    expect(b).toEqual(new NMDBeta(nmdb, flat).generateCashflows(path));
  });
});

describe('the "history" warmup kind', () => {
  // A made-up dated series, January 2024 to June 2026: 30 months of 4.00, 4.01, ..., 4.29 percent.
  const values = Array.from({ length: 30 }, (_, i) => 4 + i / 100);
  const series = { label: "made-up test series", firstMonth: "2024-01", valuesPct: values };

  it("reads every month up to and including the as-of month, the same history in every scenario, dynamic ones too", () => {
    const w = resolveNmdWarmup({ kind: "history", series }, [...SCENARIOS, s("D1", { kind: "parallel", shockBp: 100 }, "dynamic")], R0_PCT, "2026-03-31");
    // January 2024 to March 2026 is 27 months: values 4.00 to 4.26.
    const expected = values.slice(0, 27);
    expect(w.record).toEqual({ kind: "history", label: "made-up test series", months: 27, firstMonth: "2024-01", lastMonth: "2026-03" });
    for (const id of ["S0", "P200", "SRP-STEEP", "D1"]) expect(w.byScenario.get(id)).toEqual(expected);
    expect(w.unshifted).toEqual(expected);
    expect(expected[26]).toBeCloseTo(4.26, 12);
  });

  it("refuses a series that ends before the as-of month or starts after it, in one sentence", () => {
    expect(() => resolveNmdWarmup({ kind: "history", series }, SCENARIOS, R0_PCT, "2026-07-31")).toThrow(/ends in 2026-06, before the run's as-of month 2026-07/);
    expect(() => resolveNmdWarmup({ kind: "history", series }, SCENARIOS, R0_PCT, "2023-12-31")).toThrow(/starts in 2024-01, after the run's as-of month 2023-12/);
  });

  it("checks the series' shape", () => {
    expect(nmdWarmupConfigError({ kind: "history", series: { ...series, firstMonth: "2024-13" } }, "nmdWarmup")).toMatch(/firstMonth must be a month "YYYY-MM"/);
    expect(nmdWarmupConfigError({ kind: "history", series: { ...series, valuesPct: [4, Number.NaN] } }, "nmdWarmup")).toMatch(/valuesPct\[1\] must be a finite number/);
    expect(nmdWarmupConfigError({ kind: "history", series: { ...series, label: " " } }, "nmdWarmup")).toMatch(/label must be a non-empty string/);
    expect(nmdWarmupConfigError({ kind: "history", series, months: 3 }, "nmdWarmup")).toMatch(/months is not a field of a "history" warmup/);
    expect(nmdWarmupConfigError({ kind: "history", series }, "nmdWarmup")).toBeUndefined();
    const copy = nmdWarmupOf({ kind: "history", series });
    expect(copy).toStrictEqual({ kind: "history", series: { label: "made-up test series", firstMonth: "2024-01", valuesPct: values } });
    expect((copy as { series: { valuesPct: number[] } }).series.valuesPct).not.toBe(values);
  });
});
