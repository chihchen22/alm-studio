// deriveMacroCarry.test.ts
import { describe, expect, it } from "vitest";
import { MBS_DEFAULTS } from "@alm/kernel";
import { bindAssumptions } from "../bindAssumptions";
import { AssumptionDerivationError, deriveAssumptionSet } from "../deriveAssumptionSet";
const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const mapped = { schemaVersion: "1.0.0", id: "m", label: "m", macroBindings: [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }],
  bindings: [{ familyId: "mbs", modelVersion: "v", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS, housing: H } }] } as never;
const target = { familyId: "mbs", kind: "prepay" };
describe("derive carries macroBindings verbatim", () => {
  it("a behavioral shock keeps the mapping and binds", () => {
    const r = deriveAssumptionSet(mapped, [{ target, path: "params.maxCpr", op: "add", value: 5 }]);
    expect(r.set.macroBindings).toEqual([{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }]);
    expect(() => bindAssumptions(r.set)).not.toThrow();
  });
  it("an op on a group field shocks it", () => {
    const r = deriveAssumptionSet(mapped, [{ target, path: "housing.asOfLtv", op: "set", value: 0.8 }]);
    expect((r.set.bindings[0]!.overlay as { housing: { asOfLtv: number } }).housing.asOfLtv).toBe(0.8);
  });
  it("an op on a group field the binding lacks is refused", () => {
    const plain = { ...(mapped as object), macroBindings: undefined, bindings: [{ familyId: "mbs", modelVersion: "v", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS } }] } as never;
    try { deriveAssumptionSet(plain, [{ target, path: "housing.asOfLtv", op: "set", value: 0.8 }]); expect.unreachable(); }
    catch (e) { expect((e as AssumptionDerivationError).problems[0]!.message).toBe('ops[0]: "housing.asOfLtv" is a field of the optional group House-price response (illustrative), which this binding does not carry'); }
  });
});
