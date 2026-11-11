/**
 * POST /api/scenarios/preview. The shift rules are restated here from the spec's Section 2 item
 * 2, never imported from the engine: parallel adds the shift at every node; a
 * twist runs linearly from shortBp at 0y to zero at the pivot and from zero at
 * the pivot to longBp at the longest node; tenor knots interpolate linearly and
 * hold flat beyond the first and last knot. The base curve is compared with the
 * engine's own curve: the route is the code under test and the engine function
 * is the reference the spec names (a recorded exception to the restating rule).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { curveNodesOf } from "@alm/engine";
import { buildBaseCurve } from "@alm/engine/src/scenario";
import type { MarketSnapshot } from "@alm/kernel";
import { api, bootTestPlatform, loadTestMarket, type TestPlatform } from "./harness";

let t: TestPlatform;
let market: MarketSnapshot;
beforeAll(async () => {
  t = await bootTestPlatform();
  market = await loadTestMarket();
  t.platform.context.store.putDocument("market", "market-test", market, { label: "test market" });
});
afterAll(() => t.close());

type Nodes = { t: number[]; z: number[]; df: number[] };
type Reply = { marketSnapshot: string; calibrationDate: string; base: Nodes; shocked: Nodes; shiftBp: number[]; error: { code: string; message: string } };
const preview = (rateSpec: unknown, marketSnapshot: unknown = "market-test") =>
  api<Reply>(t.base, "POST", "/api/scenarios/preview", { marketSnapshot, rateSpec });

/** The public test market's longest par tenor, restated: 30 years. */
const LONGEST = 30;

describe("POST /api/scenarios/preview", () => {
  it("serves the engine's base curve and a parallel shift of 300 bp at every node", async () => {
    const r = await preview({ kind: "parallel", shockBp: 300 });
    expect(r.status).toBe(200);
    expect(r.body.marketSnapshot).toBe("market-test");
    expect(r.body.calibrationDate).toBe(market.calibrationDate);
    expect(r.body.base).toEqual(curveNodesOf(buildBaseCurve(market)));
    expect(r.body.base.t.at(-1)).toBe(LONGEST);
    expect(r.body.shocked.t).toEqual(r.body.base.t);
    r.body.base.z.forEach((z, i) => expect(Math.abs(r.body.shocked.z[i]! - (z + 0.03)), `node ${i}`).toBeLessThanOrEqual(1e-12));
    expect(r.body.shiftBp).toHaveLength(r.body.base.t.length);
    for (const s of r.body.shiftBp) expect(Math.abs(s - 300)).toBeLessThanOrEqual(1e-9);
  });

  it("a twist moves each node by the restated twist rule", async () => {
    const r = await preview({ kind: "twist", shortBp: -50, longBp: 75, pivotYears: 2 });
    expect(r.status).toBe(200);
    const want = (tt: number) => (tt <= 2 ? -50 * (1 - tt / 2) : (75 * (tt - 2)) / (LONGEST - 2));
    r.body.base.t.forEach((tt, i) => expect(Math.abs(r.body.shiftBp[i]! - want(tt)), `${tt}y`).toBeLessThanOrEqual(1e-9));
  });

  it("tenor knots interpolate linearly and hold flat beyond the first and last knot", async () => {
    const r = await preview({ kind: "custom", shocks: [{ tenorYears: 1, shockBp: 25 }, { tenorYears: 5, shockBp: 50 }, { tenorYears: 10, shockBp: -25 }] });
    expect(r.status).toBe(200);
    const want = (tt: number) => {
      if (tt <= 1) return 25;
      if (tt <= 5) return 25 + ((50 - 25) * (tt - 1)) / (5 - 1);
      if (tt <= 10) return 50 + ((-25 - 50) * (tt - 5)) / (10 - 5);
      return -25;
    };
    r.body.base.t.forEach((tt, i) => expect(Math.abs(r.body.shiftBp[i]! - want(tt)), `${tt}y`).toBeLessThanOrEqual(1e-9));
  });

  it("refuses a twist whose pivot lies outside the curve, with the engine's text", async () => {
    const r = await preview({ kind: "twist", shortBp: 0, longBp: 100, pivotYears: 40 });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("must lie strictly inside");
  });

  it("refuses knots out of order, with the engine's text", async () => {
    const r = await preview({ kind: "custom", shocks: [{ tenorYears: 5, shockBp: 10 }, { tenorYears: 1, shockBp: 20 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("must strictly exceed the preceding tenor");
  });

  it("refuses a pivot that is not above zero, with the engine's text", async () => {
    const r = await preview({ kind: "twist", shortBp: 0, longBp: 100, pivotYears: 0 });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("rateSpec.pivotYears");
  });

  it("answers 404 for a market snapshot the store does not hold", async () => {
    const r = await preview({ kind: "parallel", shockBp: 100 }, "market-nope");
    expect(r.status).toBe(404);
    // The store's refusal names the collection and the id; an unrouted path's 404 does not.
    expect(r.body.error.message).toBe('market "market-nope" not found');
  });

  it("answers 400 for a malformed body", async () => {
    const bodies: unknown[] = [
      [1],
      { rateSpec: { kind: "parallel", shockBp: 1 } },
      { marketSnapshot: "", rateSpec: { kind: "parallel", shockBp: 1 } },
      { marketSnapshot: "market-test", rateSpec: "parallel" },
      { marketSnapshot: "market-test", rateSpec: [1] },
    ];
    for (const body of bodies) {
      const r = await api(t.base, "POST", "/api/scenarios/preview", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });
});
