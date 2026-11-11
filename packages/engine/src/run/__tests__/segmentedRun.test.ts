/**
 * Piece 2a acceptance (b) and (c): two positions of one family run two decay
 * parameter sets, the base NII moves against the family-wide run, and the same
 * set with the second selector removed is refused naming a position.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { OverlappingBindingError } from "../executorErrors";
import { resolveDefaultContext } from "../engine";
import { buildRunResult } from "../orchestrate";
import {
  baseAssumptions,
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  segmentedAssumptions,
  segmentedNmdBook,
} from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const baseNii = (r: ReturnType<typeof buildRunResult>) =>
  r.nii.byScenario.find((s) => s.scenarioId === "S0")!.byFamily.find((f) => f.familyId === "DDA")!.net12;

describe("segmented deposit book", () => {
  it("(b) the segmented run's DDA base NII differs from the family-wide run's", () => {
    const book = segmentedNmdBook();
    const wide = baseAssumptions("AS-WIDE");
    const seg = segmentedAssumptions();
    const wideRun = buildRunResult(
      makeRunRequest(market, {
        portfolioId: book.id,
        assumptionSets: [wide],
        scenarios: regulatoryScenarios(wide.id),
      }),
      book,
      resolveDefaultContext(),
    );
    const segRun = buildRunResult(
      makeRunRequest(market, {
        portfolioId: book.id,
        assumptionSets: [seg],
        scenarios: regulatoryScenarios(seg.id),
      }),
      book,
      resolveDefaultContext(),
    );
    expect(baseNii(segRun)).not.toBe(baseNii(wideRun));
    expect(Number.isFinite(baseNii(segRun))).toBe(true);
    // The two same-kind DDA bindings are told apart in provenance by their
    // canonical predicate, so neither segment's model version is lost.
    expect(segRun.provenance.modelVersions).toMatchObject({
      'DDA::nmd-decay::{"segment":["rate-shopper"]}': "nmd-fixture-1",
      'DDA::nmd-decay::{"segment":["relationship"]}': "nmd-fixture-relationship-1",
      "MORTGAGE::prepay": "mbs-fixture-1",
    });
  });

  it("(c) with the second selector removed the run is refused naming D1 and nmd-decay", () => {
    const book = segmentedNmdBook();
    const seg = segmentedAssumptions();
    delete (seg.bindings[3] as { selector?: unknown }).selector;
    let err: unknown;
    try {
      buildRunResult(
        makeRunRequest(market, {
          portfolioId: book.id,
          assumptionSets: [seg],
          scenarios: regulatoryScenarios(seg.id),
        }),
        book,
        resolveDefaultContext(),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OverlappingBindingError);
    expect((err as OverlappingBindingError).positionId).toBe("D1");
    expect((err as OverlappingBindingError).kind).toBe("nmd-decay");
  });
});
