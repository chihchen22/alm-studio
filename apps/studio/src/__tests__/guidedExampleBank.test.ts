// apps/studio/src/__tests__/guidedExampleBank.test.ts
/**
 * What "Explore the example bank" writes, and the two new badges. The analysis below is
 * written here by hand, with values that are no default; each expected document is worked out from it by the rule the
 * guided steps state (guided/setup.ts, the New volume step's plan id rule), never read back from the module under test.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PortfolioSpec } from "@alm/engine";
import { summarizeBook } from "../guided/book";
import type { ExampleAnalysis } from "@alm/reader";
import { continueStep, examplePlan, exampleSet, exampleSetupBody, finishExampleAnalysis, nextGuidedPlanId, withArchiveOnFailure, type ExampleApi } from "../guided/exampleAnalysis";
import { isIllustrativeVersion, publishedBadge } from "../guided/behavior";
import { isIllustrativePack } from "../guided/market";

const ANALYSIS: ExampleAnalysis = {
  schemaVersion: "1.0.0",
  bookId: "bank",
  label: "L",
  behavior: { label: "Round models", modelVersion: "illustrative-v1", bindings: [{ familyId: "sav", overlay: { kind: "deposit-beta", params: { betaMin: 0.2, betaMax: 0.6, k: 2, m: 4, lambda: 0.5 } }, modelVersion: "illustrative-v1" }] },
  targets: { label: "Held flat", unlistedFamilies: "runoff", targets: [{ familyId: "sav", path: [{ month: 1, balance: 70_000_000 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 360 } }] },
  templates: [{ familyId: "sav", rateType: "deposit", amortization: "decay", indexTenorMonths: 1, behavior: "family", termMonths: 360, spreadOverIndexBp: 0 }],
  goingConcern: true,
  nmdWarmup: { kind: "history", series: { label: "made-up series", firstMonth: "2025-01", valuesPct: [4.1, 4.2, 4.3] } },
  warmupSource: { file: "f.json", source: "s", sourceUrl: "u", notice: "n", termsUrl: "t", firstMonth: "2025-01", lastMonth: "2025-03" },
};

describe("the finished example analysis", () => {
  it("saves the guided setup the steps would: the targets as the answer, each family's product, going-concern value on its default span, the history", () => {
    const s = exampleSetupBody(ANALYSIS, "bp-guided-x-1");
    expect(s.nii.basis).toEqual({ kind: "custom", balancePlanId: "bp-guided-x-1" });
    expect(s.nii.templates).toEqual(ANALYSIS.templates);
    expect(s.nii.templates).not.toBe(ANALYSIS.templates);
    // Going-concern value on, its span left out (the 12-month default); the forecast gap off, so no field.
    expect(s.eve.goingConcern).toBe(true);
    expect("goingConcernSpan" in s.eve).toBe(false);
    expect("forecast" in s.gap).toBe(false);
    expect(s.nmdWarmup).toEqual({ kind: "history", series: { label: "made-up series", firstMonth: "2025-01", valuesPct: [4.1, 4.2, 4.3] } });
    // The guided defaults: the parallel grid with its base first, risk-free value, 60 months of earnings.
    expect(s.scenarios).toEqual({ kind: "library", refs: ["regulatory-grid-v1#S0", "regulatory-grid-v1#S100", "regulatory-grid-v1#S-100", "regulatory-grid-v1#S200", "regulatory-grid-v1#S-200"] });
    expect(s.eve.discountBasis).toBe("risk-free");
    expect(s.nii.horizonMonths).toBe(60);
  });

  it("saves the set and the plan under the ids the Behavior and New volume steps would give them", () => {
    expect(exampleSet(ANALYSIS, "guided-x-1", "Example bank")).toEqual({ schemaVersion: "1.0.0", id: "guided-x-1", label: "Round models, Example bank", bindings: ANALYSIS.behavior.bindings });
    expect(examplePlan(ANALYSIS, "bp-guided-x-2", "2026-03-31")).toEqual({ schemaVersion: "1.0.0", id: "bp-guided-x-2", label: "Held flat", asOf: "2026-03-31", targets: ANALYSIS.targets.targets, unlistedFamilies: "runoff" });
    expect(nextGuidedPlanId("ws-example-bank", [])).toBe("bp-guided-example-bank-1");
    expect(nextGuidedPlanId("ws-example-bank", ["bp-guided-example-bank-1", "bp-guided-example-bank-2"])).toBe("bp-guided-example-bank-3");
  });
});

describe("the badges", () => {
  it("a published default shows the server's badge, else the S2a words", () => {
    expect(publishedBadge({ badge: "illustrative textbook default, not fitted to any data" })).toBe("illustrative textbook default, not fitted to any data");
    expect(publishedBadge({})).toBe("default, not fitted");
    expect(publishedBadge(null)).toBe("default, not fitted");
  });
  it("a saved model version that starts illustrative is badged illustrative", () => {
    expect(isIllustrativeVersion("illustrative-v1")).toBe(true);
    expect(isIllustrativeVersion("published-default-v1")).toBe(false);
    expect(isIllustrativeVersion(null)).toBe(false);
  });
  it("the public snapshot's surfaces and funding premium are labelled illustrative", () => {
    expect(isIllustrativePack({ discountingIndex: "RFR" })).toBe(true);
    expect(isIllustrativePack({ discountingIndex: "SOFR_OIS" })).toBe(false);
  });
});

describe("the Balance step's summary of the example bank and the v2 template (S3a-1 fix round H1, M1)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  it("Quillfield Bank: assets $5,000M, liabilities $4,450M, equity $550M, tied; the swap and the undrawn lines on a line of their own", () => {
    const bank = JSON.parse(readFileSync(join(root, "examples", "mid-size-bank-v1.json"), "utf8")) as PortfolioSpec;
    const s = summarizeBook(bank);
    // By hand from the data note: 250 non-earning + 4,750 earning; deposits 4,200 + advances 250.
    expect([s.assets, s.liabilities, s.plug]).toEqual([5_000_000_000, 4_450_000_000, 550_000_000]);
    expect(s.tie.ok).toBe(true);
    expect(s.offBalance).toEqual({ swapNotional: 250_000_000, undrawn: 1_000_000_000, sentence: "Off the balance sheet, and in none of these totals: swap notional $250.0 million and undrawn committed lines $1,000.0 million." });
    expect(s.families.filter((f) => f.offBalance).map((f) => f.familyId).sort()).toEqual(["mb-commitments", "mb-swaps"]);
  });
  it("the v2 CSV template: assets $290M, liabilities $260M, equity $30M, tied", () => {
    // The template's rows by hand: assets 40 + 10 (premises) + 30 + 40 + 60 + 110; liabilities 90 + 100 + 60 (three cd rows) + 10; off: swap 25, line 50.
    const rows = readFileSync(join(root, "examples", "positions-template-v2.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
    const fam = (id: string, side: string, instrumentType: string) => ({ id, label: id, side, instrumentType, coaNodeId: id });
    const sides: Record<string, [string, string]> = {
      "mb-cash": ["asset", "fixed-loan"], "mb-non-earning": ["asset", "non-rate-sensitive"], "mb-treasuries": ["asset", "fixed-loan"], "mb-agency-mbs": ["asset", "mortgage"], "mb-ci-floating": ["asset", "floating-loan"],
      "mb-cre-fixed": ["asset", "fixed-loan"], "mb-commitments": ["asset", "commitment"], "mb-nib-checking": ["liability", "nmd"], "mb-mma": ["liability", "nmd-b"],
      "mb-cds": ["liability", "cd"], "mb-fhlb-floating": ["liability", "floating-loan"], "mb-swaps": ["derivative", "swap"],
    };
    const book = {
      id: "t", label: "t", asOf: "2026-03-31",
      coa: { schemaVersion: "1.0.0", nodes: [{ id: "eq", label: "Equity", parentId: null, side: "equity", isLeaf: false, order: 0 }], families: Object.entries(sides).map(([id, [side, t]]) => fam(id, side, t)) },
      positions: rows.map((r, i) => ({ id: `${r[0]}-${i}`, familyId: r[1], coaNodeId: r[1], terms: { id: `${r[0]}-${i}`, type: r[3], notional: Number(r[5]) } })),
    } as unknown as PortfolioSpec;
    const s = summarizeBook(book);
    expect([s.assets, s.liabilities, s.plug]).toEqual([290_000_000, 260_000_000, 30_000_000]);
    expect(s.tie.ok).toBe(true);
    expect([s.offBalance.swapNotional, s.offBalance.undrawn]).toEqual([25_000_000, 50_000_000]);
  });
});

describe("Explore's failure and readiness paths (S3a-1 fix round M2, L8, L9)", () => {
  const head = (revision: number) => ({ id: "ws-example-bank", name: "Example bank", revision, blocks: { assumptions: { defaultSetId: null } } }) as never;
  /** A fake reader: every call recorded; `fail` names the call that throws, `acks` the readiness notes to confirm. */
  function fakeApi(opts: { fail?: string | string[]; acks?: string[] }) {
    const calls: string[] = [];
    let rev = 3;
    const call = <T>(name: string, value: () => T) => async (..._args: unknown[]): Promise<T> => {
      calls.push(name);
      if (opts.fail === name || (Array.isArray(opts.fail) && opts.fail.includes(name))) throw new Error(`${name} answered 409`);
      return value();
    };
    const api = {
      getExampleAnalysis: call("getExampleAnalysis", () => ANALYSIS),
      listAssumptionSets: call("listAssumptionSets", () => []),
      createAssumptionSet: call("createAssumptionSet", () => ({})),
      setBlock: call("setBlock", () => head(++rev)),
      listBalancePlans: call("listBalancePlans", () => []),
      saveBalancePlan: call("saveBalancePlan", () => ({})),
      saveRunSetup: call("saveRunSetup", () => ({})),
      getReadiness: call("getReadiness", () => ({ launchable: { "setup-guided": { ok: true, blocking: [], acknowledgeable: opts.acks ?? [] } } })),
      launchSetup: call("launchSetup", () => ({ runIds: ["run-1"] })),
      getRun: call("getRun", () => ({ state: "done" })),
      getWorkspace: call("getWorkspace", () => head(rev)),
      archiveWorkspace: call("archiveWorkspace", () => head(rev + 1)),
    } as unknown as ExampleApi;
    return { api, calls };
  }
  const P = { ws: "ws-example-bank", head: head(3), bookId: "bank", asOf: "2026-03-31", by: "Analyst", say: () => undefined };

  it("a failed write archives the half-built workspace and says so in one sentence", async () => {
    const { api, calls } = fakeApi({ fail: "saveBalancePlan" });
    await expect(withArchiveOnFailure({ id: "ws-example-bank", name: "Example bank", by: "Analyst" }, () => finishExampleAnalysis(P, api), api)).rejects.toThrow(
      "Setting up Example bank failed, so it was archived and left out of the list: saveBalancePlan answered 409",
    );
    expect(calls.slice(-3)).toEqual(["saveBalancePlan", "getWorkspace", "archiveWorkspace"]);
    expect(calls).not.toContain("launchSetup");
  });

  it("says the workspace stays in the list when the archive fails too (S3f fix round, L1)", async () => {
    const { api, calls } = fakeApi({ fail: ["saveBalancePlan", "archiveWorkspace"] });
    await expect(withArchiveOnFailure({ id: "ws-example-bank", name: "Example bank", by: "Analyst" }, () => finishExampleAnalysis(P, api), api)).rejects.toThrow(
      "Setting up Example bank failed, and it could not be archived, so it stays in the list half set up: saveBalancePlan answered 409",
    );
    expect(calls.slice(-2)).toEqual(["getWorkspace", "archiveWorkspace"]);
  });

  it("a readiness note stops before the launch and opens the Run step, which asks the learner to confirm it", async () => {
    const { api, calls } = fakeApi({ acks: ["balance/Positions"] });
    expect(await finishExampleAnalysis(P, api)).toBe("run");
    expect(calls).not.toContain("launchSetup");
    expect(calls).not.toContain("archiveWorkspace");
  });

  it("with nothing to confirm it launches, waits for the run and opens Reports", async () => {
    const { api, calls } = fakeApi({});
    expect(await finishExampleAnalysis(P, api, async () => undefined)).toBe("reports");
    expect(calls.filter((c) => c === "launchSetup")).toHaveLength(1);
  });

  it("continue opens Reports only when a run is done", () => {
    expect(continueStep([{ status: { state: "done" } }])).toBe("reports");
    expect(continueStep([{ status: { state: "error" } }, { status: null }])).toBe("market");
    expect(continueStep([])).toBe("market");
  });
});
