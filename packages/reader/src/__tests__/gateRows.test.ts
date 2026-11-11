/**
 * The gate-row formatter (harness Plane 4). A gate failure is the
 * server's judgment; the formatter only picks a stage placeholder and carries
 * the detail string verbatim.
 */
import { describe, expect, it } from "vitest";
import { gateRows } from "../format";

describe("gateRows", () => {
  it("renders one row per failure with a dash for plan-wide failures, verbatim detail", () => {
    const rows = gateRows({ passed: false, failures: [
      { gate: "type", rule: "T4", stageId: null, detail: "the dependency graph has a cycle" },
      { gate: "routing", rule: "R1", stageId: "st-decay", detail: 'class "decay" may not feed metric "nii" (policy says none)' },
    ], checked: [] });
    expect(rows).toEqual([
      { gate: "type", rule: "T4", stage: "—", detail: "the dependency graph has a cycle" },
      { gate: "routing", rule: "R1", stage: "st-decay", detail: 'class "decay" may not feed metric "nii" (policy says none)' },
    ]);
  });
  it("returns no rows for a passing report", () => {
    expect(gateRows({ passed: true, failures: [], checked: ["T1 ok"] })).toEqual([]);
  });
});
