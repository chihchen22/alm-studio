/**
 * The LCR two ways. Every expectation is restated by hand; no rate
 * table or cap function is imported to compute one.
 *
 * The base fixture, horizon 2:
 *   CASH  asset l1,  balance[0] 100, principal [100, 0], interest [1, 0]  -> L1 100
 *   MBS   asset l2a, balance[0] 200                                        -> L2A 170
 *   LOANS asset untagged, principal [20, 20], interest [4, 4]              -> inflow 0.5 * 24 = 12
 *   DDA   liability nmd   retail-stable, balance[0] 1000, principal [50, 50], interest [1, 1]
 *   MMA   liability nmd-b retail-other,  balance[0] 500,  principal [50, 50], interest [2, 2]
 *   CD    liability cd    retail-stable, balance[0] 100,  principal [40, 60], interest [1, 1]
 *   BORR  liability fixed-loan wholesale-financial, balance[0] 300, principal [30, 0], interest [3, 0]
 * HQLA: the 40 percent cap binds, 270 - (170 - 200/3) = 500/3.
 * lcr-scenario:   Out = 51 + 52 + 41 + 33 = 177; In = min(12, 132.75) = 12; net 165; LCR = (500/3)/165.
 * lcr-regulatory: Out = 0.03*1000 + 0.10*500 + 0.03*40 + 1.00*30 = 111.2; In 12; net 99.2.
 */
import { describe, expect, it } from "vitest";
import { validateCustomMetricResult } from "../../contracts/customMetric";
import type { PortfolioSpec } from "../../contracts/position";
import type { ScenarioCashflows } from "../../contracts/results";
import type { CustomMetricInput } from "../../plugins/services";
import { computeLcrRegulatory, computeLcrScenario } from "../lcr";

interface FamDef {
  id: string;
  side: "asset" | "liability";
  instrumentType: string;
  /** One entry per position: its dimensions, or undefined for an untagged position. */
  tags: Array<Record<string, string> | undefined>;
}

function book(defs: FamDef[]): PortfolioSpec {
  return {
    id: "PF-LCR",
    label: "test",
    asOf: "2026-01-01",
    coa: {
      families: defs.map((d) => ({ id: d.id, label: d.id, side: d.side, instrumentType: d.instrumentType, coaNodeId: `N-${d.id}` })),
      nodes: [],
    },
    positions: defs.flatMap((d) =>
      d.tags.map((tag, i) => ({
        id: `${d.id}-${i}`,
        familyId: d.id,
        coaNodeId: `N-${d.id}`,
        terms: {},
        ...(tag === undefined ? {} : { dimensions: tag }),
      })),
    ),
  } as unknown as PortfolioSpec;
}

function fam(familyId: string, balance0: number, principal = [0, 0], interest = [0, 0]): ScenarioCashflows["byFamily"][number] {
  return { familyId, series: { balance: [balance0, 0], principal, interest } } as ScenarioCashflows["byFamily"][number];
}

const L1 = { "hqla-level": "l1" };
const L2A = { "hqla-level": "l2a" };
const cat = (c: string) => ({ "lcr-category": c });

const BASE_DEFS: FamDef[] = [
  { id: "CASH", side: "asset", instrumentType: "fixed-loan", tags: [L1, L1] },
  { id: "MBS", side: "asset", instrumentType: "mortgage", tags: [L2A] },
  { id: "LOANS", side: "asset", instrumentType: "fixed-loan", tags: [undefined] },
  { id: "DDA", side: "liability", instrumentType: "nmd", tags: [cat("retail-stable")] },
  { id: "MMA", side: "liability", instrumentType: "nmd-b", tags: [cat("retail-other")] },
  { id: "CD", side: "liability", instrumentType: "cd", tags: [cat("retail-stable")] },
  { id: "BORR", side: "liability", instrumentType: "fixed-loan", tags: [cat("wholesale-financial")] },
];

function baseFamilies(over: { loansPrincipal?: number[]; ddaPrincipal?: number[] } = {}): ScenarioCashflows["byFamily"] {
  return [
    fam("CASH", 100, [100, 0], [1, 0]),
    fam("MBS", 200, [5, 5], [1, 1]),
    fam("LOANS", 80, over.loansPrincipal ?? [20, 20], [4, 4]),
    fam("DDA", 1000, over.ddaPrincipal ?? [50, 50], [1, 1]),
    fam("MMA", 500, [50, 50], [2, 2]),
    fam("CD", 100, [40, 60], [1, 1]),
    fam("BORR", 300, [30, 0], [3, 0]),
  ];
}

function input(defs: FamDef[], scenarios: Array<{ id: string; byFamily: ScenarioCashflows["byFamily"] }>, horizon = 2): CustomMetricInput {
  return {
    horizonMonths: horizon,
    baseScenarioId: scenarios[0]!.id,
    scenarios: scenarios.map((s) => ({
      scenarioId: s.id,
      assumptionSetId: "AS",
      cashflows: { scenarioId: s.id, byFamily: s.byFamily, byCoaNode: [] },
    })),
    book: book(defs),
  };
}

const HQLA = 500 / 3;

describe("lcr-scenario", () => {
  it("reads month-1 liability flows as projected", () => {
    const r = computeLcrScenario(input(BASE_DEFS, [{ id: "S0", byFamily: baseFamilies() }]));
    expect(validateCustomMetricResult(r, { metricId: "lcr-scenario", scenarioIds: ["S0"] })).toEqual([]);
    expect(r.keys.map((k) => k.id)).toEqual(["hqla", "outflows-30d", "inflows-30d", "net-outflows", "lcr"]);
    const v = r.byScenario[0]!.values;
    expect(v.hqla).toBeCloseTo(HQLA, 12);
    expect(v["outflows-30d"]).toBeCloseTo(177, 12);
    expect(v["inflows-30d"]).toBeCloseTo(12, 12);
    expect(v["net-outflows"]).toBeCloseTo(165, 12);
    expect(v.lcr).toBeCloseTo(HQLA / 165, 12);
  });

  it("needs no lcr-category tag", () => {
    const untagged = BASE_DEFS.map((d) => (d.side === "liability" ? { ...d, tags: [undefined] } : d));
    const v = computeLcrScenario(input(untagged, [{ id: "S0", byFamily: baseFamilies() }])).byScenario[0]!.values;
    expect(v.lcr).toBeCloseTo(HQLA / 165, 12);
  });

  it("caps inflows at 75 percent of outflows", () => {
    // LOANS principal 400, interest 4 -> raw inflow 0.5 * 404 = 202 > 0.75 * 177 = 132.75
    const v = computeLcrScenario(input(BASE_DEFS, [{ id: "S0", byFamily: baseFamilies({ loansPrincipal: [400, 0] }) }]))
      .byScenario[0]!.values;
    expect(v["inflows-30d"]).toBeCloseTo(132.75, 12);
    expect(v["net-outflows"]).toBeCloseTo(44.25, 12);
    expect(v.lcr).toBeCloseTo(HQLA / 44.25, 12);
  });

  it("moves with the scenario's deposit flows", () => {
    const r = computeLcrScenario(
      input(BASE_DEFS, [
        { id: "S0", byFamily: baseFamilies() },
        { id: "S1", byFamily: baseFamilies({ ddaPrincipal: [100, 0] }) },
      ]),
    );
    expect(r.byScenario[1]!.values["outflows-30d"]).toBeCloseTo(227, 12);
  });

  it("leaves lcr out when there is no outflow", () => {
    const quiet = baseFamilies().map((f) =>
      ["DDA", "MMA", "CD", "BORR"].includes(f.familyId) ? fam(f.familyId, f.series.balance[0]!) : f,
    );
    const v = computeLcrScenario(input(BASE_DEFS, [{ id: "S0", byFamily: quiet }])).byScenario[0]!.values;
    expect(v["outflows-30d"]).toBe(0);
    expect(v["inflows-30d"]).toBe(0);
    expect(v["net-outflows"]).toBe(0);
    expect("lcr" in v).toBe(false);
  });
});

describe("lcr-regulatory", () => {
  it("applies US rates to NMD balances and to month-1 maturing principal", () => {
    const r = computeLcrRegulatory(input(BASE_DEFS, [{ id: "S0", byFamily: baseFamilies() }]));
    expect(validateCustomMetricResult(r, { metricId: "lcr-regulatory", scenarioIds: ["S0"] })).toEqual([]);
    const v = r.byScenario[0]!.values;
    expect(v.hqla).toBeCloseTo(HQLA, 12);
    expect(v["outflows-30d"]).toBeCloseTo(111.2, 12);
    expect(v["inflows-30d"]).toBeCloseTo(12, 12);
    expect(v["net-outflows"]).toBeCloseTo(99.2, 12);
    expect(v.lcr).toBeCloseTo(HQLA / 99.2, 12);
  });

  it("pins all six run-off rates on month-1 term principal", () => {
    // Six term liability families (fixed-loan), each principal[0] 100, balance[0] 500, interest[0] 2:
    //   Out = 100 * (0.03 + 0.10 + 0.25 + 0.25 + 0.40 + 1.00) = 3 + 10 + 25 + 25 + 40 + 100 = 203
    //   (principal only: neither the 500 balance nor the interest enters)
    //   In = min(12, 0.75 * 203 = 152.25) = 12; net = 191; LCR = (500/3) / 191
    const six = ["retail-stable", "retail-other", "operational", "secured-gse", "wholesale-nonfinancial", "wholesale-financial"];
    const defs: FamDef[] = [
      ...BASE_DEFS.filter((d) => d.side === "asset"),
      ...six.map((c, i) => ({ id: `T${i}`, side: "liability" as const, instrumentType: "fixed-loan", tags: [cat(c)] })),
    ];
    const byFamily = [
      ...baseFamilies().filter((f) => ["CASH", "MBS", "LOANS"].includes(f.familyId)),
      ...six.map((_, i) => fam(`T${i}`, 500, [100, 0], [2, 0])),
    ];
    const v = computeLcrRegulatory(input(defs, [{ id: "S0", byFamily }])).byScenario[0]!.values;
    expect(v["outflows-30d"]).toBeCloseTo(203, 12);
    expect(v["inflows-30d"]).toBeCloseTo(12, 12);
    expect(v["net-outflows"]).toBeCloseTo(191, 12);
    expect(v.lcr).toBeCloseTo(HQLA / 191, 12);
  });

  it("does not move with a scenario's NMD flows", () => {
    const r = computeLcrRegulatory(
      input(BASE_DEFS, [
        { id: "S0", byFamily: baseFamilies() },
        { id: "S1", byFamily: baseFamilies({ ddaPrincipal: [100, 0] }) },
      ]),
    );
    expect(r.byScenario[1]!.values["outflows-30d"]).toBeCloseTo(111.2, 12);
  });

  it("carries no keys when a liability family is untagged, unknown or mixed", () => {
    const swap = (id: string, tags: FamDef["tags"]) => BASE_DEFS.map((d) => (d.id === id ? { ...d, tags } : d));
    for (const defs of [
      swap("DDA", [undefined]),
      swap("DDA", [cat("retail-sticky")]),
      swap("DDA", [cat("constructor")]),
      swap("DDA", [cat("retail-stable"), cat("retail-other")]),
      swap("DDA", [cat("retail-stable"), undefined]),
    ]) {
      expect(computeLcrRegulatory(input(defs, [{ id: "S0", byFamily: baseFamilies() }])).byScenario[0]!.values).toEqual({});
    }
  });
});

describe("both metrics", () => {
  it("carry no keys without a buffer family", () => {
    const noBuffer = BASE_DEFS.map((d) => (d.side === "asset" ? { ...d, tags: d.tags.map(() => undefined) } : d));
    for (const fn of [computeLcrScenario, computeLcrRegulatory]) {
      expect(fn(input(noBuffer, [{ id: "S0", byFamily: baseFamilies() }])).byScenario[0]!.values).toEqual({});
    }
  });

  it("carry no keys when the buffer classifier refuses", () => {
    const mixed = BASE_DEFS.map((d) => (d.id === "CASH" ? { ...d, tags: [L1, undefined] } : d));
    for (const fn of [computeLcrScenario, computeLcrRegulatory]) {
      expect(fn(input(mixed, [{ id: "S0", byFamily: baseFamilies() }])).byScenario[0]!.values).toEqual({});
    }
  });

  it("report hqla alone at horizon 0", () => {
    for (const fn of [computeLcrScenario, computeLcrRegulatory]) {
      const v = fn(input(BASE_DEFS, [{ id: "S0", byFamily: baseFamilies() }], 0)).byScenario[0]!.values;
      expect(Object.keys(v)).toEqual(["hqla"]);
      expect(v.hqla).toBeCloseTo(HQLA, 12);
    }
  });
});
