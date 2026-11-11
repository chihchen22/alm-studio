import type { GapLadder } from "@alm/engine";
import { signClass, signedMM, usdMM } from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";

function Ladder({ ladder, title }: { ladder: GapLadder; title: string }) {
  return (
    <div>
      <p className="desc" style={{ marginTop: 8 }}>
        {title}
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Band</th>
              <th>Assets</th>
              <th>Liabilities</th>
              <th>Gap</th>
              <th>Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {ladder.rows.map((r) => (
              <tr key={r.band.label}>
                <td>{r.band.label}</td>
                <td className="num">{usdMM(r.assets)}</td>
                <td className="num">{usdMM(r.liabilities)}</td>
                <td className={`num ${signClass(r.gap)}`}>{signedMM(r.gap)}</td>
                <td className={`num ${signClass(r.cumulativeGap)}`}>{signedMM(r.cumulativeGap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Repricing and liquidity gap ladders for the selected scenario. Both bucketed
 * into standard time bands with a cumulative gap per band; all figures read from
 * GapResult, including the cumulative running sum the engine computed.
 */
export function GapLadders({
  repricing,
  liquidity,
  selected,
}: {
  repricing: GapLadder[];
  liquidity: GapLadder[];
  selected: string;
}) {
  const scenarioLabel = useScenarioLabel();
  const rep = repricing.find((l) => l.scenarioId === selected) ?? repricing[0];
  const liq = liquidity.find((l) => l.scenarioId === selected) ?? liquidity[0];
  return (
    <section className="panel">
      <h2>Gap ladders</h2>
      <p className="desc">
        {scenarioLabel(selected)} scenario. Repricing gap off the instrument repricing schedule; liquidity gap
        off principal cash flows.
      </p>
      <Ladder ladder={rep} title="Repricing gap" />
      <Ladder ladder={liq} title="Liquidity gap" />
    </section>
  );
}
