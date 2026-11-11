// apps/studio/src/pages/run/runActions.ts
/** Run page reads and the submit (Studio S3a). Every value is a server reply; nothing is computed. */
import type { RunPlan } from "@alm/engine";
import {
  ApiError, getRun, getRunPlan, listRunPlans, listRuns, listWorkspaceRuns, runPlan, seededPlanIdFor, validatePlan,
  type RunPlanMeta, type RunSummary,
} from "@alm/reader";
import { classify, type ValidateState } from "../plan/useValidate";
import { pageErrText } from "../../errText";

export interface ConfirmData {
  plan: RunPlan;
  seeded: RunPlan | null;
  v: ValidateState;
}

/**
 * The plan store and the run list. Given a workspace, the runs are that workspace's attached runs only (review M2);
 * the plans stay the whole store, which the page says. Given a followed run, `endedAt` is its stored end time: read
 * off the list when the run is in it, otherwise off the run's own record (a run outside the workspace's list); an
 * unreadable record leaves it unset rather than failing the page.
 */
export async function loadRunPage(ws?: string, follow?: string): Promise<{ plans: RunPlanMeta[]; runs: RunSummary[]; endedAt?: string }> {
  const [plans, all, attached] = await Promise.all([listRunPlans(), listRuns(), ws === undefined ? Promise.resolve(null) : listWorkspaceRuns(ws)]);
  const ids = attached === null ? null : new Set(attached.map((r) => r.runId));
  const runs = ids === null ? all : all.filter((r) => ids.has(r.runId));
  if (follow === undefined) return { plans, runs };
  const listed = runs.find((r) => r.runId === follow);
  const endedAt = listed !== undefined ? listed.endedAt : await getRun(follow).then((d) => d.endedAt, () => undefined);
  return endedAt === undefined ? { plans, runs } : { plans, runs, endedAt };
}

/** The stored plan, its book's seeded plan when the store holds one, and one validate reply. */
export async function loadConfirm(planId: string, plans: RunPlanMeta[]): Promise<ConfirmData> {
  const plan = await getRunPlan(planId);
  const seededId = seededPlanIdFor(plan.inputs.positionBook);
  const seededP = seededId !== plan.planId && plans.some((p) => p.id === seededId) ? getRunPlan(seededId) : Promise.resolve(null);
  const [seeded, v] = await Promise.all([
    seededP,
    validatePlan(plan).then((reply): ValidateState => ({ state: "ok", reply }), classify),
  ]);
  return { plan, seeded, v };
}

/** One confirm answer, tagged with the plan id the sheet asked for. */
export interface ConfirmAnswer {
  planId: string;
  data: ConfirmData;
}

/**
 * The confirm data for the plan now on the sheet, or null while the answer in
 * hand was asked for another plan. A late or stale reply for plan A never
 * shows, or enables Run, while plan B is on the sheet.
 */
export function confirmFor(planId: string, answer: ConfirmAnswer | null): ConfirmData | null {
  return answer !== null && answer.planId === planId ? answer.data : null;
}

export type SubmitOutcome =
  | { kind: "submitted"; runId: string }
  | { kind: "refused"; status: number; code: string; message: string }
  | { kind: "failed"; message: string };

/** POST /api/plans/run with the stored plan. A 409 or 422 is the server's refusal, carried verbatim. */
export async function submitStoredPlan(plan: RunPlan): Promise<SubmitOutcome> {
  try {
    const r = await runPlan(plan, { label: plan.label });
    return { kind: "submitted", runId: r.runId };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
      return { kind: "refused", status: e.status, code: e.code, message: e.message };
    }
    return { kind: "failed", message: pageErrText(e) };
  }
}
