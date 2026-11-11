/**
 * The BGM model choice through the stochastic route, the child and the
 * stored documents.
 *
 *   - `stochastic.model` is "hull-white-1f" (the default when absent) or "bgm-lmm-2f"; anything else
 *     is a 422 in words. An HW post with no `model` writes no `model` key into request.json, and its
 *     envelope equals the committed HW golden apart from runId and the 0.3.0
 *     schema stamp. An explicit value is stored verbatim.
 *   - A BGM run on the seeded public market lands a 0.3.0 envelope with model bgm-lmm-2f and a 1.2.0
 *     rates.json carrying the BGM fan.
 *   - BGM refusals at the route, before queueing: a lineage carrying a short-rate volatility shock
 *     (decision 84 c sentence, with or without an override, at any link), a lineage that cannot be
 *     followed (naming the model), an empty long-yield surface and a thin default subset (both waived
 *     under a BGM override), an override of the HW shape, an override outside the decision 84 bounds.
 *   - BGM skips the HW at-the-money column check; HW keeps every refusal it had, its ATM refusal
 *     reworded to the words of record.
 *
 * Same-seed BGM envelopes differ only in simulation.fixedCostMs (a wall clock, decision 96); nothing
 * here byte-compares two BGM envelopes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDefaultCalibrationSwaption, type MarketSnapshot } from "@alm/kernel";
import { deriveMarketSnapshot } from "@alm/engine/src/market";
import type { Scenario } from "@alm/engine";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

const BASE_ID = "market-public-2026-03-31";
const SHOCK_ID = "vol-shock-demo-v1";
const SHOCK_SENTENCE =
  "the market carries a short-rate volatility shock, which the BGM model does not read (it calibrates to " +
  "the long-yield surface), so the shock would be silently ignored; run Hull-White on this market, or BGM " +
  "on the unshocked base.";
const HW_OVERRIDE = { a: 0.03, sigma: 0.01, reason: "probe" };
const BGM_OVERRIDE = { a: 0.2, b: 0.1, c: 0.5, d: 0.1, beta: 0.1, volScalar: 1, reason: "probe" };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
  const base = store.getDocument<MarketSnapshot>("market", BASE_ID).doc;
  const put = (id: string, doc: unknown): void => {
    store.putDocument("market", id, doc, { label: id });
  };
  // Hand-built markets (illustrative, built from the public pack in this test only).
  put("bgm-no-long-yield", { ...base, swaptionATMQuotes: [] });
  const subset = base.swaptionATMQuotes.filter(isDefaultCalibrationSwaption);
  const offSubset = base.swaptionATMQuotes.filter((q) => !isDefaultCalibrationSwaption(q));
  put("bgm-thin-subset", { ...base, swaptionATMQuotes: [...subset.slice(0, 5), ...offSubset] });
  put("bgm-no-cap", { ...base, capQuotes: [] });
  put("bgm-orphan", { ...base, derivedFrom: { baseId: "missing-base", baseContentHash: "x", ops: [{ op: "add", value: 1 }] } });
  // A TLP add on top of the seeded volatility shock: the shock is one link up, so only the route's
  // lineage walk sees it (the engine reads the immediate record).
  const shocked = store.getDocument<MarketSnapshot>("market", SHOCK_ID).doc;
  const chained = deriveMarketSnapshot(shocked, [{ op: "add", value: 10 }], { baseId: SHOCK_ID, id: "bgm-chained" });
  store.putDocument("market", "bgm-chained", chained.snapshot, { label: "chained", derivedFromMarketId: SHOCK_ID });
  // A slate whose base scenario asks for dynamic new business.
  const slate = store.getDocument<{ scenarios: Scenario[] }>("scenario-slates", "regulatory-grid-vanilla").doc;
  const dynBase = slate.scenarios
    .filter((s) => s.rateSpec.kind === "base")
    .map((s) => ({ ...s, newBusiness: { mode: "dynamic", rules: [] } }));
  store.putDocument(
    "scenario-slates",
    "bgm-dynamic-base",
    { id: "bgm-dynamic-base", label: "dynamic base", scenarios: dynBase },
    { label: "dynamic base", scenarioCount: dynBase.length },
  );
}, 180_000);
afterAll(() => t.close());

const post = (marketId: string, stochastic: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  api<Json>(t.base, "POST", "/api/runs", {
    portfolioId: "vanilla-book-v1",
    marketId,
    scenarioSlateId: "regulatory-grid-vanilla",
    assumptionSetIds: ["vanilla-empty-v1"],
    mode: "stochastic",
    seed: "42",
    stochastic: { nPaths: 64, ...stochastic },
    ...extra,
  });

const runCount = async (): Promise<number> => (await api<unknown[]>(t.base, "GET", "/api/runs")).body.length;

const waitDone = async (runId: string): Promise<void> => {
  const done = await waitFor(
    () => api<Json>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body),
    (s) => s.state === "done" || s.state === "error",
    240_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
};

/** Submit, expect 202, wait for done, return the run id. */
const runDone = async (marketId: string, stochastic: Record<string, unknown>): Promise<string> => {
  const sub = await post(marketId, stochastic);
  expect(sub.status, JSON.stringify(sub.body)).toBe(202);
  await waitDone(sub.body.runId);
  return sub.body.runId as string;
};

/** Submit, expect 422 with every fragment, and no run queued. */
const refused = async (marketId: string, stochastic: Record<string, unknown>, ...fragments: string[]): Promise<string> => {
  const before = await runCount();
  const r = await post(marketId, stochastic);
  expect(r.status, JSON.stringify(r.body)).toBe(422);
  const message = (r.body as { error: { message: string } }).error.message;
  for (const f of fragments) expect(message).toContain(f);
  expect(await runCount()).toBe(before);
  return message;
};

const requestOf = (runId: string): Json => store.readRunJson<Json>(runId, "request.json");

describe("the model choice", () => {
  it("a BGM post on the seeded public market lands a 0.3.0 envelope with model bgm and a 1.2.0 rates.json with the BGM fan", async () => {
    const sub = await post(BASE_ID, { model: "bgm-lmm-2f" });
    expect(sub.status, JSON.stringify(sub.body)).toBe(202);
    // The cost note names the model and both measured books.
    const note = sub.body.stochastic.costNote as string;
    expect(note).toContain("bgm-lmm-2f");
    expect(note).toContain("471-position");
    expect(note).toContain("2,351-position");
    await waitDone(sub.body.runId);
    const runId = sub.body.runId as string;

    expect(requestOf(runId).stochastic).toEqual({ nPaths: 64, model: "bgm-lmm-2f" });

    const env = (await api<Json>(t.base, "GET", `/api/runs/${runId}/stochastic`)).body;
    expect(env.schemaVersion).toBe("0.3.0");
    expect(env.model).toBe("bgm-lmm-2f");
    expect(env.calibration.source).toBe("long-yield-atm-calibration");
    expect(env.calibration.nQuotes).toBe(28);
    expect(env.simulation.savedTenors).toHaveLength(10);
    expect(env.eveDistribution.nPaths).toBe(64);

    const rates = (await api<Json>(t.base, "GET", `/api/runs/${runId}/rates`)).body;
    expect(rates.schemaVersion).toBe("1.2.0");
    expect(rates.stochastic.model).toBe("bgm-lmm-2f");
    expect(rates.stochastic.nPaths).toBe(64);
    expect(rates.stochastic.times).toHaveLength(360);
    expect(rates.stochastic.mean).toHaveLength(360);
    expect(rates.stochastic.bgm.displacement).toBe(0.05);
    expect(rates.stochastic.bgm.cevBeta).toBe(0.5);
    expect(rates.stochastic.bgm.a).toBe(env.calibration.a);
  }, 300_000);

  it("a post with no model writes no model key and lands the HW golden envelope (runId and schema stamp aside)", async () => {
    const sub = await post(BASE_ID, {});
    expect(sub.status).toBe(202);
    expect(sub.body.stochastic.costNote).toContain("hull-white-1f");
    await waitDone(sub.body.runId);
    const runId = sub.body.runId as string;
    expect(Object.keys(requestOf(runId).stochastic)).toEqual(["nPaths"]);

    const env = (await api<Json>(t.base, "GET", `/api/runs/${runId}/stochastic`)).body;
    expect(env.schemaVersion).toBe("0.3.0");
    expect(env.model).toBe("hull-white-1f");
    expect("simulation" in env).toBe(false);
    const golden = JSON.parse(
      readFileSync(join(repoRoot(), "packages/engine/src/run/__tests__/golden/stochastic-hw-vanilla-64.json"), "utf8"),
    ) as Json;
    const strip = (e: Json): string => JSON.stringify({ ...e, runId: "", schemaVersion: "" });
    expect(strip(env)).toBe(strip(golden));
  }, 300_000);

  it("an explicit hull-white-1f is stored verbatim", async () => {
    const runId = await runDone(BASE_ID, { model: "hull-white-1f" });
    expect(requestOf(runId).stochastic).toEqual({ nPaths: 64, model: "hull-white-1f" });
    const env = (await api<Json>(t.base, "GET", `/api/runs/${runId}/stochastic`)).body;
    expect(env.model).toBe("hull-white-1f");
  }, 300_000);

  it("a model value outside the two is refused in words", async () => {
    await refused(BASE_ID, { model: "sabr" }, "stochastic.model", '"hull-white-1f"', '"bgm-lmm-2f"', '"sabr"');
    await refused(BASE_ID, { model: 42 }, "stochastic.model", "42");
    await refused(BASE_ID, { model: null }, "stochastic.model", "null");
  });
});

describe("BGM refusals and waivers at the route", () => {
  it("BGM on the seeded volatility shock is refused with the shock sentence, with and without an override", async () => {
    const a = await refused(SHOCK_ID, { model: "bgm-lmm-2f" }, SHOCK_SENTENCE, `market "${SHOCK_ID}"`, `base "${BASE_ID}"`);
    const b = await refused(SHOCK_ID, { model: "bgm-lmm-2f", modelParams: BGM_OVERRIDE }, SHOCK_SENTENCE);
    expect(b).toBe(a);
  });

  it("a shock one link up is refused at the route by the lineage walk", async () => {
    await refused("bgm-chained", { model: "bgm-lmm-2f" }, SHOCK_SENTENCE, `(the shock was applied in market "${SHOCK_ID}" on base "${BASE_ID}")`);
  });

  it("a lineage that cannot be followed is refused naming the model, with and without an override", async () => {
    const fragments = ['cannot be followed past "bgm-orphan" (base "missing-base" is not in the store)', "BGM model (bgm-lmm-2f)"];
    await refused("bgm-orphan", { model: "bgm-lmm-2f" }, ...fragments);
    await refused("bgm-orphan", { model: "bgm-lmm-2f", modelParams: BGM_OVERRIDE }, ...fragments);
  });

  it("HW on the seeded volatility shock is still accepted without an override and still refused with one", async () => {
    await runDone(SHOCK_ID, {});
    await refused(SHOCK_ID, { modelParams: HW_OVERRIDE }, `market "${SHOCK_ID}" carries a short-rate volatility shock`);
  }, 300_000);

  it("an override of the HW shape under BGM is refused, and a BGM shape under HW", async () => {
    await refused(BASE_ID, { model: "bgm-lmm-2f", modelParams: HW_OVERRIDE }, "stochastic.modelParams", "bgm-lmm-2f", "volScalar");
    await refused(BASE_ID, { modelParams: BGM_OVERRIDE }, "stochastic.modelParams", "sigma");
    await refused(BASE_ID, { model: "bgm-lmm-2f", modelParams: null }, "stochastic.modelParams");
    await refused(BASE_ID, { modelParams: null }, "stochastic.modelParams");
  });

  it("a BGM override outside the decision 84 bounds is refused naming the field and its range", async () => {
    await refused(BASE_ID, { model: "bgm-lmm-2f", modelParams: { ...BGM_OVERRIDE, c: 0 } }, "stochastic.modelParams.c", "[0.001, 5]");
    await refused(BASE_ID, { model: "bgm-lmm-2f", modelParams: { ...BGM_OVERRIDE, beta: 1.5 } }, "stochastic.modelParams.beta", "[-1, 1]");
    await refused(BASE_ID, { model: "bgm-lmm-2f", modelParams: { ...BGM_OVERRIDE, volScalar: -0.1 } }, "stochastic.modelParams.volScalar", "[0, 2]");
    await refused(BASE_ID, { model: "bgm-lmm-2f", modelParams: { ...BGM_OVERRIDE, a: "x" } }, "stochastic.modelParams.a", "[0, 5]");
    await refused(BASE_ID, { model: "bgm-lmm-2f", modelParams: { ...BGM_OVERRIDE, reason: "" } }, "stochastic.modelParams.reason", "non-empty");
  });

  it("a volScalar 0 override is accepted and recorded as source override", async () => {
    const runId = await runDone(BASE_ID, { model: "bgm-lmm-2f", modelParams: { ...BGM_OVERRIDE, volScalar: 0 } });
    expect(requestOf(runId).stochastic).toEqual({
      nPaths: 64,
      model: "bgm-lmm-2f",
      modelParams: { ...BGM_OVERRIDE, volScalar: 0 },
    });
    const env = (await api<Json>(t.base, "GET", `/api/runs/${runId}/stochastic`)).body;
    expect(env.calibration).toEqual({ source: "override", model: "bgm-lmm-2f", ...BGM_OVERRIDE, volScalar: 0 });
  }, 300_000);

  it("a market with an empty long-yield block is refused at submission, and waived under an override", async () => {
    await refused("bgm-no-long-yield", { model: "bgm-lmm-2f" }, "stochastic run refused", "no long-yield volatility surface");
    await runDone("bgm-no-long-yield", { model: "bgm-lmm-2f", modelParams: BGM_OVERRIDE });
  }, 300_000);

  it("a thin default subset is refused naming the count, and waived under an override", async () => {
    await refused("bgm-thin-subset", { model: "bgm-lmm-2f" }, "holds 5 of the 28 points", "at least 8");
    await runDone("bgm-thin-subset", { model: "bgm-lmm-2f", modelParams: BGM_OVERRIDE });
  }, 300_000);

  it("BGM skips the HW at-the-money column check; HW refuses it in the words of record", async () => {
    await refused("bgm-no-cap", {}, "at-the-money column", "short-rate volatility surface", "stochastic.modelParams");
    await runDone("bgm-no-cap", { model: "bgm-lmm-2f" });
  }, 300_000);

  it("BGM refuses a base scenario with dynamic new business before queueing", async () => {
    const before = await runCount();
    const r = await api<Json>(t.base, "POST", "/api/runs", {
      portfolioId: "vanilla-book-v1",
      marketId: BASE_ID,
      scenarioSlateId: "bgm-dynamic-base",
      assumptionSetIds: ["vanilla-empty-v1"],
      mode: "stochastic",
      seed: "42",
      stochastic: { nPaths: 64, model: "bgm-lmm-2f" },
    });
    expect(r.status).toBe(422);
    expect((r.body as { error: { message: string } }).error.message).toContain("dynamic new business");
    expect(await runCount()).toBe(before);
  });
});
