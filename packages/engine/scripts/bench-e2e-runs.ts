/**
 * Whole-run cost of the dense curve.
 *
 *   npx tsx packages/engine/scripts/bench-e2e-runs.ts
 *
 * bench-curve-reads.ts measured one curve read at 4x to 8x slower on a curve
 * with 360 dense monthly nodes than on the kernel's 11 quote nodes (the kernel
 * lerp scans nodes linearly). This script asks what that costs a WHOLE run.
 *
 * Market: packages/kernel/public/market_public.json, made month-exact by the
 * curveBuilder test helper (it already quotes 1M to 30Y, so no quote is added
 * and none is dropped). Three base curves, all from that one copy:
 *   A  legacy  buildBaseCurve(snapshot plus the curveDefault: 1 marker): the
 *              kernel bootstrap, 11 quote nodes, linear in zero rate (curve
 *              default 1; since B4 Task 11 the marker keeps this arm legacy,
 *              because a snapshot with no setup and no marker now builds B);
 *   B  dense   the same snapshot, no curveSetup block and no marker: curve
 *              default 2, 360 monthly nodes log-linear on discount factor
 *              from the engine solver (before B4 this arm carried an explicit
 *              curveSetup = setupFromSnapshot(snap, "log-linear-df"); the
 *              script prints the max zero gap between the two, expected 0);
 *   D  control A's own zeroRate(k/12), k = 1..360, rehydrated as a 360-node
 *              curve (rehydrateCurve): B's node count, A's values. D/A is the
 *              pure node-count cost, with no change of model.
 *   G BGM (workload 1 only)
 *              runStochastic with model "bgm-lmm-2f" on B's request: the same
 *              market, book, seed and path count, so G against B is the BGM
 *              cost against the Hull-White cost of a no-model run today.
 *
 * Book: generatePortfolio(DEFAULT_GENERATOR_CONFIG, targetPositions 500; 471
 * after the CD draws fold into one cohort position), the eleven-family
 * synthetic book (fixed, floating, mortgages, MBS, deposits, CDs, FHLB,
 * borrowings), under the walkthrough example's base assumption set
 * (four-factor CPR prepayment on mortgages and MBS, NMD decay on DDA, deposit
 * beta on MMA). Horizon 360 months.
 *
 * Workloads:
 *   1  stochastic: runStochastic (Hull-White 1F, cap-ATM calibration) at the
 *      default 256 paths, base scenario. runStochastic builds its own base
 *      curve, so D (and the counting runs) go through stochasticOnCurve below:
 *      a line-for-line copy of runStochastic's body that takes the curve as an
 *      argument. The copy is checked against the real entry: on A and on B its
 *      per-path EVE and NII sums must equal the real envelope's means exactly.
 *   2  deterministic: buildRunResult (the normal orchestration) on base plus a
 *      +200bp parallel shock.
 *   3  key-rate durations: buildRunResult with keyRate on, base scenario only
 *      (the base run plus the KRD regenerations, 25bp bump), on the book with
 *      the NMD regime amplifier zeroed (see krdPortfolio).
 *
 * Timing: performance.now(); one warm-up of each curve, then rounds run A, B
 * (D) interleaved so machine noise from other checkouts falls on every curve
 * alike; median of 3 rounds when a warm-up exceeds 10 s, else 5.
 *
 * BGM split (workload 1, arms B and G): each run is also timed at the
 * environment hand-out (onEnvironment on B, onBgmEnvironment on G, observation
 * only), and G's envelope carries simulation.fixedCostMs. benchSplit.ts turns
 * that into fixed cost, the rest of the environment build, projection (whole
 * run less both) and per-path projection; the report gives medians over the
 * rounds and the round-by-round G/B ratios.
 *
 * Read share (workload 1): a counting proxy (script only) wraps the curve
 * object handed to the stochastic environment and counts EXTERNAL calls per
 * method (the wrapped method runs with the raw curve as `this`, so a read's
 * own internal reads are not counted twice). It also keeps a reservoir sample
 * of 100,000 argument sets per method; replaying that sample on each curve
 * gives a per-read cost on the run's own argument mix. Estimated read time =
 * sum over methods of (calls x per-read cost); share = that / run time.
 */
import { readFileSync } from "node:fs";
import {
  BETA_S_CURVE_DEFAULTS,
  DEFAULT_TLP_CURVE,
  MBS_DEFAULTS,
  NMD_DEFAULTS,
  buildTLPCurve,
  parseMarketSnapshot,
  rehydrateCurve,
  type MarketSnapshot,
  type ZeroCurve,
} from "@alm/kernel";
import { generatePortfolio, DEFAULT_GENERATOR_CONFIG } from "../../../data/src/generate";
import {
  DEFAULT_STOCHASTIC_PATHS,
  buildRunResult,
  resolveDefaultContext,
  runStochastic,
  type AssumptionSet,
  type PortfolioSpec,
  type RunRequest,
  type RunResult,
  type Scenario,
  type StochasticRunResult,
} from "../src/index";
import { commitmentFamilyIds } from "../src/commitment/offBalanceSheet";
import type { BalanceSheetSide } from "../src/contracts/ids";
import { buildTlpFactors, pvBucketedSeriesOnPath } from "../src/eve/pathDiscount";
import { macroTargetsOf, resolveRunMacro } from "../src/macro/runMacro";
import { computeNII } from "../src/nii";
import { aggregateScenario } from "../src/portfolio";
import { applyStaticOverlays } from "../src/projection/static";
import { resolveRunRateIndices } from "../src/rateIndex/resolve";
import { bindAssumptions, buildBaseCurve } from "../src/scenario";
import { buildStochasticEnvironment } from "../src/scenario/stochasticEnvironment";
import { derivativeFamilyIds, hasDerivativeFamily } from "../src/swap/derivatives";
import { monthExactSnapshot, setupFromSnapshot } from "../src/curveBuilder/__tests__/helpers";
import { pairedRatios, splitStochasticTiming, type StochasticRunSplit } from "./benchSplit";

const BOOK_POSITIONS = Number(process.env.BENCH_BOOK ?? 500);
const N_PATHS = Number(process.env.BENCH_PATHS ?? DEFAULT_STOCHASTIC_PATHS);
const HORIZON = 360;
const LONG_RUN_MS = 10_000;
const SAMPLE_SIZE = 100_000;
const REPLAY_PASSES = 5;
const METHODS = ["discountFactor", "forwardRate", "forwardSwapRate", "zeroRate", "forwardRateBey"] as const;
type Method = (typeof METHODS)[number];

// ---------------------------------------------------------------- inputs
const raw = JSON.parse(readFileSync(new URL("../../kernel/public/market_public.json", import.meta.url), "utf8"));
const { snapshot: legacySnap, dropped } = monthExactSnapshot(parseMarketSnapshot(raw));
// Arm A carries the curveDefault: 1 marker so it stays the kernel (legacy) curve; arm B is the
// plain snapshot, which builds curve default 2. The explicit log-linear-df setup (B before B4) is kept untimed
// as a check that the default builds the same curve.
const markedSnap = { ...legacySnap, curveDefault: 1 } as MarketSnapshot;
const denseSnap = legacySnap;
const setupSnap = { ...legacySnap, curveSetup: setupFromSnapshot(legacySnap, "log-linear-df") } as MarketSnapshot;

const curveA = buildBaseCurve(markedSnap);
const curveB = buildBaseCurve(denseSnap);
const curveSetupB = buildBaseCurve(setupSnap);
const dT: number[] = [];
const dZ: number[] = [];
for (let k = 1; k <= 360; k++) {
  dT.push(k / 12);
  dZ.push(curveA.zeroRate(k / 12));
}
const curveD = rehydrateCurve({ t: dT, z: dZ, convention: curveA.convention });
if (curveB.t.length !== 360) throw new Error(`expected 360 dense nodes on B, got ${curveB.t.length}`);

const portfolio: PortfolioSpec = generatePortfolio({ ...DEFAULT_GENERATOR_CONFIG, targetPositions: BOOK_POSITIONS });
const assumptionSet: AssumptionSet = {
  schemaVersion: "1.0.0",
  id: "bench-base-v1",
  label: "walkthrough base behavioral set (kernel defaults)",
  bindings: [
    { familyId: "mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS }, modelVersion: "kernel-four-factor-cpr-1" },
    { familyId: "mbs", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS }, modelVersion: "kernel-four-factor-cpr-1" },
    { familyId: "dda", overlay: { kind: "nmd-decay", params: NMD_DEFAULTS }, modelVersion: "kernel-nmd-decay-1" },
    { familyId: "mma", overlay: { kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS }, modelVersion: "kernel-deposit-beta-1" },
  ],
};
const S0: Scenario = { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: assumptionSet.id, newBusiness: { mode: "static", rules: [] } };
const S200: Scenario = { id: "S200", label: "+200bp", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: assumptionSet.id, newBusiness: { mode: "static", rules: [] } };

/**
 * Workload 3 only: the key-rate stage refuses a book whose NMD positions carry
 * a nonzero regime amplifier (eve.key-rate.regime-amplifier), and the
 * generated book and NMD_DEFAULTS both carry regimeAlpha 2. The KRD runs use
 * the same book and set with regimeAlpha set to 0 on every NMD position and on
 * the DDA binding; nothing else changes.
 */
const krdPortfolio: PortfolioSpec = {
  ...portfolio,
  positions: portfolio.positions.map((p) => {
    const t = p.terms as { type: string; nmdParams?: { regimeAlpha?: number } };
    if ((t.type !== "nmd" && t.type !== "nmd-b") || !t.nmdParams) return p;
    return { ...p, terms: { ...t, nmdParams: { ...t.nmdParams, regimeAlpha: 0 } } } as typeof p;
  }),
};
const krdSet: AssumptionSet = {
  ...assumptionSet,
  bindings: assumptionSet.bindings.map((b) =>
    b.overlay.kind === "nmd-decay" ? { ...b, overlay: { ...b.overlay, params: { ...b.overlay.params, regimeAlpha: 0 } } } : b,
  ),
};

function request(market: MarketSnapshot, scenarios: Scenario[], runId: string, set: AssumptionSet = assumptionSet): RunRequest {
  return {
    runId,
    portfolioId: portfolio.id,
    marketSnapshot: market,
    scenarios,
    assumptionSets: [set],
    grid: { horizonMonths: HORIZON, asOf: portfolio.asOf },
    seed: "42",
    timestamps: { startedAt: "2026-10-12T00:00:00.000Z", finishedAt: "2026-10-12T00:00:00.000Z" },
  };
}

// ---------------------------------------------------- stochastic on a curve
/**
 * runStochastic's body (packages/engine/src/run/stochastic.ts) with the base
 * curve as an argument. Request validation and the envelope summaries are left
 * out; the per-path loop is verbatim. Returns the per-path EVE and NII.
 */
function stochasticOnCurve(req: RunRequest, book: PortfolioSpec, curve: ZeroCurve): { eve: Float64Array; nii: Float64Array; a: number; sigma: number } {
  const base = req.scenarios.find((s) => s.rateSpec.kind === "base")!;
  const set = bindAssumptions(req.assumptionSets.find((s) => s.id === base.assumptionSetId)!);
  const macro = resolveRunMacro(req, req.marketSnapshot);
  const effective = set.bindings.length > 0 ? applyStaticOverlays(book, set, undefined, macroTargetsOf(macro)) : book;
  const rateIndices = resolveRunRateIndices(book, req.marketSnapshot);
  const nodes = req.marketSnapshot.tlpNodes;
  const tlp = nodes.length > 0 ? buildTLPCurve(nodes) : DEFAULT_TLP_CURVE;
  const env = buildStochasticEnvironment(req.marketSnapshot, curve, { horizonMonths: HORIZON, nPaths: N_PATHS, seed: BigInt(req.seed) });
  const tlpFactors = buildTlpFactors(HORIZON, tlp, "all-in");
  const coa = effective.coa;
  const sideByFamily = new Map<string, BalanceSheetSide>();
  for (const f of coa.families) sideByFamily.set(f.id, f.side);
  const commitments = commitmentFamilyIds(coa);
  const hedged = hasDerivativeFamily(coa);
  const derivatives = derivativeFamilyIds(coa);
  const riskFreeFactors = hedged ? buildTlpFactors(HORIZON, tlp, "risk-free") : tlpFactors;
  const eve = new Float64Array(N_PATHS);
  const nii = new Float64Array(N_PATHS);
  for (let p = 0; p < N_PATHS; p++) {
    const cf = aggregateScenario(effective, { scenarioId: base.id, path: env.paths[p] }, req.grid, rateIndices, macro);
    let pvAssets = 0;
    let pvLiabilities = 0;
    let pvDerivatives = 0;
    for (const fam of cf.byFamily) {
      if (commitments.has(fam.familyId)) continue;
      if (derivatives.has(fam.familyId)) {
        pvDerivatives += pvBucketedSeriesOnPath(fam.series, env.discount.Dcorr[p], riskFreeFactors);
        continue;
      }
      const side = sideByFamily.get(fam.familyId);
      const pv = pvBucketedSeriesOnPath(fam.series, env.discount.Dcorr[p], tlpFactors);
      if (side === "liability") pvLiabilities += pv;
      else if (side === "asset") pvAssets += pv;
    }
    eve[p] = hedged ? pvAssets - pvLiabilities + pvDerivatives : pvAssets - pvLiabilities;
    nii[p] = computeNII([cf], coa).byScenario[0].totalNet12;
  }
  return { eve, nii, a: env.sim.a, sigma: env.sim.sigma };
}

/** The mean exactly as runStochastic's summarise computes it (index-order sum, then divide). */
function meanOf(v: Float64Array): number {
  let m = 0;
  for (let i = 0; i < v.length; i++) m += v[i];
  return m / v.length;
}

// ------------------------------------------------------- counting proxy
interface CallLog {
  counts: Record<Method, number>;
  samples: Record<Method, number[][]>;
}

function countingCurve(curve: ZeroCurve, log: CallLog): ZeroCurve {
  let seed = 12345;
  const rand = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  const wrapped = new Map<string, unknown>();
  for (const m of METHODS) {
    const fn = (curve as unknown as Record<string, (...a: number[]) => number>)[m];
    wrapped.set(m, (...args: number[]): number => {
      const n = ++log.counts[m];
      const s = log.samples[m];
      if (s.length < SAMPLE_SIZE) s.push(args);
      else {
        const j = Math.floor(rand() * n);
        if (j < SAMPLE_SIZE) s[j] = args;
      }
      return fn.apply(curve, args);
    });
  }
  return new Proxy(curve, {
    get(target, prop) {
      if (typeof prop === "string" && wrapped.has(prop)) return wrapped.get(prop);
      return Reflect.get(target, prop, target);
    },
  });
}

function emptyLog(): CallLog {
  const counts = {} as Record<Method, number>;
  const samples = {} as Record<Method, number[][]>;
  for (const m of METHODS) {
    counts[m] = 0;
    samples[m] = [];
  }
  return { counts, samples };
}

let sink = 0;
/**
 * Mean ns per call of `method` on `curve`, replaying the sampled arguments as
 * direct method calls, net of the same loop with no curve call (the array
 * reads and the sum), so the harness's own cost is not billed to the curve.
 */
function perReadNs(curve: ZeroCurve, method: Method, sample: number[][]): number {
  if (sample.length === 0) return 0;
  const a0 = Float64Array.from(sample, (s) => s[0]);
  const a1 = Float64Array.from(sample, (s) => s[1] ?? 0);
  const n = sample.length;
  const loops: Record<Method | "none", () => void> = {
    discountFactor: () => { for (let i = 0; i < n; i++) sink += curve.discountFactor(a0[i]); },
    forwardRate: () => { for (let i = 0; i < n; i++) sink += curve.forwardRate(a0[i], a1[i]); },
    forwardSwapRate: () => { for (let i = 0; i < n; i++) sink += curve.forwardSwapRate(a0[i], a1[i]); },
    zeroRate: () => { for (let i = 0; i < n; i++) sink += curve.zeroRate(a0[i]); },
    forwardRateBey: () => { for (let i = 0; i < n; i++) sink += curve.forwardRateBey(a0[i], a1[i]); },
    none: () => { for (let i = 0; i < n; i++) sink += a0[i] + a1[i]; },
  };
  const timeOf = (fn: () => void): number => {
    fn();
    const times: number[] = [];
    for (let r = 0; r < REPLAY_PASSES; r++) {
      const t0 = performance.now();
      fn();
      times.push(performance.now() - t0);
    }
    return median(times);
  };
  const net = timeOf(loops[method]) - timeOf(loops.none);
  return (Math.max(net, 0) * 1e6) / n;
}

// ------------------------------------------------------------- timing
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface Timed {
  ms: Record<string, number[]>;
  warmMs: Record<string, number>;
  rounds: number;
}

/** One warm-up of each, then interleaved rounds; 3 rounds if any warm-up is over 10 s, else 5. */
function interleaved(fns: Array<[string, () => unknown]>): Timed {
  const warmMs: Record<string, number> = {};
  const ms: Record<string, number[]> = {};
  for (const [name, fn] of fns) {
    const t0 = performance.now();
    fn();
    warmMs[name] = performance.now() - t0;
    ms[name] = [];
    console.error(`  warm-up ${name}: ${(warmMs[name] / 1000).toFixed(2)} s`);
  }
  const rounds = Object.values(warmMs).some((t) => t > LONG_RUN_MS) ? 3 : 5;
  for (let r = 0; r < rounds; r++) {
    for (const [name, fn] of fns) {
      const t0 = performance.now();
      fn();
      ms[name].push(performance.now() - t0);
    }
    console.error(`  round ${r + 1}/${rounds}: ${fns.map(([n]) => `${n} ${(ms[n][r] / 1000).toFixed(2)} s`).join(", ")}`);
  }
  return { ms, warmMs, rounds };
}

const fmtS = (ms: number): string => (ms / 1000).toFixed(2);
const rel = (b: number, a: number): string => ((b - a) / Math.abs(a)).toExponential(3);

// ================================================================= run
const famCounts: Record<string, number> = {};
for (const p of portfolio.positions) famCounts[p.familyId] = (famCounts[p.familyId] ?? 0) + 1;
let maxDA = 0;
for (let i = 0; i <= 3600; i++) maxDA = Math.max(maxDA, Math.abs(curveD.zeroRate(i / 100) - curveA.zeroRate(i / 100)));

console.log(`node ${process.version}; market ${legacySnap.curveConvention}, quotes ${legacySnap.curveQuotes.map((q) => q.term).join(" ")}, dropped [${dropped.join(" ")}]`);
let maxBS = 0;
for (let i = 0; i <= 3600; i++) maxBS = Math.max(maxBS, Math.abs(curveB.zeroRate(i / 100) - curveSetupB.zeroRate(i / 100)));
console.log(`nodes A ${curveA.t.length}, B ${curveB.t.length}, D ${curveD.t.length}; max |zD - zA| on a 0.01y grid to 36y: ${maxDA.toExponential(2)}`);
console.log(`B (curve default 2, no setup) against the explicit log-linear-df setup: max |dz| on a 0.01y grid to 36y ${maxBS.toExponential(2)}`);
console.log(`book ${portfolio.positions.length} positions: ${JSON.stringify(famCounts)}`);
console.log(`stochastic paths ${N_PATHS}, horizon ${HORIZON} months`);

// ---- workload 1: stochastic
console.error("workload 1: stochastic");
const reqA1 = request(markedSnap, [S0], "bench-stoch-A");
const reqB1 = request(denseSnap, [S0], "bench-stoch-B");
let resA1!: StochasticRunResult;
let resB1!: StochasticRunResult;
let resD1!: ReturnType<typeof stochasticOnCurve>;
let resG1!: StochasticRunResult;
const reqG1 = request(denseSnap, [S0], "bench-stoch-G");
// Arms B and G record their split on every call (index 0 is the warm-up).
const splitB: StochasticRunSplit[] = [];
const splitG: StochasticRunSplit[] = [];
function splitRun(req: RunRequest, bgm: boolean, into: StochasticRunSplit[]): StochasticRunResult {
  const t0 = performance.now();
  let ready = NaN;
  const mark = (): void => {
    ready = performance.now() - t0;
  };
  const res = bgm
    ? runStochastic(req, portfolio, { nPaths: N_PATHS, model: "bgm-lmm-2f", onBgmEnvironment: mark })
    : runStochastic(req, portfolio, { nPaths: N_PATHS, onEnvironment: mark });
  const wholeMs = performance.now() - t0;
  into.push(splitStochasticTiming({ wholeMs, envReadyMs: ready, fixedCostMs: res.simulation?.fixedCostMs, nPaths: res.nPaths }));
  return res;
}
const w1 = interleaved([
  ["A", () => (resA1 = runStochastic(reqA1, portfolio, { nPaths: N_PATHS }))],
  ["B", () => (resB1 = splitRun(reqB1, false, splitB))],
  ["D", () => (resD1 = stochasticOnCurve(reqA1, portfolio, curveD))],
  ["G", () => (resG1 = splitRun(reqG1, true, splitG))],
]);

// counting runs (untimed): the copy on proxied A and B, checked against the real envelope
console.error("workload 1: counting runs");
const logA = emptyLog();
const cntA = stochasticOnCurve(reqA1, portfolio, countingCurve(curveA, logA));
const logB = emptyLog();
const cntB = stochasticOnCurve(reqB1, portfolio, countingCurve(curveB, logB));
const copyCheck = {
  A: meanOf(cntA.eve) === resA1.eveDistribution.mean && meanOf(cntA.nii) === resA1.nii12mDistribution.mean,
  B: meanOf(cntB.eve) === resB1.eveDistribution.mean && meanOf(cntB.nii) === resB1.nii12mDistribution.mean,
};

const costNs: Record<string, Record<Method, number>> = {};
for (const [name, c] of [["A", curveA], ["B", curveB], ["D", curveD]] as const) {
  costNs[name] = {} as Record<Method, number>;
  for (const m of METHODS) costNs[name][m] = perReadNs(c, m, logA.samples[m]);
}

// ---- workload 2: deterministic base + parallel +200
console.error("workload 2: deterministic");
const ctx = resolveDefaultContext();
let resA2!: RunResult;
let resB2!: RunResult;
const w2 = interleaved([
  ["A", () => (resA2 = buildRunResult(request(markedSnap, [S0, S200], "bench-det-A"), portfolio, ctx))],
  ["B", () => (resB2 = buildRunResult(request(denseSnap, [S0, S200], "bench-det-B"), portfolio, ctx))],
]);

// ---- workload 3: key-rate durations
console.error("workload 3: key-rate durations");
const ctxKr = { ...resolveDefaultContext(), keyRate: true };
let resA3!: RunResult;
let resB3!: RunResult;
const w3 = interleaved([
  ["A", () => (resA3 = buildRunResult(request(markedSnap, [S0], "bench-krd-A", krdSet), krdPortfolio, ctxKr))],
  ["B", () => (resB3 = buildRunResult(request(denseSnap, [S0], "bench-krd-B", krdSet), krdPortfolio, ctxKr))],
]);

// ================================================================ report
console.log("\n## Timings (median seconds; interleaved rounds after one warm-up each)");
console.log("workload | rounds | A s | B s | D s | B/A | D/A");
const row = (label: string, w: Timed): void => {
  const a = median(w.ms.A);
  const b = median(w.ms.B);
  const d = w.ms.D ? median(w.ms.D) : NaN;
  console.log(`${label} | ${w.rounds} | ${fmtS(a)} | ${fmtS(b)} | ${w.ms.D ? fmtS(d) : "n/a"} | ${(b / a).toFixed(2)}x | ${w.ms.D ? (d / a).toFixed(2) + "x" : "n/a"}`);
};
row(`1 stochastic, ${N_PATHS} paths`, w1);
row("2 deterministic, base + parallel +200", w2);
row("3 base + key-rate durations", w3);
console.log("raw ms:", JSON.stringify({ w1: w1.ms, w2: w2.ms, w3: w3.ms }));
console.log("warm-up ms:", JSON.stringify({ w1: w1.warmMs, w2: w2.warmMs, w3: w3.warmMs }));

console.log("\n## Workload 1: curve calls (external calls on the curve object, one run)");
console.log(`copy check (stochasticOnCurve vs runStochastic, exact mean EVE and NII): A ${copyCheck.A}, B ${copyCheck.B}`);
console.log("method | calls on A | calls on B | ns/read A | ns/read B | ns/read D");
for (const m of METHODS) {
  console.log(`${m} | ${logA.counts[m]} | ${logB.counts[m]} | ${costNs.A[m].toFixed(1)} | ${costNs.B[m].toFixed(1)} | ${costNs.D[m].toFixed(1)}`);
}
for (const name of ["A", "B", "D"] as const) {
  const log = name === "B" ? logB : logA;
  let readMs = 0;
  for (const m of METHODS) readMs += (log.counts[m] * costNs[name][m]) / 1e6;
  const runMs = median(w1.ms[name]);
  console.log(`estimated read time ${name}: ${fmtS(readMs)} s of ${fmtS(runMs)} s run = ${((100 * readMs) / runMs).toFixed(1)} percent`);
}

console.log("\n## Workload 1: BGM arm G against the Hull-White arm B (same market, book, seed, paths)");
{
  const roundsB = splitB.slice(1);
  const roundsG = splitG.slice(1);
  const med = (xs: StochasticRunSplit[], k: keyof StochasticRunSplit): number => median(xs.map((x) => x[k]));
  console.log("quantity (median of the rounds) | B Hull-White | G BGM | G/B");
  const line = (label: string, k: keyof StochasticRunSplit, unit: "s" | "ms"): void => {
    const b = med(roundsB, k);
    const g = med(roundsG, k);
    const f = (v: number): string => (unit === "s" ? fmtS(v) : v.toFixed(2));
    console.log(`${label} | ${f(b)} | ${f(g)} | ${b > 0 ? (g / b).toFixed(3) + "x" : "n/a"}`);
  };
  line("whole run s", "wholeMs", "s");
  line("fixed cost s (simulation.fixedCostMs)", "fixedCostMs", "s");
  line("environment build less fixed cost s", "envBuildMs", "s");
  line("projection s (whole less fixed cost less environment build)", "projectionMs", "s");
  line("per-path projection ms", "perPathMs", "ms");
  const wholeR = pairedRatios(roundsG.map((x) => x.wholeMs), roundsB.map((x) => x.wholeMs));
  const pathR = pairedRatios(roundsG.map((x) => x.perPathMs), roundsB.map((x) => x.perPathMs));
  console.log(`paired G/B whole run by round: [${wholeR.map((r) => r.toFixed(3)).join(", ")}], median ${median(wholeR).toFixed(3)}x`);
  console.log(`paired G/B per-path projection by round: [${pathR.map((r) => r.toFixed(3)).join(", ")}], median ${median(pathR).toFixed(3)}x`);
  console.log(`warm-up (first in-process call) B: ${JSON.stringify(splitB[0])}`);
  console.log(`warm-up (first in-process call) G: ${JSON.stringify(splitG[0])}`);
  console.log("split ms by call (index 0 is the warm-up):", JSON.stringify({ B: splitB, G: splitG }));
  const cal = resG1.calibration as { source: string; rmseBp?: number; nQuotes?: number; iterations?: number; rmseGateBreached?: boolean };
  console.log(`BGM calibration: source ${cal.source}, rmse ${cal.rmseBp?.toFixed(2)} bp over ${cal.nQuotes} points, ${cal.iterations} iterations, gate breached ${cal.rmseGateBreached}`);
  console.log(`BGM simulation: ${JSON.stringify({ ...resG1.simulation, fixedCostMs: undefined })}`);
  console.log(`stochastic mean EVE B ${resB1.eveDistribution.mean.toFixed(2)}, G ${resG1.eveDistribution.mean.toFixed(2)}; mean NII 12m B ${resB1.nii12mDistribution.mean.toFixed(2)}, G ${resG1.nii12mDistribution.mean.toFixed(2)}`);
}

console.log("\n## Headline numbers");
console.log("quantity | A | B | D | (B-A)/|A| | (D-A)/|A|");
const h1 = (label: string, a: number, b: number, d: number): void =>
  console.log(`${label} | ${a.toFixed(2)} | ${b.toFixed(2)} | ${d.toFixed(2)} | ${rel(b, a)} | ${rel(d, a)}`);
h1("stochastic mean EVE", resA1.eveDistribution.mean, resB1.eveDistribution.mean, meanOf(resD1.eve));
h1("stochastic mean NII 12m", resA1.nii12mDistribution.mean, resB1.nii12mDistribution.mean, meanOf(resD1.nii));
// Since slice two the calibration is a union; arms A and B are Hull-White runs, so a and sigma are read as such.
const hwCal = (r: StochasticRunResult): { a: number; sigma: number } => r.calibration as unknown as { a: number; sigma: number };
console.log(`HW calibration a / sigma: A ${hwCal(resA1).a.toFixed(6)} / ${hwCal(resA1).sigma.toFixed(6)}, B ${hwCal(resB1).a.toFixed(6)} / ${hwCal(resB1).sigma.toFixed(6)}, D ${resD1.a.toFixed(6)} / ${resD1.sigma.toFixed(6)}`);
const eveOf = (r: RunResult, id: string): number => r.eve.byScenario.find((s) => s.scenarioId === id)!.eve;
const niiOf = (r: RunResult, id: string): number => r.nii.byScenario.find((s) => s.scenarioId === id)!.totalNet12;
const h2 = (label: string, a: number, b: number): void => console.log(`${label} | ${a.toFixed(2)} | ${b.toFixed(2)} | n/a | ${rel(b, a)} | n/a`);
h2("deterministic EVE S0", eveOf(resA2, "S0"), eveOf(resB2, "S0"));
h2("deterministic EVE S200", eveOf(resA2, "S200"), eveOf(resB2, "S200"));
h2("deterministic delta EVE S200", eveOf(resA2, "S200") - eveOf(resA2, "S0"), eveOf(resB2, "S200") - eveOf(resB2, "S0"));
h2("deterministic NII 12m S0", niiOf(resA2, "S0"), niiOf(resB2, "S0"));
h2("deterministic NII 12m S200", niiOf(resA2, "S200"), niiOf(resB2, "S200"));
const krA = resA3.eve.keyRate!;
const krB = resB3.eve.keyRate!;
console.log(`KRD knots A ${krA.nodes.length} [${krA.nodes.map((n) => n.tenorYears.toFixed(3)).join(" ")}], B ${krB.nodes.length} [${krB.nodes.map((n) => n.tenorYears.toFixed(3)).join(" ")}]`);
h2("KRD sum (years)", krA.sum, krB.sum);
h2("KRD parallel reference (years)", krA.parallelReference, krB.parallelReference);
console.log(`(checksum ${sink.toPrecision(6)})`);
