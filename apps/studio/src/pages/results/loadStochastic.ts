// apps/studio/src/pages/results/loadStochastic.ts
/** Stochastic distributions reads: the run detail, then the summary of a done stochastic run's stored envelope. */
import { getRun, getStochasticSummary, type RunDetail, type StochasticSummaryReply } from "@alm/reader";
import { errText } from "../../errText";

export interface StochasticData {
  detail: RunDetail;
  summary: StochasticSummaryReply | null;
  /** Why there is no summary, in plain words; null when the summary is here. */
  note: string | null;
}

export async function loadStochastic(runId: string): Promise<StochasticData> {
  const detail = await getRun(runId);
  if ((detail.mode ?? "deterministic") !== "stochastic") {
    return {
      detail,
      summary: null,
      note: "This is a deterministic run. A stochastic distribution exists only for a run submitted in stochastic mode; this run's results are on the measure layers.",
    };
  }
  if (detail.state !== "done") {
    return { detail, summary: null, note: `The run is ${detail.state}; a stochastic distribution exists only for a run that ended in state done.` };
  }
  try {
    return { detail, summary: await getStochasticSummary(runId), note: null };
  } catch (e) {
    return { detail, summary: null, note: errText(e) };
  }
}
