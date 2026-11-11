/**
 * Runnable example: author a custom simulation end to end and print every layer.
 *
 * The operational counterpart: inputs (market
 * snapshot + seeded book), a stressed assumption set pushed through the
 * compile gate (show-before-run diff), a scenario slate mixing the regulatory
 * shock, the same shock under stressed behavior, a twist, and a dynamic
 * new-business rule, then one deterministic run and the readback, including
 * the honest attribution decline on the multi-driver scenarios.
 *
 * From the repo root: `npm run walkthrough` (~9 s at 5,000 positions).
 * Numbers change with the book size and seed; the layers do not.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadMarketSnapshot,
  MBS_DEFAULTS,
  NMD_DEFAULTS,
  BETA_S_CURVE_DEFAULTS,
} from "@alm/kernel";
import {
  createEngine,
  resolveDefaultContext,
  type AssumptionSet,
  type RunRequest,
  type Scenario,
} from "@alm/engine";
import { createAssumptionCompiler } from "@alm/ai";
import { DEFAULT_GENERATOR_CONFIG, generatePortfolio } from "../generate";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET_PATH = resolve(HERE, "../../../packages/kernel/public/market_public.json");
const fmtM = (v: number) => (v / 1e6).toFixed(2).padStart(10) + "M";

async function main() {
  // LAYER 1 - inputs: market snapshot + seeded synthetic book
  const snap = await loadMarketSnapshot(MARKET_PATH);
  const portfolio = generatePortfolio({ ...DEFAULT_GENERATOR_CONFIG, targetPositions: 5000 });
  console.log("=== LAYER 1: INPUTS ===");
  console.log(`portfolio: ${portfolio.positions.length} positions, families=${portfolio.coa.families.map((f) => f.id).join(", ")}`);

  // LAYER 2 - assumption sets: base (kernel defaults) + a stressed candidate
  const base: AssumptionSet = {
    schemaVersion: "1.0.0",
    id: "walk-base-v1",
    label: "Base behavioral set (kernel defaults)",
    bindings: [
      { familyId: "mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS }, modelVersion: "kernel-four-factor-cpr-1" },
      { familyId: "mbs", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS }, modelVersion: "kernel-four-factor-cpr-1" },
      { familyId: "dda", overlay: { kind: "nmd-decay", params: NMD_DEFAULTS }, modelVersion: "kernel-nmd-decay-1" },
      { familyId: "mma", overlay: { kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS }, modelVersion: "kernel-deposit-beta-1" },
    ],
  };

  // The candidate author is where the language model sits in production (the
  // MCP compileAssumptions tool). Here it is a plain function so the example
  // is deterministic: MMA betas +15 points, prepayments at half speed.
  const compiler = createAssumptionCompiler(() => ({
    ...base,
    id: "walk-stressed-v1",
    label: "Stressed: MMA betas +15pts, prepay half speed",
    bindings: base.bindings.map((b) => {
      if (b.familyId === "mma")
        return { ...b, overlay: { kind: "deposit-beta" as const, params: { ...BETA_S_CURVE_DEFAULTS, betaMin: BETA_S_CURVE_DEFAULTS.betaMin + 0.15, betaMax: BETA_S_CURVE_DEFAULTS.betaMax + 0.15 } } };
      if (b.familyId === "mortgages" || b.familyId === "mbs")
        return { ...b, overlay: { kind: "prepay" as const, model: "four-factor-cpr" as const, params: { ...MBS_DEFAULTS, minCpr: MBS_DEFAULTS.minCpr / 2, maxCpr: MBS_DEFAULTS.maxCpr / 2 } } };
      return b;
    }),
  }));
  const compiled = compiler.compile({
    instruction: "MMA betas 15 points higher and prepayments at half speed",
    base,
    families: portfolio.coa.families,
  });
  console.log("\n=== LAYER 2: ASSUMPTION SET, COMPILED (show-before-run) ===");
  console.log(`contentHash: ${compiled.assumptionSet.contentHash}`);
  console.log("rationale:", compiled.rationale);

  // LAYER 3 - scenarios: rate spec + assumption set + new-business strategy
  const scenarios: Scenario[] = [
    { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: base.id, newBusiness: { mode: "static", rules: [] } },
    { id: "S200", label: "Parallel +200bp", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: base.id, newBusiness: { mode: "static", rules: [] } },
    { id: "S200-STRESS", label: "+200bp with stressed behavior", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: compiled.assumptionSet.id, newBusiness: { mode: "static", rules: [] } },
    { id: "TWIST", label: "Steepener +100 short / -50 long, pivot 5y", rateSpec: { kind: "twist", shortBp: 100, longBp: -50, pivotYears: 5 }, assumptionSetId: base.id, newBusiness: { mode: "static", rules: [] } },
    { id: "DYN-FLAT", label: "Base rates, fixed-loans held flat (reinvest)", rateSpec: { kind: "base" }, assumptionSetId: base.id, newBusiness: { mode: "dynamic", rules: [{ familyId: "fixed-loans", reinvest: "flat", spreadOverIndexBp: 50, termMonths: 60 }] } },
  ];
  console.log("\n=== LAYER 3: SCENARIOS ===");
  for (const s of scenarios) console.log(`  ${s.id.padEnd(12)} ${JSON.stringify(s.rateSpec).padEnd(58)} set=${s.assumptionSetId} nb=${s.newBusiness.mode}`);

  // LAYER 4 - the run
  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(portfolio);
  const request: RunRequest = {
    runId: "walkthrough-1",
    portfolioId: portfolio.id,
    marketSnapshot: snap,
    scenarios,
    assumptionSets: [base, compiled.assumptionSet],
    grid: { horizonMonths: 360, asOf: portfolio.asOf },
    seed: "20260717",
    timestamps: { startedAt: "2026-07-17T00:00:00Z", finishedAt: "2026-07-17T00:00:00Z" },
  };
  const t0 = performance.now();
  const result = engine.run(request);
  console.log(`\n=== LAYER 4: RUN === ${(performance.now() - t0).toFixed(0)}ms, provenance.inputsHash=${result.provenance.inputsHash.slice(0, 12)}...`);

  // LAYER 5 - readback
  console.log("\n=== LAYER 5: RESULTS ===");
  console.log("scenario       net NII 12m       EVE          dEVE vs base");
  for (const s of scenarios) {
    const nii = result.nii.byScenario.find((x) => x.scenarioId === s.id);
    const eve = result.eve.byScenario.find((x) => x.scenarioId === s.id);
    console.log(`  ${s.id.padEnd(12)} ${fmtM(nii?.totalNet12 ?? 0)}  ${fmtM(eve?.eve ?? 0)}  ${fmtM(eve?.deltaEveVsBase ?? 0)}`);
  }
  const s200 = result.eve.byScenario.find((x) => x.scenarioId === "S200");
  const s200s = result.eve.byScenario.find((x) => x.scenarioId === "S200-STRESS");
  console.log(`\noverlay impact at +200bp (stressed minus base behavior): ${fmtM((s200s?.eve ?? 0) - (s200?.eve ?? 0))}`);

  console.log("\nexplain(+200, eve):");
  const ex1 = engine.explain({ runId: "walkthrough-1", metric: "eve", scenarioId: "S200" });
  console.log(`  supported=${ex1.supported}: ${ex1.answer.slice(0, 350)}`);
  console.log("\nexplain(+200 stressed, eve)  [rate AND assumptions moved -> must decline]:");
  const ex2 = engine.explain({ runId: "walkthrough-1", metric: "eve", scenarioId: "S200-STRESS" });
  console.log(`  supported=${ex2.supported}: ${ex2.answer.slice(0, 350)}`);
  console.log("\nnotImplemented tags:", JSON.stringify(result.notImplemented ?? []));
}

main().catch((e) => { console.error(e); process.exit(1); });
