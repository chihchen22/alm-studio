import type { NIIResult, ReinvestmentShortfall, ScenarioNII } from "@alm/engine";
import { familyNetAtHorizon, scenarioNetAtHorizon, signedMM, signClass, usdMM } from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";

/**
 * NII by scenario plus a per-family breakdown for the selected scenario.
 * Every figure reads from NIIResult; the total rows use the engine-provided
 * scenario totals, not a client-side sum.
 *
 * W3-P7 extensions, all verbatim envelope reads:
 *  - Flexible horizons: one net column per entry of the envelope's
 *    horizonsMonths. 12/24 read the pinned net12/net24 fields (identities of
 *    byHorizon per contract); other horizons read totalNetByHorizon /
 *    byHorizon via the tested lookup helpers. A pre-1.2.0 envelope renders
 *    "n/a (pre-1.2.0 envelope)" for the missing slots — never blank, never 0.
 *  - Monthly net vector: sampled verbatim at month anchors. No
 *    cumulative series is drawn because that would be client-side summation;
 *    the horizon nets ARE the engine's partial sums of this vector.
 *  - Typed reinvestment shortfalls: rendered as stored, one row per
 *    under-hit family, only when the envelope carries them (dynamic scenarios
 *    that met every target, and static scenarios, carry no slot at all).
 */
export function NiiTable({
  nii,
  familyLabel,
  selected,
}: {
  nii: NIIResult;
  familyLabel: (id: string) => string;
  selected: string;
}) {
  const scenarioLabel = useScenarioLabel();
  const scen = nii.byScenario.find((s) => s.scenarioId === selected) ?? nii.byScenario[0];
  const horizons = nii.horizonsMonths;
  return (
    <section className="panel">
      <h2>Net Interest Income</h2>
      <p className="desc">
        Projected net interest income over {horizons.join(", ")} months, by scenario. Horizon windows are the
        engine&rsquo;s own sums (the 12/24 columns are the pinned fields; others read the byHorizon block).
      </p>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              {horizons.map((h) => (
                <th key={h}>Net {h}M</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nii.byScenario.map((s) => (
              <tr key={s.scenarioId}>
                <td>{scenarioLabel(s.scenarioId)}</td>
                {horizons.map((h) => (
                  <NetCell key={h} value={scenarioNetAtHorizon(s, h)} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="desc" style={{ marginTop: 16 }}>
        By family — {scenarioLabel(scen.scenarioId)} scenario
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Family</th>
              <th>Income 12M</th>
              <th>Expense 12M</th>
              {horizons.map((h) => (
                <th key={h}>Net {h}M</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scen.byFamily.map((f) => (
              <tr key={f.familyId}>
                <td>{familyLabel(f.familyId)}</td>
                <td className="num">{usdMM(f.interestIncome12)}</td>
                <td className="num">{usdMM(f.interestExpense12)}</td>
                {horizons.map((h) => (
                  <NetCell key={h} value={familyNetAtHorizon(f, h)} />
                ))}
              </tr>
            ))}
            <tr className="total">
              <td>Total net</td>
              <td className="num"></td>
              <td className="num"></td>
              {horizons.map((h) => (
                <NetCell key={h} value={scenarioNetAtHorizon(scen, h)} />
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <MonthlyNet scen={scen} />
      <Shortfalls shortfalls={scen.shortfalls} familyLabel={familyLabel} />
    </section>
  );
}

/** A horizon net cell: verbatim value, or the distinct absent state. */
function NetCell({ value }: { value: number | undefined }) {
  if (value === undefined) {
    return (
      <td className="num">
        <span
          className="muted"
          title="This envelope predates the schemaVersion 1.2.0 byHorizon field set; the window was not stored and stored results are never recomputed."
        >
          n/a (pre-1.2.0 envelope)
        </span>
      </td>
    );
  }
  return <td className={`num ${signClass(value)}`}>{signedMM(value)}</td>;
}

/** Month anchors for the sampled monthly-net view (verbatim single buckets). */
const MONTH_ANCHORS = [1, 3, 6, 12, 18, 24, 36, 60];

function MonthlyNet({ scen }: { scen: ScenarioNII }) {
  const v = scen.netMonthly;
  if (v === undefined) return null; // pre-1.2.0 envelope: no vector was stored
  const cols = MONTH_ANCHORS.filter((m) => m <= v.length);
  return (
    <>
      <p className="desc" style={{ marginTop: 16 }}>
        Monthly net interest (scenario total, side-signed), sampled verbatim from the envelope&rsquo;s
        {" "}netMonthly vector ({v.length} buckets). Bucket k is calendar month k+1; the horizon nets above are
        the engine&rsquo;s partial sums of this vector, so any horizon is computable from the stored envelope
        without recomputation.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {cols.map((m) => (
                <th key={m}>M{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {cols.map((m) => (
                <td key={m} className={`num ${signClass(v[m - 1])}`}>
                  {signedMM(v[m - 1])}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function Shortfalls({
  shortfalls,
  familyLabel,
}: {
  shortfalls: ReinvestmentShortfall[] | undefined;
  familyLabel: (id: string) => string;
}) {
  if (shortfalls === undefined) return null; // absent slot: static scenario, or every dynamic target met
  return (
    <>
      <p className="desc" style={{ marginTop: 16 }}>
        Reinvestment shortfalls, typed (schemaVersion 1.1.0): families whose dynamic reinvestment target the
        strategy could not hit. Reported by the engine, mirrored verbatim; the strategy only originates,
        never sells.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Family</th>
              <th>Rule</th>
              <th>First clamped bucket</th>
              <th>Clamped buckets</th>
              <th>Target balance (end)</th>
              <th>Achieved balance (end)</th>
              <th>Balance gap (end)</th>
            </tr>
          </thead>
          <tbody>
            {shortfalls.map((s) => (
              <tr key={s.familyId}>
                <td>{familyLabel(s.familyId)}</td>
                <td>{s.reinvest}</td>
                <td className="num">{s.firstBucket}</td>
                <td className="num">{s.clampedBuckets}</td>
                <td className="num">{usdMM(s.targetBalanceEnd)}</td>
                <td className="num">{usdMM(s.achievedBalanceEnd)}</td>
                <td className={`num ${signClass(s.balanceGapEnd)}`}>{signedMM(s.balanceGapEnd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
