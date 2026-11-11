/**
 * Acceptance check — stochastic run mode v0 (W2-A4 engine, W3-A4b platform arm).
 * Register id: "stochastic-hw-v0".
 *
 * Anchors, each printed with its measured
 * value:
 *
 *   1. ZERO-VOL DEGENERACY — at sigma = 0 the Monte Carlo collapses onto the
 *      fitted drift, so the stochastic mean EVE must equal the deterministic
 *      base EVE within 1e-6 relative. The single test that catches most wiring
 *      errors, run here on the vanilla book through the real entry point.
 *   2. ENGINE-LEVEL MARTINGALE — the corrected identity per-path discounting
 *      relies on, E_p[D_p(t_k)] = P^M(0,t_k), max residual surfaced in the
 *      envelope, with the printed SE of the terminal DF. The raw (uncorrected)
 *      drift is disclosed, never hidden.
 *   3. CALIBRATION RMSE SURFACED — the 5 bp gate is applied and the breach
 *      FLAG must be truthful (rmseGateBreached === rmseBp > gate). On the
 *      vendored 2026-03-31 surface the one-factor fit sits near 7.8 bp: the
 *      breach is a disclosure, and this check fails if it is ever absorbed.
 *   4. DISTRIBUTION HONESTY — every distribution carries its path count N and
 *      an antithetic-pair standard error; quantiles are ascending and inside
 *      [min, max].
 *   5. SEED DETERMINISM — same seed, byte-identical envelope; different seed,
 *      different content. The run seed is load-bearing on this path.
 *   6. TYPED REFUSALS — no ATM cap vols -> StochasticCapVolsError (no guessed
 *      volatility); an odd path count -> StochasticPathCountError (never
 *      silently adjusted).
 *
 * Cost: four 256-path runs plus two 64-path runs on the 9-position vanilla
 * book — a few seconds. The platform-path proof (submission arm, envelope
 * route, refusals as 422s) lives in
 * apps/server/src/__tests__/stochasticRun.test.ts.
 *
 * Register wiring note for W3-V2: the stochastic envelope carries the
 * in-envelope refusal layer "stochastic.shocked-scenarios"; when
 * this check is imported into accept/registry.ts, that layer must be added to
 * the register entry's expectedNotImplementedLayers in the same commit, or
 * stage 4 will (correctly) fail the diff.
 */
import {
  createEngine,
  resolveDefaultContext,
  runStochastic,
  DEFAULT_STOCHASTIC_PATHS,
  HW_RMSE_GATE_BP,
  type RunRequest,
  type StochasticRunResult,
  type PortfolioSpec,
} from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "../../vanilla";
import type { CapabilityCheck, CheckLine } from "./types";

/** Fixed timestamps: the two fields outside the deterministic core. */
const FIXED_TS = { startedAt: "2026-08-02T00:00:00.000Z", finishedAt: "2026-08-02T00:00:00.000Z" };

const ZERO_VOL_REL_TOL = 1e-6;
const MARTINGALE_MAX_BP = 1e-8; // corrected identity residual bound, bp

function mkRequest(market: MarketSnapshot, portfolio: PortfolioSpec, seed: string): RunRequest {
  const set = vanillaAssumptionSet();
  return {
    runId: `accept-stochastic-${seed}`,
    portfolioId: portfolio.id,
    marketSnapshot: market,
    scenarios: vanillaScenarios(set.id),
    assumptionSets: [set],
    grid: { horizonMonths: 360, asOf: portfolio.asOf },
    seed,
    timestamps: { ...FIXED_TS },
  };
}

export const stochasticCheck: CapabilityCheck = {
  capabilityId: "stochastic-hw-v0",
  title: "Stochastic run mode v0: HW1F Monte Carlo, separate distribution envelope",
  run({ market }) {
    const lines: CheckLine[] = [];
    const observed = new Set<string>();
    const portfolio = buildVanillaPortfolio();
    const note = (env: StochasticRunResult): StochasticRunResult => {
      for (const t of env.notImplemented) observed.add(t.layer);
      return env;
    };

    // Deterministic base EVE — the independent side of the degeneracy anchor,
    // computed through the deterministic engine, not the stochastic path.
    const engine = createEngine(resolveDefaultContext());
    engine.loadPortfolio(portfolio);
    const det = engine.run(mkRequest(market, portfolio, "accept"));
    const baseEve = det.eve.byScenario.find((s) => s.scenarioId === "S0")?.eve;
    for (const t of det.notImplemented) observed.add(t.layer);
    if (baseEve === undefined) {
      lines.push({
        id: "zero-vol-degeneracy",
        status: "fail",
        detail: "deterministic base scenario S0 missing from the EVE block; no comparison side exists",
      });
      return { lines, observedNotImplemented: [...observed] };
    }

    // 1. Zero-vol degeneracy at the default path count.
    const zero = note(
      runStochastic(mkRequest(market, portfolio, "42"), portfolio, {
        nPaths: DEFAULT_STOCHASTIC_PATHS,
        modelParams: { a: 0.05, sigma: 0, reason: "zero-vol degeneracy anchor (accept battery)" },
      }),
    );
    const relErr = Math.abs(zero.eveDistribution.mean - baseEve) / Math.abs(baseEve);
    lines.push({
      id: "zero-vol-degeneracy",
      status: relErr <= ZERO_VOL_REL_TOL ? "pass" : "fail",
      detail:
        `sigma=0 stochastic mean EVE ${zero.eveDistribution.mean.toFixed(2)} vs deterministic ` +
        `base EVE ${baseEve.toFixed(2)}: relative error ${relErr.toExponential(2)} ` +
        `(bound ${ZERO_VOL_REL_TOL}; anchor: at zero vol every path collapses onto the fitted ` +
        `drift, so the platform-visible mean must reproduce the deterministic engine exactly)`,
    });

    // 2-4. Calibrated run at the default count: martingale, RMSE surfacing,
    // distribution honesty.
    const cal = note(
      runStochastic(mkRequest(market, portfolio, "42"), portfolio, {
        nPaths: DEFAULT_STOCHASTIC_PATHS,
      }),
    );
    const m = cal.martingale;
    lines.push({
      id: "martingale",
      status: m.correctedMaxAbsErrBp <= MARTINGALE_MAX_BP ? "pass" : "fail",
      detail:
        `corrected max |E_p[D_p(t)] - P^M(0,t)| = ${m.correctedMaxAbsErrBp.toExponential(2)} bp ` +
        `(bound ${MARTINGALE_MAX_BP} bp) with terminal-DF SE ${m.terminalDfStandardError.toExponential(3)} ` +
        `at ${m.terminalYears}y; raw uncorrected drift ${m.rawTerminalErrBp.toFixed(1)} bp disclosed ` +
        `in-envelope (anchor: the kernel's multiplicative martingale correction makes the ` +
        `discounting identity exact; the raw drift shows the workload, never hidden)`,
    });
    if (cal.calibration.source !== "cap-atm-calibration") {
      lines.push({
        id: "calibration-surfaced",
        status: "fail",
        detail: `expected a market calibration, got source "${cal.calibration.source}"`,
      });
    } else {
      const c = cal.calibration;
      const flagTruthful = c.rmseGateBreached === c.rmseBp > c.rmseGateBp;
      lines.push({
        id: "calibration-surfaced",
        status: flagTruthful && c.rmseGateBp === HW_RMSE_GATE_BP ? "pass" : "fail",
        detail:
          `HW fit on ${c.nQuotes} ATM cap quotes: RMSE ${c.rmseBp.toFixed(4)} bp vs gate ` +
          `${c.rmseGateBp} bp, rmseGateBreached=${c.rmseGateBreached} (anchor: the breach flag ` +
          `must equal rmseBp > gate — surfaced, never absorbed; ~7.8 bp is the documented ` +
          `structural one-factor limit on the vendored 2026-03-31 surface)`,
      });
    }
    const d = cal.eveDistribution;
    const qs = d.quantiles.map((q) => q.value);
    const ascending = qs.every((v, i) => i === 0 || qs[i - 1] <= v);
    const inRange = qs.every((v) => v >= d.min && v <= d.max);
    const honest =
      d.nPaths === DEFAULT_STOCHASTIC_PATHS && d.standardError > 0 && ascending && inRange;
    lines.push({
      id: "distribution-honesty",
      status: honest ? "pass" : "fail",
      detail:
        `EVE distribution: N=${d.nPaths}, mean ${d.mean.toFixed(2)} +/- SE ` +
        `${d.standardError.toFixed(2)} (antithetic-pair basis), stdev ${d.stdev.toFixed(2)}, ` +
        `quantiles ascending=${ascending} within [min,max]=${inRange} (anchor: every statistic ` +
        `carries its N and SE, so a mean can never read as a converged deterministic EVE)`,
    });

    // 5. Seed determinism at a cheaper count (64 paths; even, >= 20).
    const s1 = JSON.stringify(note(runStochastic(mkRequest(market, portfolio, "42"), portfolio, { nPaths: 64 })));
    const s2 = JSON.stringify(note(runStochastic(mkRequest(market, portfolio, "42"), portfolio, { nPaths: 64 })));
    const s3 = JSON.stringify(note(runStochastic(mkRequest(market, portfolio, "43"), portfolio, { nPaths: 64 })));
    lines.push({
      id: "seed-determinism",
      status: s1 === s2 && s1 !== s3 ? "pass" : "fail",
      detail:
        `seed "42" twice: byte-identical=${s1 === s2} (${s1.length.toLocaleString("en-US")} bytes); ` +
        `seed "43": differs=${s1 !== s3} (anchor: the run seed is load-bearing on the stochastic ` +
        `path — all randomness flows from the kernel PCG32, no clock, no ambient RNG)`,
    });

    // 6. Typed refusals: no cap vols; odd path count.
    const noVols: MarketSnapshot = { ...market, capQuotes: [] };
    let capRefusal = "no error thrown";
    try {
      runStochastic(mkRequest(noVols, portfolio, "42"), portfolio, { nPaths: 64 });
    } catch (err) {
      capRefusal = err instanceof Error ? err.name : String(err);
    }
    let oddRefusal = "no error thrown";
    try {
      runStochastic(mkRequest(market, portfolio, "42"), portfolio, { nPaths: 21 });
    } catch (err) {
      oddRefusal = err instanceof Error ? err.name : String(err);
    }
    lines.push({
      id: "typed-refusals",
      status:
        capRefusal === "StochasticCapVolsError" && oddRefusal === "StochasticPathCountError"
          ? "pass"
          : "fail",
      detail:
        `snapshot without ATM cap quotes -> ${capRefusal}; nPaths=21 -> ${oddRefusal} ` +
        `(anchor: no default volatility exists anywhere in the code path, and a path count ` +
        `is never silently adjusted — refusal, not fabrication)`,
    });

    return { lines, observedNotImplemented: [...observed] };
  },
};
