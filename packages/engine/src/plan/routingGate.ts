/**
 * The routing gate (harness Plane 4): is the plan ALLOWED. R1 and R2 read the
 * routing policy; R3 and R4 read the book ONE POSITION AT A TIME.
 * Selectors bind on productFamily, side (lowercase compare) and
 * behavioralClasses, the last the union of the classes the COA family
 * declares, the classes the position itself tags, and the classes the
 * assumption bindings derive (see classesOfPosition in behavioralClasses.ts),
 * and then on selector.dimensions against the position's effective bag.
 */
import type { AssumptionSet } from "../contracts/assumptions";
import type { GateFailure, GateReport, PlanStage, RoutingPolicy, RunPlan } from "../contracts/plan";
import type { PortfolioSpec } from "../contracts/position";
import { dimensionsOf } from "../portfolio/dimensions";
import { classesOfPosition, derivedClassesByFamily } from "./behavioralClasses";
// The family matcher moved to ./dimensions so the bag form sits beside
// it. Re-exported here so every existing importer keeps working.
import { canonicalPredicate, selectorMatchesFamily, stageSelectorMatchesPosition } from "./dimensions";

export { selectorMatchesFamily };

function fail(rule: GateFailure["rule"], stageId: string | null, detail: string): GateFailure {
  return { gate: "routing", rule, stageId, detail };
}
function list<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function routingGate(
  plan: RunPlan,
  policy: RoutingPolicy,
  portfolio: PortfolioSpec,
  assumptionSets: AssumptionSet[],
): GateReport {
  const failures: GateFailure[] = [];
  const checked: string[] = [];
  const classById = new Map(policy.classes.map((c) => [c.id, c]));
  const derived = derivedClassesByFamily(assumptionSets, portfolio.coa.families);
  const familiesInBook = new Set(portfolio.positions.map((p) => p.familyId));
  const behavioral = plan.stages.filter((s) => s.kind === "behavioral");

  // R1 and R2: policy. A behavioral stage the gate cannot check is itself a
  // failure: without a declared class there is nothing to route, and without a
  // feeds array there is nothing to route INTO.
  for (const s of behavioral) {
    const declared = list(s.selector?.behavioralClasses);
    if (declared.length === 0) {
      failures.push(fail("R1", s.id, "behavioral stage must declare selector.behavioralClasses (the routing gate cannot check a stage with no class)"));
    }
    if (s.feeds === undefined) {
      failures.push(fail("R1", s.id, "behavioral stage must declare feeds (an empty array means the stage feeds no metric)"));
    }
    for (const cls of declared) {
      const rule = classById.get(cls);
      if (!rule) { failures.push(fail("R1", s.id, `behavioral class "${cls}" is not in routing policy ${policy.id}`)); continue; }
      for (const m of s.feeds ?? []) {
        const v = rule.routing[m];
        if (v === "none") failures.push(fail("R1", s.id, `class "${cls}" may not feed metric "${m}" (policy says none)`));
        else if (v === "A" && s.disposition === "M") {
          const override = s.params?.override;
          if (typeof override === "string" && override.length > 0) checked.push(`R2 ${s.id}: M routed to "${m}" (policy A) under override: ${override}`);
          else failures.push(fail("R2", s.id, `disposition M routed to metric "${m}" which the policy marks A for class "${cls}"; declare params.override with the reason`));
        }
      }
    }
  }
  checked.push(`R1 ${behavioral.length} behavioral stages checked against policy ${policy.id}`);
  checked.push("R1 every behavioral stage must declare selector.behavioralClasses and feeds; an unclassed stage covers nothing under R4");
  checked.push("R2 M-to-A routings require params.override");

  // The gate reads the bag per position. One bag and one class set
  // per position, computed once here and shared by R3 and R4.
  const familyById = new Map(portfolio.coa.families.map((f) => [f.id, f]));
  const perPosition = portfolio.positions.map((p) => {
    const fam = familyById.get(p.familyId);
    if (fam === undefined) return undefined;
    return {
      fam,
      bag: dimensionsOf(p, fam, portfolio.taxonomy),
      classes: classesOfPosition(p, fam, derived.get(fam.id), portfolio.taxonomy),
    };
  });

  // R3: every selector binds to at least one position.
  for (const s of behavioral) {
    let n = 0;
    for (const e of perPosition) {
      if (e === undefined) continue;
      if (stageSelectorMatchesPosition(s.selector, e.bag, e.classes)) n++;
    }
    if (n === 0) failures.push(fail("R3", s.id, `selector ${JSON.stringify(s.selector ?? {})} (dimensions ${canonicalPredicate(s.selector?.dimensions) || "<none>"}) matches no position in portfolio ${portfolio.id}`));
    else checked.push(`R3 ${s.id} matches ${n} position${n === 1 ? "" : "s"}`);
  }
  checked.push(`R3 selectors bound against ${portfolio.positions.length} positions in ${familiesInBook.size} families`);

  // R4: every (position, class) pair has a behavioral stage declaring the class
  // and matching the position, predicate included.
  const uncoveredCount = new Map<string, number>();
  for (const e of perPosition) {
    if (e === undefined) continue;
    for (const cls of e.classes) {
      const covered = behavioral.some((st: PlanStage) => {
        const want = list(st.selector?.behavioralClasses);
        // An unclassed stage covers nothing: it already failed R1 and the gate
        // must not let it mask an uncovered position.
        return want.includes(cls) && stageSelectorMatchesPosition(st.selector, e.bag, new Set([cls]));
      });
      if (!covered) {
        const k = `${e.fam.id}:${cls}`;
        uncoveredCount.set(k, (uncoveredCount.get(k) ?? 0) + 1);
      }
    }
  }
  if (uncoveredCount.size > 0) {
    const lines = [...uncoveredCount].map(([k, n]) => `${k} (${n} position${n === 1 ? "" : "s"})`);
    failures.push(fail("R4", null, `positions carry behavioral classes with no matching behavioral stage: ${lines.join(", ")}`));
  }
  checked.push(`R4 ${portfolio.positions.length} positions checked for class coverage`);

  return { passed: failures.length === 0, failures, checked };
}
