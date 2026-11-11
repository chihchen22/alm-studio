// packages/engine/src/market/__tests__/deriveMacroAsOf.test.ts
/**
 * Piece 7b follow-up (mfu-1, final review Slice 1 M4): a base market with no
 * readable calibrationDate and a macro op is a MarketDerivationError (the route's
 * 422), never a TypeError (500). One case per former TypeError site: the base
 * block check and the derived block check. Texts restated by hand.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { deriveMarketSnapshot, MarketDerivationError } from "../deriveMarketSnapshot";
import { loadMarket } from "../../run/__tests__/fixtures";

let base: MarketSnapshot;
beforeAll(async () => { base = await loadMarket(); });
const setOp = (id: string) => ({
  op: "set-macro-series", id, label: `${id} (authored projection)`, kind: "index", role: "projection",
  unit: "ratio to 2026-03", firstMonth: "2026-04", values: new Array(360).fill(1), source: { authored: true, note: "Synthetic." },
});
const TEXT = 'market "m-1" carries no readable calibrationDate, so a macro op has no as-of month to check its series against';
const refusal = (snap: unknown, ops: unknown[]): unknown => {
  try { deriveMarketSnapshot(snap as MarketSnapshot, ops, { baseId: "m-1" }); return null; } catch (e) { return e; }
};

describe("a macro op on a base with no readable calibrationDate", () => {
  it("a base that carries a macro block: refused as a derivation, not a TypeError", () => {
    const withBlock = deriveMarketSnapshot(base, [setOp("hpi-flat")], { baseId: "x" }).snapshot;
    const { calibrationDate: _c, ...bare } = withBlock;
    const e = refusal(bare, [{ op: "remove-macro-series", seriesId: "hpi-flat" }]);
    expect(e).toBeInstanceOf(MarketDerivationError);
    expect((e as MarketDerivationError).problems).toEqual([{ at: "base", message: TEXT }]);
  });
  it("a base with no macro block: refused as a derivation, not a TypeError", () => {
    const e = refusal({ ...base, calibrationDate: 7 }, [setOp("hpi-flat")]);
    expect(e).toBeInstanceOf(MarketDerivationError);
    expect((e as MarketDerivationError).problems).toEqual([{ at: "base", message: TEXT }]);
  });
  it("a derive with no macro op does not read the as-of month", () => {
    const { calibrationDate: _c, ...bare } = base;
    expect(refusal(bare, [{ op: "add", value: 10 }])).toBeNull();
  });
});
