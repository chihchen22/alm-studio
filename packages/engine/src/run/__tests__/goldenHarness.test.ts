/**
 * The acceptance of spec Section 8.2: the same book produces the same bytes
 * whether the pipeline reaches its seams by import or through the kernel, and
 * the same bytes as the committed illustrative-beta baseline
 * (`golden/demo-run.illustrative-beta.json`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { overlayKindOf } from "../../contracts/assumptions";
import { buildDemoPortfolio, buildDemoRequest } from "../../../../../data/src/demo/request";
import { defaultHarness } from "../../plugins/defaultHarness";
import type { RunResult } from "../../contracts/run";
import { resolveDefaultContext } from "../engine";
import type { RunLogEntry } from "../../contracts/runLog";
import { RUN_RESULT_SCHEMA_VERSION, buildRunResult } from "../orchestrate";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

// id-rename: was demo-run.position-wac.json; two basis labels only (deltas file, Step 4)
// Was demo-run.id-rename.json; the default curve is now curve default 2, log-linear on discount factor
// Ring-fence 2026-11-10: was demo-run.curve-default-v2.json; the kernel deposit-beta default is now round illustrative
// textbook values
const GOLDEN = fileURLToPath(new URL("./golden/demo-run.illustrative-beta.json", import.meta.url));

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

/**
 * Drop the fields piece 1b adds to the envelope, so one golden serves both this
 * task and Task 7. Every number is outside this set: the envelope version and
 * the provenance identity fields carry identity, not a computed value. Piece
 * 1's own additions (planId / planHash) are absent on both sides here, because
 * the demo request carries no plan, so they need no exclusion.
 *
 * TASK 9 UPDATE: `policyHash` and `balancePlanHash` (round-2 ruling 14) are now
 * written too, and their deletes here are genuine exclusions rather than
 * forward-proofing. They appear only on a run compiled from a plan; the two
 * requests in this file are built by hand, so both sides carry neither and no
 * number moved. Every excluded field is identity, never a computed value.
 */
function stripAdditive(result: RunResult): unknown {
  const provenance = { ...result.provenance } as Record<string, unknown>;
  delete provenance.runLog;
  delete provenance.profileHash;
  delete provenance.policyHash;
  delete provenance.balancePlanHash;
  const out = { ...result, provenance } as Record<string, unknown>;
  delete out.schemaVersion;
  return out;
}

describe("byte-identical on both paths", () => {
  it("runs the four-position fixture the same with and without a harness", () => {
    const request = makeRunRequest(market);
    const base = resolveDefaultContext();
    const viaImport = buildRunResult(request, twoSidedBook(), base);
    const viaHarness = buildRunResult(request, twoSidedBook(), { ...base, harness: defaultHarness() });
    expect(JSON.stringify(viaHarness)).toBe(JSON.stringify(viaImport));
  });

  it("runs the demo book the same with and without a harness", () => {
    const portfolio = buildDemoPortfolio();
    const request = buildDemoRequest(portfolio, market, {
      startedAt: "2026-07-16T00:00:00.000Z",
      finishedAt: "2026-07-16T00:00:01.000Z",
    });
    const base = resolveDefaultContext();
    const viaImport = buildRunResult(request, portfolio, base);
    const viaHarness = buildRunResult(request, portfolio, { ...base, harness: defaultHarness() });
    expect(JSON.stringify(viaHarness)).toBe(JSON.stringify(viaImport));
  });

  it("writes the 1.7.0 provenance fields, and the plan hashes only for a plan run", () => {
    const request = makeRunRequest(market);
    const live = buildRunResult(request, twoSidedBook(), {
      ...resolveDefaultContext(),
      harness: defaultHarness(),
    });
    const provenance = live.provenance as unknown as Record<string, unknown>;
    for (const key of ["runLog", "profileHash"]) {
      expect(Object.hasOwn(provenance, key), `provenance.${key} should be written at 1.7.0`).toBe(true);
    }
    // This request was built by hand, not compiled from a plan, so the whole
    // plan block is absent: policyHash rides on request.plan and nothing else.
    expect(Object.hasOwn(provenance, "planId")).toBe(false);
    expect(Object.hasOwn(provenance, "policyHash")).toBe(false);
  });

  it("matches the illustrative-beta baseline (demo-run.illustrative-beta.json)", () => {
    const portfolio = buildDemoPortfolio();
    const request = buildDemoRequest(portfolio, market, {
      startedAt: "2026-07-16T00:00:00.000Z",
      finishedAt: "2026-07-16T00:00:01.000Z",
    });
    const live = buildRunResult(request, portfolio, {
      ...resolveDefaultContext(),
      harness: defaultHarness(),
    });
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as RunResult;
    expect(JSON.stringify(stripAdditive(live))).toBe(JSON.stringify(stripAdditive(golden)));
  });

  it("walks the derived default plan and logs it as derived", () => {
    const request = makeRunRequest(market);
    const result = buildRunResult(request, twoSidedBook(), {
      ...resolveDefaultContext(),
      harness: defaultHarness(),
    });
    const log = result.provenance.runLog ?? [];
    const planEntry = log.find((e) => e.t === "plan") as Extract<RunLogEntry, { t: "plan" }>;
    expect(planEntry, "a plan-less run must still say which graph it walked").toBeDefined();
    expect(planEntry.derived).toBe(true);
    expect(planEntry.planId).toBeUndefined();
    expect(planEntry.stageIds).toEqual([
      "st-curve",
      "st-tlp",
      "st-term",
      "st-behavioral-prepay",
      "st-behavioral-nmd-decay",
      "st-behavioral-deposit-beta",
      "st-cashflow",
      "st-nii",
      "st-eve",
      "st-gap",
      "st-ftp",
    ]);
  });

  it("logs one stage entry per stage of the derived plan, in walk order", () => {
    const request = makeRunRequest(market);
    const result = buildRunResult(request, twoSidedBook(), {
      ...resolveDefaultContext(),
      harness: defaultHarness(),
    });
    const stages = (result.provenance.runLog ?? []).filter(
      (e): e is Extract<RunLogEntry, { t: "stage" }> => e.t === "stage",
    );
    const planEntry = (result.provenance.runLog ?? []).find((e) => e.t === "plan") as Extract<RunLogEntry, { t: "plan" }>;
    expect(stages.map((e) => e.stageId)).toEqual(planEntry.stageIds);
    // Two checks, and only these two. (1) No stage logs the same produced slot
    // twice: the key is the shelf's own key, type|scope|producer, so the
    // behavioral chain's several Position artifacts at one assumption-set scope
    // are distinct slots by design. (2) Every consumed edge names a slot some
    // earlier stage line already produced.
    const producedKeys = new Set<string>();
    for (const entry of stages) {
      for (const p of entry.produced) {
        const key = `${p.type}|${p.scope}|${entry.stageId}`;
        expect(producedKeys.has(key), `${entry.stageId} logged ${key} twice`).toBe(false);
        producedKeys.add(key);
      }
      for (const c of entry.consumed) {
        if (c.producerStageId === "<context>") continue;
        expect(
          producedKeys.has(`${c.type}|${c.scope}|${c.producerStageId}`),
          `${c.type} consumed before "${c.producerStageId}" produced it`,
        ).toBe(true);
      }
    }
  });

  // IMPORTANT 1 (fix round 1): a request compiled from SOME OTHER plan carries
  // that plan's stage ids on its PlanRef. A run with no context.plan walks the
  // DERIVED plan, whose behavioral stages are named st-behavioral-<kind>, so the
  // foreign licensing must not be taken: taking it would leave every behavioral
  // stage unbound and drop every overlay silently, which shows up as numbers
  // moving against the plan-less run. Nothing stamps licensedBindings before
  // Task 8, so this test is the only thing holding the precedence today.
  it("ignores a foreign PlanRef's licensing when it walks the derived plan", () => {
    const base = makeRunRequest(market);
    const withForeignRef: typeof base = {
      ...base,
      plan: {
        planId: "plan-from-somewhere-else",
        planHash: "0".repeat(64),
        licensedBindings: base.assumptionSets.flatMap((set) =>
          set.bindings.map((binding, bindingIndex) => ({
            stageId: "st-some-other-plans-stage",
            assumptionSetId: set.id,
            familyId: binding.familyId,
            kind: overlayKindOf(binding.overlay),
            bindingIndex,
          })),
        ),
      },
    };
    const context = { ...resolveDefaultContext(), harness: defaultHarness() };
    const plain = buildRunResult(base, twoSidedBook(), context);
    const foreign = buildRunResult(withForeignRef, twoSidedBook(), context);
    // The PlanRef stamps planId and planHash on the provenance, which is
    // identity and not a computed value, so it is dropped alongside the other
    // identity fields. Every number is still compared.
    const stripPlanIdentity = (r: RunResult): unknown => {
      const out = stripAdditive(r) as { provenance: Record<string, unknown> };
      const provenance = { ...out.provenance };
      delete provenance.planId;
      delete provenance.planHash;
      return { ...out, provenance };
    };
    expect(JSON.stringify(stripPlanIdentity(foreign))).toBe(JSON.stringify(stripPlanIdentity(plain)));
    // THE LOAD-BEARING HALF. The fixture's overlays bind the kernel term
    // defaults the positions already carry, so dropping them moves no number
    // and the byte comparison above would pass on a book like this one even
    // with every overlay silently discarded. What proves the licensing reached
    // the DERIVED stage ids is that no behavioral stage is logged unbound.
    const stages = (foreign.provenance.runLog ?? []).filter(
      (e): e is Extract<RunLogEntry, { t: "stage" }> => e.t === "stage",
    );
    const unbound = stages.filter((e) => e.kind === "behavioral" && e.skipped === "no-binding");
    expect(unbound.map((e) => e.stageId)).toEqual([]);
  });

  it("bumps the envelope to 1.13.0 and leaves every number where it was", () => {
    expect(RUN_RESULT_SCHEMA_VERSION).toBe("1.13.0");
  });
});
