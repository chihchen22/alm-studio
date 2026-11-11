// apps/studio/src/guided/exampleAnalysis.ts
/**
 * "Explore the example bank" opens a finished analysis: the example bank on the newest
 * market snapshot, its illustrative behavior models, every balance held at its opening level with each family's
 * product, the parallel rate grid, going-concern value on its 12-month default and the published SOFR history as the
 * deposits' warm-up, then one run, launched at once unless readiness holds a note to confirm (the Run step then asks). Every write is one the guided steps make themselves, through the
 * same routes, so each step opens on what was set and the learner can change any of it.
 *
 * Pure helpers first (the documents the steps would write), then the one async call the start choice makes.
 */
import {
  archiveWorkspace, createAssumptionSet, getExampleAnalysis, getReadiness, getRun, getWorkspace, launchSetup, listAssumptionSets, listBalancePlans,
  saveBalancePlan, saveRunSetup, setBlock, type ExampleAnalysis, type RunSetup, type WorkspaceManifest,
} from "@alm/reader";
import type { AssumptionSet, BalancePlan } from "@alm/engine";
import { GUIDED_SLOT } from "./steps";
import { guidedSetupBody, withNewVolumeViews, withTemplates, type MaturingAnswer } from "./setup";
import { nextGuidedSetId } from "./behavior";

/** The guided behavior set the analysis saves, under the id the Behavior step would give it. */
export function exampleSet(a: ExampleAnalysis, id: string, workspaceName: string): AssumptionSet {
  return { schemaVersion: "1.0.0", id, label: `${a.behavior.label}, ${workspaceName}`, bindings: a.behavior.bindings.map((b) => JSON.parse(JSON.stringify(b)) as AssumptionSet["bindings"][number]) };
}

/** The balance targets the analysis saves, under the id the New volume step would give them. */
export function examplePlan(a: ExampleAnalysis, id: string, asOf: string): BalancePlan {
  return { schemaVersion: "1.0.0", id, label: a.targets.label, asOf, targets: JSON.parse(JSON.stringify(a.targets.targets)) as BalancePlan["targets"], unlistedFamilies: "runoff" };
}

/** The first free `bp-guided-<ws>-<n>`: the New volume step's own rule. */
export function nextGuidedPlanId(ws: string, taken: readonly string[]): string {
  const stem = `bp-guided-${ws.replace(/^ws-/, "")}`.slice(0, 58);
  let n = 1;
  while (taken.includes(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/**
 * The guided setup the analysis saves: the guided defaults (the parallel grid, 60 months of earnings, risk-free value),
 * the targets as the answer to "What happens to maturing balances?", each family's product, going-concern value on
 * its default 12-month span when the analysis asks for it, and the deposit history.
 */
export function exampleSetupBody(a: ExampleAnalysis, balancePlanId: string): Omit<RunSetup, "id"> {
  const answer: MaturingAnswer = { kind: "custom", balancePlanId };
  const s = withNewVolumeViews(withTemplates(guidedSetupBody(answer), a.templates), { goingConcern: a.goingConcern, forecastGap: false, span: "default" });
  return { ...s, nmdWarmup: { kind: "history", series: { ...a.nmdWarmup.series, valuesPct: [...a.nmdWarmup.series.valuesPct] } } };
}

/** How long the start choice waits for the run before it opens the Run step instead, in milliseconds. */
export const RUN_WAIT_MS = 10 * 60 * 1000;

/** The reader calls the analysis makes; a test hands in its own (fix round M2). */
export const READER_API = {
  getExampleAnalysis, listAssumptionSets, createAssumptionSet, setBlock, listBalancePlans, saveBalancePlan, saveRunSetup, getReadiness, launchSetup, getRun,
  getWorkspace, archiveWorkspace,
};
export type ExampleApi = typeof READER_API;

/**
 * Set the finished analysis up on a workspace that already holds the book and the market (startWorkspace in
 * StartChoices) and launch its run. Returns the step to open:
 *   "reports" the run is done;
 *   "run"     the launch needs a note confirmed (fix round L8: the learner confirms it on the Run step, never the
 *             start choice), the launch is blocked, or the run ended any other way or is still going after RUN_WAIT_MS.
 * `say` reports progress in a plain sentence. A failed write throws; `withArchiveOnFailure` turns that into an archived
 * workspace (M2).
 */
export async function finishExampleAnalysis(
  p: { ws: string; head: WorkspaceManifest; bookId: string; asOf: string; by: string; say: (s: string) => void },
  api: ExampleApi = READER_API,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<"reports" | "run"> {
  const a = await api.getExampleAnalysis(p.bookId);
  let head = p.head;
  p.say("Saving the illustrative behavior models");
  const setId = nextGuidedSetId(p.ws, (await api.listAssumptionSets()).map((s) => s.id));
  await api.createAssumptionSet(exampleSet(a, setId, head.name));
  head = await api.setBlock(p.ws, { expectedRevision: head.revision, by: p.by, block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: setId } });
  if (head.blocks.assumptions.defaultSetId !== setId) {
    head = await api.setBlock(p.ws, { expectedRevision: head.revision, by: p.by, block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id: setId } });
  }
  p.say("Saving the balance targets and the new-volume products");
  const planId = nextGuidedPlanId(p.ws, (await api.listBalancePlans()).map((x) => x.id));
  await api.saveBalancePlan(examplePlan(a, planId, p.asOf));
  head = await api.setBlock(p.ws, { expectedRevision: head.revision, by: p.by, block: "targets", op: "add", ref: { collection: "plans", id: planId } });
  await api.saveRunSetup({ workspaceId: p.ws, setupLineageId: GUIDED_SLOT, expectedRevision: head.revision, by: p.by, setup: exampleSetupBody(a, planId) });
  p.say("Launching the run");
  const readiness = await api.getReadiness(p.ws);
  const launch = readiness.launchable[GUIDED_SLOT];
  // L8: a note to confirm is the learner's to read; the Run step lists it beside the Launch button.
  if (launch === undefined || launch.blocking.length > 0 || launch.acknowledgeable.length > 0) return "run";
  const reply = await api.launchSetup(p.ws, GUIDED_SLOT, { by: p.by, acknowledge: [] });
  const runId = reply.runIds[0];
  if (runId === undefined) return "run";
  const start = Date.now();
  for (;;) {
    const d = await api.getRun(runId);
    if (d.state === "done") return "reports";
    if (d.state === "error" || d.state === "cancelled" || d.state === "interrupted") return "run";
    if (Date.now() - start > RUN_WAIT_MS) return "run";
    p.say(`Running the example analysis (${Math.round((Date.now() - start) / 1000)} seconds so far): the results open when it finishes`);
    await sleep(1500);
  }
}

/**
 * Fix round M2: run `fn` on a workspace the start choice just made; when it throws, archive the workspace (the store
 * keeps every document, so archiving is how it leaves the list) and throw one sentence that says so. The same rule
 * startWorkspace applies to its own writes, so a failed Explore never leaves a half-built workspace active.
 */
export async function withArchiveOnFailure<T>(ws: { id: string; name: string; by: string }, fn: () => Promise<T>, api: Pick<ExampleApi, "getWorkspace" | "archiveWorkspace"> = READER_API): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const head = await api.getWorkspace(ws.id).catch(() => null);
    // S3f fix round (L1): the sentence says what happened to the workspace, archived or not.
    const archived = head !== null && (await api.archiveWorkspace(ws.id, { expectedRevision: head.revision, by: ws.by, note: "Archived by the start choice: setting it up failed." }).then(() => true, () => false));
    throw new Error(`${archiveSentence(ws.name, archived)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The first half of a failed setup's sentence: archived and out of the list, or still in the list when the archive failed too. */
export function archiveSentence(name: string, archived: boolean): string {
  return archived
    ? `Setting up ${name} failed, so it was archived and left out of the list`
    : `Setting up ${name} failed, and it could not be archived, so it stays in the list half set up`;
}

/** Fix round L9: where "Or continue" opens an example workspace: Reports when one of its runs is done, else step 1. */
export function continueStep(runs: ReadonlyArray<{ status?: { state?: string } | null }>): "reports" | "market" {
  return runs.some((r) => r.status?.state === "done") ? "reports" : "market";
}
