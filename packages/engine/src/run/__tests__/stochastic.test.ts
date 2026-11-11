/**
 * Stochastic run mode v0 — the anchors, in build order:
 *
 *  1. ZERO-VOL DEGENERACY (the plumbing proof, built first): at sigma = 0 the
 *     stochastic per-path EVE and NII-12m collapse to the deterministic base
 *     values within 1e-6 relative.
 *  2. Engine-level martingale: the corrected per-path DFs reproduce the curve
 *     (max residual < 1e-6 bp, surfaced in the envelope), and a path-invariant
 *     fixed bullet's path-mean PV equals its deterministic PV as an identity
 *     through the FULL chain (projection, bucketing, per-path discounting) —
 *     the wiring test the DF check alone cannot perform (alm-hull-white
 *     gotcha 8 / cross-model #66). The SE is surfaced in the envelope.
 *  3. Calibration: the Lab public pack's illustrative cap surface fits at
 *     about 0.89 bp RMSE, under the 5 bp gate and NOT flagged; a kinked
 *     surface (model-generated, short expiries lifted 60%) exceeds the gate
 *     and IS flagged, which keeps the breach branch covered; a synthetic
 *     surface generated from known HW parameters is recovered with RMSE under
 *     the gate.
 *  4. Determinism: same seed byte-identical envelope; different seed different
 *     content.
 *  5. Refusals: no ATM cap vols, inadmissible path counts, garbage seed,
 *     dynamic base scenario, missing base scenario — all typed, none guessed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  hwCapletNormalVol,
  type CapQuote,
  type MarketSnapshot,
} from "@alm/kernel";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import { NotImplementedError } from "../../runtime/notImplemented";
import { clearPortfolios } from "../../portfolio/registry";
import { createEngine, type EngineTools } from "../index";
import {
  runStochastic,
  StochasticCapVolsError,
  StochasticPathCountError,
  StochasticSeedError,
  STOCHASTIC_SHOCKED_SCENARIOS_LAYER,
} from "../stochastic";
import {
  DEFAULT_STOCHASTIC_PATHS,
  MIN_STOCHASTIC_PATHS,
  STOCHASTIC_QUANTILES,
  STOCHASTIC_RESULT_SCHEMA_VERSION,
  type StochasticDistribution,
} from "../../contracts/stochastic";
import {
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  twoSidedBook,
  fixedPosition,
  makeCoa,
  AS_OF,
} from "./fixtures";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunRequest } from "../../contracts/run";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

/** Base-scenario-only request (the stochastic mode is base-only). */
function baseOnlyRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return makeRunRequest(market, {
    scenarios: regulatoryScenarios().slice(0, 1), // S0, kind "base"
    ...overrides,
  });
}

function deterministicEngine(portfolio?: PortfolioSpec): EngineTools {
  clearPortfolios();
  const engine = createEngine();
  engine.loadPortfolio(portfolio ?? twoSidedBook());
  return engine;
}

/** Walk a serialized envelope for any non-finite number. */
function assertAllFinite(x: unknown, path = "$"): void {
  if (typeof x === "number") {
    expect(Number.isFinite(x), `non-finite number at ${path}`).toBe(true);
  } else if (Array.isArray(x)) {
    x.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
  } else if (typeof x === "object" && x !== null) {
    for (const [k, v] of Object.entries(x)) assertAllFinite(v, `${path}.${k}`);
  }
}

function expectQuantilesSane(d: StochasticDistribution): void {
  expect(d.quantiles.map((q) => q.p)).toEqual([...STOCHASTIC_QUANTILES]);
  for (let i = 1; i < d.quantiles.length; i++) {
    expect(d.quantiles[i].value).toBeGreaterThanOrEqual(d.quantiles[i - 1].value);
  }
  for (const q of d.quantiles) {
    expect(q.value).toBeGreaterThanOrEqual(d.min);
    expect(q.value).toBeLessThanOrEqual(d.max);
  }
  expect(d.standardError).toBeGreaterThanOrEqual(0);
  expect(d.stdev).toBeGreaterThanOrEqual(0);
}

// ---------------------------------------------------------------------------
// Anchor 1: zero-vol degeneracy (build first — this proves the plumbing).
// ---------------------------------------------------------------------------
describe("stochastic — zero-vol degeneracy", () => {
  it("collapses to the deterministic base EVE and NII-12m within 1e-6 relative", () => {
    const req = baseOnlyRequest();
    const engine = deterministicEngine();
    const det = engine.run(req);
    const detEve = det.eve.byScenario.find((s) => s.scenarioId === "S0")!.eve;
    const detNii = det.nii.byScenario.find((s) => s.scenarioId === "S0")!.totalNet12;

    const sto = runStochastic(req, twoSidedBook(), {
      nPaths: 32,
      modelParams: { a: 0.05, sigma: 0, reason: "zero-vol degeneracy anchor" },
    });

    expect(sto.calibration.source).toBe("override");
    // Every path is the deterministic path: the distribution is a point mass.
    expect(sto.eveDistribution.stdev).toBeLessThan(Math.abs(detEve) * 1e-12);
    expect(sto.eveDistribution.standardError).toBeLessThan(Math.abs(detEve) * 1e-12);

    const relEve = Math.abs(sto.eveDistribution.mean - detEve) / Math.abs(detEve);
    expect(relEve).toBeLessThan(1e-6);

    const relNii = Math.abs(sto.nii12mDistribution.mean - detNii) / Math.abs(detNii);
    expect(relNii).toBeLessThan(1e-6);

    // The corrected DF identity is exact when every path is identical.
    expect(sto.martingale.correctedMaxAbsErrBp).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// Anchor 2: engine-level martingale, full chain.
// ---------------------------------------------------------------------------
describe("stochastic — martingale through the full engine chain", () => {
  /** One fixed 10Y bullet: its cash flows are path-invariant by construction. */
  function bulletBook(): PortfolioSpec {
    const coa = makeCoa();
    return {
      id: "PF-BULLET",
      label: "Single fixed bullet",
      asOf: AS_OF,
      coa,
      positions: [
        fixedPosition("Z1", {
          notional: 1_000_000,
          coupon: 0.04,
          maturityMonths: 120,
          amortType: "bullet",
        }),
      ],
    };
  }

  it("path-mean PV of a path-invariant bullet equals its deterministic PV (identity), SE surfaced", () => {
    const book = bulletBook();
    const req = baseOnlyRequest({ portfolioId: book.id });
    const det = deterministicEngine(book).run(req);
    const detPv = det.eve.byScenario.find((s) => s.scenarioId === "S0")!.pvAssets;

    const sto = runStochastic(req, book, {
      nPaths: 64,
      modelParams: { a: 0.05, sigma: 0.01, reason: "martingale full-chain anchor" },
    });

    // The bullet has no liabilities, so the per-path EVE is its per-path PV.
    // With E_p[D_p(t)] = P^M(0,t) enforced by the terminal correction, the
    // path-mean PV is an IDENTITY with the deterministic PV, not an estimate:
    // any gap is a wiring error (bucket misalignment, wrong DF index).
    const rel = Math.abs(sto.eveDistribution.mean - detPv) / detPv;
    expect(rel).toBeLessThan(1e-8);

    // Dispersion across paths is genuine (sigma > 0) and its SE is surfaced.
    expect(sto.eveDistribution.stdev).toBeGreaterThan(0);
    expect(sto.eveDistribution.standardError).toBeGreaterThan(0);
    expect(sto.martingale.terminalDfStandardError).toBeGreaterThan(0);

    // The corrected DF martingale residual the discounting relies on.
    expect(sto.martingale.correctedMaxAbsErrBp).toBeLessThan(1e-6);

    // The raw (uncorrected) drift is reported honestly: nonzero on this
    // vendored kernel (no phi(t) in the short rate) and absorbed by the
    // correction, never hidden.
    expect(Number.isFinite(sto.martingale.rawTerminalErrBp)).toBe(true);
    expect(sto.martingale.terminalYears).toBeCloseTo(req.grid.horizonMonths / 12, 9);
  });

  it("sigma > 0 produces genuine dispersion in EVE and NII on a behavioral book", () => {
    const req = baseOnlyRequest();
    const sto = runStochastic(req, twoSidedBook(), {
      nPaths: 32,
      modelParams: { a: 0.05, sigma: 0.01, reason: "dispersion sanity" },
    });
    expect(sto.eveDistribution.stdev).toBeGreaterThan(0);
    expect(sto.nii12mDistribution.stdev).toBeGreaterThan(0);
    expectQuantilesSane(sto.eveDistribution);
    expectQuantilesSane(sto.nii12mDistribution);
    assertAllFinite(JSON.parse(JSON.stringify(sto)));
  });
});

// ---------------------------------------------------------------------------
// Anchor 3: calibration — surfaced RMSE, gate flag, parameter recovery.
// ---------------------------------------------------------------------------
describe("stochastic — HW calibration surfacing and the 5 bp gate", () => {
  it("fits the public pack's illustrative cap surface under the 5 bp gate, not flagged", () => {
    const req = baseOnlyRequest();
    const sto = runStochastic(req, twoSidedBook(), { nPaths: 20 });
    const cal = sto.calibration;
    if (cal.source !== "cap-atm-calibration") throw new Error("expected a market calibration");
    // Public-basis re-base: the Lab public pack's cap vols are constructed
    // illustrative analogs, which a one-factor model fits closely. Measured
    // 2026-09-24 (deltas file) at 0.8925 bp on the kernel curve. On curve
    // default 2 the fit reads 0.9010 bp; the pin keeps 0.8925 because one
    // decimal (|diff| < 0.05) admits both, and the fit is not what this test
    // pins. The breach branch is covered by the next test.
    expect(cal.rmseBp).toBeCloseTo(0.8925, 1);
    expect(cal.rmseGateBp).toBe(5);
    expect(cal.rmseGateBreached).toBe(false);
    expect(cal.nQuotes).toBeGreaterThan(0);
    expect(cal.sigma).toBeGreaterThan(0);
    expect(cal.a).toBeGreaterThan(0);
  });

  it("flags a surface a one-factor model cannot fit (breach branch)", () => {
    // A model-generated surface with the short expiries lifted 60%: a kinked
    // term structure no single (a, sigma) reproduces, so the fit must exceed
    // the 5 bp gate and the run must say so.
    const tau = 0.25;
    // The forwards of the run's own base curve (the default, log-linear on DF), which the calibration reads.
    const curve = buildBaseCurve(market);
    const kinked: CapQuote[] = market.capQuotes
      .filter((q) => q.isAtm)
      .map((q) => ({
        expiryYears: q.expiryYears,
        strike: null,
        normalVol:
          hwCapletNormalVol(0.08, 0.012, q.expiryYears, tau,
            curve.forwardRate(q.expiryYears, q.expiryYears + tau)) *
          (q.expiryYears <= 2 ? 1.6 : 1.0),
        isAtm: true,
      }));
    const req = baseOnlyRequest({ marketSnapshot: { ...market, capQuotes: kinked } });
    const cal = runStochastic(req, twoSidedBook(), { nPaths: 20 }).calibration;
    if (cal.source !== "cap-atm-calibration") throw new Error("expected a market calibration");
    expect(cal.rmseBp).toBeGreaterThan(5);
    expect(cal.rmseGateBreached).toBe(true);
  });

  it("recovers known HW parameters from a model-generated surface with RMSE under the 5 bp gate", () => {
    const aStar = 0.08;
    const sigmaStar = 0.012;
    const tau = 0.25;
    // B4 Task 10 (Task 5 review minor): the synthetic surface is priced on the forwards of the curve the run calibrates
    // on, buildBaseCurve (the default, log-linear on DF), not the kernel bootstrap. On the kernel's forwards the fit read
    // rmse 0.0412 bp, a 0.0800233, sigma 0.0119979; on the run's own forwards it recovers both parameters to roundoff
    // (measured rmse 9.9e-8 bp, a error 7.2e-10, sigma error 2.3e-11), so the bounds are tightened. Deltas Step 1.
    const curve = buildBaseCurve(market);
    const synthetic: CapQuote[] = market.capQuotes
      .filter((q) => q.isAtm)
      .map((q) => ({
        expiryYears: q.expiryYears,
        strike: null,
        normalVol: hwCapletNormalVol(
          aStar,
          sigmaStar,
          q.expiryYears,
          tau,
          curve.forwardRate(q.expiryYears, q.expiryYears + tau),
        ),
        isAtm: true,
      }));
    const snap: MarketSnapshot = { ...market, capQuotes: synthetic };
    const req = baseOnlyRequest({ marketSnapshot: snap });

    const sto = runStochastic(req, twoSidedBook(), { nPaths: 20 });
    const cal = sto.calibration;
    if (cal.source !== "cap-atm-calibration") throw new Error("expected a market calibration");
    expect(cal.rmseBp).toBeLessThan(1e-4); // well under the 5 bp gate
    expect(cal.rmseGateBreached).toBe(false);
    expect(Math.abs(cal.a - aStar)).toBeLessThan(1e-6);
    expect(Math.abs(cal.sigma - sigmaStar)).toBeLessThan(1e-8);
  });
});

// ---------------------------------------------------------------------------
// Anchor 4: determinism — the seed is load-bearing.
// ---------------------------------------------------------------------------
describe("stochastic — seed determinism", () => {
  it("same seed: byte-identical envelope; different seed: different content", () => {
    const opts = {
      nPaths: MIN_STOCHASTIC_PATHS,
      modelParams: { a: 0.05, sigma: 0.01, reason: "determinism anchor" },
    };
    const r1 = runStochastic(baseOnlyRequest({ seed: "42" }), twoSidedBook(), opts);
    const r2 = runStochastic(baseOnlyRequest({ seed: "42" }), twoSidedBook(), opts);
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));

    const r3 = runStochastic(baseOnlyRequest({ seed: "43" }), twoSidedBook(), opts);
    expect(JSON.stringify(r3)).not.toBe(JSON.stringify(r1));
    // The difference is numeric, not just the echoed seed string.
    expect(r3.eveDistribution.mean).not.toBe(r1.eveDistribution.mean);
  });
});

// ---------------------------------------------------------------------------
// Anchor 5: refusals — typed, never a guessed number.
// ---------------------------------------------------------------------------
describe("stochastic — typed refusals", () => {
  it("refuses without ATM cap vols instead of guessing a volatility", () => {
    const noAtm: MarketSnapshot = {
      ...market,
      capQuotes: market.capQuotes.filter((q) => !q.isAtm),
    };
    const req = baseOnlyRequest({ marketSnapshot: noAtm });
    expect(() => runStochastic(req, twoSidedBook(), { nPaths: 20 })).toThrow(
      StochasticCapVolsError,
    );
    try {
      runStochastic(req, twoSidedBook(), { nPaths: 20 });
    } catch (e) {
      expect((e as StochasticCapVolsError).layer).toBe("stochastic.calibration");
    }
  });

  it("refuses inadmissible path counts (odd, fractional, below quantile support)", () => {
    const req = baseOnlyRequest();
    const params = { a: 0.05, sigma: 0.01, reason: "refusal cases" };
    for (const bad of [21, 30.5, 10, 0, -20]) {
      expect(() =>
        runStochastic(req, twoSidedBook(), { nPaths: bad, modelParams: params }),
      ).toThrow(StochasticPathCountError);
    }
  });

  it("refuses a non-integer seed", () => {
    const req = baseOnlyRequest({ seed: "not-a-seed" });
    expect(() =>
      runStochastic(req, twoSidedBook(), {
        nPaths: 20,
        modelParams: { a: 0.05, sigma: 0.01, reason: "seed refusal" },
      }),
    ).toThrow(StochasticSeedError);
  });

  it("refuses a dynamic base scenario (static runoff only)", () => {
    const req = baseOnlyRequest();
    req.scenarios = [
      {
        ...req.scenarios[0],
        newBusiness: {
          mode: "dynamic",
          rules: [{ familyId: "FIXED", reinvest: "flat" }],
        },
      },
    ];
    expect(() =>
      runStochastic(req, twoSidedBook(), {
        nPaths: 20,
        modelParams: { a: 0.05, sigma: 0.01, reason: "dynamic refusal" },
      }),
    ).toThrow(NotImplementedError);
  });

  it("refuses a request with no base scenario", () => {
    const req = makeRunRequest(market, {
      scenarios: regulatoryScenarios().slice(1, 2), // S100 only
    });
    expect(() => runStochastic(req, twoSidedBook(), { nPaths: 20 })).toThrow(
      /no base scenario/,
    );
  });
});

// ---------------------------------------------------------------------------
// Envelope contract: its own schema, never readable as a deterministic result.
// ---------------------------------------------------------------------------
describe("stochastic — envelope contract", () => {
  it("carries its own schema version, the structural discriminant, and the in-envelope register", () => {
    const req = baseOnlyRequest();
    const sto = runStochastic(req, twoSidedBook(), {
      nPaths: 20,
      modelParams: { a: 0.05, sigma: 0.01, reason: "envelope contract" },
    });
    expect(sto.schemaVersion).toBe(STOCHASTIC_RESULT_SCHEMA_VERSION);
    expect(sto.kind).toBe("stochastic-distribution");
    expect(sto.model).toBe("hull-white-1f");
    expect(sto.scenarioId).toBe("S0");
    expect(sto.seed).toBe(req.seed);
    expect(sto.nPaths).toBe(20);
    expect(sto.discountBasis).toBe("all-in");
    // No bare "eve" field exists: distributions are the only value carriers.
    expect((sto as unknown as Record<string, unknown>)["eve"]).toBeUndefined();
    expect(sto.eveDistribution.nPaths).toBe(20);
    // The deliberate boundary is registered in-envelope.
    expect(sto.notImplemented.map((t) => t.layer)).toContain(
      STOCHASTIC_SHOCKED_SCENARIOS_LAYER,
    );
    assertAllFinite(JSON.parse(JSON.stringify(sto)));
  });

  it("pins the defaults as contract constants", () => {
    expect(DEFAULT_STOCHASTIC_PATHS).toBe(256);
    expect(MIN_STOCHASTIC_PATHS).toBe(20);
    expect(STOCHASTIC_QUANTILES).toEqual([0.05, 0.25, 0.5, 0.75, 0.95]);
  });
});

// ---------------------------------------------------------------------------
// The environment hand-out is observation only.
// ---------------------------------------------------------------------------
describe("stochastic — onEnvironment hand-out", () => {
  it("is called once with the built environment and the base scenario, and changes no byte of the envelope", () => {
    const opts = {
      nPaths: MIN_STOCHASTIC_PATHS,
      modelParams: { a: 0.05, sigma: 0.01, reason: "hand-out anchor" },
    };
    const silent = runStochastic(baseOnlyRequest({ seed: "42" }), twoSidedBook(), opts);

    const seen: { nPaths: number; nSteps: number; scenarioId: string }[] = [];
    const observed = runStochastic(baseOnlyRequest({ seed: "42" }), twoSidedBook(), {
      ...opts,
      onEnvironment: (env, baseScenario) => {
        seen.push({ nPaths: env.sim.nPaths, nSteps: env.sim.times.length, scenarioId: baseScenario.id });
      },
    });

    expect(seen).toEqual([{ nPaths: MIN_STOCHASTIC_PATHS, nSteps: 360, scenarioId: "S0" }]);
    expect(JSON.stringify(observed)).toBe(JSON.stringify(silent));
  });
});
