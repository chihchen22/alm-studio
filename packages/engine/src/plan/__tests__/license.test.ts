/**
 * licenseBindings: a binding has exactly ONE licensee. Zero
 * is unlicensed, two is ambiguous, and the stages that license nothing are named
 * so the compiler can tag them and the walker can skip them.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mountProfile } from "@alm/harness";
import type { DimensionTaxonomy } from "../../contracts/dimensions";
import type { PlanStage, RunPlan } from "../../contracts/plan";
import { PLAN_SCHEMA_VERSION } from "../../contracts/plan";
import type { PortfolioSpec } from "../../contracts/position";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import {
  AS_OF,
  baseAssumptions,
  nmdPosition,
  segmentedAssumptions,
  segmentedNmdBook,
  twoSidedBook,
} from "../../run/__tests__/fixtures";
import { kindsByPlugin, licenseBindings } from "../license";

const ctx = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
const PLUGIN_KINDS = kindsByPlugin(ctx.get("behavioral"));
afterAll(() => ctx.dispose());

/** A plan carrying exactly the behavioral stages a case needs. */
function planWith(stages: PlanStage[]): RunPlan {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: "P-LICENSE",
    label: "license fixture",
    authoredBy: "person",
    asOf: AS_OF,
    grid: { horizonMonths: 12 },
    inputs: { marketSnapshot: "<request>", positionBook: "PF-TWO-SIDED", routingPolicy: "<none>" },
    stages,
    scenarios: [],
    reports: [],
    validationRules: { typeGate: [], routingGate: [] },
  };
}

function behavioralStage(id: string, component: string, selector?: PlanStage["selector"]): PlanStage {
  return {
    id,
    component,
    kind: "behavioral",
    consumes: ["Position", "RatePath"],
    produces: ["Position"],
    dependsOn: ["st-term"],
    ...(selector !== undefined ? { selector } : {}),
  };
}

const SETS = [baseAssumptions()];
const BOOK = twoSidedBook();

describe("kindsByPlugin", () => {
  it("asks the registry who owns each kind rather than parsing the plugin id", () => {
    expect(PLUGIN_KINDS.get("engine.behavioral.prepay")).toEqual(["prepay"]);
    expect(PLUGIN_KINDS.get("engine.behavioral.nmd-decay")).toEqual(["nmd-decay"]);
    expect(PLUGIN_KINDS.get("engine.behavioral.deposit-beta")).toEqual(["deposit-beta"]);
  });
});

describe("licenseBindings", () => {
  it("licenses one stage per binding when each kind has one selector-matching stage", () => {
    const plan = planWith([
      behavioralStage("st-prepay", "engine.behavioral.prepay"),
      behavioralStage("st-decay", "engine.behavioral.nmd-decay"),
      behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
    ]);
    const out = licenseBindings(plan, SETS, BOOK, PLUGIN_KINDS);
    expect(out.licensed).toEqual([
      { stageId: "st-prepay", assumptionSetId: "AS-BASE", familyId: "MORTGAGE", kind: "prepay", bindingIndex: 0 },
      { stageId: "st-decay", assumptionSetId: "AS-BASE", familyId: "DDA", kind: "nmd-decay", bindingIndex: 1 },
      { stageId: "st-beta", assumptionSetId: "AS-BASE", familyId: "MMA", kind: "deposit-beta", bindingIndex: 2 },
    ]);
    expect(out.unlicensed).toEqual([]);
    expect(out.multi).toEqual([]);
    expect(out.unboundStageIds).toEqual([]);
  });

  it("reports a binding no stage matches as unlicensed, naming the right-kind candidates", () => {
    // The only prepay stage selects the DDA family, so the MORTGAGE prepay
    // binding has a stage of the right KIND and no stage that matches it.
    const plan = planWith([
      behavioralStage("st-prepay", "engine.behavioral.prepay", { productFamily: ["DDA"] }),
      behavioralStage("st-decay", "engine.behavioral.nmd-decay"),
      behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
    ]);
    const out = licenseBindings(plan, SETS, BOOK, PLUGIN_KINDS);
    expect(out.unlicensed).toEqual([
      {
        assumptionSetId: "AS-BASE",
        familyId: "MORTGAGE",
        kind: "prepay",
        bindingIndex: 0,
        candidateStageIds: ["st-prepay"],
      },
    ]);
    expect(out.licensed.map((l) => l.kind)).toEqual(["nmd-decay", "deposit-beta"]);
    // The stage licensed nothing, so it is named for the tag and the skip.
    expect(out.unboundStageIds).toEqual(["st-prepay"]);
  });

  it("reports a binding two stages match as ambiguous, naming BOTH", () => {
    const plan = planWith([
      behavioralStage("st-prepay-a", "engine.behavioral.prepay"),
      behavioralStage("st-prepay-b", "engine.behavioral.prepay"),
      behavioralStage("st-decay", "engine.behavioral.nmd-decay"),
      behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
    ]);
    const out = licenseBindings(plan, SETS, BOOK, PLUGIN_KINDS);
    expect(out.multi).toEqual([
      {
        assumptionSetId: "AS-BASE",
        familyId: "MORTGAGE",
        kind: "prepay",
        bindingIndex: 0,
        candidateStageIds: ["st-prepay-a", "st-prepay-b"],
      },
    ]);
    // An ambiguous binding licenses NEITHER candidate, so both are unbound.
    expect(out.licensed.map((l) => l.stageId)).toEqual(["st-decay", "st-beta"]);
    expect(out.unboundStageIds).toEqual(["st-prepay-a", "st-prepay-b"]);
  });

  it("names a stage whose kind no binding uses as unbound, and refuses nothing", () => {
    const plan = planWith([
      behavioralStage("st-prepay", "engine.behavioral.prepay"),
      behavioralStage("st-decay", "engine.behavioral.nmd-decay"),
      behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
      behavioralStage("st-rollover", "engine.behavioral.cd-rollover"),
    ]);
    const out = licenseBindings(plan, SETS, BOOK, PLUGIN_KINDS);
    expect(out.unlicensed).toEqual([]);
    expect(out.multi).toEqual([]);
    expect(out.unboundStageIds).toEqual(["st-rollover"]);
  });

  it("resolves a stage's component through the alias table before asking who owns the kind", () => {
    const plan = planWith([
      behavioralStage("st-prepay", "alm-mortgage-prepayment"),
      behavioralStage("st-decay", "engine.behavioral.nmd-decay"),
      behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
    ]);
    const out = licenseBindings(plan, SETS, BOOK, PLUGIN_KINDS);
    expect(out.licensed.find((l) => l.kind === "prepay")?.stageId).toBe("st-prepay");
    expect(out.unlicensed).toEqual([]);
  });
});

describe("piece 2a: bindingIndex and per-position coverage", () => {
  it("two bindings of one kind on one family license separately by index", () => {
    const plan = planWith([
      behavioralStage("st-prepay", "engine.behavioral.prepay"),
      behavioralStage("st-decay", "engine.behavioral.nmd-decay"),
      behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
    ]);
    const out = licenseBindings(plan, [segmentedAssumptions()], segmentedNmdBook(), PLUGIN_KINDS);
    expect(out.licensed.map((l) => [l.stageId, l.bindingIndex])).toEqual([
      ["st-prepay", 0],
      ["st-decay", 1],
      ["st-beta", 2],
      ["st-decay", 3],
    ]);
  });

  it("a stage predicate that covers every position the binding matches licenses it", () => {
    const plan = planWith([
      behavioralStage("st-prepay", "engine.behavioral.prepay"),
      behavioralStage("st-decay-shoppers", "engine.behavioral.nmd-decay", {
        behavioralClasses: "decay",
        dimensions: { segment: "rate-shopper" },
      }),
      behavioralStage("st-decay-rel", "engine.behavioral.nmd-decay", {
        behavioralClasses: "decay",
        dimensions: { segment: "relationship" },
      }),
      behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
    ]);
    const out = licenseBindings(plan, [segmentedAssumptions()], segmentedNmdBook(), PLUGIN_KINDS);
    expect(out.unlicensed).toEqual([]);
    expect(out.multi).toEqual([]);
    expect(
      out.licensed.filter((l) => l.kind === "nmd-decay").map((l) => [l.stageId, l.bindingIndex]),
    ).toEqual([
      ["st-decay-shoppers", 1],
      ["st-decay-rel", 3],
    ]);
  });

  it("a stage predicate that misses a position the binding matches does not license it, naming the position", () => {
    const plan = planWith([
      behavioralStage("st-prepay", "engine.behavioral.prepay"),
      behavioralStage("st-decay-shoppers", "engine.behavioral.nmd-decay", {
        behavioralClasses: "decay",
        dimensions: { segment: "rate-shopper" },
      }),
      behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
    ]);
    const out = licenseBindings(plan, [baseAssumptions()], segmentedNmdBook(), PLUGIN_KINDS);
    const gap = out.unlicensed.find((g) => g.kind === "nmd-decay")!;
    expect(gap.bindingIndex).toBe(1);
    expect(gap.uncoveredPositionId).toBe("D3");
    expect(gap.candidateStageIds).toEqual(["st-decay-shoppers"]);
  });
});

/**
 * The behavioralClasses facet moves off the family
 * and onto the position, read with the exact class set R3 and R4 read
 * (classesOfPosition: the family's declared classes and the position's own tag
 * through dimensionsOf, plus the classes the run's bindings derive for the
 * family). That set is a SUPERSET of the family-level set, so the rule is never
 * stricter than it was; case (c) pins that.
 */
describe("piece 2d: classes per position", () => {
  const CLASS_TAXONOMY: DimensionTaxonomy = {
    schemaVersion: "1.0.0",
    id: "TAX-CLASSES",
    label: "Position-level behavioral classes",
    dimensions: [
      {
        id: "behavioralClasses",
        label: "Behavioral classes",
        multiValued: true,
        values: ["product-mix"],
      },
    ],
  };

  /**
   * twoSidedBook plus a second DDA position, so a class tag can cover one of
   * the family's positions and miss the other. The COA families declare no
   * behavioralClasses, so "product-mix" reaches a position only through its own
   * tag; the base set's DDA binding derives "decay" for the whole family.
   */
  function classTaggedBook(tagged: readonly string[]): PortfolioSpec {
    const book = twoSidedBook("PF-CLASS-TAGGED");
    book.taxonomy = CLASS_TAXONOMY;
    book.positions = [...book.positions, nmdPosition("D2", { notional: 1_000_000 })].map((p) =>
      tagged.includes(p.id) ? { ...p, dimensions: { behavioralClasses: ["product-mix"] } } : p,
    );
    return book;
  }

  function planWithDecaySelector(selector: PlanStage["selector"]): RunPlan {
    return planWith([
      behavioralStage("st-prepay", "engine.behavioral.prepay"),
      behavioralStage("st-decay", "engine.behavioral.nmd-decay", selector),
      behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
    ]);
  }

  it("licenses a stage naming a class the family does not declare when every matched position tags it", () => {
    const out = licenseBindings(
      planWithDecaySelector({ behavioralClasses: "product-mix" }),
      SETS,
      classTaggedBook(["D1", "D2"]),
      PLUGIN_KINDS,
    );
    expect(out.unlicensed).toEqual([]);
    expect(out.multi).toEqual([]);
    expect(
      out.licensed.filter((l) => l.kind === "nmd-decay").map((l) => [l.stageId, l.bindingIndex]),
    ).toEqual([["st-decay", 1]]);
  });

  it("does not license it when one matched position lacks the tag, naming that position", () => {
    const out = licenseBindings(
      planWithDecaySelector({ behavioralClasses: "product-mix" }),
      SETS,
      classTaggedBook(["D1"]),
      PLUGIN_KINDS,
    );
    const gap = out.unlicensed.find((g) => g.kind === "nmd-decay")!;
    expect(gap.bindingIndex).toBe(1);
    expect(gap.uncoveredPositionId).toBe("D2");
    expect(gap.candidateStageIds).toEqual(["st-decay"]);
  });

  /**
   * The one direction in which the new rule REFUSES what the old one licensed.
   * Under 2a the family-level filter dropped the "product-mix" stage (DDA does
   * not declare the class), leaving one licensee. Once the class reaches the
   * position, both stages cover every matched position and the ambiguity is
   * real, so the binding is a compile refusal rather than a silent pick.
   */
  it("makes two stages differing only by class ambiguous once the positions tag both", () => {
    const out = licenseBindings(
      planWith([
        behavioralStage("st-prepay", "engine.behavioral.prepay"),
        behavioralStage("st-decay-derived", "engine.behavioral.nmd-decay", {
          behavioralClasses: "decay",
        }),
        behavioralStage("st-decay-tagged", "engine.behavioral.nmd-decay", {
          behavioralClasses: "product-mix",
        }),
        behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
      ]),
      SETS,
      classTaggedBook(["D1", "D2"]),
      PLUGIN_KINDS,
    );
    expect(out.unlicensed).toEqual([]);
    expect(out.multi).toEqual([
      {
        assumptionSetId: "AS-BASE",
        familyId: "DDA",
        kind: "nmd-decay",
        bindingIndex: 1,
        candidateStageIds: ["st-decay-derived", "st-decay-tagged"],
      },
    ]);
  });

  /**
   * The vacuous case, pinned. When the binding's family holds no position, the
   * per-position class test has nothing to fail on, so EVERY right-kind stage
   * whose family facets match licenses the binding. Two stages differing only
   * by class therefore both license it and compile refuses it as ambiguous,
   * where 2a's family-level class test left the derived-class stage alone.
   */
  it("licenses a binding matching no position through every class-split stage, so it is ambiguous", () => {
    const emptyDdaBook = classTaggedBook([]);
    emptyDdaBook.positions = emptyDdaBook.positions.filter((p) => p.familyId !== "DDA");
    const out = licenseBindings(
      planWith([
        behavioralStage("st-prepay", "engine.behavioral.prepay"),
        behavioralStage("st-decay-derived", "engine.behavioral.nmd-decay", {
          behavioralClasses: "decay",
        }),
        behavioralStage("st-decay-tagged", "engine.behavioral.nmd-decay", {
          behavioralClasses: "product-mix",
        }),
        behavioralStage("st-beta", "engine.behavioral.deposit-beta"),
      ]),
      SETS,
      emptyDdaBook,
      PLUGIN_KINDS,
    );
    expect(out.unlicensed).toEqual([]);
    expect(out.multi).toEqual([
      {
        assumptionSetId: "AS-BASE",
        familyId: "DDA",
        kind: "nmd-decay",
        bindingIndex: 1,
        candidateStageIds: ["st-decay-derived", "st-decay-tagged"],
      },
    ]);
    expect(out.multi[0]).not.toHaveProperty("uncoveredPositionId");
  });

  it("still licenses a stage naming a class the run derives for the family", () => {
    const out = licenseBindings(
      planWithDecaySelector({ behavioralClasses: "decay" }),
      SETS,
      classTaggedBook([]),
      PLUGIN_KINDS,
    );
    expect(out.unlicensed).toEqual([]);
    expect(out.multi).toEqual([]);
    expect(out.licensed.filter((l) => l.kind === "nmd-decay").map((l) => l.stageId)).toEqual([
      "st-decay",
    ]);
  });
});
