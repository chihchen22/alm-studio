// packages/engine/src/scenario/__tests__/macroBindings.test.ts
import { describe, expect, it } from "vitest";
import { MBS_DEFAULTS } from "@alm/kernel";
import { contentHash } from "../../runtime/contentHash";
import { assembleProvenance } from "../../provenance/assembleProvenance";
import { bindAssumptions } from "../bindAssumptions";
import { AssumptionValidationError } from "../assumptionValidationError";
import { MacroMappingError } from "../macroBindings";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const ff = (familyId: string, housing = true) => ({ familyId, modelVersion: "v", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS, ...(housing ? { housing: H } : {}) } });
const set = (extra: object = {}) => ({ schemaVersion: "1.0.0", id: "s", label: "s", bindings: [ff("mortgages"), ff("mbs")], ...extra }) as never;
const mb = (familyId: string, seriesId = "hpi-down-30") => ({ seriesId, feeder: "prepay-housing", familyId });
const err = (s: unknown) => { try { bindAssumptions(s as never); return null; } catch (e) { return e as Error; } };

describe("macroBindings at bind (A7, F2, F7)", () => {
  it("no mapping: the hash is the bindings hash, unchanged", () => {
    const s = set();
    expect(bindAssumptions(s).contentHash).toBe(contentHash((s as { bindings: unknown }).bindings));
  });
  it("a mapping moves the hash and is hashed with the bindings", () => {
    const s = set({ macroBindings: [mb("mortgages"), mb("mbs")] });
    expect(bindAssumptions(s).contentHash).toBe(contentHash({ bindings: (s as { bindings: unknown }).bindings, macroBindings: [mb("mortgages"), mb("mbs")] }));
  });
  it("refuses an empty list", () => {
    const e = err(set({ macroBindings: [] }));
    expect(e).toBeInstanceOf(MacroMappingError);
    expect(e!.message).toBe("invalid assumption set at macroBindings: must be a non-empty list; omit the field for a set with no mapping");
  });
  it("refuses an unknown feeder, a duplicate target, two series, and a family without the group", () => {
    expect(err(set({ macroBindings: [{ ...mb("mbs"), feeder: "volumes" }] }))!.message).toBe('invalid assumption set at macroBindings[0].feeder: unknown feeder "volumes"; the one feeder is "prepay-housing"');
    expect(err(set({ macroBindings: [mb("mbs"), mb("mbs")] }))!.message).toBe('invalid assumption set at macroBindings[1]: maps family "mbs" twice');
    expect(err(set({ macroBindings: [mb("mbs"), mb("mortgages", "hpi-up-15")] }))!.message).toBe("invalid assumption set at macroBindings: maps 2 series (hpi-down-30, hpi-up-15); a run reads one series in 7b");
    const noGroup = { schemaVersion: "1.0.0", id: "s", label: "s", bindings: [ff("mbs", false)], macroBindings: [mb("mbs")] };
    expect(err(noGroup)!.message).toBe('invalid assumption set at macroBindings[0]: maps family "mbs" to the house-price response, but its four-factor prepay binding carries no housing group');
  });
  it("a partial group is a MacroMappingError", () => {
    const { turnoverCprFloor: _x, ...part } = H;
    const s = { schemaVersion: "1.0.0", id: "s", label: "s", bindings: [{ ...ff("mbs"), overlay: { ...ff("mbs").overlay, housing: part } }] };
    expect(err(s)).toBeInstanceOf(MacroMappingError);
  });
  it("housing on constant CPR and a floor above minCpr are MacroMappingError at bind (Slice 3 M6)", () => {
    const one = (overlay: object) => ({ schemaVersion: "1.0.0", id: "s", label: "s", bindings: [{ familyId: "mbs", modelVersion: "v", overlay }] });
    const cc = err(one({ kind: "prepay", model: "constant-cpr", annualCpr: 0.06, housing: H }));
    expect(cc).toBeInstanceOf(MacroMappingError);
    expect(cc!.message).toBe("invalid assumption set at bindings[0].overlay.housing: House-price response (illustrative) applies to the four-factor CPR only");
    // MBS_DEFAULTS.minCpr is 2 (percent CPR), so a 2.5 floor sits above it.
    const fl = err(one({ kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS, housing: { ...H, turnoverCprFloor: 2.5 } }));
    expect(fl).toBeInstanceOf(MacroMappingError);
    expect(fl!.message).toBe("invalid assumption set at bindings[0].overlay.housing.turnoverCprFloor: Turnover CPR floor must be at most the minimum CPR");
    // Power: a defect outside the housing group is the plain AssumptionValidationError, so the class is what the two above assert.
    const plain = err(one({ kind: "prepay", model: "constant-cpr", annualCpr: 2 }));
    expect(plain).toBeInstanceOf(AssumptionValidationError);
    expect(plain).not.toBeInstanceOf(MacroMappingError);
  });
  it("provenance's per-set hash sees the mapping (F2)", () => {
    const b = set({ macroBindings: [mb("mortgages")] }) as { bindings: unknown };
    const request = { runId: "r", portfolioId: "p", marketSnapshot: {}, scenarios: [], assumptionSets: [b], grid: { horizonMonths: 12 }, seed: "1", timestamps: {} } as never;
    const prov = assembleProvenance(request, { id: "p" } as never, { engineVersion: "t", kernel: {} } as never);
    expect(prov.assumptionSets[0]!.hash).toBe(contentHash({ bindings: b.bindings, macroBindings: [mb("mortgages")] }));
  });
});
