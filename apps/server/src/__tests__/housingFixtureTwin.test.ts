// apps/server/src/__tests__/housingFixtureTwin.test.ts
/**
 * Studio Piece 7b follow-up (Slice 4 M1): the run-level tests run housingSet,
 * a fixture twin of the seeded housing sets. The twin adds the housing group
 * to every four-factor binding with no family filter; the seed filters to
 * mortgages and mbs. This pins the two equal up to the label, so the twin
 * cannot drift in family scope or values from what the seed stores.
 */
import { describe, expect, it } from "vitest";
import { housingSet } from "@alm/engine/src/run/__tests__/macroFixtures";
import { buildHousingAssumptions } from "../../scripts/seed-store";

const unlabel = (s: object) => { const { label: _l, ...rest } = s as { label?: unknown }; return rest; };

describe("housing fixture twin", () => {
  it("housingSet equals buildHousingAssumptions up to the label, for both seeded series", () => {
    for (const seriesId of ["hpi-down-30", "hpi-flat"] as const) {
      const seeded = buildHousingAssumptions("twin", seriesId, "a label");
      // Power: the seed carries the group on exactly the two mapped families, so equality fixes the twin's scope.
      expect(seeded.bindings.filter((b) => b.overlay.kind === "prepay" && b.overlay.model === "four-factor-cpr" && b.overlay.housing !== undefined).map((b) => b.familyId)).toEqual(["mortgages", "mbs"]);
      expect(unlabel(housingSet("twin", seriesId))).toEqual(unlabel(seeded));
    }
  });
});
