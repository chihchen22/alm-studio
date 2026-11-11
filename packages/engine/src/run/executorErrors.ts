/**
 * The executor's refusals. All typed, all carrying the run log
 * as far as the walk got, the way the 1b compile refusals do: a refusal with no
 * audit trail leaves a rejected run with less provenance than a successful one.
 *
 * A walker error is a refusal, not a partial answer. No result is returned and
 * no number is invented; the run log rides on the error so the caller can say
 * which stages ran before the one that could not.
 */
import type { ArtifactScope, ContractTypeName } from "../contracts/plan";
import { scopeKey } from "../contracts/plan";
import type { RunLogEntry } from "../contracts/runLog";

/** The base every executor refusal extends, so a caller can catch the family. */
export class ExecutorError extends Error {
  /** The run log as far as the walk got, attached by buildRunResult on the way out. */
  runLog?: RunLogEntry[];
  constructor(message: string) {
    super(message);
    this.name = "ExecutorError";
  }
}

/**
 * A plan the walker cannot order or wire: a cycle, a dangling dependsOn, a
 * consumed type with no producer or two producers in the direct dependsOn, or a
 * stage whose component and kind resolve to no stage function. T4 and the
 * tightened T1 refuse all of these at compile, so on a COMPILED plan this cannot
 * fire; it exists because a caller may hand the walker an uncompiled plan.
 */
export class PlanGraphError extends ExecutorError {
  readonly stageId: string | null;
  readonly detail: string;
  constructor(stageId: string | null, detail: string) {
    super(stageId === null ? `plan graph: ${detail}` : `plan graph at stage "${stageId}": ${detail}`);
    this.name = "PlanGraphError";
    this.stageId = stageId;
    this.detail = detail;
  }
}

/**
 * An artifact that should be on the shelf and is not. `role` says which half of
 * the edge failed: "consumer" is the edges-in check before a stage runs,
 * "producer" is a stage function that returned less than it declared, or a get
 * for a triple nothing put.
 */
export class ArtifactMissingError extends ExecutorError {
  readonly stageId: string;
  readonly type: ContractTypeName;
  readonly scope: ArtifactScope;
  readonly role: "consumer" | "producer";
  constructor(
    stageId: string,
    type: ContractTypeName,
    scope: ArtifactScope,
    role: "consumer" | "producer",
    detail?: string,
  ) {
    super(
      (role === "consumer"
        ? `stage "${stageId}" consumes "${type}" at scope ${scopeKey(scope)}, which nothing produced`
        : `stage "${stageId}" declares it produces "${type}" at scope ${scopeKey(scope)} but returned no such artifact`) +
        (detail === undefined ? "" : `; ${detail}`),
    );
    this.name = "ArtifactMissingError";
    this.stageId = stageId;
    this.type = type;
    this.scope = scope;
    this.role = role;
  }
}

/**
 * One shelf key written twice, or, at compile, two metric stages claiming one
 * result slot. At run time only a stage-function bug can raise it, which is the
 * bug it exists to catch.
 */
export class ArtifactConflictError extends ExecutorError {
  readonly type: ContractTypeName;
  readonly scope: ArtifactScope;
  readonly firstStageId: string;
  readonly secondStageId: string;
  constructor(type: ContractTypeName, scope: ArtifactScope, firstStageId: string, secondStageId: string) {
    super(
      `"${type}" at scope ${scopeKey(scope)} is produced by both "${firstStageId}" and "${secondStageId}"; ` +
        `one artifact has one producer`,
    );
    this.name = "ArtifactConflictError";
    this.type = type;
    this.scope = scope;
    this.firstStageId = firstStageId;
    this.secondStageId = secondStageId;
  }
}

/** A stage function returned a type the stage did not declare it produces. */
export class UndeclaredArtifactError extends ExecutorError {
  readonly stageId: string;
  readonly type: ContractTypeName;
  constructor(stageId: string, type: ContractTypeName) {
    super(
      `stage "${stageId}" returned "${type}", which it does not declare in produces; ` +
        `declare it or stop producing it, because nothing downstream may read an undeclared artifact`,
    );
    this.name = "UndeclaredArtifactError";
    this.stageId = stageId;
    this.type = type;
  }
}

/**
 * Compile, L1. A binding no behavioral stage licenses, or a binding two stages
 * license: a binding has exactly one licensee. `candidateStageIds` lists the
 * stages of the right kind that did not match (zero case) or that both matched
 * (two case), so the message is enough to fix the plan.
 */
export class UnlicensedBindingError extends ExecutorError {
  readonly assumptionSetId: string;
  readonly familyId: string;
  readonly kind: string;
  /**
   * Which binding of the set. Piece 2a lets one family carry two bindings of one
   * kind, split by selector, so the family and the kind alone no longer name the
   * thing to fix; the index does.
   */
  readonly bindingIndex: number;
  readonly candidateStageIds: string[];
  /**
   * Set when the stages of the right kind DO match the family but
   * their stage predicate leaves a position the binding matches uncovered: the
   * binding is licensed for the family and unlicensed for that position, which
   * is a different fix from "no selector matches the family".
   */
  readonly uncoveredPositionId?: string;
  /**
   * The component a stage must name to license this kind: the id of the plugin
   * that registered it, read off the mounted registry. Set only in the
   * zero-candidate case, where the fix is to ADD a stage and the plan holds no
   * example of the right one. Without it the message names the kind that is
   * unlicensed and leaves the author to guess the component, which is the whole
   * of the fix: `docs/harness/example-plan.json`'s `st-draw` row names
   * `alm-draw-rate-model` CORRECTLY, for the revolving-facility utilization
   * rows of the book it targets, so an author who copies it onto a commitment
   * book has nothing wrong to notice and nothing to point them at
   * `engine.behavioral.commitment-draw`.
   */
  readonly licensingComponent?: string;
  constructor(
    assumptionSetId: string,
    familyId: string,
    kind: string,
    bindingIndex: number,
    candidateStageIds: string[],
    uncoveredPositionId?: string,
    licensingComponent?: string,
  ) {
    super(
      candidateStageIds.length > 1
        ? `assumption set "${assumptionSetId}" bindings[${bindingIndex}] binds family "${familyId}" to behavioral kind "${kind}", ` +
            `which ${candidateStageIds.length} stages license: [${candidateStageIds.join(", ")}]; ` +
            `narrow one selector so exactly one stage owns the binding`
        : `assumption set "${assumptionSetId}" bindings[${bindingIndex}] binds family "${familyId}" to behavioral kind "${kind}", ` +
            `which no behavioral stage in the plan licenses` +
            (candidateStageIds.length === 0
              ? licensingComponent === undefined
                ? `; add a stage whose component registers "${kind}", which no mounted plugin does`
                : `; add a behavioral stage whose component is "${licensingComponent}", ` +
                  `the plugin that registers "${kind}"`
              : `; the stages of that kind are [${candidateStageIds.join(", ")}] and ` +
                (uncoveredPositionId === undefined
                  ? `no selector matches the family`
                  : `stage predicate does not cover position "${uncoveredPositionId}"`)),
    );
    this.name = "UnlicensedBindingError";
    this.assumptionSetId = assumptionSetId;
    this.familyId = familyId;
    this.kind = kind;
    this.bindingIndex = bindingIndex;
    this.candidateStageIds = candidateStageIds;
    if (uncoveredPositionId !== undefined) this.uncoveredPositionId = uncoveredPositionId;
    if (licensingComponent !== undefined) this.licensingComponent = licensingComponent;
  }
}

/** Compile, L2. The plan produces no stage for a result the envelope requires. */
export class RequiredMetricMissingError extends ExecutorError {
  readonly type: ContractTypeName;
  constructor(type: ContractTypeName) {
    super(
      `no stage in the plan produces "${type}"; the run envelope carries it on every result, ` +
        `so a plan that computes it nowhere is refused rather than answered with an empty block`,
    );
    this.name = "RequiredMetricMissingError";
    this.type = type;
  }
}

/** Compile. The plan names a taxonomy id the book does not carry. */
export class TaxonomyMismatchError extends ExecutorError {
  readonly planTaxonomyId: string;
  readonly bookTaxonomyId: string;
  constructor(planTaxonomyId: string, bookTaxonomyId: string) {
    super(
      `plan inputs.dimensionTaxonomy names "${planTaxonomyId}" but the position book carries taxonomy "${bookTaxonomyId}"; ` +
        `the book is the source, so name its taxonomy id or drop the plan field`,
    );
    this.name = "TaxonomyMismatchError";
    this.planTaxonomyId = planTaxonomyId;
    this.bookTaxonomyId = bookTaxonomyId;
  }
}

/**
 * Compile. A predicate on a binding or a stage names a tag the
 * taxonomy does not declare, or a value a closed tag refuses. A refusal rather
 * than a non-match: a misspelt tag that matched nothing would look like an empty
 * segment.
 */
export class UnknownDimensionError extends ExecutorError {
  readonly where: string;
  readonly dimension: string;
  readonly value?: string;
  constructor(where: string, dimension: string, value?: string) {
    super(
      value === undefined
        ? `${where}: selector names tag "${dimension}", which the book's taxonomy does not declare`
        : `${where}: selector names value "${value}" for tag "${dimension}", which the taxonomy does not allow`,
    );
    this.name = "UnknownDimensionError";
    this.where = where;
    this.dimension = dimension;
    if (value !== undefined) this.value = value;
  }
}

/**
 * Compile L3, and the applier's validation gate. Two bindings of one
 * kind match one position. Decay plus beta on one position is fine (two kinds);
 * two decays are a collision the run refuses rather than resolves.
 */
export class OverlappingBindingError extends ExecutorError {
  readonly assumptionSetId: string;
  readonly positionId: string;
  readonly kind: string;
  readonly firstIndex: number;
  readonly secondIndex: number;
  readonly firstSelector: string;
  readonly secondSelector: string;
  constructor(
    assumptionSetId: string,
    positionId: string,
    kind: string,
    firstIndex: number,
    secondIndex: number,
    firstSelector: string,
    secondSelector: string,
  ) {
    super(
      `assumption set "${assumptionSetId}": position "${positionId}" is matched by two "${kind}" bindings, ` +
        `bindings[${firstIndex}] (selector ${firstSelector === "" ? "<whole family>" : firstSelector}) and ` +
        `bindings[${secondIndex}] (selector ${secondSelector === "" ? "<whole family>" : secondSelector}); ` +
        `narrow one so no position is governed twice by one kind`,
    );
    this.name = "OverlappingBindingError";
    this.assumptionSetId = assumptionSetId;
    this.positionId = positionId;
    this.kind = kind;
    this.firstIndex = firstIndex;
    this.secondIndex = secondIndex;
    this.firstSelector = firstSelector;
    this.secondSelector = secondSelector;
  }
}

/**
 * A view that cannot partition the book. One class for three
 * rules because a caller handles all three the same way, and 2a's
 * UnknownDimensionError is not reused for P1: its message says "selector names
 * tag", which a view did not.
 *
 *   P1  the view names a tag the taxonomy does not declare, repeats one, or
 *       names none at all
 *   P2  the view groups on a multi-valued tag, so a position would belong to
 *       two groups and the sum over groups would exceed the book
 *   P3  a position carries no value for a grouped tag, so it would be lost or
 *       bucketed into an "(unset)" group this piece deliberately does not create
 */
export class ViewDefinitionError extends ExecutorError {
  readonly rule: "P1" | "P2" | "P3";
  readonly viewId: string;
  readonly dimension: string;
  readonly positionId?: string;
  constructor(
    rule: "P1" | "P2" | "P3",
    viewId: string,
    dimension: string,
    detail: string,
    positionId?: string,
  ) {
    super(
      `view "${viewId}" cannot partition the book (${rule}, dimension "${dimension}")` +
        (positionId !== undefined ? ` at position "${positionId}"` : "") +
        `: ${detail}`,
    );
    this.name = "ViewDefinitionError";
    this.rule = rule;
    this.viewId = viewId;
    this.dimension = dimension;
    if (positionId !== undefined) this.positionId = positionId;
  }
}

/**
 * A static pass whose predicted peak sits above the cell budget.
 *
 * Piece 2b moved accumulation to cell grain. The limitations page and
 * `run/__tests__/cardinality.test.ts` put a MEASURED formula on what that
 * costs: `CHUNK_METRICS * cells * horizon * 8` bytes per sink, one master sink
 * per scenario on both paths, and on the sharded path one retained chunk buffer
 * per (group, scenario, chunk) triple until it posts. A 100,000-position book
 * under a per-account view needs about 174 GiB of that. Before this refusal
 * such a run died as an out-of-memory that took the process with it, and the
 * arithmetic needs nothing that is not already in hand, so it is checked before
 * the first allocation rather than discovered during it.
 *
 * The ceiling is a BYTE budget and not a cell count, because the same
 * cardinality is cheap on a small book and fatal on a large one: at 4 GiB the
 * sharded path admits roughly 14,900 cells on a 10,000-position book and
 * roughly 2,300 on a 100,000-position one.
 *
 * Since piece 2c the same prediction runs in `plan/compile.ts` after the
 * scenarios resolve, so a platform-submitted plan over budget is refused at
 * submit as a 422 (`executorRefused` in the plan routes maps every
 * ExecutorError), and this name is in the server's `validationNames` table as
 * the net under any route that does not catch it. The run-time check here
 * stays as the hard stop for engine-API callers that form groups differently.
 */
export class CellBudgetError extends ExecutorError {
  readonly viewIds: string[];
  readonly cellCount: number;
  readonly positionCount: number;
  readonly scenarioCount: number;
  readonly workerCount: number;
  readonly predictedBytes: number;
  readonly budgetBytes: number;
  constructor(
    viewIds: string[],
    cellCount: number,
    positionCount: number,
    scenarioCount: number,
    workerCount: number,
    predictedBytes: number,
    budgetBytes: number,
  ) {
    const from = viewIds.length === 0 ? "the identity plan" : `view(s) ${viewIds.join(", ")}`;
    super(
      `cell budget: the static pass over ${cellCount} cells from ${from}, on ${positionCount} ` +
        `positions across ${scenarioCount} scenarios and ${workerCount} worker(s), is predicted ` +
        `to peak at ${predictedBytes} bytes, above the budget of ${budgetBytes}. Declare a ` +
        `coarser view, or raise the budget on a host with the headroom.`,
    );
    this.name = "CellBudgetError";
    this.viewIds = viewIds;
    this.cellCount = cellCount;
    this.positionCount = positionCount;
    this.scenarioCount = scenarioCount;
    this.workerCount = workerCount;
    this.predictedBytes = predictedBytes;
    this.budgetBytes = budgetBytes;
  }
}

/**
 * A custom metric function returned a result that breaks the CustomMetricResult
 * contract (spec Section 2 rules C1 to C5).
 *
 * It FAILS THE RUN, the same class of failure as ArtifactMissingError. A
 * partially valid custom block on the envelope would be a number nobody can
 * trace, and the platform publishes no such thing: the run refuses, naming the
 * metric, the stage, the rule and the first problem.
 */
export class CustomMetricShapeError extends ExecutorError {
  readonly metricId: string;
  readonly stageId: string;
  readonly rule: string;
  constructor(metricId: string, stageId: string, rule: string, detail: string) {
    super(
      `custom metric "${metricId}" at stage "${stageId}" returned a result that breaks the ` +
        `CustomMetricResult contract (${rule}): ${detail}`,
    );
    this.name = "CustomMetricShapeError";
    this.metricId = metricId;
    this.stageId = stageId;
    this.rule = rule;
  }
}

/**
 * Piece 7 final fix, item 2b. A position whose `terms.type` and whose family's
 * `instrumentType` disagree about being a `commitment`, in either direction.
 *
 * The engine reads that one fact two ways on purpose (the gap ladder keys on
 * the POSITION's terms because it holds an Instrument; every other guarded fold
 * keys on the FAMILY's instrumentType because it walks family-grain series),
 * and both readings are correct only while the mapping holds. The
 * intake validator cannot enforce it for this type, because it refuses a
 * commitment family and a commitment position outright before the mapping rule
 * runs, so the assertion lives in the engine. See
 * `commitment/offBalanceSheet.ts` for what a mismapped book computes instead of
 * throwing.
 */
export class CommitmentFamilyMappingError extends ExecutorError {
  readonly positionId: string;
  readonly familyId: string;
  readonly termsType: string;
  readonly instrumentType: string;
  constructor(positionId: string, familyId: string, termsType: string, instrumentType: string) {
    super(
      `position "${positionId}" carries terms.type "${termsType}" but sits in family "${familyId}", ` +
        `whose instrumentType is "${instrumentType}"; exactly one of the two says "commitment". ` +
        `An undrawn committed line is off balance sheet and is kept out of every asset aggregate by ` +
        `the family's instrumentType, while the gap ladder reads the position's terms.type, so a book ` +
        `that disagrees is guarded by one set of folds and not the other and produces silently wrong ` +
        `numbers rather than a refusal. Put commitment terms in a commitment family, or neither`,
    );
    this.name = "CommitmentFamilyMappingError";
    this.positionId = positionId;
    this.familyId = familyId;
    this.termsType = termsType;
    this.instrumentType = instrumentType;
  }
}

/**
 * A position whose `terms.type`, whose family's `instrumentType` and
 * whose family's side disagree about being a swap. Every fold reads the
 * family side and the gap ladder reads the position's terms.type, so a book
 * that disagrees is folded one way by some and another way by others. See
 * `swap/derivatives.ts`.
 */
export class SwapFamilyMappingError extends ExecutorError {
  readonly positionId: string;
  readonly familyId: string;
  readonly termsType: string;
  readonly instrumentType: string;
  readonly side: string;
  constructor(positionId: string, familyId: string, termsType: string, instrumentType: string, side: string) {
    super(
      `position "${positionId}" carries terms.type "${termsType}" and sits in family "${familyId}", ` +
        `whose instrumentType is "${instrumentType}" and whose side is "${side}". A swap must sit in a ` +
        `family whose instrumentType is "swap" and whose side is "derivative", and a family with either ` +
        `property must have both. The folds read the family side while the gap ladder reads the ` +
        `position's terms.type, so a book that disagrees produces silently wrong numbers rather than a ` +
        `refusal. Put swap terms in a swap family declared side "derivative", or use none of the three`,
    );
    this.name = "SwapFamilyMappingError";
    this.positionId = positionId;
    this.familyId = familyId;
    this.termsType = termsType;
    this.instrumentType = instrumentType;
    this.side = side;
  }
}
