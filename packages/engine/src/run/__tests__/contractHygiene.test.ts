/**
 * Contract hygiene (additive evolution):
 *
 *  - schemaVersion reads 1.13.0 (bumped by teaching build slice B2: the optional GapResult.fixedRate; before it slice 4a, the
 *    optional GapLadder.withInterest; before that slice three,
 *    the optional GapLadder.userBuckets and NIIResult.windowMonths) and the exported constant agrees;
 *  - deltaEvePct is PINNED as a decimal fraction of base EVE (not a percent):
 *    exactly deltaEveVsBase / baseEve, 0 at base;
 *  - the EVE block echoes the durationMode the run was executed under,
 * so base-only is readable directly, not inferred from
 *    undefined duration fields;
 *  - a dynamic scenario's reinvestment under-hit lands in the TYPED
 *    ScenarioNII.shortfalls slot with family and magnitude, and the pre-1.1.0
 *    free-text `run.shortfall.*` NotImplemented tag is gone;
 *  - a no-NaN/no-Infinity walker over the full serialized result is green,
 *    including the new shortfall slot;
 *  - the static regulatory grid's ScenarioNII rows carry no `shortfalls` key,
 *    so the exercised static envelope shape is unchanged by the new field.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { clearPortfolios } from "../../portfolio/registry";
import type { RunResult } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import { createEngine, resolveDefaultContext, type EngineTools } from "../index";
import { INSTRUMENTS_SCHEMA_VERSION } from "../../contracts/instruments";
import { RUN_RESULT_SCHEMA_VERSION } from "../orchestrate";
import { baseAssumptions, loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function freshEngine(context?: Parameters<typeof createEngine>[0]): EngineTools {
  clearPortfolios();
  const engine = createEngine(context);
  engine.loadPortfolio(twoSidedBook());
  return engine;
}

/** Collect every non-finite number in a serialized result, with its path. */
function collectNonFinite(x: unknown, path: string, bad: string[]): void {
  if (typeof x === "number") {
    if (!Number.isFinite(x)) bad.push(`${path} = ${x}`);
  } else if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) collectNonFinite(x[i], `${path}[${i}]`, bad);
  } else if (x !== null && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) collectNonFinite(v, `${path}.${k}`, bad);
  }
}

/**
 * A run whose one shocked scenario reinvests dynamically against a DECLINING
 * growth target on the FIXED family (a 60-month bullet). The bullet's balance
 * cannot follow a -5%/month target down without disposals, so the sweep clamps
 * origination and reports a shortfall — the path the limitations page said had
 * no typed home before 1.1.0.
 */
function shortfallRun(engine: EngineTools): RunResult {
  const dynScenario: Scenario = {
    id: "SDYN",
    label: "dynamic, declining target",
    rateSpec: { kind: "parallel", shockBp: 100 },
    assumptionSetId: "AS-BASE",
    newBusiness: {
      mode: "dynamic",
      rules: [{ familyId: "FIXED", reinvest: "growth", monthlyGrowthRate: -0.05 }],
    },
  };
  const baseScenario: Scenario = {
    id: "S0",
    label: "S0",
    rateSpec: { kind: "base" },
    assumptionSetId: "AS-BASE",
    newBusiness: { mode: "static", rules: [] },
  };
  return engine.run(
    makeRunRequest(market, {
      scenarios: [baseScenario, dynScenario],
      assumptionSets: [baseAssumptions()],
    }),
  );
}

describe("schemaVersion 1.13.0 (additive bump)", () => {
  // RE-EXPECTATION: 1.1.0 -> 1.2.0. The 1.2.0 field set (ftp block,
  // NII byHorizon/netMonthly/walYears, opt-in EVE keyRate/channels) landed
  // across waves 2-3; the constant is bumped by the LAST results.ts owner
  // per the plan collision ledger and ADR-015. Purely additive:
  // nothing renamed or removed, every 1.1.0 assertion below still holds.
  // RE-EXPECTATION: 1.2.0 -> 1.3.0, optional planId/planHash
  // on the provenance record and an optional plan ref on the request. Additive
  // again: a run built without a plan serializes exactly as it did at 1.2.0.
  // RE-EXPECTATION: 1.3.0 -> 1.4.0, optional runLog and
  // profileHash on the provenance record.
  // RE-EXPECTATION: 1.5.0 -> 1.6.0, the run log's license
  // arm and the stage arm's bindings. Prior: 1.4.0 -> 1.5.0, the plan and
  // stage arms and PlanRef.licensedBindings. Additive again: every number in
  // the envelope is unchanged, which the platform/v2 golden still pins.
  // RE-EXPECTATION: 1.6.0 -> 1.7.0, the cell and view arms.
  // Additive again: a run with no view declared serializes exactly as it did at 1.6.0.
  // RE-EXPECTATION: 1.7.0 -> 1.8.0, the optional custom arm.
  // Additive again: a run that names no custom metric stage writes no arm, so
  // its envelope serializes exactly as it did at 1.7.0.
  // RE-EXPECTATION: 1.8.0 -> 1.9.0, the optional seg, liquidityStress,
  // instrumentsFile, nmdConvention and parentOf blocks on the run result, NIIResult.nimPct, and three optional
  // Position fields. Additive again: a run that opts in to none of them serializes exactly as it did at 1.8.0
  // apart from this string.
  // RE-EXPECTATION: 1.9.0 -> 1.10.0, the optional provenance.curveDefault stamp.
  // Additive again: the stamp is a new provenance key; no field is renamed or removed.
  // RE-EXPECTATION: 1.10.0 -> 1.11.0, the optional GapLadder.userBuckets and
  // NIIResult.windowMonths (spec decision 103). Additive again: a run that asks for neither writes neither.
  // RE-EXPECTATION: 1.11.0 -> 1.12.0, the optional GapLadder.withInterest on the
  // liquidity ladder. Additive again: a run that does not ask for principal-plus-interest writes nothing new.
  // RE-EXPECTATION: 1.12.0 -> 1.13.0, the optional GapResult.fixedRate ladder.
  // Additive again: a run that does not ask for fixedRateGap writes nothing new.
  it("stamps 1.13.0 on the envelope and the exported constant agrees", () => {
    const result = freshEngine().run(makeRunRequest(market));
    expect(RUN_RESULT_SCHEMA_VERSION).toBe("1.13.0");
    expect(result.schemaVersion).toBe("1.13.0");
  });

  it("a default run carries none of the 1.9.0 optional blocks (left out, never null, [] or {})", () => {
    const result = freshEngine().run(makeRunRequest(market));
    for (const key of ["seg", "liquidityStress", "instrumentsFile", "nmdConvention", "parentOf"]) {
      expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(false);
    }
    for (const s of result.nii.byScenario) expect(Object.prototype.hasOwnProperty.call(s, "nimPct")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.nii, "nimPct")).toBe(false);
  });

  it("a default run carries none of the 1.11.0 optional fields (userBuckets on either ladder, nii.windowMonths)", () => {
    const result = freshEngine().run(makeRunRequest(market));
    const ladders = [...result.gap.repricing, ...result.gap.liquidity];
    expect(ladders.length).toBeGreaterThan(0);
    for (const ladder of ladders) expect(Object.prototype.hasOwnProperty.call(ladder, "userBuckets")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.nii, "windowMonths")).toBe(false);
  });

  it("a default run carries none of the 1.12.0 optional fields (withInterest on either ladder)", () => {
    const result = freshEngine().run(makeRunRequest(market));
    const ladders = [...result.gap.repricing, ...result.gap.liquidity];
    expect(result.gap.liquidity.length).toBeGreaterThan(0);
    for (const ladder of ladders) expect(Object.prototype.hasOwnProperty.call(ladder, "withInterest")).toBe(false);
  });

  it("a default run carries none of the 1.13.0 optional fields (gap.fixedRate)", () => {
    const result = freshEngine().run(makeRunRequest(market));
    expect(Object.prototype.hasOwnProperty.call(result.gap, "fixedRate")).toBe(false);
  });

  it("the instruments file contract exports its schema version", () => {
    // Spec P1 (slice K1 carried the type over): files are written at 1.1.0.
    expect(INSTRUMENTS_SCHEMA_VERSION).toBe("1.1.0");
  });
});

describe("deltaEvePct — pinned as a decimal fraction, not a percent", () => {
  it("equals deltaEveVsBase / baseEve exactly, and is 0 at base", () => {
    const result = freshEngine().run(makeRunRequest(market));
    const base = result.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(base.deltaEvePct).toBe(0);
    const shocked = result.eve.byScenario.filter((s) => s.scenarioId !== "S0");
    expect(shocked.length).toBeGreaterThan(0);
    for (const s of shocked) {
      // The pinned definition, to the bit: a fraction of base EVE.
      expect(s.deltaEvePct).toBe(s.deltaEveVsBase / base.eve);
      // Percent-scale sanity: a grid shock moves EVE by well under 100% of base
      // on this book, so a fraction stays under 1 in magnitude where the
      // percent reading would exceed 1. Guards against a silent x100 rescale.
      expect(Math.abs(s.deltaEvePct)).toBeLessThan(1);
    }
  });
});

describe("durationMode — echoed into the EVE block", () => {
  it("echoes base-only for the default context", () => {
    // resolveDefaultContext pins base-only (sign-off 2026-07-18).
    const result = freshEngine().run(makeRunRequest(market));
    expect(result.eve.durationMode).toBe("base-only");
    // And the echo agrees with the shape it explains: shocked scenarios carry
    // no duration block in base-only mode.
    for (const s of result.eve.byScenario.filter((x) => x.scenarioId !== "S0")) {
      expect(s.effectiveDurationEquity).toBeUndefined();
      expect(s.durationSanityPassed).toBe(true);
    }
  });

  it("echoes per-scenario when the engine is built that way", () => {
    const engine = freshEngine({ ...resolveDefaultContext(), durationMode: "per-scenario" });
    const result = engine.run(makeRunRequest(market));
    expect(result.eve.durationMode).toBe("per-scenario");
  });
});

describe("reinvestment shortfalls — typed slot, free-text tag gone", () => {
  it("carries the under-hit typed with family and magnitude on the scenario's NII row", () => {
    const result = shortfallRun(freshEngine());
    const dynNii = result.nii.byScenario.find((s) => s.scenarioId === "SDYN")!;
    expect(dynNii.shortfalls).toBeDefined();
    expect(dynNii.shortfalls).toHaveLength(1);
    const sf = dynNii.shortfalls![0];
    expect(sf.familyId).toBe("FIXED");
    expect(sf.reinvest).toBe("growth");
    expect(sf.firstBucket).toBeGreaterThanOrEqual(1);
    expect(sf.clampedBuckets).toBeGreaterThan(0);
    // The magnitude is present and real: a bullet held above a declining target.
    expect(Number.isFinite(sf.balanceGapEnd)).toBe(true);
    expect(sf.achievedBalanceEnd - sf.targetBalanceEnd).toBe(sf.balanceGapEnd);
    expect(Number.isFinite(sf.targetBalanceEnd)).toBe(true);
    expect(Number.isFinite(sf.achievedBalanceEnd)).toBe(true);
  });

  it("no longer emits the free-text run.shortfall NotImplemented tag", () => {
    const result = shortfallRun(freshEngine());
    const shortfallTags = result.notImplemented.filter((t) =>
      t.layer.startsWith("run.shortfall"),
    );
    expect(shortfallTags).toEqual([]);
  });

  it("scenarios without a dynamic under-hit carry no shortfalls key at all", () => {
    const result = shortfallRun(freshEngine());
    const baseNii = result.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    expect("shortfalls" in baseNii).toBe(false);
  });

  it("no-NaN walker is green over the full result including the new slot", () => {
    const result = shortfallRun(freshEngine());
    // Walk the SERIALIZED form, so what is checked is what a consumer reads.
    const bad: string[] = [];
    collectNonFinite(JSON.parse(JSON.stringify(result)), "result", bad);
    expect(bad).toEqual([]);
  });
});

describe("static regulatory grid — envelope shape unchanged by the new field", () => {
  it("emits no shortfalls key on any static scenario's NII row", () => {
    const result = freshEngine().run(makeRunRequest(market));
    for (const scn of result.nii.byScenario) {
      expect("shortfalls" in scn).toBe(false);
    }
    // Static grid stays fully implemented end to end.
    expect(result.notImplemented).toEqual([]);
  });
});
