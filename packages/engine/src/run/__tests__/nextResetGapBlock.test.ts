/**
 * The `nextResetGap` opt-in on the run pipeline.
 * It writes GapResult.nextReset from the run's book and the run's beta at r0,
 * and leaves every other byte alone; a run without the opt-in carries no key.
 *
 * Expected numbers are restated by hand (four-NMD book, betas at r0
 * 0.95 / 0.70 / 0.25): behavioral repricing slices 95 + 17.5 + 2.5 =
 * 115M in 0-1M and core 5 + 7.5 + 7.5 + 50 = 70M;
 * regulatory non-core floaters 50 + 12.5 + 2.5 = 65M in 0-1M and
 * core 115 + 5 = 120M.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { BETA_S_CURVE_DEFAULTS, betaAtRate, type MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { RunRequest } from "../../contracts/run";
import { computeNextResetLadder } from "../../gap/nextResetLadder";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";
import { HYS_A_CURVE, R0, fourNmdBook } from "../../nmd/__tests__/fixtures";

const M = 1_000_000;
let market: MarketSnapshot;
/**
 * The curve-version-1 market (curveDefault: 1). The expected betas at r0 are the
 * spec curves solved at the seeded pack's r0 on curve default version 1; the default curve moves r0 by 7.9e-10
 * (first node at exactly 1/12), which would move every slice off its round figure. Deltas Step 1.
 */
let v1Market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
  v1Market = { ...market, curveDefault: 1 } as MarketSnapshot;
});

function ctx(extra?: Partial<RunPipelineContext>): RunPipelineContext {
  return { ...resolveDefaultContext(), ...extra };
}

const EMPTY_SET: AssumptionSet = { schemaVersion: "1.0.0", id: "AS-NMD", label: "No overlays", bindings: [] };

function nmdRequest(book: PortfolioSpec, set: AssumptionSet = EMPTY_SET): RunRequest {
  return makeRunRequest(v1Market, {
    runId: "RUN-NEXT-RESET",
    portfolioId: book.id,
    scenarios: [
      { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: set.id, newBusiness: { mode: "static", rules: [] } },
    ],
    assumptionSets: [set],
  });
}

const band0 = (r: RunResult) => r.gap.nextReset!.rows.find((x) => x.band === "0-1M")!;

describe("run pipeline: the nextResetGap opt-in (Task 15)", () => {
  it("a run without the opt-in carries no nextReset key, and the opt-in adds only that key", () => {
    const plain = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx());
    expect("nextReset" in plain.gap).toBe(false);
    const opted = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ nextResetGap: true }));
    expect(opted.gap.nextReset).toBeDefined();
    const copy = JSON.parse(JSON.stringify(opted)) as { gap: { nextReset?: unknown } };
    delete copy.gap.nextReset;
    expect(JSON.stringify(copy)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(opted)).not.toMatch(/NaN/);
  });

  it("nextResetGap false is the same as leaving it out", () => {
    const plain = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx());
    const off = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ nextResetGap: false }));
    expect(JSON.stringify(off)).toBe(JSON.stringify(plain));
  });

  it("behavioral: the deposit repricing slices read the run's beta at r0, 115M in 0-1M, core 70M", () => {
    const book = fourNmdBook();
    const r = buildRunResult(nmdRequest(book), book, ctx({ nextResetGap: true }));
    expect(Math.abs(band0(r).liabilities - 115 * M)).toBeLessThan(1e-3);
    expect(Math.abs(r.gap.nextReset!.coreExcluded - 70 * M)).toBeLessThan(1e-3);
    expect(r.gap.nextReset!.uncovered).toEqual([]);
  });

  it("regulatory: the ladder reads the transformed book, 65M in 0-1M, core 120M", () => {
    const book = fourNmdBook();
    const r = buildRunResult(nmdRequest(book), book, ctx({ nextResetGap: true, nmdConvention: "regulatory" }));
    expect(Math.abs(band0(r).liabilities - 65 * M)).toBeLessThan(1e-3);
    expect(Math.abs(r.gap.nextReset!.coreExcluded - 120 * M)).toBeLessThan(1e-3);
  });

  it("on the unmarked public market (curve default 2) both 0-1M slices land within $25 of the version-1 market's round figures", () => {
    // r0 moves 7.9e-10 on the month grid, so beta at r0 sits a hair off the spec values: measured 0.50 dollars
    // (behavioral) and 0.02 dollars (regulatory) off. This keeps the NMD path on the default curve exercised. Deltas Step 1.
    const book = fourNmdBook();
    const onDefault = { ...nmdRequest(book), marketSnapshot: market };
    const beh = buildRunResult(onDefault, book, ctx({ nextResetGap: true }));
    const reg = buildRunResult(onDefault, book, ctx({ nextResetGap: true, nmdConvention: "regulatory" }));
    expect(Math.abs(band0(beh).liabilities - 115 * M)).toBeLessThan(25);
    expect(Math.abs(band0(reg).liabilities - 65 * M)).toBeLessThan(25);
  });

  it("the beta at r0 is the run's effective deposit-beta binding, not the raw terms", () => {
    // The raw book carries the kernel default curve on every nmd-b; the bound overlay gives hys-a the spec curve (0.95 at r0).
    const d = BETA_S_CURVE_DEFAULTS;
    const book = fourNmdBook({ a: d, b: d, ib: d });
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "AS-BETA",
      label: "hys-a beta",
      bindings: [{ familyId: "HYS-A", overlay: { kind: "deposit-beta", params: HYS_A_CURVE }, modelVersion: "t" }],
    };
    const rawBeta = betaAtRate(R0 * 100, d);
    const raw = computeNextResetLadder(book, () => rawBeta);
    const r = buildRunResult(nmdRequest(book, set), book, ctx({ nextResetGap: true }));
    // hys-a moves from the default beta x 100 to 0.95 x 100 in 0-1M; the other two keep the default.
    expect(Math.abs(rawBeta - 0.95)).toBeGreaterThan(0.1);
    const lift = band0(r).liabilities - raw.rows[0]!.liabilities;
    expect(Math.abs(lift - (0.95 - rawBeta) * 100 * M)).toBeLessThan(1e-2);
  });
});
