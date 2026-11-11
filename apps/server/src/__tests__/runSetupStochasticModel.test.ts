/**
 * The guided Simulation step's choice on a run setup: `eve.stochastic.model` is
 * optional and additive. A setup that leaves it out parses to the bytes it always did; one that names a model keeps it;
 * a model the platform does not run is refused naming the field. The deterministic compile reads none of the block,
 * so a setup that carries it still compiles to the same engine options as one without it.
 */
import { describe, expect, it } from "vitest";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { engineOptionsOfSetup } from "../workspaces/setupCompile";
import { standardAlcoSetup } from "../workspaces/standardAlco";
import type { RunSetup } from "../workspaces/types";

function base(): Omit<RunSetup, "id"> {
  const { id: _id, ...alco } = standardAlcoSetup("ws-guided");
  return alco;
}

describe("eve.stochastic.model", () => {
  it("is absent unless written, so a setup without it keeps its bytes", () => {
    const s = base();
    expect(JSON.stringify(parseRunSetup(s))).toBe(JSON.stringify(s));
    const withPaths = { ...s, eve: { ...s.eve, stochastic: { nPaths: 256, seed: "42" } } };
    expect(parseRunSetup(withPaths).eve.stochastic).toEqual({ nPaths: 256, seed: "42" });
  });

  it("keeps a named model, after nPaths and seed", () => {
    const s = base();
    const parsed = parseRunSetup({ ...s, eve: { ...s.eve, stochastic: { nPaths: 64, seed: "7", model: "bgm-lmm-2f" } } });
    expect(JSON.stringify(parsed.eve.stochastic)).toBe('{"nPaths":64,"seed":"7","model":"bgm-lmm-2f"}');
  });

  it("refuses a model the platform does not run, naming the field", () => {
    const s = base();
    expect(() => parseRunSetup({ ...s, eve: { ...s.eve, stochastic: { nPaths: 64, model: "cir" } } })).toThrow(/eve\.stochastic\.model/);
  });

  it("leaves the deterministic engine options unchanged", () => {
    const s = base();
    const withModel = parseRunSetup({ ...s, eve: { ...s.eve, stochastic: { nPaths: 64, seed: "7", model: "hull-white-1f" } } });
    expect(engineOptionsOfSetup(withModel)).toEqual(engineOptionsOfSetup(s));
  });
});
