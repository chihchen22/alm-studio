// apps/server/src/__tests__/housingGroupSeeds.test.ts
/**
 * The standing guard of spec v4 Section 6: the optional
 * housing group leaves every stored seeded assumption set valid.
 */
import { describe, expect, it } from "vitest";
import { bindAssumptions } from "@alm/engine/src/scenario";
import { checkOverlayParams } from "@alm/engine/src/contracts/paramSchema";
import { planSeedDocuments } from "../../scripts/seed-store";
import { repoRoot } from "../config";

describe("the optional group leaves every seeded set valid", () => {
  it("every seeded assumption set binds with zero issues", async () => {
    const docs = (await planSeedDocuments(repoRoot())).filter((d) => d.collection === "assumption-sets");
    // Measured when this test was written: the seed wrote seven assumption sets; later housing sets only add to that.
    expect(docs.length).toBeGreaterThanOrEqual(7);
    for (const d of docs) {
      const set = d.doc as Parameters<typeof bindAssumptions>[0];
      expect(() => bindAssumptions(set)).not.toThrow();
      for (const b of set.bindings) if (b.overlay.kind !== "registered") expect(checkOverlayParams(b.overlay)).toEqual([]);
    }
  });
});
