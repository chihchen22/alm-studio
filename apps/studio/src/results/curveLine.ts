// apps/studio/src/results/curveLine.ts
/**
 * The curve a run built on, as a page shows it. The server owns the words: a done
 * run's detail carries `curve` (apps/server/src/export/curveLine.ts: the run's stamp, else the setup its stored
 * request pinned, else platform default v1), and this module prints it verbatim. Only when the detail carries none
 * does it say why, from the run's state.
 */
import type { RunCurveLine, RunState } from "@alm/reader";

export interface CurveOfRun {
  state: RunState;
  curve?: RunCurveLine;
}

/** The line after "Curve: ": the server's value, or why there is none. */
export function runCurveValue(d: CurveOfRun): string {
  if (d.curve !== undefined) return d.curve.value;
  if (d.state === "queued" || d.state === "running") return "unknown until the run finishes";
  if (d.state !== "done") return `none, the run ended ${d.state} without a result`;
  return "Unobservable, the run detail carries no curve line";
}

/** The whole line, for example "Curve: platform default v2, log-linear on discount factor". */
export function runCurveLine(d: CurveOfRun): string {
  return d.curve !== undefined ? d.curve.line : `Curve: ${runCurveValue(d)}`;
}
