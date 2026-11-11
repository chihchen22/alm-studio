// apps/studio/src/__tests__/setupRows.test.ts
import { describe, expect, it } from "vitest";
import {
  BASIS_CHOICES, STOCHASTIC_PATH_REFUSAL, acknowledgeLabel, assumptionSetOptions, blockingText, draftForSave, launchOutcomeText,
  batchOverview, keepMarketOption, marketInputChoices, marketInputFrom, marketSelectValue, parseBucketEdges, rateSpecText, scenarioRefsOf, scenarioSummary,
  setupListRows, slotChipState, withBasis,
} from "../rows/setupRows";
import { ApiError } from "@alm/reader";
import { ITEMS, LIBRARIES, STANDARD_ALCO } from "./fixtures/setup";
import { HEAD } from "./fixtures/workspace";

describe("basis choices", () => {
  it("are Flat, Runoff, Custom dynamic, in that order, with the spec's words", () => {
    expect(BASIS_CHOICES.map((c) => c.kind)).toEqual(["flat", "runoff", "custom"]);
    expect(BASIS_CHOICES.map((c) => c.label)).toEqual([
      "Flat (default): balances held at opening, 60-month fixed bullets at the par swap rate",
      "Runoff (no new business)",
      "Custom dynamic (targets per family or strategic node)",
    ]);
  });
  it("withBasis writes the engine's own shapes; Custom names its plan", () => {
    expect(withBasis(STANDARD_ALCO.nii, "runoff", "p1").basis).toEqual({ kind: "runoff" });
    expect(withBasis(STANDARD_ALCO.nii, "flat", "p1").basis).toEqual({ kind: "flat", termMonths: 60, spreadOverIndexBp: 0 });
    expect(withBasis(STANDARD_ALCO.nii, "custom", "p1").basis).toEqual({ kind: "custom", balancePlanId: "p1" });
  });
});

describe("assumptionSetOptions", () => {
  it("puts the workspace default first, then the sets", () => {
    expect(assumptionSetOptions("demo-behavioral-v1", ["a", "b"]).map((o) => o.label)).toEqual(["Workspace default (demo-behavioral-v1)", "a", "b"]);
  });
  it("says so when no set is attached yet", () => {
    expect(assumptionSetOptions(null, []).map((o) => o.label)).toEqual(["Workspace default (none attached yet)"]);
  });
});

describe("parseBucketEdges", () => {
  it("reads whole months, strictly increasing, within the grid", () => {
    expect(parseBucketEdges("3, 6, 12, 24", 360)).toEqual({ edges: [3, 6, 12, 24], problem: null });
    expect(parseBucketEdges("1 2 3", 360).edges).toEqual([1, 2, 3]);
  });
  it("refuses a bucket finer than a month, a repeat, a descent and an edge past the grid", () => {
    expect(parseBucketEdges("0.5, 3", 360).problem).toBe("Bucket edges are whole months, so no bucket is finer than a month.");
    expect(parseBucketEdges("3, 3", 360).problem).toBe("Bucket edges must rise: 3 does not follow 3.");
    expect(parseBucketEdges("6, 3", 360).problem).toBe("Bucket edges must rise: 3 does not follow 6.");
    expect(parseBucketEdges("12, 400", 360).problem).toBe("Bucket edge 400 is beyond the 360-month grid.");
    expect(parseBucketEdges("0, 3", 360).problem).toBe("Bucket edges are whole months, so no bucket is finer than a month.");
    expect(parseBucketEdges("", 360).problem).toBe("Name at least one bucket edge, in months.");
    expect(parseBucketEdges("a, 3", 360).problem).toBe("Bucket edges are whole months, so no bucket is finer than a month.");
  });
});

describe("rateSpecText", () => {
  it("names a shock by kind and size", () => {
    expect(rateSpecText({ kind: "base" })).toBe("Base");
    expect(rateSpecText({ kind: "parallel", shockBp: 100 })).toBe("Parallel +100 bp");
    expect(rateSpecText({ kind: "parallel", shockBp: -200 })).toBe("Parallel -200 bp");
    expect(rateSpecText({ kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 })).toBe("Twist: 0 bp short, +100 bp long, pivot 5y");
    expect(rateSpecText({ kind: "custom", shocks: [{ tenorYears: 1, shockBp: 25 }, { tenorYears: 5, shockBp: 50 }, { tenorYears: 10, shockBp: 75 }] })).toBe("User-defined, 3 tenor knots");
  });
});

describe("scenarioRefsOf", () => {
  it("lists a library's scenarios as <library id>#<scenario id>", () => {
    expect(scenarioRefsOf(LIBRARIES[1]!)).toEqual(["steepener-v1#STEEP100"]);
  });
});

describe("the Launch strip texts", () => {
  it("prints the blocking ids in words, the section prefix dropped", () => {
    expect(blockingText(["balance/Positions", "market/Base snapshot"], ITEMS)).toBe("Positions, Base snapshot");
    expect(blockingText(["Positions", "Base snapshot"], [])).toBe("Positions, Base snapshot");
    expect(blockingText([], ITEMS)).toBe("");
  });
  it("names the two run setup ids the server files acknowledgements under", () => {
    expect(acknowledgeLabel("run/setups", ITEMS)).toBe("Run setups: a consumed pin moved since the last validation. Validate again, or launch on the changed pins.");
    expect(acknowledgeLabel("run/setup-warnings", ITEMS)).toBe("Setup warnings: the compile's warnings stand; the validation report lists them.");
    expect(acknowledgeLabel("market/Base snapshot", ITEMS)).toBe("Base snapshot: set");
  });
});

describe("launchOutcomeText", () => {
  it("a 200 reply names the queued runs", () => {
    expect(launchOutcomeText({ kind: "reply", reply: { t: "launch-complete", setupLineageId: "s", launchNo: 2, at: "x", runIds: ["r1", "r2"], failed: [] } })).toBe("Launch 2 queued 2 runs: r1, r2.");
  });
  it("a 207 reply names the refused row and the cancel offers", () => {
    const text = launchOutcomeText({
      kind: "reply",
      reply: { t: "launch-complete", setupLineageId: "s", launchNo: 3, at: "x", runIds: ["r1"], failed: [{ row: "Runoff, up 200", status: 409, message: "pin moved" }], cancel: [{ runId: "r1", method: "POST", path: "/api/runs/r1/cancel" }] },
    });
    expect(text).toBe("Launch 3 queued 1 run: r1. Row Runoff, up 200 was refused (409): pin moved. Queued runs stay queued; cancel them from the queue if the batch is not wanted.");
  });
  it("a gate refusal lists what blocks and what needs acknowledging", () => {
    const e = new ApiError(409, "launch-blocked", "launch refused", undefined, { error: { code: "launch-blocked", message: "launch refused" }, blocking: ["balance/Positions"], acknowledgeable: [], staleRoles: [] });
    expect(launchOutcomeText({ kind: "error", error: e }, ITEMS)).toBe("Launch refused: Positions blocks it.");
  });
  it("a stochastic refusal repeats the server's text", () => {
    const e = new ApiError(422, "stochastic-path-reserved", STOCHASTIC_PATH_REFUSAL);
    expect(launchOutcomeText({ kind: "error", error: e })).toBe(`422: ${STOCHASTIC_PATH_REFUSAL}`);
  });
  it("a batch refusal names each failing row", () => {
    const e = new ApiError(422, "validation", "a batch row failed", undefined, {
      error: { code: "validation", message: "a batch row failed" },
      rows: [
        { label: "ok row", outcome: "pass", planId: "p", basisLabel: "Flat", skippedFamilies: [], warnings: [] },
        { label: "bad row", outcome: "fail", status: 422, error: { code: "x", message: "carries its own runoff strategy" } },
      ],
    });
    expect(launchOutcomeText({ kind: "error", error: e })).toBe("Nothing was submitted. Row bad row failed: carries its own runoff strategy.");
  });
});

describe("draftForSave", () => {
  it("supersedes the stored document, drops the id, and clears a plan id the edit no longer matches", () => {
    const stored = { ...STANDARD_ALCO, plan: { ...STANDARD_ALCO.plan, planId: "plan-x" } };
    const out = draftForSave(stored, { ...stored, note: "changed" });
    expect(out.supersedes).toBe("rs-standard-alco");
    expect("id" in out).toBe(false);
    expect(out.plan.planId).toBeNull();
  });
});

describe("setupListRows and slotChipState", () => {
  const slots = [
    { slot: { setupLineageId: "s1", current: { collection: "run-setups", id: "rs-1", contentHash: "h", pinnedAt: "t" } }, setup: STANDARD_ALCO },
    { slot: { setupLineageId: "s2", current: { collection: "run-setups", id: "rs-2", contentHash: "h", pinnedAt: "t" } }, setup: { ...STANDARD_ALCO, id: "rs-2", name: "Runoff", nii: { ...STANDARD_ALCO.nii, basis: { kind: "runoff" as const } } } },
  ];
  const runs = [
    { runId: "a", attachedBy: "launch", at: "2026-10-01T10:00:00.000Z", setupLineageId: "s1", launchNo: 1, pins: "consumed", status: null, basisLabel: null },
    { runId: "b", attachedBy: "launch", at: "2026-10-05T10:00:00.000Z", setupLineageId: "s1", launchNo: 2, pins: "consumed", status: null, basisLabel: null },
    { runId: "c", attachedBy: "migration", at: "2026-09-01T10:00:00.000Z", pins: "reconstructed", status: null, basisLabel: null },
  ] as never;
  it("prints name, launch count, basis label as chosen and last launched", () => {
    const rows = setupListRows(slots as never, runs, { items: ITEMS, launchable: { s1: { ok: true, blocking: [], acknowledgeable: ["run/setup-warnings"] }, s2: { ok: true, blocking: [], acknowledgeable: [] } } } as never);
    expect(rows.map((r) => r.name)).toEqual(["Standard ALCO", "Runoff"]);
    expect(rows.map((r) => r.launchCount)).toEqual([2, 0]);
    expect(rows.map((r) => r.basisText)).toEqual(["Flat (default)", "Runoff"]);
    expect(rows.map((r) => r.lastLaunched)).toEqual(["2026-10-05", null]);
    expect(rows.map((r) => r.state)).toEqual(["warning", "valid"]);
  });
  it("derives a slot's state from its launch lists when there are several slots", () => {
    const report = { items: ITEMS, sections: {}, launchable: { s1: { ok: false, blocking: ["run/setups"], acknowledgeable: [] }, s2: { ok: false, blocking: [], acknowledgeable: ["run/setups"] } } } as never;
    expect(slotChipState("s1", report, 2)).toBe("error");
    expect(slotChipState("s2", report, 2)).toBe("stale");
  });
});

describe("batchOverview and scenarioSummary", () => {
  const withBatch = {
    ...STANDARD_ALCO,
    batch: [
      { label: "Flat, up 200", scenarios: { kind: "library" as const, refs: ["regulatory-grid-v1#S200"] }, assumptionSetIds: { kind: "block-default" as const }, basis: { kind: "flat" as const, termMonths: 60 as const, spreadOverIndexBp: 0 as const } },
      { label: "Slate, custom", scenarios: { kind: "slate" as const, slateId: "alco-user-slate", include: ["KN-1-5-10"] }, assumptionSetIds: ["loan-repricing-demo-v1"], basis: { kind: "custom" as const, balancePlanId: "bp-1" } },
    ],
  };
  const listed = [{ slot: { setupLineageId: "s1", current: { collection: "run-setups", id: "rs-1", contentHash: "h", pinnedAt: "t" } }, setup: withBatch }] as never;
  it("lists each row under its setup with its scenarios, set and basis in words", () => {
    expect(batchOverview(listed)).toEqual([
      { lineageId: "s1", setupName: "Standard ALCO", rowNo: 1, label: "Flat, up 200", scenarios: "1 library scenario", assumptionSets: "Workspace default", basis: "Flat (default)" },
      { lineageId: "s1", setupName: "Standard ALCO", rowNo: 2, label: "Slate, custom", scenarios: "slate alco-user-slate, 1 scenario", assumptionSets: "loan-repricing-demo-v1", basis: "Custom dynamic (bp-1)" },
    ]);
  });
  it("names the three scenario sources", () => {
    expect(scenarioSummary({ kind: "library", refs: ["a#1", "a#2"] })).toBe("2 library scenarios");
    expect(scenarioSummary({ kind: "slate", slateId: "x", include: "all" })).toBe("slate x, all scenarios");
    expect(scenarioSummary({ kind: "plan-scenarios", items: [{ ref: "a#1" }] })).toBe("imported plan list, 1 scenario");
  });
});

describe("the market input (Piece B, step B3a, decision 42)", () => {
  const block = HEAD.blocks.market;
  it("offers the base snapshot first, then each derived market of the block by its definition key", () => {
    expect(marketInputChoices(block)).toEqual([
      { value: "base", label: "Base snapshot (market-public-2026-03-31)", disabled: false },
      { value: "derived:macro-demo-v1", label: "Derived market macro-demo-v1", disabled: false },
      { value: "derived:tlp-shock-demo-v1", label: "Derived market tlp-shock-demo-v1", disabled: false },
      { value: "derived:vol-shock-demo-v1", label: "Derived market vol-shock-demo-v1", disabled: false },
    ]);
  });
  it("names the current market id beside a definition key a roll-forward moved", () => {
    const moved = { ...block, derived: [{ ...block.derived[0]!, id: "derived-mk-0123456789ab" }] };
    expect(marketInputChoices(moved)[1]).toEqual({ value: "derived:macro-demo-v1", label: "Derived market macro-demo-v1 (now derived-mk-0123456789ab)", disabled: false });
  });
  it("reads and writes the setup's market role", () => {
    expect(marketSelectValue({ role: "base" })).toBe("base");
    expect(marketSelectValue({ role: "derived", definitionKey: "tlp-shock-demo-v1" })).toBe("derived:tlp-shock-demo-v1");
    expect(marketInputFrom("base")).toEqual({ role: "base" });
    expect(marketInputFrom("derived:tlp-shock-demo-v1")).toEqual({ role: "derived", definitionKey: "tlp-shock-demo-v1" });
  });
  it("keeps a derived market the block no longer holds as a named, disabled choice", () => {
    const choices = marketInputChoices(block);
    expect(keepMarketOption({ role: "derived", definitionKey: "gone-v1" }, choices)).toEqual({ value: "derived:gone-v1", label: "Derived market gone-v1 (not in the market block)", disabled: true });
    expect(keepMarketOption({ role: "derived", definitionKey: "tlp-shock-demo-v1" }, choices)).toBeNull();
    expect(keepMarketOption({ role: "base" }, choices)).toBeNull();
  });
  it("with no snapshot the base choice says so", () => {
    expect(marketInputChoices({ ...block, snapshot: null, derived: [] })).toEqual([{ value: "base", label: "Base snapshot (none attached yet)", disabled: false }]);
  });
});
