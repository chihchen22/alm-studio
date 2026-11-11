/**
 * `nmdConvention: "regulatory"` applies
 * the deposit-convention transform at run entry, so every block runs on the
 * transformed book, and the result records the convention and the
 * child-to-parent map.
 *
 * Expected numbers are restated from the plan and the capstone digest
 * (regulatory 1Y cumulative repricing gap: only the three non-core floaters,
 * 50 + 12.5 + 2.5 = 65M; behavioral: the beta slices at month 1,
 * 0.95 x 100 + 0.70 x 25 + 0.25 x 10 = 115M). The parents carry
 * zero decay so the behavioral locked slices run off at month 360, outside the
 * first year; the regulatory children do not depend on that choice.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { BETA_S_CURVE_DEFAULTS, NMD_B_TERMS_DEFAULTS, type MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { PortfolioSpec } from "../../contracts/position";
import type { GapLadder, RunResult } from "../../contracts";
import type { RunRequest } from "../../contracts/run";
import { defaultHarness } from "../../plugins/defaultHarness";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";
import { CHECKING_IB_CURVE, HYS_A_CURVE, HYS_B_CURVE, R0, fourNmdBook } from "../../nmd/__tests__/fixtures";

const M = 1_000_000;
let market: MarketSnapshot;
/**
 * The curve-version-1 market. The spec beta curves were solved so beta(r0) is 0.95, 0.70 and 0.25 at the seeded pack's r0,
 * which a market marked curveDefault: 1 builds on curve default version 1. The default curve
 * moves r0 by 7.9e-10 (first node at exactly 1/12), which would move every slice off its round figure, so these runs
 * carry that marker. Deltas Step 1.
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

function request(book: PortfolioSpec, set: AssumptionSet = EMPTY_SET): RunRequest {
  return makeRunRequest(v1Market, {
    runId: "RUN-REG",
    portfolioId: book.id,
    scenarios: [
      { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: set.id, newBusiness: { mode: "static", rules: [] } },
    ],
    assumptionSets: [set],
  });
}

function ladder(result: RunResult, kind: "repricing" | "liquidity"): GapLadder {
  return result.gap[kind].find((l) => l.scenarioId === "S0")!;
}
function cumulative1y(result: RunResult): number {
  return ladder(result, "repricing").rows.find((r) => r.band.label === "6-12M")!.cumulativeGap;
}
function liabilitiesIn(result: RunResult, band: string): number {
  return ladder(result, "liquidity").rows.find((r) => r.band.label === band)!.liabilities;
}

describe("run pipeline: regulatory deposit convention (spec E2)", () => {
  it("the version-1 market's base path (curveDefault: 1) reads r0 = 0.037111877541 at step 0 (precondition of the margins)", () => {
    const h = defaultHarness();
    const path = h.get("ratePaths").get("deterministic")(
      h.get("curves").build(v1Market),
      { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "x", newBusiness: { mode: "static", rules: [] } },
      12,
    );
    expect(Math.abs(path.rateAt(0) - R0)).toBeLessThan(1e-9);
  });

  it("records the convention and a 44-key parentOf, and the 1Y cumulative repricing gap is -65M", () => {
    const book = fourNmdBook();
    const result = buildRunResult(request(book), book, ctx({ nmdConvention: "regulatory" }));
    expect(result.nmdConvention).toBe("regulatory");
    expect(Object.keys(result.parentOf!)).toHaveLength(44);
    expect(result.parentOf!["hys-a-core-1"]).toBe("hys-a");
    expect(result.parentOf!["checking-nib-noncore"]).toBe("checking-nib");
    expect(Math.abs(cumulative1y(result) - -65 * M)).toBeLessThan(1e-3);
  });

  it("the behavioral run on the same book reads -115M and carries no parentOf", () => {
    const book = fourNmdBook();
    const result = buildRunResult(request(book), book, ctx({ nmdConvention: "behavioral" }));
    expect(result.nmdConvention).toBe("behavioral");
    expect("parentOf" in result).toBe(false);
    expect(Math.abs(cumulative1y(result) - -115 * M)).toBeLessThan(1e-3);
  });

  it("the regulatory liquidity ladder still carries every rung's principal at its month", () => {
    const book = fourNmdBook();
    const result = buildRunResult(request(book), book, ctx({ nmdConvention: "regulatory" }));
    // One rung of each book: 5 + 1.25 + 0.75 + 4.5 = 11.5M.
    const rung = 11.5 * M;
    // Month 1: the four non-core slices, 50 + 12.5 + 2.5 + 5 = 70M.
    expect(liabilitiesIn(result, "0-1M")).toBeCloseTo(70 * M, 0);
    expect(liabilitiesIn(result, "1-3M")).toBe(0);
    expect(liabilitiesIn(result, "3-6M")).toBeCloseTo(rung, 0); // month 6
    expect(liabilitiesIn(result, "6-12M")).toBe(0);
    expect(liabilitiesIn(result, "1-2Y")).toBeCloseTo(rung, 0); // month 18
    expect(liabilitiesIn(result, "2-3Y")).toBeCloseTo(rung, 0); // month 30
    expect(liabilitiesIn(result, "3-5Y")).toBeCloseTo(2 * rung, 0); // months 42, 54
    expect(liabilitiesIn(result, "5-10Y")).toBeCloseTo(5 * rung, 0); // months 66 to 114
    expect(liabilitiesIn(result, "10Y+")).toBe(0);
  });

  it("reads the overlaid beta curve at r0 and leaves the frozen children untouched by the family overlays", () => {
    // Raw positions carry the kernel default curve; the set's deposit-beta overlay
    // carries the spec curves, and an nmd-decay overlay with live runoff sits on
    // every family. With the raw curve checking-ib would read beta near 0.6 and
    // split 50/50 (1Y gap -67.5M); with the overlay it splits 75/25.
    const raw = { a: BETA_S_CURVE_DEFAULTS, b: BETA_S_CURVE_DEFAULTS, ib: BETA_S_CURVE_DEFAULTS };
    const book = fourNmdBook(raw);
    const decay = NMD_B_TERMS_DEFAULTS.nmdParams;
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "AS-NMD",
      label: "Spec beta curves and a live decay",
      bindings: [
        { familyId: "HYS-A", overlay: { kind: "deposit-beta", params: HYS_A_CURVE }, modelVersion: "t" },
        { familyId: "HYS-B", overlay: { kind: "deposit-beta", params: HYS_B_CURVE }, modelVersion: "t" },
        { familyId: "CHECKING-IB", overlay: { kind: "deposit-beta", params: CHECKING_IB_CURVE }, modelVersion: "t" },
        { familyId: "HYS-A", overlay: { kind: "nmd-decay", params: decay }, modelVersion: "t" },
        { familyId: "HYS-B", overlay: { kind: "nmd-decay", params: decay }, modelVersion: "t" },
        { familyId: "CHECKING-IB", overlay: { kind: "nmd-decay", params: decay }, modelVersion: "t" },
        { familyId: "CHECKING-NIB", overlay: { kind: "nmd-decay", params: decay }, modelVersion: "t" },
      ],
    };
    const result = buildRunResult(request(book, set), book, ctx({ nmdConvention: "regulatory" }));
    expect(Math.abs(cumulative1y(result) - -65 * M)).toBeLessThan(1e-3);
    expect(liabilitiesIn(result, "3-6M")).toBeCloseTo(11.5 * M, 0);
    expect(liabilitiesIn(result, "6-12M")).toBe(0);
  });

  it("a run without the field carries neither key, and the behavioral convention changes no other byte", () => {
    const plain = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx());
    expect("nmdConvention" in plain).toBe(false);
    expect("parentOf" in plain).toBe(false);
    const behavioral = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx({ nmdConvention: "behavioral" }));
    const { nmdConvention, ...rest } = behavioral;
    expect(nmdConvention).toBe("behavioral");
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
  });

  it("a regulatory run on a book with no deposits records the convention, writes no parentOf, and moves no number", () => {
    const loans: PortfolioSpec = { ...twoSidedBook(), positions: twoSidedBook().positions.filter((p) => p.terms.type === "fixed-loan") };
    const req = makeRunRequest(market);
    const plain = buildRunResult(req, loans, ctx());
    const regulatory = buildRunResult(req, loans, ctx({ nmdConvention: "regulatory" }));
    expect(regulatory.nmdConvention).toBe("regulatory");
    expect("parentOf" in regulatory).toBe(false);
    const { nmdConvention: _n, ...rest } = regulatory;
    void _n;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
  });

  it("two regulatory runs serialize byte-identically", () => {
    const book = fourNmdBook();
    const a = buildRunResult(request(book), book, ctx({ nmdConvention: "regulatory" }));
    const b = buildRunResult(request(book), fourNmdBook(), ctx({ nmdConvention: "regulatory" }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
