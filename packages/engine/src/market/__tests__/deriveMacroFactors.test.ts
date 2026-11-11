// packages/engine/src/market/__tests__/deriveMacroFactors.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { canonicalize } from "../../runtime/contentHash";
import { deriveMarketSnapshot, MarketDerivationError } from "../deriveMarketSnapshot";
import { loadMarket } from "../../run/__tests__/fixtures";

let base: MarketSnapshot;
beforeAll(async () => { base = await loadMarket(); });
const AS_OF = "2026-03"; // the fixture market's calibrationDate is 2026-03-31; restated
const ramp = (end: number) => Array.from({ length: 360 }, (_, i) => 1 + (end - 1) * Math.min(1, (i + 1) / 24));
const setOp = (id: string, values: number[]) => ({
  op: "set-macro-series", id, label: `${id} (authored projection)`, kind: "index", role: "projection",
  unit: "ratio to 2026-03", firstMonth: "2026-04", values, source: { authored: true, note: "Synthetic." },
});
const d = (ops: unknown[]) => deriveMarketSnapshot(base, ops, { baseId: "market-public-2026-03-31" });

describe("set-macro-series and remove-macro-series", () => {
  it("adds a projection, sorted by id, and leaves every other block byte-identical", () => {
    expect(base.calibrationDate.slice(0, 7)).toBe(AS_OF); // the projections below start the month after
    const r = d([setOp("hpi-up-15", ramp(1.15)), setOp("hpi-down-30", ramp(0.7))]);
    const m = r.snapshot as typeof r.snapshot & { macroFactors: Array<{ id: string; values: number[] }> };
    expect(m.macroFactors.map((s) => s.id)).toEqual(["hpi-down-30", "hpi-up-15"]);
    expect(m.macroFactors[0]!.values).toEqual(ramp(0.7)); // stored as given; the seed rounds its own to 12 digits
    const { macroFactors: _m, derivedFrom: _d, ...rest } = m;
    expect(canonicalize(rest)).toBe(canonicalize(base));
    expect(r.macroChanges).toEqual([{ id: "hpi-up-15", change: "added", ops: [0] }, { id: "hpi-down-30", change: "added", ops: [1] }]);
    expect(r.label).toBe("Macro factors on market-public-2026-03-31 (demonstration values)");
  });
  it("a derive with no macro op carries the base block unchanged", () => {
    const withBlock = d([setOp("hpi-flat", new Array(360).fill(1))]).snapshot;
    const r = deriveMarketSnapshot(withBlock, [{ op: "add", value: 10 }], { baseId: "x" });
    expect(canonicalize((r.snapshot as { macroFactors?: unknown }).macroFactors)).toBe(canonicalize((withBlock as { macroFactors?: unknown }).macroFactors));
    expect(r.macroChanges).toEqual([]);
  });
  it("removes a series the market carries and refuses one it does not", () => {
    const withBlock = d([setOp("hpi-flat", new Array(360).fill(1)), setOp("hpi-up-15", ramp(1.15))]).snapshot;
    const r = deriveMarketSnapshot(withBlock, [{ op: "remove-macro-series", seriesId: "hpi-flat" }], { baseId: "y" });
    expect(((r.snapshot as { macroFactors: Array<{ id: string }> }).macroFactors).map((s) => s.id)).toEqual(["hpi-up-15"]);
    expect(r.macroChanges).toEqual([{ id: "hpi-flat", change: "removed", ops: [0] }]);
    try { deriveMarketSnapshot(withBlock, [{ op: "remove-macro-series", seriesId: "nope" }], { baseId: "y" }); expect.unreachable(); }
    catch (e) {
      expect((e as MarketDerivationError).problems[0]!.message).toBe(
        'ops[0]: remove-macro-series names series "nope", which market "y" does not carry at that point in the op list (it carries hpi-flat, hpi-up-15)');
    }
  });
  it("refuses an out-of-bounds projection with the validator's text", () => {
    const v = new Array(360).fill(1); v[3] = 5;
    try { d([setOp("hpi-flat", v)]); expect.unreachable(); }
    catch (e) { expect((e as MarketDerivationError).problems.map((p) => p.message)).toEqual(["macroFactors[0].values[3]: an index projection lies from 0.25 to 4; got 5"]); }
  });
  it("mixes with TLP ops inside the 32-op limit", () => {
    const r = d([{ op: "add", value: 10 }, setOp("hpi-flat", new Array(360).fill(1))]);
    expect(r.label).toBe("Funding spread shock and macro factors on market-public-2026-03-31 (demonstration values)");
  });
});
