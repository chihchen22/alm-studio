/**
 * The two gates run as waterfall listeners, and their checked lines say who
 * checked. A bank's policy plugin appends a failure and vetoes; the built-in
 * listener's report is what it delegated to.
 *
 * The producer set comes from a mounted DEFAULT_PROFILE rather than from the
 * two-row context under test: a context holding only the gate listeners
 * declares no component, so a producer set read off it would fail every stage
 * on T1 and the subject of these tests, the waterfall chain, would never be
 * reached.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Context, mountProfile, type Plugin } from "@alm/harness";
import type { GateReport } from "../../contracts/plan";
import { fixturePlan, loadPolicy } from "../../plan/__tests__/fixtures";
import { baseAssumptions, twoSidedBook } from "../../run/__tests__/fixtures";
import { registryProducers } from "../../plan/compile";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../catalog";
import { routingGatePlugin, typeGatePlugin } from "../gates";

const SEED: GateReport = { passed: true, failures: [], checked: [] };

// Mounted once and unwound at the end: no test in this file leaves a live tree.
const profileCtx = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
const PRODUCERS = registryProducers(profileCtx);
afterAll(() => profileCtx.dispose());

const open: Context[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.dispose();
});

function mounted(extra?: Plugin) {
  const ctx = new Context();
  ctx.mount(typeGatePlugin, undefined, "gate.type");
  ctx.mount(routingGatePlugin, undefined, "gate.routing");
  if (extra) ctx.mount(extra, undefined, "policy");
  ctx.finalize();
  open.push(ctx);
  return ctx;
}

describe("engine.gate.type", () => {
  it("returns a passing report for the fixture plan and stamps its plugin id on every checked line", () => {
    const ctx = mounted();
    const report = ctx.waterfall(
      "plan/type-check",
      { plan: fixturePlan(), portfolioAsOf: twoSidedBook().asOf, producers: PRODUCERS },
      SEED,
    );
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checked.length).toBeGreaterThan(0);
    for (const line of report.checked) expect(line.startsWith("[engine.gate.type] ")).toBe(true);
  });

  it("lets a policy plugin veto by returning without calling next", () => {
    const vetoer: Plugin = {
      id: "acme.policy.no-360",
      apply(ctx) {
        ctx.on(
          "plan/type-check",
          (payload, value) => ({
            passed: false,
            failures: [
              ...value.failures,
              { gate: "type" as const, rule: "T3" as const, stageId: null, detail: `horizon ${payload.plan.grid.horizonMonths} exceeds bank policy` },
            ],
            checked: [...value.checked, "[acme.policy.no-360] horizon policy applied"],
          }),
          { prepend: true },
        );
      },
    };
    const ctx = mounted(vetoer);
    const report = ctx.waterfall(
      "plan/type-check",
      { plan: fixturePlan(), portfolioAsOf: twoSidedBook().asOf, producers: PRODUCERS },
      SEED,
    );
    expect(report.passed).toBe(false);
    expect(report.failures[0]!.detail).toContain("bank policy");
    expect(report.checked.some((l) => l.startsWith("[engine.gate.type]"))).toBe(false);
  });
});

describe("engine.gate.routing", () => {
  it("runs R1 to R4 and stamps its plugin id", () => {
    const ctx = mounted();
    const report = ctx.waterfall(
      "plan/route",
      {
        plan: fixturePlan(),
        policy: loadPolicy(),
        portfolio: twoSidedBook(),
        assumptionSets: [baseAssumptions()],
      },
      SEED,
    );
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    expect(report.passed).toBe(true);
    for (const line of report.checked) expect(line.startsWith("[engine.gate.routing] ")).toBe(true);
  });
});
