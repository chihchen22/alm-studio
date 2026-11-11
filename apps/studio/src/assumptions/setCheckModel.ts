// apps/studio/src/assumptions/setCheckModel.ts
/**
 * Edit a set > Check against a plan (Set Check). The draft is sent to POST
 * /api/plans/validate as a candidate under its source set's id, where it stands
 * in for the stored set in one compile of a stored plan that reads that set;
 * nothing is stored. The answer is the compile's own: "Passes", or the gate
 * failures (rule, stage, detail) and the compile refusal (class, detail, which
 * names the binding). The check never holds Save off: saveBlock takes no check.
 * Pure functions; the page holds the state.
 */
import type { AssumptionSet, RunPlan } from "@alm/engine";
import { checkSetAgainstPlan, getRunPlan, listRunPlans, type RunPlanMeta, type ValidateResponse } from "@alm/reader";
import { pageErrText } from "../errText";
import { savePayload, type SetDraft } from "./setEditModel";

/** A stored plan and the assumption set ids its inputs name. */
export interface PlanReads { id: string; label: string; setIds: string[] }

/** Every stored plan read in full, and how many could not be. */
export interface PlansRead { plans: PlanReads[]; unread: number }

/**
 * Read the stored plans: the list, then every listed plan, since the list rows
 * do not carry the sets a plan reads. A plan that cannot be read is left out and
 * counted, never swallowed; a list that cannot be read rejects the whole read.
 */
export async function readPlans(
  list: () => Promise<RunPlanMeta[]> = listRunPlans,
  get: (id: string) => Promise<RunPlan> = getRunPlan,
): Promise<PlansRead> {
  const listed = await list();
  const reads = await Promise.allSettled(listed.map((m) => get(m.id)));
  const plans = reads.flatMap((r, i): PlanReads[] => {
    if (r.status !== "fulfilled") return [];
    const m = listed[i]!;
    return [{ id: m.id, label: m.label ?? m.id, setIds: [...(r.value.inputs?.assumptionSets ?? [])] }];
  });
  return { plans, unread: reads.filter((r) => r.status === "rejected").length };
}

/** The plans whose inputs name the set: the only plans a draft of it can stand in for. */
export function plansReading(plans: readonly PlanReads[], setId: string): PlanReads[] {
  return plans.filter((p) => p.setIds.includes(setId));
}

/** A plan in the picker: "<id>: <label>", or the id alone when the label is the id. */
export function planOptionText(p: PlanReads): string {
  return p.label !== "" && p.label !== p.id ? `${p.id}: ${p.label}` : p.id;
}

/** Why the picker offers no plan, or not every plan; null when nothing is missing. */
export function plansNoteOf(read: PlansRead, setId: string): string | null {
  if (read.unread > 0) {
    return read.unread === 1 ? "1 stored plan could not be read; it is not offered." : `${read.unread} stored plans could not be read; they are not offered.`;
  }
  return plansReading(read.plans, setId).length === 0 ? `No stored plan reads ${setId}, so there is no plan to check against.` : null;
}

/** One check's answer: a pass, a refusal in lines, or a request that did not get an answer. */
export type CheckOutcome =
  | { kind: "passes"; planId: string }
  | { kind: "refused"; planId: string; lines: string[] }
  | { kind: "failed"; planId: string; text: string };

/**
 * The validate reply as an outcome. Each gate failure is "<rule> at stage
 * <stage>: <detail>" (or "at the plan" when it names none). The compile refusal
 * is "<class>: <detail>", left out only when it is PlanRejected restating gate
 * failures already listed (the Plan page's rule, gatePaint).
 */
export function outcomeOf(planId: string, reply: ValidateResponse): CheckOutcome {
  if (reply.compile.passed) return { kind: "passes", planId };
  const failures = [...reply.type.failures, ...reply.routing.failures];
  const lines = failures.map((f) => `${f.rule} at ${f.stageId === null ? "the plan" : `stage ${f.stageId}`}: ${f.detail}`);
  if (!(reply.compile.error === "PlanRejected" && failures.length > 0)) {
    lines.push(`${reply.compile.error ?? "Refused"}: ${reply.compile.detail ?? ""}`);
  }
  return { kind: "refused", planId, lines };
}

/** The reads one check makes; parameters so a test can see what is sent. */
export interface CheckDeps {
  getPlan(id: string): Promise<RunPlan>;
  check(plan: unknown, candidate: AssumptionSet): Promise<ValidateResponse>;
}

/**
 * One check: the stored plan as stored, and the draft as Save would post it but
 * under its SOURCE set's id, which is how the server knows which stored set it
 * stands in for. Any failed request is its text (pageErrText), never a pass.
 */
export async function checkDraft(
  draft: SetDraft,
  planId: string,
  deps: CheckDeps = { getPlan: getRunPlan, check: checkSetAgainstPlan },
): Promise<CheckOutcome> {
  try {
    const plan = await deps.getPlan(planId);
    return outcomeOf(planId, await deps.check(plan, savePayload(draft, draft.source.id)));
  } catch (e) {
    return { kind: "failed", planId, text: pageErrText(e) };
  }
}

/** The outcome's first line. */
export function checkHeadline(o: CheckOutcome): string {
  if (o.kind === "passes") return `Passes plan ${o.planId}`;
  return o.kind === "refused" ? `Refused by plan ${o.planId}` : `Not checked against plan ${o.planId}`;
}

/** Why Check is off, or null when it is on. */
export function checkBlock(planId: string | null, checking: string | null): string | null {
  if (checking !== null) return `Checking against ${checking}`;
  return planId === null ? "Pick a plan to check against" : null;
}

/** A check's outcome, stamped with the draft's edit count and the plan picked at the Check click. */
export interface CheckNote { outcome: CheckOutcome; edits: number; planId: string }

/** The check to show: only while the draft has had no edit since, and the same plan is picked (the save note's rule). */
export function checkShown(note: CheckNote | null, edits: number, planId: string | null): CheckNote | null {
  return note !== null && note.edits === edits && note.planId === planId ? note : null;
}
