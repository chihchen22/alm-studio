/**
 * computeEve integration.
 *
 *  - Base EVE reconciles to the base PV computed straight from the kernel
 *    cash flows (EVE ties to the projected balance sheet, not a second one).
 *  - Δ-versus-base is 0 at base and moves under a shock.
 *  - The sanity gate fires end to end: tightened bounds drop every duration and
 *    flip durationSanityPassed false, leaving the numbers undefined not patched.
 *  - discountBasis is carried onto the result.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TLP_CURVE,
  loadMarketSnapshot,
  pvCashflows,
  type ZeroCurve,
} from "@alm/kernel";
import type { BucketedCashflowResult } from "../../contracts/results";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import {
  buildScenarioRatePath,
  projectStaticRunoffAll,
  type StaticScenarioLeg,
} from "../../projection/static/staticRunoff";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { computeEve } from "../computeEve";
import {
  fixedPosition,
  makeCoa,
  makePortfolio,
  mortgagePosition,
  nmdBetaPosition,
  nmdPosition,
  regulatoryScenarios,
  AS_OF,
} from "./fixtures";

const MARKET = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);
const HORIZON = 360;
const GRID = { horizonMonths: HORIZON, asOf: AS_OF };

let base: ZeroCurve;
beforeAll(async () => {
  base = buildBaseCurve(await loadMarketSnapshot(MARKET));
});

function twoSidedBook() {
  return makePortfolio([
    fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 }),
    mortgagePosition("M1", { notional: 4_000_000, originalBalance: 4_000_000 }),
    nmdPosition("D1", { notional: 3_000_000 }),
    nmdBetaPosition("B1", { notional: 2_000_000 }),
  ]);
}

/** Project the regulatory grid through m05 to get the EVE engine's cash-flow input. */
function projectGrid(portfolio = twoSidedBook()): {
  portfolio: ReturnType<typeof twoSidedBook>;
  cashflows: BucketedCashflowResult;
  scenarios: ReturnType<typeof regulatoryScenarios>;
} {
  const scenarios = regulatoryScenarios();
  const legs: StaticScenarioLeg[] = scenarios.map((scenario) => ({
    scenario,
    ratePath: buildScenarioRatePath(base, scenario, HORIZON),
  }));
  const cashflows = projectStaticRunoffAll(portfolio, legs, GRID);
  return { portfolio, cashflows, scenarios };
}

describe("computeEve — base EVE reconciles to base PV", () => {
  it("base EVE equals net PV of the kernel cash flows on the base all-in curve", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const result = computeEve({ portfolio, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE });

    const baseScn = scenarios.find((s) => s.rateSpec.kind === "base")!;
    const basePath = buildScenarioRatePath(base, baseScn, HORIZON);
    const df0 = (t: number) =>
      t <= 0 ? 1 : base.discountFactor(t) * Math.exp(-DEFAULT_TLP_CURVE.tlp(t) * t);
    const sideById = new Map(makeCoa().families.map((f) => [f.id, f.side]));

    let refEve = 0;
    let refAssets = 0;
    let refLiab = 0;
    for (const pos of portfolio.positions) {
      const cf = makeInstrument(pos.terms).generateCashflows(basePath);
      const pv = pvCashflows(cf, df0);
      if (sideById.get(pos.familyId) === "liability") {
        refLiab += pv;
        refEve -= pv;
      } else {
        refAssets += pv;
        refEve += pv;
      }
    }

    const baseRow = result.byScenario.find((r) => r.scenarioId === baseScn.id)!;
    expect(baseRow.eve).toBeCloseTo(refEve, 2);
    expect(baseRow.pvAssets).toBeCloseTo(refAssets, 2);
    expect(baseRow.pvLiabilities).toBeCloseTo(refLiab, 2);
    expect(baseRow.eve).toBeCloseTo(baseRow.pvAssets - baseRow.pvLiabilities, 6);
    expect(baseRow.pvAssets).toBeGreaterThan(baseRow.pvLiabilities); // positive equity
  });

  it("base row has zero delta; a shock moves EVE", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const result = computeEve({ portfolio, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE });

    const baseRow = result.byScenario.find((r) => r.scenarioId === "S0")!;
    expect(baseRow.deltaEveVsBase).toBe(0);
    expect(baseRow.deltaEvePct).toBe(0);

    const up = result.byScenario.find((r) => r.scenarioId === "S200")!;
    const down = result.byScenario.find((r) => r.scenarioId === "S-200")!;
    expect(up.deltaEveVsBase).toBeCloseTo(up.eve - baseRow.eve, 6);
    // Under the public basis EVE falls under S200 and rises under S-200
    // (public-basis re-base, deltas file).
    expect(up.deltaEveVsBase).toBeLessThan(0);
    // Public-basis re-base: measured +62,655.02 on the public Treasury CMT pack
    // with Lab fix A; the sign returned to positive (was -11,797.30; deltas file).
    expect(down.deltaEveVsBase).toBeGreaterThan(0);
    expect(up.deltaEvePct).toBeCloseTo(up.deltaEveVsBase / baseRow.eve, 10);
  });
});

describe("computeEve — result shape and duration reporting", () => {
  it("reports every family PV and a defined, sane equity duration at base", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const result = computeEve({ portfolio, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE });

    expect(result.discountBasis).toBe("all-in");
    const baseRow = result.byScenario.find((r) => r.scenarioId === "S0")!;
    expect([...baseRow.byFamily.map((f) => f.familyId)].sort()).toEqual(["DDA", "FIXED", "MMA", "MORTGAGE"]);
    // every family carries a PV
    for (const f of baseRow.byFamily) expect(Number.isFinite(f.pv)).toBe(true);

    expect(baseRow.durationSanityPassed).toBe(true);
    expect(baseRow.effectiveDurationEquity).toBeDefined();
    expect(Number.isFinite(baseRow.effectiveDurationEquity!)).toBe(true);
    // asset families carry a positive effective duration
    const fixed = baseRow.byFamily.find((f) => f.familyId === "FIXED")!;
    expect(fixed.effectiveDuration).toBeGreaterThan(0);
  });

  it("the sanity gate fires end to end under tightened bounds", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const result = computeEve({
      portfolio,
      cashflows,
      scenarios,
      baseCurve: base,
      tlp: DEFAULT_TLP_CURVE,
      bounds: { maxAbsYears: 0.001, signTolYears: 1e-3 },
    });
    const baseRow = result.byScenario.find((r) => r.scenarioId === "S0")!;
    expect(baseRow.durationSanityPassed).toBe(false);
    expect(baseRow.effectiveDurationEquity).toBeUndefined();
    for (const f of baseRow.byFamily) expect(f.effectiveDuration).toBeUndefined();
    // PVs are untouched by the duration gate.
    for (const f of baseRow.byFamily) expect(Number.isFinite(f.pv)).toBe(true);
  });

  it("carries the risk-free discount basis onto the result", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const result = computeEve({
      portfolio,
      cashflows,
      scenarios,
      baseCurve: base,
      tlp: DEFAULT_TLP_CURVE,
      discountBasis: "risk-free",
    });
    expect(result.discountBasis).toBe("risk-free");
  });
});

describe("computeEve — gate policy 1a (base-environment sign gate)", () => {
  it("keeps a genuinely negative behavioral duration at a shocked environment and still passes sanity", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const result = computeEve({ portfolio, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE });

    // At -100 the mortgage down-bump reaches the refi wave, so its effective
    // duration goes negative — genuine negative convexity, not a fault. The new
    // policy gates shocked environments on finiteness and magnitude only, so the
    // number is kept and durationSanityPassed stays true.
    const down = result.byScenario.find((r) => r.scenarioId === "S-100")!;
    const mtg = down.byFamily.find((f) => f.familyId === "MORTGAGE")!;
    expect(mtg.effectiveDuration).toBeDefined();
    expect(mtg.effectiveDuration!).toBeLessThan(0);
    expect(down.durationSanityPassed).toBe(true);
  });

  it("keeps the positive-sign gate at the base environment", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const result = computeEve({ portfolio, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE });
    // The base scenario's families are all genuinely positive here; the base sign
    // gate passes them and the row is clean.
    const baseRow = result.byScenario.find((r) => r.scenarioId === "S0")!;
    expect(baseRow.durationSanityPassed).toBe(true);
    for (const f of baseRow.byFamily) {
      expect(f.effectiveDuration).toBeDefined();
      expect(f.effectiveDuration!).toBeGreaterThan(0); // all genuinely positive at base
    }
  });
});

describe("computeEve — durationMode", () => {
  it("base-only: base scenario carries the full duration block, shocked scenarios carry none", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const result = computeEve({
      portfolio,
      cashflows,
      scenarios,
      baseCurve: base,
      tlp: DEFAULT_TLP_CURVE,
      durationMode: "base-only",
    });

    const baseRow = result.byScenario.find((r) => r.scenarioId === "S0")!;
    expect(baseRow.effectiveDurationEquity).toBeDefined();
    expect(baseRow.durationSanityPassed).toBe(true);
    for (const f of baseRow.byFamily) expect(f.effectiveDuration).toBeDefined();

    for (const scnId of ["S100", "S-100", "S200", "S-200"]) {
      const row = result.byScenario.find((r) => r.scenarioId === scnId)!;
      expect(row.effectiveDurationEquity).toBeUndefined();
      for (const f of row.byFamily) expect(f.effectiveDuration).toBeUndefined();
      // Vacuous AND over the evaluated gates: not computed here, so true.
      expect(row.durationSanityPassed).toBe(true);
      // The PVs and EVE are still fully populated — the headline is unaffected.
      for (const f of row.byFamily) expect(Number.isFinite(f.pv)).toBe(true);
      expect(Number.isFinite(row.eve)).toBe(true);
    }
  });

  it("the EVE / Δ-EVE headline is identical in both modes (durations do not feed it)", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const perScenario = computeEve({ portfolio, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE, durationMode: "per-scenario" });
    const baseOnly = computeEve({ portfolio, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE, durationMode: "base-only" });
    for (const a of perScenario.byScenario) {
      const b = baseOnly.byScenario.find((x) => x.scenarioId === a.scenarioId)!;
      expect(b.eve).toBe(a.eve);
      expect(b.pvAssets).toBe(a.pvAssets);
      expect(b.pvLiabilities).toBe(a.pvLiabilities);
      expect(b.deltaEveVsBase).toBe(a.deltaEveVsBase);
      expect(b.byFamily.map((f) => f.pv)).toEqual(a.byFamily.map((f) => f.pv));
    }
  });

  it("the base scenario's duration block is identical in both modes", () => {
    const { portfolio, cashflows, scenarios } = projectGrid();
    const perScenario = computeEve({ portfolio, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE, durationMode: "per-scenario" });
    const baseOnly = computeEve({ portfolio, cashflows, scenarios, baseCurve: base, tlp: DEFAULT_TLP_CURVE, durationMode: "base-only" });
    const a = perScenario.byScenario.find((r) => r.scenarioId === "S0")!;
    const b = baseOnly.byScenario.find((r) => r.scenarioId === "S0")!;
    expect(b.effectiveDurationEquity).toBe(a.effectiveDurationEquity);
    expect(b.byFamily.map((f) => f.effectiveDuration)).toEqual(a.byFamily.map((f) => f.effectiveDuration));
  });
});

describe("computeEve — determinism", () => {
  it("is byte-identical across two runs on the same inputs", () => {
    const a = projectGrid();
    const resA = computeEve({ ...a, baseCurve: base, tlp: DEFAULT_TLP_CURVE });
    const b = projectGrid();
    const resB = computeEve({ ...b, baseCurve: base, tlp: DEFAULT_TLP_CURVE });
    expect(JSON.stringify(resA)).toEqual(JSON.stringify(resB));
  });
});
