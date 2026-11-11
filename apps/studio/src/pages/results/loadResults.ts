// apps/studio/src/pages/results/loadResults.ts
/**
 * Results reads (Studio S3a): the run detail, then the stored envelope of a
 * done deterministic run. A stochastic run's result is a distribution envelope
 * this layer does not read; its note names Stochastic distributions, the layer
 * that shows it.
 */
import type { RunResult } from "@alm/engine";
import { getResult, getRun, type RunDetail } from "@alm/reader";
import { errText } from "../../errText";

export interface ResultsData {
  detail: RunDetail;
  result: RunResult | null;
  /** Why there is no result, in plain words; null when the result is here. */
  note: string | null;
}

export async function loadResults(runId: string): Promise<ResultsData> {
  const detail = await getRun(runId);
  if ((detail.mode ?? "deterministic") === "stochastic") {
    return { detail, result: null, note: "This is a stochastic run. Its result is a Monte Carlo distribution envelope, not a deterministic result, so this layer does not read it; Stochastic distributions shows it." };
  }
  if (detail.state !== "done") {
    return { detail, result: null, note: `The run is ${detail.state}; a result exists only for a run that ended in state done.` };
  }
  try {
    return { detail, result: await getResult(runId), note: null };
  } catch (e) {
    return { detail, result: null, note: errText(e) };
  }
}

/**
 * The plan id the compiler stamped on the provenance; no route serves the
 * stored planDocument. With no result in hand the text says why: a
 * deterministic run still queued or running has no result yet; one that ended
 * error, cancelled or interrupted never will; a done run (or a stochastic
 * one, whose distribution envelope this layer never reads) had its result not
 * read, for the reason the load recorded.
 */
export function planIdText(data: { detail: Pick<RunDetail, "state" | "mode">; result: RunResult | null; note: string | null }): string {
  const { detail, result, note } = data;
  if (result !== null) return result.provenance.planId ?? "none: the run was not submitted from a plan";
  const stochastic = (detail.mode ?? "deterministic") === "stochastic";
  if (!stochastic && (detail.state === "queued" || detail.state === "running")) return "unknown until the run finishes";
  if (!stochastic && detail.state !== "done") return `unknown: the run ended ${detail.state} without a result`;
  return `unknown: the result was not read. ${note ?? "No reason was recorded."}`;
}
