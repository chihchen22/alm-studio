/**
 * POST /api/scenarios/preview on a market carrying a curveSetup block (ALM
 * Studio Piece B): the preview shows the curve's quote nodes,
 * not its dense monthly nodes, for the base and the shocked curve alike, and
 * the shift is read node for node on those quote tenors.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { setupFromSnapshot } from "@alm/engine/src/curveBuilder/__tests__/helpers";
import { api, bootTestPlatform, loadTestMarket, type TestPlatform } from "./harness";

let t: TestPlatform;
let market: MarketSnapshot;
beforeAll(async () => {
  t = await bootTestPlatform();
  market = await loadTestMarket();
  const withSetup = { ...market, curveSetup: setupFromSnapshot(market, "log-linear-df") };
  t.platform.context.store.putDocument("market", "market-setup", withSetup, { label: "test market with a curve setup" });
});
afterAll(() => t.close());

type Nodes = { t: number[]; z: number[]; df: number[] };
type Reply = { base: Nodes; shocked: Nodes; shiftBp: number[] };

describe("POST /api/scenarios/preview with a curve setup", () => {
  it("serves quote nodes for base and shocked curves and a 100 bp shift at each", async () => {
    const r = await api<Reply>(t.base, "POST", "/api/scenarios/preview", { marketSnapshot: "market-setup", rateSpec: { kind: "parallel", shockBp: 100 } });
    expect(r.status).toBe(200);
    const want = market.curveQuotes.map((q) => Math.round(q.tYears * 12) / 12);
    expect(r.body.base.t).toEqual(want);
    expect(r.body.shocked.t).toEqual(want);
    expect(r.body.shiftBp).toHaveLength(want.length);
    for (const s of r.body.shiftBp) expect(Math.abs(s - 100)).toBeLessThanOrEqual(1e-9);
  });
});
