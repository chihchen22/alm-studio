/**
 * Run-pipeline wiring for the opt-in EVE analytics.
 *
 *  - OFF BY DEFAULT: a run without the context flags serializes with NO
 *    keyRate / channels keys anywhere in the eve block — the standard grid's
 *    shape is untouched (additive; the cost label means nothing if the
 *    cost is paid silently).
 *  - Opt-in on a clean book: the blocks land, keyRate anchored at the base
 *    scenario with one node per curve node and the bump echoed.
 *  - Regime-amplifier register tag: on a book with a nonzero one-sided regime
 *    amplifier the run COMPLETES, the keyRate block is ABSENT, and the typed
 *    `eve.key-rate.regime-amplifier` tag lands in result.notImplemented naming
 *    the positions (the ftp.seasoned-book pattern); channels are unaffected.
 *  - Determinism: two opt-in runs serialize byte-identically.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapZeroCurve, type MarketSnapshot } from "@alm/kernel";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import {
  fixedPosition,
  loadMarket,
  makeCoa,
  makeRunRequest,
  mortgagePosition,
  nmdBetaPosition,
  twoSidedBook,
} from "./fixtures";
import type { PortfolioSpec } from "../../contracts/position";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function ctx(extra?: Partial<RunPipelineContext>): RunPipelineContext {
  return { ...resolveDefaultContext(), ...extra };
}

/** The fixture book minus the amp-carrying Non-IB NMD (keyRate-clean). */
function cleanBook(): PortfolioSpec {
  return {
    id: "PF-RUN",
    label: "KRD-clean run book",
    asOf: "2026-01-01",
    coa: makeCoa(),
    positions: [
      fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 }),
      mortgagePosition("M1", { notional: 4_000_000, originalBalance: 4_000_000 }),
      nmdBetaPosition("B1", { notional: 2_000_000 }),
    ],
  };
}

describe("run pipeline — opt-in EVE analytics", () => {
  it("emits neither block by default (standard grid untouched)", () => {
    const result = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx());
    expect("keyRate" in result.eve).toBe(false);
    expect("channels" in result.eve).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized.includes('"keyRate"')).toBe(false);
    expect(serialized.includes('"channels"')).toBe(false);
  });

  it("opt-in on a clean book lands both blocks, anchored and echoed", () => {
    const book = cleanBook();
    const result = buildRunResult(
      makeRunRequest(market),
      book,
      ctx({ keyRate: { bumpBp: 10 }, eveChannels: true }),
    );
    expect(result.schemaVersion).toBe("1.13.0");
    const kr = result.eve.keyRate;
    expect(kr).toBeDefined();
    expect(kr!.scenarioId).toBe("S0");
    expect(kr!.bumpBp).toBe(10);
    expect(kr!.nodes).toHaveLength(bootstrapZeroCurve(market).t.length);
    expect(kr!.convergence.converged).toBe(true);
    const ch = result.eve.channels;
    expect(ch).toBeDefined();
    // One row per shocked scenario, request order, none for base.
    expect(ch!.byScenario.map((r) => r.scenarioId)).toEqual(["S100", "S-100", "S200", "S-200"]);
    for (const row of ch!.byScenario) {
      expect(row.projectionDelta + row.discountingDelta + row.interactionResidual).toBe(
        row.totalDelta,
      );
    }
    // No refusal tag on the clean book.
    expect(result.notImplemented.map((t) => t.layer)).not.toContain(
      "eve.key-rate.regime-amplifier",
    );
  }, 120_000);

  it("regime-amplified book: run completes, keyRate absent, typed register tag", () => {
    // twoSidedBook's D1 carries the default Non-IB regimeAlpha 2.0.
    const result = buildRunResult(
      makeRunRequest(market),
      twoSidedBook(),
      ctx({ keyRate: true, eveChannels: true }),
    );
    expect(result.eve.keyRate).toBeUndefined();
    expect(JSON.stringify(result.eve).includes('"keyRate"')).toBe(false);
    const tag = result.notImplemented.find((t) => t.layer === "eve.key-rate.regime-amplifier");
    expect(tag).toBeDefined();
    expect(tag!.reason).toContain("D1");
    // Channels have no node-bump construction and remain live.
    expect(result.eve.channels).toBeDefined();
    // Every other layer ran: the headline EVE and NII blocks are intact.
    expect(result.eve.byScenario).toHaveLength(5);
    expect(result.nii.byScenario).toHaveLength(5);
  }, 120_000);

  it("two opt-in runs serialize byte-identically (determinism)", () => {
    const request = makeRunRequest(market);
    const a = JSON.stringify(
      buildRunResult(request, cleanBook(), ctx({ keyRate: { bumpBp: 10 }, eveChannels: true })),
    );
    const b = JSON.stringify(
      buildRunResult(request, cleanBook(), ctx({ keyRate: { bumpBp: 10 }, eveChannels: true })),
    );
    expect(a).toBe(b);
  }, 240_000);
});
