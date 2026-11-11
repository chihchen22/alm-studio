// stackMacro.test.ts
import { describe, expect, it } from "vitest";
import { MBS_DEFAULTS } from "@alm/kernel";
import { bindAssumptions } from "@alm/engine/src/scenario";
import { flattenStack, MacroStackConflictError } from "../stack";
const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const MB = [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }];
const base = { schemaVersion: "1.0.0", id: "b", label: "b", macroBindings: MB, bindings: [{ familyId: "mbs", modelVersion: "v", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS, housing: H } }] } as never;
const layer = (id: string, macroBindings?: unknown) => ({ schemaVersion: "1.0.0", id, label: id, bindings: [], ...(macroBindings ? { macroBindings } : {}) }) as never;
describe("stack and macroBindings", () => {
  it("a stack on a mapped base keeps the mapping, checked through bindAssumptions", async () => {
    const f = await flattenStack(base, [layer("l1")]);
    expect(f.set.macroBindings).toEqual(MB);
    expect(() => bindAssumptions(f.set)).not.toThrow();
  });
  it("an identical layer mapping is fine; a different one refuses naming the sets", async () => {
    await expect(flattenStack(base, [layer("l1", MB)])).resolves.toBeDefined();
    await expect(flattenStack(base, [layer("l2", [{ ...MB[0], seriesId: "hpi-up-15" }])])).rejects.toThrow(new MacroStackConflictError('stack refused: "b", "l2" carry different macro mappings; a stack carries one mapping'));
  });
  it("a layer supplies a mapping the base lacks (Slice 3 M5)", async () => {
    const { macroBindings: _m, ...unmapped } = base as unknown as Record<string, unknown>;
    // Power: the unmapped base on an unmapped layer carries no mapping, so the one below comes from the layer.
    expect("macroBindings" in (await flattenStack(unmapped as never, [layer("l1")])).set).toBe(false);
    const f = await flattenStack(unmapped as never, [layer("l1"), layer("l2", MB)]);
    expect(f.set.macroBindings).toEqual([{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }]);
    expect(() => bindAssumptions(f.set)).not.toThrow();
  });
});
