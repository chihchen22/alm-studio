/**
 * Spec Section 8.4: the compile-side acceptances of piece 1c.
 *
 *  (b) a plan that drops the decay stage AND the decay binding changes NII; the
 *      same plan with the binding left in is refused, naming the family and kind;
 *  (c) a plan with no EveResult producer is refused, naming EveResult;
 *  plus T6, the two-licensee refusal, and the duplicate-metric conflict.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PatchLayer } from "@alm/harness";
import { mountProfile } from "@alm/harness";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { RunPlan } from "../../contracts/plan";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunLogEntry } from "../../contracts/runLog";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import { buildCellPlan } from "../../portfolio/cells";
import { resolveDefaultContext } from "../../run/engine";
import { buildRunResult } from "../../run/orchestrate";
import {
  ArtifactConflictError,
  CellBudgetError,
  OverlappingBindingError,
  RequiredMetricMissingError,
  TaxonomyMismatchError,
  UnknownDimensionError,
  UnlicensedBindingError,
  ViewDefinitionError,
} from "../../run/executorErrors";
import {
  predictedPassBytes,
  runStaticPass,
  type StaticPassGroup,
} from "../../run/shard/staticPass";
import { buildScenarioRatePath } from "../../projection/static";
import { buildBaseCurve } from "../../scenario";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import {
  baseAssumptions,
  loadMarket,
  segmentedAssumptions,
  segmentedNmdBook,
  twoSidedBook,
} from "../../run/__tests__/fixtures";
import { compilePlan, registryProducers } from "../compile";
import { typeGate } from "../typeGate";
import { fixturePlan, loadPolicy } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

function compile(plan: RunPlan, sets: AssumptionSet[], patches?: PatchLayer[]) {
  return compilePlan(
    plan,
    {
      portfolio: twoSidedBook(),
      marketSnapshot: market,
      assumptionSets: sets,
      policy: loadPolicy(),
      libraries: SHIPPED_LIBRARIES,
      catalog: BUILTIN_CATALOG,
      ...(patches !== undefined ? { patches } : {}),
    },
    { runId: "RUN-1C", seed: "1", timestamps: { startedAt: "", finishedAt: "" } },
  );
}

/**
 * The fixture set with a DDA decay binding that actually bites. The shipped
 * fixture binds the kernel term DEFAULTS the position already carries, so
 * applying that overlay is numerically a no-op by design and dropping it could
 * not move a number whatever the plan did. A faster closure and a smaller
 * rate-driven ceiling give the stage work to do.
 */
function movedDecaySet(): AssumptionSet {
  const set = baseAssumptions();
  return {
    ...set,
    bindings: set.bindings.map((b) => b.overlay.kind === "nmd-decay"
      ? { ...b, overlay: { ...b.overlay, params: { ...b.overlay.params, closureSteady: 0.4, maxRateDecay: 0.5 } } }
      : b),
  };
}

/** The same set without its DDA decay binding. */
function noDecaySet(): AssumptionSet {
  const set = movedDecaySet();
  return { ...set, bindings: set.bindings.filter((b) => b.overlay.kind !== "nmd-decay") };
}

/**
 * The same set with an MMA deposit-beta binding that actually bites. Like the
 * decay binding, the shipped one is the kernel's own `BETA_S_CURVE_DEFAULTS`,
 * so it reprices the IB book exactly as the untouched position already does. A
 * higher beta ceiling and a lower midpoint pass more of the market rate through
 * to the deposit rate, which is interest expense, which is NII.
 */
function movedBetaSet(): AssumptionSet {
  const set = baseAssumptions();
  return {
    ...set,
    bindings: set.bindings.map((b) => b.overlay.kind === "deposit-beta"
      ? { ...b, overlay: { ...b.overlay, params: { ...b.overlay.params, betaMax: 0.95, m: 2.0 } } }
      : b),
  };
}

/** The same set without its MMA deposit-beta binding. */
function noBetaSet(): AssumptionSet {
  const set = movedBetaSet();
  return { ...set, bindings: set.bindings.filter((b) => b.overlay.kind !== "deposit-beta") };
}

/** The fixture plan without its beta stage, and rewired around the hole. */
function noBetaPlan(): RunPlan {
  const plan = fixturePlan();
  plan.stages = plan.stages.filter((s) => s.id !== "st-beta");
  // st-beta was the last link of the behavioral chain, so every stage that read
  // the rewritten book now reads it from st-decay.
  for (const id of ["st-cashflow", "st-eve", "st-gap"]) {
    const s = plan.stages.find((x) => x.id === id)!;
    s.dependsOn = s.dependsOn!.map((d) => (d === "st-beta" ? "st-decay" : d));
  }
  return plan;
}

/** The fixture plan without its decay stage, and rewired around the hole. */
function noDecayPlan(): RunPlan {
  const plan = fixturePlan();
  plan.stages = plan.stages.filter((s) => s.id !== "st-decay");
  const beta = plan.stages.find((s) => s.id === "st-beta")!;
  beta.dependsOn = ["st-prepay", "st-term"];
  return plan;
}

describe("acceptance (b): a stage and its binding travel together", () => {
  /**
   * The spec's acceptance says "changes NII". On THIS book it cannot: the
   * fixture's DDA is a Non-IB deposit (depositRate 0), so the decay overlay
   * moves the balance path and the interest expense stays zero whatever the
   * balances do. The acceptance is asserted where the stage's work actually
   * lands, the present value of the DDA leg in EVE, and the NII equality is
   * asserted beside it so the reason is recorded rather than assumed.
   */
  it("dropping both changes the numbers the decay stage feeds", () => {
    const withDecay = compile(fixturePlan(), [movedDecaySet()]);
    const without = compile(noDecayPlan(), [noDecaySet()]);
    const base = resolveDefaultContext();
    const a = buildRunResult(withDecay.request, twoSidedBook(), { ...base, harness: withDecay.harness, plan: fixturePlan() });
    const b = buildRunResult(without.request, twoSidedBook(), { ...base, harness: without.harness, plan: noDecayPlan() });
    const dda = (r: typeof a) => r.eve.byScenario[0]!.byFamily.find((f) => f.familyId === "DDA")!.pv;
    expect(dda(b)).not.toBe(dda(a));
    expect(JSON.stringify(b.nii.byScenario[0]!.totalNetByHorizon), "a Non-IB deposit pays no interest either way").toBe(
      JSON.stringify(a.nii.byScenario[0]!.totalNetByHorizon),
    );
    withDecay.harness.dispose();
    without.harness.dispose();
  });

  /**
   * The same acceptance on the interest-bearing pair, which is the channel the
   * spec names: MMA is an IB deposit, so its beta stage reprices a coupon and
   * the money shows up in NII rather than only in a present value.
   */
  it("dropping the beta stage and its binding changes NII", () => {
    const withBeta = compile(fixturePlan(), [movedBetaSet()]);
    const without = compile(noBetaPlan(), [noBetaSet()]);
    const base = resolveDefaultContext();
    const a = buildRunResult(withBeta.request, twoSidedBook(), { ...base, harness: withBeta.harness, plan: fixturePlan() });
    const b = buildRunResult(without.request, twoSidedBook(), { ...base, harness: without.harness, plan: noBetaPlan() });
    expect(JSON.stringify(b.nii.byScenario[0]!.totalNetByHorizon)).not.toBe(
      JSON.stringify(a.nii.byScenario[0]!.totalNetByHorizon),
    );
    withBeta.harness.dispose();
    without.harness.dispose();
  });

  it("dropping the beta stage and leaving its binding is refused, naming the family and the kind", () => {
    expect(() => compile(noBetaPlan(), [movedBetaSet()])).toThrow(UnlicensedBindingError);
    try {
      compile(noBetaPlan(), [movedBetaSet()]);
    } catch (err) {
      const e = err as UnlicensedBindingError;
      expect(e.familyId).toBe("MMA");
      expect(e.kind).toBe("deposit-beta");
      expect(e.message).toContain("MMA");
      expect(e.message).toContain("deposit-beta");
      expect(e.runLog, "a refusal carries the log it had").toBeDefined();
    }
  });

  it("dropping the stage and leaving the binding is refused, naming the family and the kind", () => {
    expect(() => compile(noDecayPlan(), [baseAssumptions()])).toThrow(UnlicensedBindingError);
    try {
      compile(noDecayPlan(), [baseAssumptions()]);
    } catch (err) {
      const e = err as UnlicensedBindingError;
      expect(e.familyId).toBe("DDA");
      expect(e.kind).toBe("nmd-decay");
      expect(e.message).toContain("DDA");
      expect(e.message).toContain("nmd-decay");
      // Finding 4: the refusal names WHICH binding of the set, so a set with two
      // same-kind bindings on one family is fixable from the message alone.
      expect(e.bindingIndex).toBe(1);
      expect(e.message).toContain("bindings[1]");
      expect(e.runLog, "a refusal carries the log it had").toBeDefined();
    }
  });
});

describe("acceptance (c): a missing required metric is a refusal", () => {
  /**
   * The EVE stage leaves with the funding leg nobody else reads: st-tlp exists
   * to discount st-eve, so a plan that drops the metric drops its producer too.
   * Left behind, st-tlp would reach no metric and T5 would refuse the plan
   * before L2 ever ran, which would test the orphan rule rather than this one.
   */
  it("refuses a plan with no EveResult producer, naming EveResult", () => {
    const plan = fixturePlan();
    plan.stages = plan.stages.filter((s) => s.id !== "st-eve" && s.id !== "st-tlp");
    expect(() => compile(plan, [baseAssumptions()])).toThrow(RequiredMetricMissingError);
    try {
      compile(plan, [baseAssumptions()]);
    } catch (err) {
      expect((err as RequiredMetricMissingError).type).toBe("EveResult");
      expect((err as RequiredMetricMissingError).runLog, "a refusal carries the log it had").toBeDefined();
    }
  });

  /**
   * The same slot, emptied by the MOUNT rather than by the plan document. A
   * request patch that disables metric.eve leaves st-eve in the plan with no
   * plugin to execute it; ruling 13 tolerates such a stage when nothing consumes
   * what it produces, and nothing consumes EveResult. L2 counted it anyway, so
   * the plan compiled on a promise the walk could not keep: the walker skipped
   * st-eve as not-executable, no EveResult reached the shelf, and the post-walk
   * assembly threw a PlanGraphError inside the runner child, which surfaces as a
   * failed job instead of the 422 this refusal gives the caller.
   */
  it("refuses when the only EveResult producer is TOLERATED, naming EveResult", () => {
    const patches: PatchLayer[] = [{ label: "no-eve", patches: [{ disable: "metric.eve" }] }];
    expect(() => compile(fixturePlan(), [baseAssumptions()], patches)).toThrow(RequiredMetricMissingError);
    try {
      compile(fixturePlan(), [baseAssumptions()], patches);
    } catch (err) {
      expect((err as RequiredMetricMissingError).type).toBe("EveResult");
      expect((err as RequiredMetricMissingError).runLog, "a refusal carries the log it had").toBeDefined();
    }
  });

  it("accepts a plan with no FtpResult producer, because the ftp block is optional", () => {
    const plan = fixturePlan();
    expect(plan.stages.some((s) => s.produces.includes("FtpResult"))).toBe(false);
    const compiled = compile(plan, [baseAssumptions()]);
    expect(compiled.compile.passed).toBe(true);
    compiled.harness.dispose();
  });

  it("stamps the licensed bindings on the compiled request", () => {
    const compiled = compile(fixturePlan(), [baseAssumptions()]);
    expect(compiled.request.plan!.licensedBindings).toEqual([
      { stageId: "st-prepay", assumptionSetId: "AS-BASE", familyId: "MORTGAGE", kind: "prepay", bindingIndex: 0 },
      { stageId: "st-decay", assumptionSetId: "AS-BASE", familyId: "DDA", kind: "nmd-decay", bindingIndex: 1 },
      { stageId: "st-beta", assumptionSetId: "AS-BASE", familyId: "MMA", kind: "deposit-beta", bindingIndex: 2 },
    ]);
    compiled.harness.dispose();
  });
});

describe("the two-licensee refusal", () => {
  it("refuses a binding two stages license, listing both", () => {
    const plan = fixturePlan();
    const decay = plan.stages.find((s) => s.id === "st-decay")!;
    plan.stages.splice(plan.stages.indexOf(decay) + 1, 0, {
      ...decay,
      id: "st-decay-2",
      dependsOn: ["st-decay", "st-term"],
    });
    plan.stages.find((s) => s.id === "st-beta")!.dependsOn = ["st-decay-2", "st-term"];
    try {
      compile(plan, [baseAssumptions()]);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(UnlicensedBindingError);
      const e = err as UnlicensedBindingError;
      expect(e.candidateStageIds.sort()).toEqual(["st-decay", "st-decay-2"]);
    }
  });
});

describe("T1 tightened to the direct dependsOn", () => {
  const producers = () => {
    const ctx = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const p = registryProducers(ctx);
    ctx.dispose();
    return p;
  };

  it("passes the rewired fixture plan", () => {
    const r = typeGate(fixturePlan(), twoSidedBook().asOf, producers());
    expect(r.failures, JSON.stringify(r.failures, null, 2)).toEqual([]);
  });

  it("fails when a consumed type's producer is upstream but not in dependsOn", () => {
    const plan = fixturePlan();
    plan.stages.find((s) => s.id === "st-eve")!.dependsOn = ["st-cashflow"];
    const r = typeGate(plan, twoSidedBook().asOf, producers());
    expect(r.failures.some((f) => f.rule === "T1" && f.stageId === "st-eve" && f.detail.includes("ZeroCurve"))).toBe(true);
  });

  /**
   * The TLP stage is load-bearing, and this is where that is enforced. An EVE
   * stage that does not name a FundingCurve producer in its own dependsOn is
   * refused at COMPILE naming FundingCurve, so a plan that would have discounted
   * on the risk-free leg never reaches a run.
   */
  it("fails when st-eve omits st-tlp, naming FundingCurve", () => {
    const plan = fixturePlan();
    plan.stages.find((s) => s.id === "st-eve")!.dependsOn = ["st-cashflow", "st-curve", "st-beta"];
    const r = typeGate(plan, twoSidedBook().asOf, producers());
    const f = r.failures.find((x) => x.rule === "T1" && x.stageId === "st-eve");
    expect(f, JSON.stringify(r.failures, null, 2)).toBeDefined();
    expect(f!.detail).toContain("FundingCurve");
  });

  it("fails when two stages in the direct dependsOn produce one consumed type", () => {
    const plan = fixturePlan();
    // A second bootstrap curve stage: two honest ZeroCurve producers, both in
    // st-eve's dependsOn, which is the ambiguity an edge cannot carry.
    plan.stages.push({
      id: "st-curve-2",
      component: "alm-yield-curve",
      kind: "curve",
      consumes: ["MarketSnapshot"],
      produces: ["ZeroCurve"],
      params: { dayCount: "ACT/360" },
    });
    plan.stages.find((s) => s.id === "st-eve")!.dependsOn = [
      "st-cashflow", "st-curve", "st-curve-2", "st-tlp", "st-beta",
    ];
    const r = typeGate(plan, twoSidedBook().asOf, producers());
    expect(r.failures.some((f) => f.rule === "T1" && f.detail.includes("st-curve") && f.detail.includes("st-curve-2"))).toBe(true);
  });
});

describe("T6: declared equals mounted", () => {
  const producers = () => {
    const ctx = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const p = registryProducers(ctx);
    ctx.dispose();
    return p;
  };

  it("refuses a stage producing a type its executor does not declare", () => {
    const plan = fixturePlan();
    const cashflow = plan.stages.find((s) => s.id === "st-cashflow")!;
    cashflow.produces = [...cashflow.produces, "CommitmentSchedule"];
    const r = typeGate(plan, twoSidedBook().asOf, producers());
    const f = r.failures.find((x) => x.rule === "T6" && x.stageId === "st-cashflow");
    expect(f).toBeDefined();
    expect(f!.detail).toContain("CommitmentSchedule");
    expect(f!.detail).toContain("engine.contractual");
  });

  it("refuses a stage consuming a type its executor does not declare and no context supplies", () => {
    const plan = fixturePlan();
    const nii = plan.stages.find((s) => s.id === "st-nii")!;
    nii.consumes = [...nii.consumes, "DepositRatePath"];
    nii.dependsOn = [...(nii.dependsOn ?? [])];
    const r = typeGate(plan, twoSidedBook().asOf, producers());
    expect(r.failures.some((f) => f.rule === "T6" && f.stageId === "st-nii" && f.detail.includes("DepositRatePath"))).toBe(true);
  });

  /**
   * Ruling P16: a METRIC stage must declare every input its executor reads, or
   * the executor would read an artifact no edge resolved. An EVE stage that
   * omits the funding leg is refused at compile naming the stage, the plugin
   * and the type.
   */
  it("refuses a metric stage that omits an input its executor reads", () => {
    const plan = fixturePlan();
    const eve = plan.stages.find((s) => s.id === "st-eve")!;
    eve.consumes = eve.consumes.filter((t) => t !== "FundingCurve");
    const r = typeGate(plan, twoSidedBook().asOf, producers());
    const f = r.failures.find((x) => x.rule === "T6" && x.stageId === "st-eve");
    expect(f, JSON.stringify(r.failures, null, 2)).toBeDefined();
    expect(f!.detail).toContain("FundingCurve");
    expect(f!.detail).toContain("engine.metric.eve");
  });

  it("exempts a stage no mounted plugin executes", () => {
    const plan = fixturePlan();
    plan.stages.push({
      id: "st-client-rate",
      component: "alm-loan-client-rate",
      kind: "behavioral",
      consumes: ["RatePath"],
      produces: ["ClientRatePath"],
      dependsOn: ["st-term"],
    });
    plan.stages.find((s) => s.id === "st-nii")!.dependsOn = ["st-cashflow", "st-client-rate"];
    const r = typeGate(plan, twoSidedBook().asOf, producers());
    expect(r.failures.filter((f) => f.rule === "T6")).toEqual([]);
  });
});

describe("two metric stages on one result slot", () => {
  it("refuses at compile with ArtifactConflictError naming both stages", () => {
    const plan = fixturePlan();
    const nii = plan.stages.find((s) => s.id === "st-nii")!;
    plan.stages.push({ ...nii, id: "st-nii-2" });
    try {
      compile(plan, [baseAssumptions()]);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactConflictError);
      const e = err as ArtifactConflictError;
      expect([e.firstStageId, e.secondStageId].sort()).toEqual(["st-nii", "st-nii-2"]);
    }
  });
});

/**
 * Piece 2a, spec Sections 4.1, 4.2 and 4.5. The compile order after the type
 * gate is: the taxonomy cross-check and the predicate checks (layer
 * plan/dimensions), then L1, then L3 (layer plan/license), then L2.
 */
describe("piece 2a: taxonomy, predicates and L3 at compile", () => {
  // The file's own compile() pins twoSidedBook; these tests need the segmented
  // book, so they carry their own helper over the same ResolvedPlanInputs.
  function compileWith(plan: RunPlan, sets: AssumptionSet[], book: PortfolioSpec) {
    return compilePlan(
      plan,
      {
        portfolio: book,
        marketSnapshot: market,
        assumptionSets: sets,
        policy: loadPolicy(),
        libraries: SHIPPED_LIBRARIES,
        catalog: BUILTIN_CATALOG,
      },
      { runId: "RUN-2A", seed: "1", timestamps: { startedAt: "", finishedAt: "" } },
    );
  }
  function compileError(plan: RunPlan, sets: AssumptionSet[], book: PortfolioSpec): unknown {
    try {
      compileWith(plan, sets, book);
    } catch (err) {
      return err;
    }
    throw new Error("expected a refusal");
  }
  const compileOk = (plan: RunPlan, sets: AssumptionSet[], book: PortfolioSpec) => compileWith(plan, sets, book);
  const lastRefuse = (err: unknown): RunLogEntry & { t: "refuse" } =>
    (err as { runLog?: RunLogEntry[] }).runLog!.filter((e) => e.t === "refuse").at(-1)! as RunLogEntry & { t: "refuse" };

  it("refuses a plan whose inputs.dimensionTaxonomy differs from the book's taxonomy id", () => {
    const plan = fixturePlan();
    plan.inputs.dimensionTaxonomy = "TAX-OTHER";
    const err = compileError(plan, [segmentedAssumptions()], segmentedNmdBook());
    expect(err).toBeInstanceOf(TaxonomyMismatchError);
    expect((err as TaxonomyMismatchError).bookTaxonomyId).toBe("TAX-SEGMENT");
    expect(lastRefuse(err).ids.layer).toBe("plan/dimensions");
  });

  it("accepts inputs.dimensionTaxonomy equal to the book's id, and ignores it on a book with no taxonomy", () => {
    const plan = fixturePlan();
    plan.inputs.dimensionTaxonomy = "TAX-SEGMENT";
    expect(() => compileOk(plan, [segmentedAssumptions()], segmentedNmdBook())).not.toThrow();
    plan.inputs.dimensionTaxonomy = "whatever";
    expect(() => compileOk(plan, [baseAssumptions()], twoSidedBook())).not.toThrow();
  });

  it("refuses a binding predicate naming an undeclared tag, and a stage predicate naming a closed value", () => {
    const set = segmentedAssumptions();
    set.bindings[3] = { ...set.bindings[3]!, selector: { vintage: "2021" } };
    const e1 = compileError(fixturePlan(), [set], segmentedNmdBook());
    expect(e1).toBeInstanceOf(UnknownDimensionError);
    expect((e1 as UnknownDimensionError).where).toBe("assumption set AS-SEGMENTED bindings[3]");
    const plan = fixturePlan();
    plan.stages.find((s) => s.id === "st-decay")!.selector = { behavioralClasses: "decay", dimensions: { segment: "whale" } };
    const e2 = compileError(plan, [segmentedAssumptions()], segmentedNmdBook());
    expect(e2).toBeInstanceOf(UnknownDimensionError);
    expect((e2 as UnknownDimensionError).value).toBe("whale");
  });

  it("L3: two decay bindings matching one position refuse at compile under plan/license", () => {
    const set = segmentedAssumptions();
    delete (set.bindings[3] as { selector?: unknown }).selector;
    const err = compileError(fixturePlan(), [set], segmentedNmdBook());
    expect(err).toBeInstanceOf(OverlappingBindingError);
    expect((err as OverlappingBindingError).positionId).toBe("D1");
    expect(lastRefuse(err).ids.layer).toBe("plan/license");
  });

  it("L1 refusal names the position a stage predicate failed to cover", () => {
    const plan = fixturePlan();
    plan.stages.find((s) => s.id === "st-decay")!.selector = { behavioralClasses: "decay", dimensions: { segment: "rate-shopper" } };
    const err = compileError(plan, [baseAssumptions()], segmentedNmdBook());
    expect(err).toBeInstanceOf(UnlicensedBindingError);
    expect((err as UnlicensedBindingError).uncoveredPositionId).toBe("D3");
    expect((err as UnlicensedBindingError).bindingIndex).toBe(1);
    expect((err as UnlicensedBindingError).message).toContain("bindings[1]");
  });

  /**
   * Piece 2b rides the same block. The view check sits inside block 3a, after
   * the predicate checks and behind the same type gate, and writes its refusal
   * under layer plan/views. The run log matters to a reader: the 422 body the
   * server returns from routes/plans.ts ships it.
   */
  it("refuses a plan whose view cannot partition the book, and logs it under plan/views", () => {
    const plan = fixturePlan();
    plan.views = [{ id: "by-segment", label: "By segment", groupBy: ["segment"] }];
    // segmentedNmdBook leaves F1, M1 and B1 with no segment tag, so P3 fires.
    const err = compileError(plan, [segmentedAssumptions()], segmentedNmdBook());
    expect(err).toBeInstanceOf(ViewDefinitionError);
    expect((err as ViewDefinitionError).rule).toBe("P3");
    expect((err as ViewDefinitionError).positionId).toBe("F1");
    const entry = lastRefuse(err);
    expect(entry.ids).toEqual({
      layer: "plan/views",
      planId: plan.planId,
      rule: "P3",
      viewId: "by-segment",
      dimension: "segment",
      positionId: "F1",
    });
    expect(entry.error).toBe((err as ViewDefinitionError).message);
  });

  it("compiles a view that DOES partition, copies it onto the request, and logs no refusal", () => {
    // The negative control for the test above: without it, a check wired to
    // refuse everything, or wired outside the type gate, would still look right.
    const plan = fixturePlan();
    plan.views = [{ id: "by-side", label: "By side", groupBy: ["side"] }];
    const compiled = compileOk(plan, [segmentedAssumptions()], segmentedNmdBook());
    expect(compiled.request.views).toEqual([{ id: "by-side", label: "By side", groupBy: ["side"] }]);
    expect(compiled.runLog.filter((e) => e.t === "refuse")).toEqual([]);
    // And a plan with no views leaves the request as it was before piece 2b.
    const plain = compileOk(fixturePlan(), [segmentedAssumptions()], segmentedNmdBook());
    expect(plain.request.views).toBeUndefined();
  });
});

/**
 * The cell budget is predicted at compile with the
 * same exported formula the static pass checks before its first allocation,
 * so an over-budget plan is a typed refusal at submit and not a run that dies
 * in a child. A fixture book cannot reach 4 GiB, so the refusal is reached by
 * lowering the budget, the way the cardinality measurement raises it.
 */
describe("piece 2c: the cell budget refuses at compile", () => {
  function compileWithBudget(plan: RunPlan, sets: AssumptionSet[], book: PortfolioSpec, cellBudgetBytes?: number) {
    return compilePlan(
      plan,
      {
        portfolio: book,
        marketSnapshot: market,
        assumptionSets: sets,
        policy: loadPolicy(),
        libraries: SHIPPED_LIBRARIES,
        catalog: BUILTIN_CATALOG,
        ...(cellBudgetBytes !== undefined ? { cellBudgetBytes } : {}),
      },
      { runId: "RUN-2C", seed: "1", timestamps: { startedAt: "", finishedAt: "" } },
    );
  }
  const bySide = () => {
    const plan = fixturePlan();
    plan.views = [{ id: "by-side", label: "By side", groupBy: ["side"] }];
    return plan;
  };

  it("refuses a plan predicted over the budget, with the pass's own formula and a plan/views refuse entry", () => {
    const plan = bySide();
    const book = segmentedNmdBook();
    let err: unknown;
    try {
      compileWithBudget(plan, [segmentedAssumptions()], book, 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CellBudgetError);
    const e = err as CellBudgetError;
    const scenarioCount = compileWithBudget(bySide(), [segmentedAssumptions()], segmentedNmdBook()).request.scenarios.length;
    expect(e.viewIds).toEqual(["by-side"]);
    expect(e.cellCount).toBe(buildCellPlan(segmentedNmdBook(), plan.views!).cells.length);
    expect(e.positionCount).toBe(book.positions.length);
    expect(e.scenarioCount).toBe(scenarioCount);
    expect(e.workerCount).toBe(1);
    expect(e.budgetBytes).toBe(1);
    expect(e.predictedBytes).toBe(
      predictedPassBytes(e.cellCount, plan.grid.horizonMonths, e.positionCount, e.scenarioCount, 1),
    );
    const entries = (e as unknown as { runLog?: RunLogEntry[] }).runLog!.filter((x) => x.t === "refuse");
    const entry = entries.at(-1)! as RunLogEntry & { t: "refuse" };
    expect(entry.error).toBe(e.message);
    expect(entry.ids).toEqual({
      layer: "plan/views",
      planId: plan.planId,
      rule: "budget",
      viewIds: "by-side",
      predictedBytes: String(e.predictedBytes),
      budgetBytes: "1",
    });
  });

  it("compiles the same plan under the default budget and logs no refusal", () => {
    const compiled = compileWithBudget(bySide(), [segmentedAssumptions()], segmentedNmdBook());
    expect(compiled.request.views).toEqual([{ id: "by-side", label: "By side", groupBy: ["side"] }]);
    expect(compiled.runLog.filter((x) => x.t === "refuse")).toEqual([]);
  });

  /**
   * The property this pins is the spec's promise behind the compile-side check:
   * a plan that passes compile on a host passes the static pass on that same
   * host, because both sides predict the SAME peak from the same numbers. The
   * existing case above proves compile calls the formula with the numbers
   * compile chose; it cannot see whether the pass would choose others. This one
   * refuses on both sides with a budget of one byte and compares the two
   * refusals field by field. It depends on three facts about how the run forms
   * its pass groups (run/stages/contractual.ts): every group carries the same
   * position count, because each group's book is an overlay-applied copy of the
   * one raw book; every scenario of the run appears in the pass, so the pass's
   * scenario count is the compiled request's; and the horizon the pass is given
   * is the plan grid's horizonMonths. Break any of the three and the two
   * predictions part company, and this test goes red where the numbers diverge.
   *
   * This is a characterisation test, not a red-then-green one: the property
   * already holds. Its guard against passing vacuously is the pair of instance
   * assertions, which fail on `undefined` if either side declines to refuse.
   */
  it("predicts the same bytes at compile and inside the static pass", () => {
    const plan = bySide();
    const book = segmentedNmdBook();
    let compileErr: unknown;
    try {
      compileWithBudget(plan, [segmentedAssumptions()], book, 1);
    } catch (e) {
      compileErr = e;
    }
    expect(compileErr).toBeInstanceOf(CellBudgetError);
    const atCompile = compileErr as CellBudgetError;

    // The pass's inputs, formed the way run/stages/contractual.ts forms them:
    // the cell plan over the raw book and the plan's views, one group per
    // assumption set (the fixture has one) carrying the book's positions and
    // every scenario of the compiled request.
    const compiled = compileWithBudget(bySide(), [segmentedAssumptions()], segmentedNmdBook());
    const cellPlan = buildCellPlan(book, plan.views!);
    const base = buildBaseCurve(market);
    const horizon = plan.grid.horizonMonths;
    const group: StaticPassGroup = {
      positions: book.positions,
      scenarios: compiled.request.scenarios.map((s) => ({
        scenarioId: s.id,
        rateSpec: s.rateSpec,
        path: buildScenarioRatePath(base, s, horizon),
      })),
    };
    let runErr: unknown;
    try {
      runStaticPass([group], cellPlan, horizon, "auto", market, 1);
    } catch (e) {
      runErr = e;
    }
    expect(runErr).toBeInstanceOf(CellBudgetError);
    const atRun = runErr as CellBudgetError;

    expect(atRun.predictedBytes).toBe(atCompile.predictedBytes);
    expect(atRun.workerCount).toBe(atCompile.workerCount);
    expect(atRun.cellCount).toBe(atCompile.cellCount);
    expect(atRun.scenarioCount).toBe(atCompile.scenarioCount);
    expect(atRun.positionCount).toBe(atCompile.positionCount);
  });
});
