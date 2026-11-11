/**
 * The model convention on a setup, through the parse gate, the compile, the run route's options
 * and the stored context; and the intake table's corrected nmd beta text.
 *
 * Expectations are stated here: the field's three states (absent, "book", "corrected-v1"), the rule that absent stays
 * absent so a setup written before K1 keeps its bytes and id, and the engine's own reading of a plain deposit's beta
 * (no gap ladder reads it), restated from packages/engine/src/gap/gapEngine.ts, not from the override.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { engineOptionsOfSetup } from "../workspaces/setupCompile";
import { runSetupIdOf, standardAlcoSetup } from "../workspaces/standardAlco";
import { resolveEngineOptions } from "../http/routes/runs";
import { pipelineOptionsOf } from "../jobs/pipelineOptions";
import { featureDemos } from "../examples/featureDemos";
import { getCsvColumnContract } from "../intake/columnContract";
import { repoRoot } from "../config";

function alcoBody() {
  const { id: _id, ...body } = standardAlcoSetup("ws-k1");
  return body;
}

describe("the model convention on a run setup (K1)", () => {
  it("a new setup carries corrected-v1, and the demo seeds do too", () => {
    expect(alcoBody().modelConvention).toBe("corrected-v1");
    for (const d of featureDemos(repoRoot())) expect(d.setup.modelConvention, d.id).toBe("corrected-v1");
  });

  it("a setup written before K1 (no field) parses to its own bytes and id, and compiles with no convention", () => {
    const { modelConvention: _drop, ...old } = alcoBody();
    const parsed = parseRunSetup(JSON.parse(JSON.stringify(old)));
    expect("modelConvention" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(old));
    expect(runSetupIdOf(parsed)).toBe(runSetupIdOf(old));
    expect("modelConvention" in engineOptionsOfSetup(parsed)).toBe(false);
  });

  it("both named values round-trip and reach the engine options; any other value is refused by name", () => {
    for (const v of ["book", "corrected-v1"] as const) {
      const parsed = parseRunSetup(JSON.parse(JSON.stringify({ ...alcoBody(), modelConvention: v })));
      expect(parsed.modelConvention).toBe(v);
      expect(engineOptionsOfSetup(parsed).modelConvention).toBe(v);
    }
    expect(() => parseRunSetup({ ...alcoBody(), modelConvention: "corrected" })).toThrow(/modelConvention must be "corrected-v1" .* or "book"/);
  });

  it("the run route stores it only when given, and the pipeline reads it back", () => {
    const none = resolveEngineOptions({}, 360);
    expect("modelConvention" in none).toBe(false);
    expect("modelConvention" in pipelineOptionsOf(none)).toBe(false);
    const named = resolveEngineOptions({ modelConvention: "corrected-v1" }, 360);
    expect(named.modelConvention).toBe("corrected-v1");
    expect(pipelineOptionsOf(named).modelConvention).toBe("corrected-v1");
    expect(() => resolveEngineOptions({ modelConvention: 1 }, 360)).toThrow(/engineOptions.modelConvention must be/);
  });
});

describe("the intake table's nmd beta text (K1 point 5)", () => {
  it("says no gap ladder reads a plain deposit's beta, not the kernel comment's repricing-gap split", () => {
    const nmd = getCsvColumnContract().contracts.find((t) => t.termsType === "nmd")!;
    const beta = nmd.columns.find((c) => c.name === "beta")!;
    expect(beta.doc).toMatch(/No gap ladder reads it/);
    expect(beta.doc).not.toMatch(/repricing-gap split/);
    // Every other type's columns keep the kernel's own comments.
    const nmdb = getCsvColumnContract().contracts.find((t) => t.termsType === "nmd-b")!;
    expect(nmdb.columns.every((c) => !/No gap ladder reads it/.test(c.doc ?? ""))).toBe(true);
  });
});

describe("the stochastic route and the drill route (K1 fix round L7, M1)", () => {
  let t: TestPlatform;
  beforeAll(async () => {
    t = await bootTestPlatform();
  }, 120_000);
  afterAll(() => t.close());

  it("refuses corrected-v1 on a stochastic run, by name, and lets book through the option check", async () => {
    const body = (modelConvention: string) => ({ portfolioId: "p", marketId: "m", scenarioSlateId: "s", assumptionSetIds: ["a"], mode: "stochastic", engineOptions: { modelConvention } });
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/runs", body("corrected-v1"));
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe(
      'engineOptions.modelConvention "corrected-v1" applies to a deterministic run only; the stochastic route keeps the original convention, so drop the option or run deterministic',
    );
    const b = await api<{ error: { message: string } }>(t.base, "POST", "/api/runs", body("book"));
    expect(b.body.error?.message ?? "").not.toMatch(/modelConvention/);
  });

  it("the drill route refuses a malformed convention in words", async () => {
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/instrument/project", { instrument: { portfolioId: "p", positionId: "x" }, marketId: "m", scenarios: { parallelShockBp: 0 }, modelConvention: "k1" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/body.modelConvention must be "corrected-v1"/);
  });
});
