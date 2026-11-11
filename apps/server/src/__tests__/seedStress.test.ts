/**
 * The seeded ILLUSTRATIVE stress assumption set visibly moves a number.
 *
 * The limitations page records the v1 posture: the demo set binds the exact
 * kernel default parameters, so overlays populate provenance but change no
 * headline. That made the show-before-run diff gate look like ceremony. This
 * suite proves the cure end to end on the seeded artifacts themselves:
 *
 *   1. the seed writes a stress set + slate, labeled unmistakably illustrative;
 *   2. the diff between the demo set and the stress set names exactly the
 *      parameters that moved, with from/to values (the pre-run safety net);
 *   3. running the seeded synthetic book under base vs stress assumptions
 *      MOVES base EVE and base NII by a visible amount — the overlay is
 *      load-bearing, not ceremonial.
 *
 * Everything runs from a scratch store seeded by the real seedStore(), so the
 * test exercises what a practitioner actually gets, not a bespoke fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssumptionSet, PortfolioSpec, RunRequest, Scenario } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import { diffAssumptions } from "@alm/ai/src/compiler";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";

const FIXED_STAMP = "2026-08-02T00:00:00.000Z";

interface SlateDoc {
  id: string;
  label: string;
  scenarios: Scenario[];
}

let storeRoot: string;
let store: FileStore;

beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-seed-stress-"));
  store = new FileStore(storeRoot);
  await seedStore(store, repoRoot());
});

afterAll(() => {
  try {
    rmSync(storeRoot, { recursive: true, force: true });
  } catch {
    // Windows file locking (McAfee); the OS temp cleaner owns the leftovers.
  }
});

/** Compose a run request from seeded artifacts, the way routes/runs.ts does. */
function compose(runId: string, slateId: string, setId: string): { request: RunRequest; portfolio: PortfolioSpec } {
  const portfolioMeta = store.getMeta("portfolios", SEED_IDS.syntheticPortfolio);
  const market = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
  const slate = store.getDocument<SlateDoc>("scenario-slates", slateId).doc;
  const set = store.getDocument<AssumptionSet>("assumption-sets", setId).doc;
  const portfolio = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.syntheticPortfolio).doc;
  const request: RunRequest = {
    runId,
    portfolioId: SEED_IDS.syntheticPortfolio,
    marketSnapshot: market,
    scenarios: slate.scenarios,
    assumptionSets: [set],
    grid: { horizonMonths: 360, asOf: portfolioMeta.asOf as string },
    seed: "platform-0",
    timestamps: { startedAt: FIXED_STAMP, finishedAt: FIXED_STAMP },
  };
  return { request, portfolio };
}

/** The engine context exactly as runnerEntry builds it for platform defaults. */
function engineContext() {
  return { ...resolveDefaultContext(), durationMode: "base-only" as const, shards: "auto" as const };
}

describe("seeded stress artifacts", () => {
  it("the stress set and its slate are seeded, labeled illustrative, and bound", () => {
    const setMeta = store.getMeta("assumption-sets", SEED_IDS.stressAssumptions);
    expect(String(setMeta.label)).toMatch(/ILLUSTRATIVE/);
    expect(String(setMeta.label)).toMatch(/NOT calibrated/);
    // Bound through the engine: the bindings hash is engine-filled, never by hand.
    expect(typeof setMeta.bindingsContentHash).toBe("string");

    const demoMeta = store.getMeta("assumption-sets", SEED_IDS.demoAssumptions);
    expect(setMeta.bindingsContentHash).not.toBe(demoMeta.bindingsContentHash);

    const slate = store.getDocument<SlateDoc>("scenario-slates", SEED_IDS.stressSlate).doc;
    expect(slate.label).toMatch(/ILLUSTRATIVE/);
    expect(slate.scenarios.length).toBe(5);
    for (const s of slate.scenarios) {
      expect(s.assumptionSetId).toBe(SEED_IDS.stressAssumptions);
    }
  });

  it("the diff against the demo set names exactly the six parameter moves", () => {
    const demo = store.getDocument<AssumptionSet>("assumption-sets", SEED_IDS.demoAssumptions).doc;
    const stress = store.getDocument<AssumptionSet>("assumption-sets", SEED_IDS.stressAssumptions).doc;
    const diff = diffAssumptions(demo, stress);
    const key = (d: { familyId: string; path: string; from: unknown; to: unknown }): string =>
      `${d.familyId} ${d.path} ${String(d.from)} -> ${String(d.to)}`;
    expect(diff.deltas.map(key).sort()).toEqual(
      [
        "mortgages params.minCpr 2 -> 6",
        "mortgages params.inflection 50 -> 25",
        "mbs params.minCpr 2 -> 6",
        "mbs params.inflection 50 -> 25",
        "dda params.closureSteady 0.75 -> 1.5",
        "dda params.maxRateDecay 3 -> 6",
        "mma params.betaMin 0.45 -> 0.55",
        "mma params.betaMax 0.8 -> 0.95",
      ].sort(),
    );
  });

  it("running base vs stress on the seeded synthetic book VISIBLY moves EVE and NII", () => {
    const base = compose("seed-stress-base", SEED_IDS.demoSlate, SEED_IDS.demoAssumptions);
    const stress = compose("seed-stress-stressed", SEED_IDS.stressSlate, SEED_IDS.stressAssumptions);

    const t0 = performance.now();
    const resultBase = buildRunResult(base.request, base.portfolio, engineContext());
    const resultStress = buildRunResult(stress.request, stress.portfolio, engineContext());
    const ms = Math.round(performance.now() - t0);

    const s0 = (r: typeof resultBase) => r.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    const baseEve = s0(resultBase).eve;
    const stressEve = s0(resultStress).eve;
    const niiBase = resultBase.nii.byScenario.find((s) => s.scenarioId === "S0")!.totalNet12;
    const niiStress = resultStress.nii.byScenario.find((s) => s.scenarioId === "S0")!.totalNet12;

    // "Visibly moves a number": at least 1bp of base EVE and 1bp of 12m NII —
    // far above numerical noise, small enough to stay robust to future seed
    // tweaks. The exact observed magnitudes are logged for the quickstart.
    expect(Math.abs(stressEve - baseEve) / Math.abs(baseEve)).toBeGreaterThan(1e-4);
    expect(Math.abs(niiStress - niiBase) / Math.abs(niiBase)).toBeGreaterThan(1e-4);

    // The +200bp shock must also separate: the stress set's higher betaMax and
    // doubled maxRateDecay bite hardest in the up-shocks.
    const s200 = (r: typeof resultBase) => r.eve.byScenario.find((s) => s.scenarioId === "S200")!;
    expect(s200(resultStress).deltaEveVsBase).not.toBe(s200(resultBase).deltaEveVsBase);

    console.log(
      `[W4-P8 stress-vs-base, seeded synthetic book] base EVE ${baseEve.toFixed(2)} -> ` +
        `stressed ${stressEve.toFixed(2)} (move ${(stressEve - baseEve).toFixed(2)}, ` +
        `${(((stressEve - baseEve) / baseEve) * 100).toFixed(3)}%); ` +
        `12m NII ${niiBase.toFixed(2)} -> ${niiStress.toFixed(2)} ` +
        `(move ${(niiStress - niiBase).toFixed(2)}); two grid runs in ${ms} ms`,
    );
  });
});
