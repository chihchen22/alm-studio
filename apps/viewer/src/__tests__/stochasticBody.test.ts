/**
 * The Workbench stochastic submission body: a Hull-White post
 * writes no `model` key, so the server stores no key in request.json; a BGM post names the model.
 * Expected bodies are restated by hand.
 */
import { describe, expect, it } from "vitest";
import { stochasticBodyOf } from "../stochasticBody";

const PICKS = {
  portfolioId: "demo-portfolio",
  marketId: "market-public-2026-03-31",
  scenarioSlateId: "slate-a",
  assumptionSetIds: ["demo-behavioral-v1"],
  nPaths: 256,
};

describe("stochasticBodyOf", () => {
  it("Hull-White 1F: no model key anywhere in the body, the body the Workbench posted before the slice", () => {
    const body = stochasticBodyOf({ ...PICKS, model: "hull-white-1f" });
    expect(body.stochastic).toBeDefined();
    expect("model" in body.stochastic!).toBe(false);
    expect(JSON.stringify(body)).toBe(
      '{"portfolioId":"demo-portfolio","marketId":"market-public-2026-03-31","scenarioSlateId":"slate-a",' +
        '"assumptionSetIds":["demo-behavioral-v1"],"mode":"stochastic","stochastic":{"nPaths":256}}',
    );
  });

  it("BGM: the body carries model bgm-lmm-2f after nPaths", () => {
    const body = stochasticBodyOf({ ...PICKS, nPaths: 64, model: "bgm-lmm-2f" });
    expect(body.mode).toBe("stochastic");
    expect(body.stochastic).toEqual({ nPaths: 64, model: "bgm-lmm-2f" });
    expect(JSON.stringify(body.stochastic)).toBe('{"nPaths":64,"model":"bgm-lmm-2f"}');
    expect("engineOptions" in body).toBe(false);
  });

  it("copies the selection, never sharing the caller's set array", () => {
    const ids = ["a", "b"];
    const body = stochasticBodyOf({ ...PICKS, assumptionSetIds: ids, model: "bgm-lmm-2f" });
    expect(body.assumptionSetIds).toEqual(["a", "b"]);
    expect(body.assumptionSetIds).not.toBe(ids);
  });
});
