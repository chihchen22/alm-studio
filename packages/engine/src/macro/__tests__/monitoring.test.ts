// packages/engine/src/macro/__tests__/monitoring.test.ts
// Section 13: three pinned checks fail loudly and are re-pinned only with a recorded hand check. This test pins that
// the three guards exist and name the trigger in their header, so a deletion or a silent re-pin is visible.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
describe("monitoring triggers", () => {
  it("A2 mirror parity names the re-vendor trigger", () => { expect(read("./housingMortgage.test.ts")).toContain("re-vendor"); });
  it("A4 WAL names the market or seed refresh trigger", () => {
    expect(read("../../run/__tests__/housingEveDirection.test.ts")).toContain("market or seed refresh");
  });
  // The A5 golden trigger lives in the golden README, which stays private: monitoringGoldenReadme.test.ts.
  it("the kernel mirror note names the mirror and both A2 guards (DIVERGENCE.md: PROVENANCE.md bytes are hashed into every run)", () => {
    const note = read("../../../../kernel/DIVERGENCE.md");
    for (const s of ["## Engine mirrors of kernel code", "packages/engine/src/macro/housingMortgage.ts", "housingMortgage.test.ts", "housingFlatIdentity.test.ts", "re-vendor"]) expect(note).toContain(s);
  });
  it("history alignment names the as-of trigger", () => {
    expect(read("../../../../../apps/server/src/__tests__/macroHistoryAlignment.test.ts")).toContain("as-of move");
  });
});
