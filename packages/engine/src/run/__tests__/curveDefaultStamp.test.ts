/**
 * The curve default stamp on the two envelopes a run writes.
 *
 *  - RunResult 1.10.0 carries provenance.curveDefault on every run: {kind: "default", version: 2} for an
 *    unmarked market with no setup, {kind: "default", version: 1} for a market marked curveDefault 1,
 *    {kind: "setup", id} for a market carrying a curveSetup block.
 *  - The stochastic envelope 0.2.0 carries the same stamp as an optional top-level field, not hashed (the
 *    envelope has no hash of its own).
 *  - Archived envelopes, a 1.9.0 RunResult and a 0.1.0 stochastic envelope, both without the stamp, still
 *    read through the engine's readers.
 * Every expected value is written out by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { RunResult } from "../../contracts/run";
import type { StochasticRunResult } from "../../contracts/stochastic";
import { clearPortfolios } from "../../portfolio/registry";
import { niiMonthly } from "../../report/niiMonthly";
import { compareStochastic } from "../../report/stochasticCompare";
import { summarizeStochastic } from "../../report/stochasticSummary";
import { setupFromSnapshot } from "../../curveBuilder/__tests__/helpers";
import { buildDemoPortfolio } from "../../../../../data/src/demo/request";
import { createEngine } from "../index";
import { runStochastic } from "../stochastic";
import { loadMarket, makeRunRequest, regulatoryScenarios, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const marked = (m: MarketSnapshot): MarketSnapshot => ({ ...m, curveDefault: 1 }) as MarketSnapshot;
const onSetup = (m: MarketSnapshot): MarketSnapshot =>
  ({ ...m, curveSetup: { ...setupFromSnapshot(m, "cubic-zero"), id: "cs-mine" } }) as MarketSnapshot;

function runOn(m: MarketSnapshot): RunResult {
  clearPortfolios();
  const engine = createEngine();
  engine.loadPortfolio(twoSidedBook());
  return engine.run(makeRunRequest(m));
}

function stochasticOn(m: MarketSnapshot): StochasticRunResult {
  return runStochastic(makeRunRequest(m, { scenarios: regulatoryScenarios().slice(0, 1) }), twoSidedBook(), {
    nPaths: 20,
    modelParams: { a: 0.05, sigma: 0.01, reason: "stamp test" },
  });
}

describe("RunResult 1.10.0 and later carries the curve default stamp", () => {
  it("stamps the envelope 1.13.0 (the stamp arrived at 1.10.0)", () => {
    expect(runOn(market).schemaVersion).toBe("1.13.0");
  });

  it("an unmarked market with no setup reads {kind: default, version: 2}", () => {
    expect(runOn(market).provenance.curveDefault).toEqual({ kind: "default", version: 2 });
  });

  it("a marked market reads {kind: default, version: 1}, with no reason", () => {
    const stamp = runOn(marked(market)).provenance.curveDefault;
    expect(stamp).toEqual({ kind: "default", version: 1 });
    expect(Object.prototype.hasOwnProperty.call(stamp, "reason")).toBe(false);
  });

  it("a market on a setup reads {kind: setup, id}", () => {
    expect(runOn(onSetup(market)).provenance.curveDefault).toEqual({ kind: "setup", id: "cs-mine" });
  });
});

describe("the stochastic envelope 0.2.0 carries the same stamp", () => {
  it("stamps the envelope 0.2.0 and writes the stamp for each route", () => {
    const unmarked = stochasticOn(market);
    // A fresh envelope is 0.3.0; the stamp is unchanged (was 0.2.0).
    expect(unmarked.schemaVersion).toBe("0.3.0");
    expect(unmarked.curveDefault).toEqual({ kind: "default", version: 2 });
    expect(stochasticOn(marked(market)).curveDefault).toEqual({ kind: "default", version: 1 });
    expect(stochasticOn(onSetup(market)).curveDefault).toEqual({ kind: "setup", id: "cs-mine" });
  });
});

describe("archived envelopes without the stamp still read", () => {
  it("a stored 1.9.0 RunResult with no stamp reads through niiMonthly", () => {
    // The public-basis archive; the earlier archives are no longer read.
    const path = fileURLToPath(new URL("./golden/demo-run.public-basis.json", import.meta.url));
    const old = JSON.parse(readFileSync(path, "utf8")) as RunResult;
    expect(old.schemaVersion).toBe("1.9.0");
    expect(old.provenance.curveDefault).toBeUndefined();
    expect(niiMonthly(old, buildDemoPortfolio().coa).kind).toBe("monthly");
  });

  it("a 0.1.0 stochastic envelope with no stamp summarizes and compares against a 0.2.0 one", () => {
    const fresh = stochasticOn(market);
    const { curveDefault: _dropped, ...rest } = fresh;
    const old: StochasticRunResult = { ...rest, schemaVersion: "0.1.0", runId: "old-run" };
    expect(Object.prototype.hasOwnProperty.call(old, "curveDefault")).toBe(false);
    const summary = summarizeStochastic({ envelope: old });
    expect(summary.context.find((r) => r.field === "schemaVersion")?.value).toBe("0.1.0");
    const cmp = compareStochastic({ envelope: old }, { envelope: fresh });
    // The fresh side is 0.3.0 (was 0.2.0).
    expect(cmp.context.find((r) => r.field === "schemaVersion")).toEqual({ field: "schemaVersion", a: "0.1.0", b: "0.3.0", same: false });
    // The distributions are the same numbers: dropping the stamp moved nothing.
    expect(cmp.eveDistribution.rows.every((r) => r.delta === 0)).toBe(true);
  });
});
