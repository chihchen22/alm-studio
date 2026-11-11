/**
 * Rate documents on a dense-node curve:
 * curveNodesOf emits the curve's quote tenors with z read off the curve at
 * each, so a setup built on 360 dense nodes still reports its quote nodes. A
 * curve with no registration reports its own nodes exactly as before.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { buildBaseCurve, shockedCurve } from "../../scenario/rateEnvironment";
import { quoteTenorsOf } from "../../curveBuilder";
import { setupFromSnapshot } from "../../curveBuilder/__tests__/helpers";
import type { MarketWithCurveSetup } from "../../contracts/curveSetup";
import { loadMarket, makeRunRequest } from "../../run/__tests__/fixtures";
import { buildRateDocument, curveNodesOf } from "../rateDocument";

let market: MarketSnapshot;
let withSetup: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
  withSetup = { ...market, curveSetup: setupFromSnapshot(market, "log-linear-df") } as MarketWithCurveSetup;
});

describe("curveNodesOf on a dense curve", () => {
  it("emits the quote tenors with z read off the curve and df = exp(-z t)", () => {
    const curve = buildBaseCurve(withSetup);
    expect(curve.t.length).toBeGreaterThan(market.curveQuotes.length);
    const nodes = curveNodesOf(curve);
    expect(nodes.t).toEqual(quoteTenorsOf(curve));
    expect(nodes.t).toHaveLength(market.curveQuotes.length);
    nodes.t.forEach((t, i) => {
      expect(nodes.z[i]).toBe(curve.zeroRate(t));
      expect(nodes.df[i]).toBe(Math.exp(-nodes.z[i]! * t));
    });
  });

  it("a curve with no registration keeps its own t and z arrays, element for element", () => {
    // The kernel bootstrap (curveDefault: 1) is the curve with no registration; the platform default now registers
    // its quote tenors like a setup does (deltas Step 1).
    const curve = buildBaseCurve({ ...market, curveDefault: 1 } as MarketSnapshot);
    expect(quoteTenorsOf(curve)).toEqual([...curve.t]);
    const nodes = curveNodesOf(curve);
    expect(nodes.t).toHaveLength(curve.t.length);
    nodes.t.forEach((t, i) => expect(Object.is(t, curve.t[i])).toBe(true));
    nodes.z.forEach((z, i) => expect(Object.is(z, curve.z[i])).toBe(true));
    for (const spec of [{ kind: "parallel", shockBp: 200 }, { kind: "twist", shortBp: 50, longBp: -50, pivotYears: 3 }] as const) {
      const shocked = shockedCurve(curve, spec);
      const n = curveNodesOf(shocked);
      n.z.forEach((z, i) => expect(Object.is(z, shocked.z[i]), `${spec.kind} node ${i}`).toBe(true));
    }
  });

  it("the rate document of a setup-bearing run reports quote nodes for the base and every scenario", () => {
    const doc = buildRateDocument(makeRunRequest(withSetup), { runId: "RUN-QT", mode: "deterministic" });
    const want = quoteTenorsOf(buildBaseCurve(withSetup));
    expect(doc.base.t).toEqual(want);
    expect(doc.scenarios.length).toBeGreaterThan(0);
    for (const s of doc.scenarios) expect(s.curve.t, s.scenarioId).toEqual(want);
  });
});
