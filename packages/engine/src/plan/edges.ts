/**
 * The producer lookup, written once.
 *
 * An edge into a stage is resolved against the consumer's DIRECT `dependsOn`,
 * never against the transitive closure: a stage reads what it says it reads.
 * The compile half (the tightened T1 in the type gate) and the run half
 * (`resolveEdges` in the walker) both ask this question, and two copies of one
 * walk are two walks that can drift, so both call this function.
 *
 * It answers only "which stages in the direct dependsOn declare this type"; the
 * zero-producer fallbacks differ by caller. The gate falls back to the context
 * supply and reports a failure row; the walker falls back to the context supply
 * and throws. Neither policy belongs here.
 */
import type { ContractTypeName, PlanStage, RunPlan } from "../contracts/plan";

/**
 * The stages in `stage.dependsOn` that declare `type` in `produces`, in
 * dependsOn order. Exactly one is a resolved edge; zero and two or more are the
 * two refusals the callers own. A dependsOn id the plan does not carry is
 * skipped here: the dangling-dependency refusal belongs to the graph walk (T4
 * at compile, `topologicalOrder` at run), which names it better than an edge
 * lookup could.
 */
export function producersOf(
  plan: Pick<RunPlan, "stages">,
  stage: PlanStage,
  type: ContractTypeName,
): string[] {
  const byId = new Map(plan.stages.map((s) => [s.id, s]));
  const out: string[] = [];
  for (const id of stage.dependsOn ?? []) {
    const producer = byId.get(id);
    if (producer === undefined) continue;
    if ((producer.produces as readonly string[]).includes(type)) out.push(producer.id);
  }
  return out;
}
