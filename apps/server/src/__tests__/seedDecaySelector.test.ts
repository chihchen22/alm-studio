// apps/server/src/__tests__/seedDecaySelector.test.ts
/**
 * The seeded synthetic plans' decay stage selects dda AND mma, so an
 * assumption set that binds mma nmd-decay (liquidity-stress-demo-v1, or a
 * saved stack carrying it) has a licensee and runs on the seeded plan.
 *
 * The widening must move no number under the demo set: a behavioral stage
 * applies only the bindings it licenses, and demo-behavioral-v1 binds no mma
 * decay. The parity test runs the seeded plan against the same plan with the
 * selector restated as dda only, and compares every result block.
 *
 * Expected selectors are restated here, never read from seedRunPlans.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunPlan, RunResult } from "@alm/engine";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

const TERMINAL = ["done", "error", "cancelled", "interrupted"];
const finished = (runId: string, ms: number) =>
  waitFor(() => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body), (s) => TERMINAL.includes(s.state), ms);

async function runToResult(plan: RunPlan, label: string): Promise<RunResult> {
  const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan, label });
  expect(r.status).toBe(202);
  expect((await finished(r.body.runId, 600_000)).state).toBe("done");
  return (await api<RunResult>(t.base, "GET", `/api/runs/${r.body.runId}/result`)).body;
}

describe("seeded decay stage covers mma", () => {
  for (const id of ["plan-synthetic-2500-v1", "plan-synthetic-2500-hedged-v1"]) {
    it(`${id}: st-decay selects dda and mma for the decay class`, async () => {
      const plan = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${id}`)).body;
      expect(plan.stages.find((s) => s.id === "st-decay")?.selector).toEqual({ productFamily: ["dda", "mma"], behavioralClasses: "decay" });
    });
  }

  it("under the demo set, the widened selector moves no number (base scenario, dda-only selector restated)", async () => {
    const seeded = (await api<RunPlan>(t.base, "GET", "/api/run-plans/plan-synthetic-2500-v1")).body;
    const baseOnly = (p: RunPlan, planId: string): RunPlan => ({
      ...p,
      planId,
      scenarios: p.scenarios.filter((s) => "ref" in s && s.ref === "regulatory-grid-v1#S0"),
    });
    const wide = baseOnly(seeded, "plan-synthetic-2500-v1-wide");
    const narrow = baseOnly(seeded, "plan-synthetic-2500-v1-narrow");
    narrow.stages = narrow.stages.map((s) => (s.id === "st-decay" ? { ...s, selector: { productFamily: "dda", behavioralClasses: "decay" } } : s));
    expect(wide.scenarios.length).toBe(1);

    const a = await runToResult(narrow, "decay selector parity: dda only");
    const b = await runToResult(wide, "decay selector parity: dda and mma");
    expect(a.nii.byScenario.length).toBe(1);
    // Two different plans ran, so an equal result is a finding, not one run read twice.
    expect(a.provenance.planId).toBe("plan-synthetic-2500-v1-narrow");
    expect(b.provenance.planId).toBe("plan-synthetic-2500-v1-wide");
    expect(typeof a.provenance.planHash).toBe("string");
    expect(b.provenance.planHash).not.toBe(a.provenance.planHash);
    for (const block of ["cashflows", "nii", "eve", "gap", "ftp", "attribution", "notImplemented"] as const) {
      expect(b[block], block).toEqual(a[block]);
    }
  }, 1_300_000);
});
