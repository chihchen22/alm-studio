// apps/studio/src/pages/results/NewBusinessBlock.tsx
/**
 * The New business block of Results > NII (spec v3.1 Sections 5.4 and 6.1). On a Flat or Custom run it shows
 * the originations the reinvestment sweep wrote for the scenario (`ScenarioNII.newBusiness`, contract 24), every
 * reinvestment shortfall as a named row, and the families the Flat basis skipped (the compile's informational tag, not
 * a warning). An envelope stored before originations existed says so. Window totals are sums of the stored series and
 * are marked derived.
 */
import type { RunResult } from "@alm/engine";
import { usd, usdMM } from "@alm/reader";
import { basisKinds } from "../../rows/basisLabel";
import { ORIGINATIONS_ABSENT_TEXT } from "./NiiAbsentStates";

const SKIPPED_TAG = "plan.balance-basis.skipped";

/** The family list the compiler's skipped tag names, after its last colon; empty when the run has no such tag. */
export function skippedFamiliesOf(result: RunResult): string[] {
  const tag = (result.notImplemented ?? []).find((t) => t.layer === SKIPPED_TAG);
  if (tag === undefined) return [];
  return tag.reason.slice(tag.reason.lastIndexOf(": ") + 2).split(", ").filter((f) => f.length > 0);
}

/**
 * The tranches made in the first `window` months (ruling 46): `originations[k]` is the tranche made at the end of month
 * k and index 0, the opening bucket, is always 0, so months 1 .. window are indices 1 .. window, as going-concern EVE
 * and the FTP window count them. A grid shorter than the window gives what it holds. Not `rollUp`: that sums indices
 * 0 .. window - 1, which is right for the cash-flow series it serves (bucket k is month k + 1) and wrong here.
 */
export function madeInWindow(originations: readonly number[], window: number): number[] {
  return originations.slice(1, window + 1);
}

export function NewBusinessBlock(props: {
  result: RunResult;
  scenarioId: string;
  scenarioLabel: (id: string) => string;
  basisLabel: string | null;
  window: number;
}) {
  const { result, scenarioId, window } = props;
  const scenarios = result.nii?.byScenario ?? [];
  const anyArm = scenarios.some((s) => s.newBusiness !== undefined);
  const kinds = basisKinds(props.basisLabel);
  // A Runoff run has no new business to show. With no label at hand the arms themselves say whether there is any.
  if (props.basisLabel !== null && !kinds.dynamic) return null;
  if (props.basisLabel === null && !anyArm) return null;
  const sel = scenarios.find((s) => s.scenarioId === scenarioId);
  const originated = sel?.newBusiness;
  const shortfalls = sel?.shortfalls ?? [];
  const skipped = skippedFamiliesOf(result);
  const label = props.scenarioLabel(scenarioId);
  return (
    <section className="card table-card" aria-label="New business">
      <div className="card-title">New business, {label}</div>
      {originated !== undefined ? (
        <>
          <p className="card-desc">Notional originated each month to hold each family at its target, as the reinvestment sweep wrote it. Bucket 0 is the opening bucket and originates nothing.</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Family</th><th scope="col" className="num">Originated, {window} months</th><th scope="col" className="num">Months originating</th></tr></thead>
              <tbody>
                {originated.map((f) => {
                  const inWindow = madeInWindow(f.originations, window);
                  return (
                    <tr key={f.familyId}>
                      <th scope="row" className="mono">{f.familyId}</th>
                      <td className="num">{usdMM(inWindow.reduce((a, v) => a + v, 0))} <span className="chip" title="Summed here from the stored monthly originations">derived</span></td>
                      <td className="num">{inWindow.filter((v) => v > 0).length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details className="nb-details">
            <summary>Originations by month</summary>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col" className="num">Month</th>{originated.map((f) => <th scope="col" key={f.familyId} className="num mono">{f.familyId}</th>)}</tr></thead>
                <tbody>
                  {Array.from({ length: Math.min(window, ...originated.map((f) => f.originations.length - 1)) }, (_, i) => i + 1).map((k) => (
                    <tr key={k}>
                      <th scope="row" className="num">{k}</th>
                      {originated.map((f) => <td key={f.familyId} className="num">{usd(f.originations[k]!)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : anyArm ? (
        <p className="card-desc">This scenario runs off: it carries no new business, so there are no originations to show.</p>
      ) : (
        <p className="kv-status"><span className="status status-unobs">Not stored</span> {ORIGINATIONS_ABSENT_TEXT}</p>
      )}
      {shortfalls.length > 0 ? (
        <ul className="nimpl-list" aria-label="Reinvestment shortfalls">
          {shortfalls.map((f) => (
            <li key={f.familyId}>
              <span className="status status-breach">Shortfall</span> <span className="mono">{f.familyId}</span>{" "}
              {f.balanceGapEnd >= 0 ? "held above its target" : "held below its target"} by {usd(Math.abs(f.balanceGapEnd))} at the end of the grid
              (first short month {f.firstBucket + 1}, {f.clampedBuckets} short {f.clampedBuckets === 1 ? "month" : "months"}). The sweep only originates and never sells.
              {" "}<span className="muted">balanceGapEnd {usd(f.balanceGapEnd)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {skipped.length > 0 ? (
        <p className="card-desc" role="note">Skipped by the Flat basis: {skipped.join(", ")}. These carry no positive opening balance or are not an asset or a liability; this is informational, not a warning.</p>
      ) : null}
      <p className="card-foot">Source: nii.byScenario[scenarioId={scenarioId}].newBusiness and .shortfalls; skipped families from notImplemented plan.balance-basis.skipped.</p>
    </section>
  );
}
