// apps/studio/src/__tests__/guidedSteps.test.ts
/**
 * The guided path's readiness-to-step mapping (S2a spec point 2). Every readiness report here is written by hand in
 * the server's shape, and every expected state and sentence is the one the mapping table states, worked from the
 * item states, never read back from stepStates.
 */
import { describe, expect, it } from "vitest";
import type { ReadinessItem, ReadinessReport, ReadinessState, RunSetup } from "@alm/reader";
import { GUIDED_SLOT, nextStep, stepStates } from "../guided/steps";
import { guidedSetupBody } from "../guided/setup";

function item(section: ReadinessItem["section"], name: string, state: ReadinessState, required: boolean, detail = `${name} detail`): ReadinessItem {
  return { section, item: name, state, required, detail };
}

/** A blank workspace with a market but no book, the way the server reports one. */
function report(over: Partial<Record<string, [ReadinessState, boolean]>> = {}, launch?: { ok: boolean; blocking: string[]; acknowledgeable: string[] }): ReadinessReport {
  const base: Array<[ReadinessItem["section"], string, ReadinessState, boolean]> = [
    ["market", "Base snapshot", "valid", true],
    ["market", "Curves", "valid", false],
    ["market", "Vol surface", "valid", false],
    ["market", "Rate indices and derived markets", "valid", false],
    ["balance", "Positions", "not-set", true],
    ["balance", "Chart of accounts", "not-set", false],
    ["balance", "Strategy", "not-set", false],
    ["assumptions", "Sets", "not-set", true],
    ["assumptions", "Routing policy", "valid", true],
    ["assumptions", "Mapping", "not-set", false],
    ["run", "Scenarios", "valid", true],
    ["run", "Run setups", "draft", true],
    ["results", "Newest result", "not-set", false],
    ["govern", "Sign-off", "not-set", false],
  ];
  const items = base.map(([s, n, st, req]) => {
    const o = over[`${s}/${n}`];
    return item(s, n, o?.[0] ?? st, o?.[1] ?? req);
  });
  return {
    items,
    sections: { workspace: "not-set", market: "valid", balance: "not-set", assumptions: "not-set", run: "draft", results: "not-set", govern: "not-set" },
    launchable: launch === undefined ? {} : { [GUIDED_SLOT]: launch },
  };
}

const flat = (): RunSetup => ({ id: "rs-1", ...guidedSetupBody({ kind: "flat" }) });

/** No run of any kind, the guided slot saved at 10:00. */
const NONE = { guidedPinnedAt: "2026-11-02T10:00:00.000Z", deterministic: [], stochastic: [], newestResultIsGuided: false };
/** One done deterministic run of the guided slot, submitted at 11:00, after the 10:00 save. */
const DET_AFTER = { ...NONE, deterministic: [{ runId: "r1", state: "done", submittedAt: "2026-11-02T11:00:00.000Z" }], newestResultIsGuided: true };

describe("stepStates", () => {
  it("a workspace with a market and nothing else: Market done, Balance sheet and Behavior need attention in plain words", () => {
    const s = stepStates({ readiness: report(), guided: null, ...NONE });
    expect(s.map((x) => [x.id, x.state])).toEqual([
      ["market", "done"],
      ["balance", "attention"],
      ["behavior", "attention"],
      ["new-volume", "attention"],
      ["calibration", "optional"],
      ["simulation", "optional"],
      ["scenarios", "attention"],
      ["run", "attention"],
      ["reports", "attention"],
    ]);
    expect(s[1]!.missing).toEqual(["Load your balance sheet."]);
    expect(s[2]!.missing).toEqual(["Choose the behavior models for your families and save them."]);
    expect(s[3]!.missing).toEqual(["Answer the question: what happens to maturing balances?"]);
    expect(s[6]!.missing[0]).toMatch(/New volume step's question first/);
    expect(nextStep(s)).toBe("balance");
  });

  it("no snapshot: Market needs attention and names the snapshot", () => {
    const s = stepStates({ readiness: report({ "market/Base snapshot": ["not-set", true] }), guided: null, ...NONE });
    expect(s[0]).toMatchObject({ state: "attention", missing: ["Choose a market snapshot."] });
  });

  it("a balance sheet dated away from the cut-off is a warning: needs attention, with the server's words in details", () => {
    const r = report({ "balance/Positions": ["warning", true], "balance/Chart of accounts": ["valid", false] });
    const s = stepStates({ readiness: r, guided: null, ...NONE });
    expect(s[1]).toMatchObject({ state: "attention", missing: ["The balance sheet's date is not the workspace date."], details: ["Positions: Positions detail"] });
  });

  it("a stored set that does not fit the balance sheet reads Error on Behavior, never a silent Error elsewhere", () => {
    const r = report({ "balance/Positions": ["valid", true], "assumptions/Sets": ["error", true], "assumptions/Mapping": ["error", false] });
    const s = stepStates({ readiness: r, guided: null, ...NONE });
    expect(s[2]!.state).toBe("attention");
    expect(s[2]!.missing).toEqual(["The saved behavior models do not fit this balance sheet.", "A model is mapped to a family this balance sheet does not hold."]);
    expect(s[2]!.details).toHaveLength(2);
  });

  it("the guided setup exists and the gate is clear but nothing ran: Run reads Ready to launch, Reports waits", () => {
    const r = report({ "balance/Positions": ["valid", true], "assumptions/Sets": ["valid", true], "assumptions/Mapping": ["valid", false] }, { ok: true, blocking: [], acknowledgeable: [] });
    const s = stepStates({ readiness: r, guided: flat(), ...NONE });
    expect(s.find((x) => x.id === "new-volume")!.state).toBe("done");
    expect(s.find((x) => x.id === "scenarios")!.state).toBe("done");
    expect(s.find((x) => x.id === "run")).toMatchObject({ state: "attention", missing: ["Ready to launch."] });
    expect(s.find((x) => x.id === "reports")!.state).toBe("attention");
    expect(nextStep(s)).toBe("run");
  });

  it("acknowledgeable notes are counted in words; blocking items send the reader back to the steps", () => {
    const ack = stepStates({ readiness: report({}, { ok: false, blocking: [], acknowledgeable: ["balance/Positions", "market/Base snapshot"] }), guided: flat(), ...NONE });
    expect(ack.find((x) => x.id === "run")!.missing).toEqual(["Ready to launch once you confirm 2 notes."]);
    const block = stepStates({ readiness: report({}, { ok: false, blocking: ["assumptions/Sets"], acknowledgeable: [] }), guided: flat(), ...NONE });
    expect(block.find((x) => x.id === "run")!.missing[0]).toMatch(/^Fix one thing before the run can start/);
  });

  it("after a run of the guided setup, Run and Reports are done", () => {
    const s = stepStates({ readiness: report({}, { ok: true, blocking: [], acknowledgeable: [] }), guided: flat(), ...DET_AFTER });
    expect(s.find((x) => x.id === "run")!.state).toBe("done");
    expect(s.find((x) => x.id === "reports")!.state).toBe("done");
  });

  it("a stochastic choice makes Simulation done and Calibration read the vol surface", () => {
    const g = flat();
    const stoch: RunSetup = { ...g, eve: { ...g.eve, stochastic: { nPaths: 64, seed: "42", model: "hull-white-1f" } } };
    const ok = stepStates({ readiness: report(), guided: stoch, ...NONE });
    expect(ok.find((x) => x.id === "simulation")!.state).toBe("done");
    expect(ok.find((x) => x.id === "calibration")!.state).toBe("done");
    const bad = stepStates({ readiness: report({ "market/Vol surface": ["error", true] }), guided: stoch, ...NONE });
    expect(bad.find((x) => x.id === "calibration")).toMatchObject({ state: "attention", missing: ["The volatility surface cannot be used for a stochastic run."] });
    // A stochastic run counts for Run; a deterministic one alone does not.
    expect(stepStates({ readiness: report({}, { ok: true, blocking: [], acknowledgeable: [] }), guided: stoch, ...DET_AFTER }).find((x) => x.id === "run")!.state).toBe("attention");
    expect(stepStates({ readiness: report({}, { ok: true, blocking: [], acknowledgeable: [] }), guided: stoch, ...NONE, stochastic: [{ runId: "s1", state: "done", submittedAt: "2026-11-02T11:00:00.000Z", setupDocId: "rs-1" }] }).find((x) => x.id === "run")!.state).toBe("done");
  });

  it("a Custom dynamic basis makes New volume read the balance plan's own item", () => {
    const custom: RunSetup = { id: "rs-2", ...guidedSetupBody({ kind: "custom", balancePlanId: "bp-1" }) };
    const s = stepStates({ readiness: report({ "balance/Strategy": ["error", false] }), guided: custom, ...NONE });
    expect(s.find((x) => x.id === "new-volume")).toMatchObject({ state: "attention", missing: ["The balance targets cannot be used."] });
  });

  it("an unread readiness report never reads done", () => {
    const s = stepStates({ readiness: null, guided: null, ...NONE });
    expect(s.slice(0, 3).every((x) => x.state === "attention")).toBe(true);
  });
});

describe("stepStates: Done only on a run of what the analysis holds now (fix round 1, M1)", () => {
  const clear = { ok: true, blocking: [], acknowledgeable: [] };
  it("a run submitted before the setup's latest save needs a re-run, with the reason; Reports flags the older run", () => {
    // Saved at 12:00 (for example "Re-run with per-position results added"), last run at 11:00.
    const s = stepStates({ readiness: report({}, clear), guided: flat(), ...DET_AFTER, guidedPinnedAt: "2026-11-02T12:00:00.000Z" });
    const run = s.find((x) => x.id === "run")!;
    expect(run.state).toBe("attention");
    expect(run.missing[0]).toBe("Needs a re-run. Your analysis changed after its last run (the setup was saved again): run it again to see what you set now.");
    const rep = s.find((x) => x.id === "reports")!;
    expect(rep.state).toBe("attention");
    expect(rep.missing[0]).toMatch(/^The newest run is from an earlier version of your analysis/);
  });
  it("an input that went stale after the guided run (market, balance sheet, models) needs a re-run too", () => {
    const s = stepStates({ readiness: report({ "results/Newest result": ["stale", false] }, clear), guided: flat(), ...DET_AFTER });
    expect(s.find((x) => x.id === "run")!.missing[0]).toMatch(/^Needs a re-run\. An input changed after the last run/);
    // The stale item belongs to another setup's newer run: the guided run still counts.
    const other = stepStates({ readiness: report({ "results/Newest result": ["stale", false] }, clear), guided: flat(), ...DET_AFTER, newestResultIsGuided: false });
    expect(other.find((x) => x.id === "run")!.state).toBe("done");
  });
  it("a stochastic run counts only when it ran the current setup document, and only this workspace's links are given", () => {
    const g = flat();
    const stoch: RunSetup = { ...g, id: "rs-2", eve: { ...g.eve, stochastic: { nPaths: 64, seed: "42", model: "hull-white-1f" } } };
    const old = stepStates({ readiness: report({}, clear), guided: stoch, ...NONE, stochastic: [{ runId: "s1", state: "done", submittedAt: "2026-11-02T11:00:00.000Z", setupDocId: "rs-1" }] });
    expect(old.find((x) => x.id === "run")!.missing[0]).toMatch(/^Needs a re-run\. Your analysis changed after its last stochastic run/);
    const cur = stepStates({ readiness: report({}, clear), guided: stoch, ...NONE, stochastic: [{ runId: "s2", state: "done", submittedAt: "2026-11-02T13:00:00.000Z", setupDocId: "rs-2" }] });
    expect(cur.find((x) => x.id === "run")!.state).toBe("done");
    expect(cur.find((x) => x.id === "reports")!.state).toBe("done");
  });
});
