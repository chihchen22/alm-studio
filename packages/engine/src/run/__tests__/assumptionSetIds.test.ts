/**
 * Duplicate assumption-set id guard (discovery SDN-OBS-1).
 *
 * Two AssumptionSets sharing an id used to collapse silently into the last one
 * registered, so a scenario referencing that id ran against whichever set was
 * seen last — a silent wrong-assumptions run. The orchestrator now throws a
 * named DuplicateAssumptionSetError at build time. This test pins that: a
 * collision is rejected loudly, and a run with unique ids is unaffected.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import { clearPortfolios } from "../../portfolio/registry";
import { UnknownFamilyError } from "../../scenario";
import { createEngine, DuplicateAssumptionSetError } from "../index";
import { baseAssumptions, loadMarket, makeRunRequest, NMD_DEFAULT_PARAMS, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function freshEngine() {
  clearPortfolios();
  const engine = createEngine();
  engine.loadPortfolio(twoSidedBook());
  return engine;
}

describe("run — duplicate assumption-set id", () => {
  it("throws a named DuplicateAssumptionSetError naming the colliding id", () => {
    const engine = freshEngine();
    // Two sets sharing id "AS-BASE"; the second would silently overwrite the first.
    const dup = { ...baseAssumptions("AS-BASE"), label: "shadow set" };
    const req = makeRunRequest(market, { assumptionSets: [baseAssumptions("AS-BASE"), dup] });

    expect(() => engine.run(req)).toThrow(DuplicateAssumptionSetError);
    expect(() => engine.run(req)).toThrow(/AS-BASE/);
  });

  it("accepts unique assumption-set ids", () => {
    const engine = freshEngine();
    const req = makeRunRequest(market, {
      assumptionSets: [baseAssumptions("AS-BASE"), baseAssumptions("AS-ALT")],
    });
    const result = engine.run(req);
    expect(result.notImplemented).toEqual([]);
  });
});

describe("run: the assumption-set axis is the REFERENCED sets", () => {
  /** The fixture set, plus one binding on a family the COA does not carry. */
  function defectiveSet(id: string): AssumptionSet {
    const bad = baseAssumptions(id);
    bad.bindings.push({
      familyId: "GHOST",
      overlay: { kind: "nmd-decay", params: NMD_DEFAULT_PARAMS },
      modelVersion: "ghost-1",
    });
    return bad;
  }

  it("neither validates nor overlays a set no scenario references", () => {
    // Every fixture scenario references AS-BASE. AS-DEAD is carried on the
    // request and reached by nothing. Before the axis existed, the env-build
    // loop validated it (UnknownFamilyError on GHOST) and the behavioral stage
    // computed a book for it, so a request that ran before the walker existed
    // could newly refuse on a set it never used.
    const engine = freshEngine();
    const req = makeRunRequest(market, {
      assumptionSets: [baseAssumptions("AS-BASE"), defectiveSet("AS-DEAD")],
    });

    const result = engine.run(req);
    expect(result.notImplemented).toEqual([]);

    // And it perturbs nothing: the dead set is absent from the walk, not merely
    // computed and discarded. A stage row cannot show this, because its scope
    // field carries the scope KIND and not the set id, so the comparison is
    // against the same run with the dead set removed.
    const clean = freshEngine().run(
      makeRunRequest(market, { assumptionSets: [baseAssumptions("AS-BASE")] }),
    );
    expect(result.nii).toEqual(clean.nii);
    expect(result.eve).toEqual(clean.eve);
  });

  it("still refuses when a scenario DOES reference the defective set", () => {
    // The positive control: the same set, now on the axis, refuses as it always
    // did. Without this the test above would pass on a build that had simply
    // stopped validating.
    const engine = freshEngine();
    const scenarios = makeRunRequest(market).scenarios.map((s) => ({ ...s, assumptionSetId: "AS-DEAD" }));
    const req = makeRunRequest(market, { assumptionSets: [defectiveSet("AS-DEAD")], scenarios });

    expect(() => engine.run(req)).toThrow(UnknownFamilyError);
  });
});
