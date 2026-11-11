// apps/studio/src/pages/results/NiiAbsentStates.tsx
/**
 * The absent states of the NII screen (spec v3.1 Section 5.4). Each prints a typed reason, never an error:
 * an envelope stored before `netMonthly`, a stochastic envelope, and (in the New business block) an envelope stored
 * before originations. A stochastic run prints its stored 12-month distribution beside the reason.
 */
import { useLoad } from "../../useLoad";
import { errText } from "../../errText";
import { getStochasticSummary, type StochasticSummaryRow } from "@alm/reader";
import { StochasticRunTable } from "./StochasticRunViews";

export const MONTHLY_ABSENT_TEXT: Record<"no-netMonthly" | "stochastic", string> = {
  "no-netMonthly": "Monthly NII not stored on this envelope; re-run on the current engine",
  stochastic: "This run is stochastic: monthly NII is not part of the stochastic envelope. Its 12-month distribution is the table below.",
};

export const ORIGINATIONS_ABSENT_TEXT = "originations not stored on this envelope";

/** A stochastic run's NII screen: the reason and the stored 12-month distribution rows. Props only. */
export function StochasticNiiView(props: { runId: string; rows: StochasticSummaryRow[] }) {
  return (
    <>
      <section className="card unobs-panel" aria-label="Monthly NII">
        <div className="card-title">Net interest income</div>
        <span className="status status-unobs">Not stored</span>
        <p className="unobs-text">{MONTHLY_ABSENT_TEXT.stochastic}</p>
      </section>
      <StochasticRunTable title="NII 12m distribution" rows={props.rows} />
      <p className="card-foot">Source: GET /api/runs/{props.runId}/stochastic/summary, nii12mDistribution.</p>
    </>
  );
}

/** Reads the summary of a stochastic run and prints the NII screen's answer for it. */
export function StochasticNiiCard(props: { runId: string }) {
  const load = useLoad(() => getStochasticSummary(props.runId), [props.runId]);
  if (load.state === "loading") return <div className="card muted">Reading the 12-month NII distribution of {props.runId}</div>;
  if (load.state === "error") {
    return (
      <>
        <section className="card unobs-panel" aria-label="Monthly NII">
          <div className="card-title">Net interest income</div>
          <span className="status status-unobs">Not stored</span>
          <p className="unobs-text">{MONTHLY_ABSENT_TEXT.stochastic}</p>
        </section>
        <div className="card" role="alert">{errText(load.error)}</div>
      </>
    );
  }
  return <StochasticNiiView runId={props.runId} rows={load.value.nii12mDistribution.rows} />;
}
