/**
 * Typed refusals on malformed scenario payloads.
 *
 * Before this wave, a hand-authored slate scenario missing `newBusiness` (or
 * `rateSpec`, or with `rules` not an array) reached defineScenario's property
 * reads and surfaced a raw JavaScript TypeError ("Cannot read properties of
 * undefined ...") as the 422 message. These tests pin the cure: every refusal
 * is still a 422, but the message names the offending field, what was found,
 * and what was expected — and never leaks TypeError text. Engine-level value
 * refusals (knot ordering, unrecognized kind) stay verbatim, unduplicated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, bootTestPlatform, mirrorStoreNow, warmCatalog, type TestPlatform } from "./harness";

let tp: TestPlatform;

beforeAll(async () => {
  tp = await bootTestPlatform();
});

afterAll(async () => {
  await tp.close();
});

interface ErrReply {
  error: { code: string; message: string };
}

const GOOD_SCENARIO = {
  id: "S0",
  label: "base",
  rateSpec: { kind: "base" },
  assumptionSetId: "set-x",
  newBusiness: { mode: "static", rules: [] },
};

function slate(scenario: unknown): unknown {
  return { id: "slate-shape", label: "shape probe", scenarios: [scenario] };
}

async function post(body: unknown): Promise<{ status: number; body: ErrReply }> {
  return api<ErrReply>(tp.base, "POST", "/api/scenario-slates", body);
}

/** Every shape refusal must read as a practitioner message, not a JS crash. */
function expectTypedRefusal(r: { status: number; body: ErrReply }, field: string): void {
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe("validation");
  expect(r.body.error.message).toContain(field);
  expect(r.body.error.message).toContain("expected");
  expect(r.body.error.message).not.toContain("Cannot read properties");
  expect(r.body.error.message).not.toContain("is not a function");
}

describe("scenario-slate shape refusals", () => {
  it("a well-formed single-base slate still creates (the gate does not over-refuse)", async () => {
    const r = await api<{ id: string }>(tp.base, "POST", "/api/scenario-slates", {
      id: "slate-good",
      label: "good",
      scenarios: [GOOD_SCENARIO],
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe("slate-good");
  });

  it("a saved slate answers on the catalog lineage read with no re-sync", async () => {
    // This file never seeds, so create the database as a boot sync would; the route then advances it.
    mirrorStoreNow(tp.storeRoot);
    await warmCatalog(tp.base);
    const r = await api<{ id: string }>(tp.base, "POST", "/api/scenario-slates", {
      id: "slate-mirror",
      label: "mirror probe",
      scenarios: [GOOD_SCENARIO],
    });
    expect(r.status).toBe(201);
    const lin = await api<{ collection: string; id: string }>(tp.base, "GET", "/api/catalog/lineage/scenario-slates/slate-mirror");
    expect(lin.status).toBe(200);
    expect(lin.body).toMatchObject({ collection: "scenario-slates", id: "slate-mirror" });
  });

  it("refuses a null scenario naming the index", async () => {
    expectTypedRefusal(await post(slate(null)), "scenarios[0]");
  });

  it("refuses a scenario missing newBusiness, naming the field (the old raw-TypeError case)", async () => {
    const { newBusiness: _omitted, ...rest } = GOOD_SCENARIO;
    expectTypedRefusal(await post(slate(rest)), "scenarios[0].newBusiness");
  });

  it("refuses a scenario missing rateSpec, naming the field", async () => {
    const { rateSpec: _omitted, ...rest } = GOOD_SCENARIO;
    expectTypedRefusal(await post(slate(rest)), "scenarios[0].rateSpec");
  });

  it("refuses newBusiness.rules that is not an array (the old '.map is not a function' case)", async () => {
    const bad = { ...GOOD_SCENARIO, newBusiness: { mode: "static", rules: "none" } };
    expectTypedRefusal(await post(slate(bad)), "scenarios[0].newBusiness.rules");
  });

  it("refuses a misspelled newBusiness.mode instead of silently running static", async () => {
    const bad = { ...GOOD_SCENARIO, newBusiness: { mode: "Static", rules: [] } };
    const r = await post(slate(bad));
    expectTypedRefusal(r, "scenarios[0].newBusiness.mode");
    expect(r.body.error.message).toContain('"static" | "dynamic"');
  });

  it("refuses a non-object rule naming its index", async () => {
    const bad = { ...GOOD_SCENARIO, newBusiness: { mode: "static", rules: [null] } };
    expectTypedRefusal(await post(slate(bad)), "scenarios[0].newBusiness.rules[0]");
  });

  it("refuses a missing label naming the field", async () => {
    const { label: _omitted, ...rest } = GOOD_SCENARIO;
    expectTypedRefusal(await post(slate(rest)), "scenarios[0].label");
  });

  it("engine value refusals still surface verbatim (no duplication of the deep gate)", async () => {
    const bad = {
      ...GOOD_SCENARIO,
      rateSpec: {
        kind: "custom",
        shocks: [
          { tenorYears: 5, shockBp: 10 },
          { tenorYears: 3, shockBp: 10 },
        ],
      },
    };
    const r = await post(slate(bad));
    expect(r.status).toBe(422);
    // The engine's CustomShockError message, verbatim through `validated`.
    expect(r.body.error.message).toContain("rateSpec.shocks[1].tenorYears");
    expect(r.body.error.message).toContain("must strictly exceed");
  });

  it("an empty id still refuses through the engine's typed ScenarioSpecError", async () => {
    const bad = { ...GOOD_SCENARIO, id: "" };
    const r = await post(slate(bad));
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("invalid scenario spec at id");
  });
});
