/**
 * The survival horizon, a liquidity metric through the custom slot.
 *
 * Every expectation is RESTATED by hand from the spec's arithmetic, never
 * computed with the module's own factor table: a check that borrowed
 * SURVIVAL_STRESS_DEMO would agree with whatever the table says.
 *
 * Since piece 5c the metric applies NO deposit stress of its own: the engine
 * projects it (a stressed assumption set) and the metric reads the series as
 * given. The fixture therefore supplies the stressed series directly, and
 * every number below is the one piece 5b pinned.
 *
 * The base fixture, horizon 4:
 *   CASH  asset, tagged l1,  balance[0] 100  -> buffer 100
 *   MBS   asset, tagged l2a, balance[0] 200  -> buffer 200 * 0.85 = 170
 *   LOANS asset, untagged, principal 20 and interest 4 a month -> inflow 0.5 * 24 = 12
 *   DDA   liability nmd,   engine principal 50, 47.5, 45.125, 42.86875 (5% a month of 1000), interest 1 a month
 *   MMA   liability nmd-b, engine principal 50, 45, 40.5, 36.45 (10% a month of 500), interest 2 a month
 *   CD    liability cd, contractual principal [0, 100, 0, 0], interest [1, 1, 0, 0]
 * Buffer B0 = 270.
 * Net outflow O = 92, 184.5, 76.625, 70.31875; cumulative C = 92, 276.5, 353.125, 423.44375.
 * C1 <= 270 and C2 > 270, so one whole month survives.
 */
import { describe, expect, it } from "vitest";
import { validateCustomMetricResult } from "../../contracts/customMetric";
import type { PortfolioSpec } from "../../contracts/position";
import type { ScenarioCashflows } from "../../contracts/results";
import type { CustomMetricInput } from "../../plugins/services";
import { computeSurvivalHorizon } from "../survivalHorizon";

const H = 4;

interface FamSeries {
  balance0: number;
  principal?: number[];
  interest?: number[];
}

function fam(familyId: string, s: FamSeries): ScenarioCashflows["byFamily"][number] {
  const principal = s.principal ?? [0, 0, 0, 0];
  return {
    familyId,
    series: {
      balance: [s.balance0, 0, 0, 0],
      principal,
      interest: s.interest ?? [0, 0, 0, 0],
    },
  };
}

interface FamDef {
  id: string;
  side: "asset" | "liability";
  instrumentType: string;
  /** One entry per position: the hqla-level value, or undefined for an untagged position. */
  tags: Array<string | string[] | undefined>;
}

function book(defs: FamDef[]): PortfolioSpec {
  const positions = defs.flatMap((d) =>
    d.tags.map((tag, i) => ({
      id: `${d.id}-${i}`,
      familyId: d.id,
      coaNodeId: `N-${d.id}`,
      terms: {},
      ...(tag === undefined ? {} : { dimensions: { "hqla-level": tag } }),
    })),
  );
  return {
    id: "PF-SURV",
    label: "test",
    asOf: "2026-01-01",
    coa: {
      families: defs.map((d) => ({
        id: d.id,
        label: d.id,
        side: d.side,
        instrumentType: d.instrumentType,
        coaNodeId: `N-${d.id}`,
      })),
      nodes: [],
    },
    positions,
  } as unknown as PortfolioSpec;
}

const BASE_DEFS: FamDef[] = [
  { id: "CASH", side: "asset", instrumentType: "fixed-loan", tags: ["l1", "l1"] },
  { id: "MBS", side: "asset", instrumentType: "mortgage", tags: ["l2a"] },
  { id: "LOANS", side: "asset", instrumentType: "fixed-loan", tags: [undefined, undefined] },
  { id: "DDA", side: "liability", instrumentType: "nmd", tags: [undefined] },
  { id: "MMA", side: "liability", instrumentType: "nmd-b", tags: [undefined] },
  { id: "CD", side: "liability", instrumentType: "cd", tags: [undefined] },
];

function baseFamilies(cdPrincipal = [0, 100, 0, 0]): ScenarioCashflows["byFamily"] {
  return [
    fam("CASH", { balance0: 100, principal: [100, 0, 0, 0], interest: [1, 0, 0, 0] }),
    fam("MBS", { balance0: 200, principal: [5, 5, 5, 5], interest: [1, 1, 1, 1] }),
    fam("LOANS", { balance0: 80, principal: [20, 20, 20, 20], interest: [4, 4, 4, 4] }),
    // The engine's stressed projection, supplied as given: since piece 5c the
    // metric reads deposit principal from the series and stresses nothing.
    fam("DDA", { balance0: 1000, principal: [50, 47.5, 45.125, 42.86875], interest: [1, 1, 1, 1] }),
    fam("MMA", { balance0: 500, principal: [50, 45, 40.5, 36.45], interest: [2, 2, 2, 2] }),
    fam("CD", { balance0: 100, principal: cdPrincipal, interest: [1, 1, 0, 0] }),
  ];
}

function input(
  defs: FamDef[],
  scenarios: Array<{ id: string; byFamily: ScenarioCashflows["byFamily"] }>,
): CustomMetricInput {
  return {
    horizonMonths: H,
    baseScenarioId: scenarios[0]!.id,
    scenarios: scenarios.map((s) => ({
      scenarioId: s.id,
      assumptionSetId: "AS",
      cashflows: { scenarioId: s.id, byFamily: s.byFamily, byCoaNode: [] },
    })),
    book: book(defs),
  };
}

/** One scenario's values; every case, empty rows included, must pass the contract validator. */
function only(defs: FamDef[], byFamily: ScenarioCashflows["byFamily"]) {
  const result = computeSurvivalHorizon(input(defs, [{ id: "S0", byFamily }]));
  expect(validateCustomMetricResult(result, { metricId: "survival-horizon", scenarioIds: ["S0"] })).toEqual([]);
  return result.byScenario[0]!.values;
}

describe("computeSurvivalHorizon", () => {
  it("reports buffer, survival months, min headroom and month-1 coverage on a breach", () => {
    const v = only(BASE_DEFS, baseFamilies());
    const B0 = 100 + 200 * 0.85;
    const O1 = 50 + 1 + 50 + 2 + 0 + 1 - 0.5 * (20 + 4);
    const C4 = 92 + 184.5 + 76.625 + 70.31875;
    expect(v["buffer"]).toBeCloseTo(270, 12);
    expect(v["buffer"]).toBeCloseTo(B0, 12);
    expect(v["survival-months"]).toBe(1);
    expect(v["min-headroom"]).toBeCloseTo(270 - 423.44375, 9);
    expect(v["min-headroom"]).toBeCloseTo(B0 - C4, 9);
    expect(v["month1-coverage"]).toBeCloseTo(270 / 92, 12);
    expect(v["month1-coverage"]).toBeCloseTo(B0 / O1, 12);
  });

  it("reports survival-months 0 when the first month already breaches", () => {
    const small: FamDef[] = BASE_DEFS.map((d) => (d.id === "MBS" ? { ...d, tags: [undefined] } : d));
    // Buffer is CASH alone, 100; MBS is now an ordinary asset: inflow 0.5 * (5 + 1) = 3.
    // O1 = 50 + 1 + 50 + 2 + 1 - 12 - 3 = 89 <= 100; O2 = 47.5 + 1 + 45 + 2 + 101 - 12 - 3 = 181.5.
    const v = only(small, baseFamilies());
    expect(v["buffer"]).toBeCloseTo(100, 12);
    expect(v["survival-months"]).toBe(1);
    const fams = baseFamilies().map((f) =>
      f.familyId === "CASH" ? fam("CASH", { balance0: 10 }) : f,
    );
    const w = only(small, fams);
    expect(w["buffer"]).toBeCloseTo(10, 12);
    expect(w["survival-months"]).toBe(0);
  });

  it("leaves survival-months out when the buffer lasts the horizon, and keeps min-headroom", () => {
    const fams = baseFamilies().map((f) =>
      f.familyId === "CASH" ? fam("CASH", { balance0: 10_000 }) : f,
    );
    const v = only(BASE_DEFS, fams);
    expect(v["buffer"]).toBeCloseTo(10_170, 12);
    expect("survival-months" in v).toBe(false);
    expect(v["min-headroom"]).toBeCloseTo(10_170 - 423.44375, 9);
    expect(v["min-headroom"]!).toBeGreaterThan(0);
  });

  it("applies the l2b haircut of one half", () => {
    const defs: FamDef[] = [
      { id: "CORP", side: "asset", instrumentType: "fixed-loan", tags: ["l2b"] },
      { id: "DDA", side: "liability", instrumentType: "nmd", tags: [undefined] },
    ];
    const v = only(defs, [fam("CORP", { balance0: 100 }), fam("DDA", { balance0: 1000 })]);
    expect(v["buffer"]).toBeCloseTo(50, 12);
  });

  it("carries no keys when no family is tagged", () => {
    const untagged = BASE_DEFS.map((d) => ({ ...d, tags: d.tags.map(() => undefined) }));
    expect(only(untagged, baseFamilies())).toEqual({});
  });

  it("carries no keys when a family mixes tagged and untagged positions", () => {
    const mixed = BASE_DEFS.map((d) => (d.id === "CASH" ? { ...d, tags: ["l1", undefined] } : d));
    expect(only(mixed, baseFamilies())).toEqual({});
  });

  it("carries no keys when a family carries two different levels", () => {
    const split = BASE_DEFS.map((d) => (d.id === "CASH" ? { ...d, tags: ["l1", "l2a"] } : d));
    expect(only(split, baseFamilies())).toEqual({});
  });

  it("carries no keys when a liability family is tagged", () => {
    const tagged = BASE_DEFS.map((d) => (d.id === "DDA" ? { ...d, tags: ["l1"] } : d));
    expect(only(tagged, baseFamilies())).toEqual({});
  });

  it("carries no keys when a tag is not a known level or is a list", () => {
    const unknown = BASE_DEFS.map((d) => (d.id === "MBS" ? { ...d, tags: ["l3"] } : d));
    expect(only(unknown, baseFamilies())).toEqual({});
    const list = BASE_DEFS.map((d) => (d.id === "MBS" ? { ...d, tags: [["l1"]] } : d));
    expect(only(list, baseFamilies())).toEqual({});
    // A prototype key is not a known level.
    const proto = BASE_DEFS.map((d) => (d.id === "MBS" ? { ...d, tags: ["constructor"] } : d));
    expect(only(proto, baseFamilies())).toEqual({});
  });

  it("leaves month1-coverage out when month 1 has no net outflow", () => {
    // LOANS pays 1000 of principal in month 1: inflow 0.5 * (1000 + 4) = 502 > 104 of outflow.
    const fams = baseFamilies().map((f) =>
      f.familyId === "LOANS"
        ? fam("LOANS", { balance0: 1000, principal: [1000, 0, 0, 0], interest: [4, 4, 4, 4] })
        : f,
    );
    const v = only(BASE_DEFS, fams);
    expect(v["buffer"]).toBeCloseTo(270, 12);
    expect("month1-coverage" in v).toBe(false);
  });

  it("writes one row per scenario in request order, and each passes the contract validator", () => {
    const result = computeSurvivalHorizon(
      input(BASE_DEFS, [
        { id: "S0", byFamily: baseFamilies() },
        // S100: the CD matures a month later. C = 92, 176.5, 353.125, 423.44375: C2 <= 270, C3 > 270.
        { id: "S100", byFamily: baseFamilies([0, 0, 100, 0]) },
      ]),
    );
    expect(result.metricId).toBe("survival-horizon");
    expect(result.byScenario.map((r) => r.scenarioId)).toEqual(["S0", "S100"]);
    expect(result.byScenario[0]!.values["survival-months"]).toBe(1);
    expect(result.byScenario[1]!.values["survival-months"]).toBe(2);
    expect(result.byScenario.every((r) => r.byFamily === undefined)).toBe(true);
    expect(validateCustomMetricResult(result, { metricId: "survival-horizon", scenarioIds: ["S0", "S100"] })).toEqual([]);
  });

  it("takes deposit principal from the engine series as projected, with no stress of its own", () => {
    // DDA runs off 1 a month as projected. A metric that still applied a 5%
    // stress would pay 50 in month 1 and breach a buffer of 10 at once.
    const defs: FamDef[] = [
      { id: "CASH", side: "asset", instrumentType: "fixed-loan", tags: ["l1"] },
      { id: "DDA", side: "liability", instrumentType: "nmd", tags: [undefined] },
    ];
    const v = only(defs, [
      fam("CASH", { balance0: 10 }),
      fam("DDA", { balance0: 1000, principal: [1, 1, 1, 1] }),
    ]);
    // O = 1, 1, 1, 1; C = 1, 2, 3, 4; never above 10.
    expect(v["buffer"]).toBeCloseTo(10, 12);
    expect("survival-months" in v).toBe(false);
    expect(v["min-headroom"]).toBeCloseTo(6, 12);
    expect(v["month1-coverage"]).toBeCloseTo(10, 12);
  });
});
