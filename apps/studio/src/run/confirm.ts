// apps/studio/src/run/confirm.ts
/**
 * The confirm sheet's view model (Studio S3a). Every hash is a validate reply
 * field; a hash the server did not compute says why. The diff is structural
 * against the book's seeded plan, found by the seed convention plan-<book>.
 * Run is enabled only when the reply shows both gates passed and the compile
 * passed; a check that is pending, failed or unavailable never enables it.
 */
import type { RunPlan } from "@alm/engine";
import { planDiff, planDiffIsEmpty, seededPlanIdFor, type PlanDiff } from "@alm/reader";
import type { ValidateState } from "../pages/plan/useValidate";

export type DiffView =
  | { kind: "self"; seededId: string }
  | { kind: "no-seed"; seededId: string }
  | { kind: "same"; seededId: string }
  | { kind: "diff"; seededId: string; lines: string[] };

export interface ConfirmModel {
  planId: string;
  label: string;
  positionBook: string;
  asOf: string;
  planHashText: string;
  profileHashText: string;
  diff: DiffView;
  runEnabled: boolean;
}

export function diffLines(d: PlanDiff): string[] {
  return [
    ...d.componentChanges.map((c) => `${c.stageId}: ${c.from} to ${c.to}`),
    ...d.wiresAdded.map((w) => `Wire added: ${w.from} to ${w.to}`),
    ...d.wiresRemoved.map((w) => `Wire removed: ${w.from} to ${w.to}`),
    ...d.stagesAdded.map((s) => `Stage added: ${s}`),
    ...d.stagesRemoved.map((s) => `Stage removed: ${s}`),
  ];
}

function hashTexts(v: ValidateState): { plan: string; profile: string } {
  const both = (why: string) => ({ plan: `plan hash not computed: ${why}`, profile: `profile hash not computed: ${why}` });
  switch (v.state) {
    case "ok": {
      const c = v.reply.compile;
      if (!c.passed) return both(`compile refused (${c.error ?? "refused"}: ${c.detail ?? ""})`);
      return {
        plan: v.reply.planHash ?? "plan hash not returned by the server",
        profile: v.reply.profileHash ?? "profile hash not returned by the server",
      };
    }
    case "shape":
      return both(`malformed plan (${v.message})`);
    case "unavailable":
      return both(`validation unavailable (${v.message})`);
    default:
      return { plan: "checking", profile: "checking" };
  }
}

function diffView(plan: RunPlan, seeded: RunPlan | null): DiffView {
  const seededId = seededPlanIdFor(plan.inputs.positionBook);
  if (plan.planId === seededId) return { kind: "self", seededId };
  if (seeded === null) return { kind: "no-seed", seededId };
  const d = planDiff(seeded, plan);
  return planDiffIsEmpty(d) ? { kind: "same", seededId } : { kind: "diff", seededId, lines: diffLines(d) };
}

export function confirmModel(plan: RunPlan, seeded: RunPlan | null, v: ValidateState): ConfirmModel {
  const h = hashTexts(v);
  return {
    planId: plan.planId,
    label: plan.label,
    positionBook: plan.inputs.positionBook,
    asOf: plan.asOf,
    planHashText: h.plan,
    profileHashText: h.profile,
    diff: diffView(plan, seeded),
    runEnabled: v.state === "ok" && v.reply.compile.passed && v.reply.type.passed && v.reply.routing.passed,
  };
}
