/**
 * The caller's merge duty: compile-time tags reach the envelope exactly once,
 * after the run's own tags, and the input result is not mutated.
 */
import { describe, expect, it } from "vitest";
import { NOT_IMPLEMENTED } from "../../contracts/errors";
import type { RunResult } from "../../contracts/run";
import { makeNotImplemented } from "../../runtime/notImplemented";
import { mergePlanTags } from "../mergePlanTags";

describe("mergePlanTags", () => {
  it("appends only the layers the result does not already carry, and does not mutate the input", () => {
    const own = [
      makeNotImplemented("run.layer.a", "a did not run"),
      makeNotImplemented("plan.stage.st-hw", "already tagged by the run"),
    ];
    const result = { schemaVersion: "1.3.0", notImplemented: own } as unknown as RunResult;
    const merged = mergePlanTags(result, [
      makeNotImplemented("plan.stage.st-hw", "compiler duplicate"),
      makeNotImplemented("plan.balance-plan.unused", "nothing consumed it"),
    ]);

    expect(merged.notImplemented.map((n) => n.layer)).toEqual([
      "run.layer.a",
      "plan.stage.st-hw",
      "plan.balance-plan.unused",
    ]);
    expect(merged.notImplemented).toHaveLength(3);
    expect(merged.notImplemented[1]!.reason).toBe("already tagged by the run");
    expect(merged.notImplemented[2]!._tag).toBe(NOT_IMPLEMENTED);
    expect(merged).not.toBe(result);
    expect(result.notImplemented).toHaveLength(2);
    expect(result.notImplemented).toBe(own);
  });
});
