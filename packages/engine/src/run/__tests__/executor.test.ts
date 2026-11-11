/**
 * Spec Section 8.2. The walker on a toy catalog: order, the two skip reasons,
 * the edges-in miss, the edges-out miss, the undeclared artifact, and the shape
 * of the `stage` log line. No engine function runs here; the stage functions are
 * replaced so the test measures the walker and nothing else.
 */
import { describe, expect, it, vi } from "vitest";
import type { ContractTypeName, PlanStage, RunPlan } from "../../contracts/plan";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunLogEntry } from "../../contracts/runLog";
import { buildCellPlan } from "../../portfolio/cells";
import {
  ArtifactMissingError,
  PlanGraphError,
  UndeclaredArtifactError,
} from "../executorErrors";
import { executePlan, resolveEdges, topologicalOrder } from "../executor";
import type { StageFn, StageRunEnv } from "../stages";

function stage(
  id: string,
  kind: PlanStage["kind"],
  consumes: ContractTypeName[],
  produces: ContractTypeName[],
  dependsOn: string[] = [],
): PlanStage {
  return { id, component: `toy.${id}`, kind, consumes, produces, dependsOn };
}

function plan(stages: PlanStage[]): RunPlan {
  return {
    schemaVersion: "1.4.0",
    planId: "PLAN-TOY",
    label: "toy",
    authoredBy: "person",
    asOf: "2026-01-01",
    grid: { horizonMonths: 12 },
    inputs: { marketSnapshot: "m", positionBook: "p", routingPolicy: "r" },
    stages,
    scenarios: [],
    reports: [],
    validationRules: { typeGate: [], routingGate: [] },
  };
}

/**
 * The toy book: empty, so the walker measures the walk and nothing else. Hoisted
 * out of the env literal because the cell plan is built FROM it, and two copies
 * of the same book would be two books.
 */
const toyBook: PortfolioSpec = { id: "P", label: "P", asOf: "2026-01-01", coa: { schemaVersion: "1.0.0", nodes: [], families: [] }, positions: [] };

/**
 * A walker env with no seams: the toy stage functions never touch them.
 * `scopes` populates the scenario and assumption-set axes, which is what makes
 * the scoped halves of the edges-out check and of `gather` reachable: with both
 * empty, every non-run `scopesOf` is an empty list and those branches never run.
 */
function toyEnv(
  log: RunLogEntry[],
  scopes: { scenarioIds?: string[]; assumptionSetIds?: string[] } = {},
): StageRunEnv {
  const scenarios = (scopes.scenarioIds ?? []).map(
    (id) => ({ id, label: id, rateSpec: { kind: "base" }, assumptionSetId: "AS", newBusiness: { mode: "static", rules: [] } }) as never,
  );
  return {
    request: { runId: "R", portfolioId: "P", marketSnapshot: {} as never, scenarios, assumptionSets: [], grid: { horizonMonths: 12, asOf: "2026-01-01" }, seed: "1", timestamps: { startedAt: "", finishedAt: "" } },
    portfolio: toyBook,
    cellPlan: buildCellPlan(toyBook, undefined),
    grid: { horizonMonths: 12, asOf: "2026-01-01" },
    horizonMonths: 12,
    baseScenario: { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS", newBusiness: { mode: "static", rules: [] } },
    setById: new Map((scopes.assumptionSetIds ?? []).map((id) => [id, {} as never])),
    assumptionSetIds: scopes.assumptionSetIds ?? [],
    shards: undefined,
    curves: {} as never,
    ratePaths: {} as never,
    behavioral: {} as never,
    metrics: {} as never,
    licensedBindings: [],
    positionsMatched: new Map<string, number>(),
    shortfalls: new Map(),
    newBusiness: new Map(),
    notImplemented: [],
    log: (e) => log.push(e),
  };
}

/** Replace the kind-to-function table for one call. */
function withStages(table: Record<string, StageFn>) {
  return { stageFunctions: table };
}

describe("topologicalOrder", () => {
  it("orders on dependsOn and breaks ties by plan order", () => {
    const p = plan([
      stage("c", "metric", [], ["NiiResult"], ["a", "b"]),
      stage("a", "curve", [], ["ZeroCurve"]),
      stage("b", "curve", [], ["ZeroCurve"]),
    ]);
    expect(topologicalOrder(p).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("throws PlanGraphError on a cycle, naming a stage in it", () => {
    const p = plan([stage("a", "curve", [], ["ZeroCurve"], ["b"]), stage("b", "curve", [], ["ZeroCurve"], ["a"])]);
    expect(() => topologicalOrder(p)).toThrow(PlanGraphError);
  });

  it("throws PlanGraphError on a dangling dependsOn", () => {
    const p = plan([stage("a", "curve", [], ["ZeroCurve"], ["ghost"])]);
    expect(() => topologicalOrder(p)).toThrow(/ghost/);
  });
});

describe("resolveEdges", () => {
  it("resolves a consumed type to the one producer in the direct dependsOn", () => {
    const p = plan([
      stage("a", "curve", [], ["ZeroCurve"]),
      stage("b", "term-structure", ["ZeroCurve"], ["RatePath"], ["a"]),
    ]);
    expect(resolveEdges(p, p.stages[1]!).get("ZeroCurve")).toBe("a");
  });

  it("resolves a context-supplied type with no producer to <context>", () => {
    const p = plan([stage("a", "behavioral", ["Position"], ["Position"])]);
    expect(resolveEdges(p, p.stages[0]!).get("Position")).toBe("<context>");
  });

  it("prefers a direct producer over the context supply", () => {
    const p = plan([
      stage("a", "behavioral", ["Position"], ["Position"]),
      stage("b", "behavioral", ["Position"], ["Position"], ["a"]),
    ]);
    expect(resolveEdges(p, p.stages[1]!).get("Position")).toBe("a");
  });

  it("refuses zero producers for a type the context does not supply", () => {
    const p = plan([stage("a", "metric", ["Cashflow"], ["NiiResult"])]);
    expect(() => resolveEdges(p, p.stages[0]!)).toThrow(/Cashflow/);
  });

  it("refuses two producers of one consumed type in the direct dependsOn", () => {
    const p = plan([
      stage("a", "curve", [], ["ZeroCurve"]),
      stage("b", "curve", ["ZeroCurve"], ["ZeroCurve"], ["a"]),
      stage("c", "metric", ["ZeroCurve"], ["EveResult"], ["a", "b"]),
    ]);
    expect(() => resolveEdges(p, p.stages[2]!)).toThrow(/two or more/);
  });
});

describe("executePlan", () => {
  const passThrough: StageFn = (_env, s, input) => ({ run: { [s.produces[0]!]: input.run[s.consumes[0]!] ?? "seed" } });

  it("runs the stages in topological order and logs one stage entry each", () => {
    const log: RunLogEntry[] = [];
    const p = plan([
      stage("a", "curve", [], ["ZeroCurve"]),
      stage("b", "metric", ["ZeroCurve"], ["NiiResult"], ["a"]),
    ]);
    const out = executePlan(p, toyEnv(log), withStages({ a: passThrough, b: passThrough }));
    expect(out.order).toEqual(["a", "b"]);
    const stages = log.filter((e): e is Extract<RunLogEntry, { t: "stage" }> => e.t === "stage");
    expect(stages.map((e) => e.stageId)).toEqual(["a", "b"]);
    expect(stages[1]!.consumed).toEqual([{ type: "ZeroCurve", scope: "run", producerStageId: "a" }]);
    expect(stages[1]!.produced).toEqual([{ type: "NiiResult", scope: "run" }]);
    expect(stages[1]!.skipped).toBeUndefined();
    expect(out.metricProducers.get("NiiResult")).toBe("b");
  });

  it("skips a stage the compile tolerated, putting nothing on the shelf", () => {
    const log: RunLogEntry[] = [];
    const p = plan([
      stage("a", "curve", [], ["ZeroCurve"]),
      stage("x", "behavioral", ["ZeroCurve"], ["ClientRatePath"], ["a"]),
      stage("b", "metric", ["ZeroCurve"], ["NiiResult"], ["a"]),
    ]);
    const out = executePlan(p, toyEnv(log), {
      ...withStages({ a: passThrough, b: passThrough }),
      unexecutedStageIds: new Set(["x"]),
    });
    const x = log.find((e) => e.t === "stage" && e.stageId === "x") as Extract<RunLogEntry, { t: "stage" }>;
    expect(x.skipped).toBe("not-executable");
    expect(x.produced).toEqual([]);
    expect(out.shelf.has("ClientRatePath", { kind: "run" }, "x")).toBe(false);
  });

  it("marks a behavioral stage that licenses no binding as skipped, and still runs it", () => {
    const log: RunLogEntry[] = [];
    // A behavioral stage writes at assumptionSet scope, so its declared Position
    // comes back in the assumptionSet bag, keyed by set id.
    const overlay: StageFn = (_e, _s, input) => ({
      assumptionSet: { Position: new Map([["AS", `overlaid:${String(input.run.Position)}`]]) },
    });
    const ran = vi.fn(overlay);
    const p = plan([stage("a", "behavioral", ["Position"], ["Position"])]);
    const out = executePlan(p, toyEnv(log, { assumptionSetIds: ["AS"] }), {
      ...withStages({ a: ran }),
      contextArtifacts: { Position: "book" },
    });
    const entry = log.find((e) => e.t === "stage") as Extract<RunLogEntry, { t: "stage" }>;
    expect(entry.skipped).toBe("no-binding");
    expect(entry.produced).toEqual([{ type: "Position", scope: "assumptionSet" }]);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(out.shelf.get("Position", { kind: "assumptionSet", assumptionSetId: "AS" }, "a")).toBe("overlaid:book");
  });

  it("puts a scenario-scope artifact once per scenario and hands it back scoped", () => {
    const log: RunLogEntry[] = [];
    const p = plan([
      stage("a", "curve", [], ["ZeroCurve"]),
      stage("b", "term-structure", ["ZeroCurve"], ["RatePath"], ["a"]),
      stage("c", "metric", ["RatePath"], ["NiiResult"], ["b"]),
    ]);
    let seenAtC: unknown;
    const out = executePlan(
      p,
      toyEnv(log, { scenarioIds: ["S1", "S2"] }),
      withStages({
        a: () => ({ run: { ZeroCurve: "z" } }),
        b: (_e, _s, input) => ({
          scenario: {
            RatePath: new Map([
              ["S1", `path:S1:${String(input.run.ZeroCurve)}`],
              ["S2", `path:S2:${String(input.run.ZeroCurve)}`],
            ]),
          },
        }),
        c: (_e, _s, input) => {
          seenAtC = input.scenario.RatePath;
          return { run: { NiiResult: 1 } };
        },
      }),
    );
    expect(out.shelf.get("RatePath", { kind: "scenario", scenarioId: "S1" }, "b")).toBe("path:S1:z");
    expect(out.shelf.get("RatePath", { kind: "scenario", scenarioId: "S2" }, "b")).toBe("path:S2:z");
    expect([...(seenAtC as ReadonlyMap<string, unknown>)]).toEqual([
      ["S1", "path:S1:z"],
      ["S2", "path:S2:z"],
    ]);
    const atC = log.find((e) => e.t === "stage" && e.stageId === "c") as Extract<RunLogEntry, { t: "stage" }>;
    expect(atC.consumed).toEqual([{ type: "RatePath", scope: "scenario", producerStageId: "b" }]);
  });

  it("refuses a scenario-scope stage that fills only some of the scenarios", () => {
    const log: RunLogEntry[] = [];
    const p = plan([stage("a", "term-structure", [], ["RatePath"])]);
    const half: StageFn = () => ({ scenario: { RatePath: new Map([["S1", "path"]]) } });
    expect(() =>
      executePlan(p, toyEnv(log, { scenarioIds: ["S1", "S2"] }), withStages({ a: half })),
    ).toThrow(ArtifactMissingError);
  });

  it("refuses a declared type returned in the bag of another scope", () => {
    const log: RunLogEntry[] = [];
    const p = plan([stage("a", "behavioral", ["Position"], ["Position"])]);
    // A behavioral stage writes at assumptionSet scope; this one answers at run
    // scope, where nothing downstream would ever look for it.
    const wrongBag: StageFn = () => ({ run: { Position: "book" } });
    expect(() =>
      executePlan(p, toyEnv(log, { assumptionSetIds: ["AS"] }), {
        ...withStages({ a: wrongBag }),
        contextArtifacts: { Position: "book" },
      }),
    ).toThrow(/writes at assumptionSet scope/);
  });

  it("refuses when a stage function returns less than it declared", () => {
    const log: RunLogEntry[] = [];
    const p = plan([stage("a", "curve", [], ["ZeroCurve", "RatePath"])]);
    const partial: StageFn = () => ({ run: { ZeroCurve: 1 } });
    expect(() => executePlan(p, toyEnv(log), withStages({ a: partial }))).toThrow(ArtifactMissingError);
  });

  it("refuses when a stage function returns a type it did not declare", () => {
    const log: RunLogEntry[] = [];
    const p = plan([stage("a", "curve", [], ["ZeroCurve"])]);
    const extra: StageFn = () => ({ run: { ZeroCurve: 1, RatePath: 2 } });
    expect(() => executePlan(p, toyEnv(log), withStages({ a: extra }))).toThrow(UndeclaredArtifactError);
  });

  it("refuses when an edge in points at a producer that put nothing", () => {
    const log: RunLogEntry[] = [];
    const p = plan([
      stage("a", "curve", [], ["ZeroCurve"]),
      stage("b", "metric", ["ZeroCurve"], ["NiiResult"], ["a"]),
    ]);
    const empty: StageFn = (_e, s) => (s.id === "a" ? { run: { ZeroCurve: undefined } } : { run: { NiiResult: 1 } });
    expect(() => executePlan(p, toyEnv(log), withStages({ a: empty, b: empty }))).toThrow(ArtifactMissingError);
  });
});
