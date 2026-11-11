// apps/studio/src/guided/learnSeed.ts
/**
 * The learn kit's seed: what `npm run learn` makes on its own store once the server answers,
 * through the Studio's own calls, so the store holds what a learner would make by hand:
 *
 *   1. the finished analysis on Quillfield Bank, made by "Explore the example bank"'s own call (exploreExampleBank:
 *      the workspace, the analysis set up through the guided steps' writes, its run launched and waited for);
 *   2. the deposit desk's workspace, as the desk's first Open makes it (startWorkspace on the desk);
 *   3. every demo the server lists, each opened into its own setup slot (openFeatureDemo) and launched once.
 *
 * It only adds. A workspace that exists is used as it is; a demo slot the workspace already holds is never saved over
 * (the learner may have changed it); a slot with a done run is not launched again; a run still queued or running is
 * waited for. A launch that needs a note confirmed is left for the learner on Run setups (fix round L8 of S3a: the
 * learner confirms a note, never a script), and the seed says so. Nothing here reads a number out of a result.
 */
import {
  getReadiness, getRun, getWorkspace, launchSetup, listExampleBooks, listExampleDemos, listWorkspaceRuns, listWorkspaces,
  type ExampleBookRow, type ExampleDemoRow, type WorkspaceManifest, type WorkspaceRunRow,
} from "@alm/reader";
import { EXAMPLE_NAME, exploreExampleBank, startWorkspace } from "../pages/workspace/StartChoices";
import { demoWorkspace, openFeatureDemo, sectionFor } from "./featureDemos";
import { GUIDED_SLOT } from "./steps";
import { DEFAULT_BY, freeName } from "./start";

/** The name the seed records with each change, as the start choices do when the learner leaves the name empty. */
export const LEARN_BY = DEFAULT_BY;

/** How long the seed waits for one run, in milliseconds. */
export const LEARN_RUN_WAIT_MS = 10 * 60 * 1000;

const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

/** A slot's newest run row (by submit time), or null when the slot has no run. */
export function newestSlotRun(rows: readonly WorkspaceRunRow[], slot: string): WorkspaceRunRow | null {
  const mine = rows.filter((r) => r.setupLineageId === slot && r.mode !== "stochastic");
  const at = (r: WorkspaceRunRow) => r.status?.submittedAt ?? r.at;
  mine.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
  return mine[0] ?? null;
}

/** True when the slot already has a done deterministic run. */
export function slotHasDoneRun(rows: readonly WorkspaceRunRow[], slot: string): boolean {
  return rows.some((r) => r.setupLineageId === slot && r.mode !== "stochastic" && r.status?.state === "done");
}

/** The reader calls the seed makes; a test hands in its own. */
export const LEARN_API = {
  listExampleBooks, listExampleDemos, listWorkspaces, getWorkspace, listWorkspaceRuns, getReadiness, launchSetup, getRun,
  startWorkspace, exploreExampleBank, openFeatureDemo,
};
export type LearnApi = typeof LEARN_API;

export interface LearnSeedReport {
  /** Workspaces the seed made, by name. */
  made: string[];
  /** Runs the seed launched, as "workspace name: slot". */
  launched: string[];
  /** Slots that already had a done run. */
  kept: string[];
  /** Slots left for the learner, each with the reason in a plain sentence. */
  left: string[];
}

type Say = (line: string) => void;

/**
 * Launch one slot unless it has a done run, and return the run id to wait for (null when nothing is to be waited
 * for). A run still queued or running is waited for, not launched again. A blocked launch, or one that needs a note
 * confirmed, is recorded in `left` and launches nothing.
 */
async function launchOnce(api: LearnApi, ws: WorkspaceManifest, slot: string, label: string, report: LearnSeedReport): Promise<string | null> {
  const rows = await api.listWorkspaceRuns(ws.id);
  if (slotHasDoneRun(rows, slot)) {
    report.kept.push(`${ws.name}: ${label}`);
    return null;
  }
  const newest = newestSlotRun(rows, slot);
  const state = newest?.status?.state;
  if (newest !== null && state !== undefined && !TERMINAL.has(state)) return newest.runId;
  const readiness = await api.getReadiness(ws.id);
  const launch = readiness.launchable[slot];
  if (launch === undefined) {
    report.left.push(`${ws.name}: ${label} (the workspace holds no setup in this slot)`);
    return null;
  }
  if (launch.blocking.length > 0) {
    report.left.push(`${ws.name}: ${label} (Run setups says what it still needs: ${launch.blocking.join("; ")})`);
    return null;
  }
  if (launch.acknowledgeable.length > 0) {
    report.left.push(`${ws.name}: ${label} (a note waits for you on Run setups; read it, then press Launch)`);
    return null;
  }
  const reply = await api.launchSetup(ws.id, slot, { by: LEARN_BY, acknowledge: [] });
  const runId = reply.runIds[0];
  if (runId === undefined) {
    report.left.push(`${ws.name}: ${label} (the launch queued no run)`);
    return null;
  }
  report.launched.push(`${ws.name}: ${label}`);
  return runId;
}

/** Wait for every run to end; each one that ends other than done is recorded in `left`. */
async function waitAll(api: LearnApi, runs: Array<{ runId: string; what: string }>, report: LearnSeedReport, sleep: (ms: number) => Promise<void>, say: Say): Promise<void> {
  const start = Date.now();
  const open = new Map(runs.map((r) => [r.runId, r.what]));
  let last = -1;
  while (open.size > 0) {
    for (const [runId, what] of [...open]) {
      const d = await api.getRun(runId);
      if (!TERMINAL.has(d.state)) continue;
      open.delete(runId);
      if (d.state !== "done") report.left.push(`${what} (its run did not finish: ${d.state}; open it on Run setups and press Launch again)`);
    }
    if (open.size === 0) break;
    if (Date.now() - start > LEARN_RUN_WAIT_MS) {
      for (const what of open.values()) report.left.push(`${what} (its run is still going; Results shows it when it finishes)`);
      return;
    }
    if (open.size !== last) {
      say(`waiting for ${open.size} run${open.size === 1 ? "" : "s"} to finish`);
      last = open.size;
    }
    await sleep(1000);
  }
}

/**
 * The seed. `say` prints progress in plain sentences. Returns what it made, launched, kept and left; it throws only
 * when a write fails (the start choice's own writes archive a workspace they could not finish, and say so).
 */
export async function seedLearnStore(
  say: Say,
  api: LearnApi = LEARN_API,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<LearnSeedReport> {
  const report: LearnSeedReport = { made: [], launched: [], kept: [], left: [] };
  const books = await api.listExampleBooks();
  const bank = books.find((b) => b.analysis === true);
  if (bank === undefined) throw new Error("the platform holds no example bank with a finished analysis");

  // 1. The finished analysis, as "Explore the example bank" makes it.
  let workspaces = await api.listWorkspaces();
  let bankWs = demoWorkspace(workspaces, bank.id);
  let analysisDone = false;
  if (bankWs === null) {
    const name = freeName(EXAMPLE_NAME, workspaces);
    say(`making ${name}: the finished analysis on ${bank.label}, as "Explore the example bank" makes it`);
    const { id, step } = await api.exploreExampleBank(workspaces, LEARN_BY, () => undefined);
    report.made.push(name);
    bankWs = await api.getWorkspace(id);
    analysisDone = step === "reports";
    if (analysisDone) report.launched.push(`${name}: the finished analysis`);
    workspaces = await api.listWorkspaces();
  }
  const pending: Array<{ runId: string; what: string }> = [];
  // A workspace that was there already, or an analysis whose run did not finish, gets the same launch as a demo.
  const guided = analysisDone ? null : await launchOnce(api, bankWs, GUIDED_SLOT, "the finished analysis", report);
  if (guided !== null) pending.push({ runId: guided, what: `${bankWs.name}: the finished analysis` });

  // 2 and 3. Every demo the server lists, book by book, each on its book's workspace.
  for (const book of books) {
    const demos = await api.listExampleDemos(book.id);
    if (demos.length === 0) continue;
    let ws = book.id === bank.id ? bankWs : demoWorkspace(workspaces, book.id);
    if (ws === null) {
      const section = sectionFor(book.id);
      if (section.makesWorkspace === null) continue;
      const name = freeName(section.makesWorkspace, workspaces);
      say(`making ${name}: the workspace on ${book.label}, as its first Open makes it`);
      ws = (await api.startWorkspace(name, LEARN_BY, workspaces, book)).head;
      report.made.push(name);
      workspaces = await api.listWorkspaces();
    }
    say(`setting up ${demos.length} demo${demos.length === 1 ? "" : "s"} on ${ws.name}`);
    for (const demo of demos) await openAndLaunch(api, ws.id, book, demo, report, pending);
  }
  if (pending.length > 0) await waitAll(api, pending, report, sleep, say);
  return report;
}

/** Open one demo into its slot unless the workspace already holds the slot, then launch it once. */
async function openAndLaunch(
  api: LearnApi, wsId: string, book: ExampleBookRow, demo: ExampleDemoRow, report: LearnSeedReport, pending: Array<{ runId: string; what: string }>,
): Promise<void> {
  if (!demo.stored) {
    report.left.push(`${book.label}: ${demo.title} (this store was seeded before the demo existed)`);
    return;
  }
  let head = await api.getWorkspace(wsId);
  if (!head.blocks.run.setups.some((s) => s.setupLineageId === demo.lineageId)) {
    await api.openFeatureDemo({ ws: wsId, demo, by: LEARN_BY });
    head = await api.getWorkspace(wsId);
  }
  const runId = await launchOnce(api, head, demo.lineageId, demo.title, report);
  if (runId !== null) pending.push({ runId, what: `${head.name}: ${demo.title}` });
}
