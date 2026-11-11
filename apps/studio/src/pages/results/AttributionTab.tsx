// apps/studio/src/pages/results/AttributionTab.tsx
/**
 * Attribution tab (Studio S3a): one stored headline decomposition at a time,
 * picked by its position in attribution.headlines. The chart places stored
 * contributions end to end; the residual is printed as stored, never drawn.
 * Formats follow the viewer's AttributionWaterfall: base and scenario anchors
 * unsigned (usdMM), steps and the total change signed (signedMM). The residual
 * prints at significant figures, since signedMM would round a stored
 * float-noise residual to zero.
 */
import type { HeadlineAttribution } from "@alm/engine";
import { driverLabel, sig, signedMM, usdMM } from "@alm/reader";
import { Waterfall } from "../../charts/Waterfall";

import { waterfallLayout } from "../../results/waterfall";
import { blockOf, NotInRun, tabHref, type TabProps } from "./common";

const METRIC_LABEL: Record<HeadlineAttribution["metric"], string> = { "nii-12m": "NII 12m", "nii-24m": "NII 24m", eve: "EVE" };

export const NO_HEADLINE =
  "attribution.headlines is empty: the run has no shocked scenario, or every shocked scenario changes assumptions or new business versus base, " +
  "which the engine declines rather than split (each one carries a notImplemented tag attribution.<scenario id>, listed above the tabs)";

export function AttributionTab(p: TabProps) {
  const block = blockOf(p.result, "attribution");
  if (block === undefined) return <NotInRun title="Attribution" reason="The envelope carries no attribution block." />;
  const heads = block.headlines;
  if (heads.length === 0) return <NotInRun title="Attribution" reason={NO_HEADLINE} />;
  const want = Number(p.query.headline);
  const idx = Number.isInteger(want) && want >= 0 && want < heads.length ? want : 0;
  const h = heads[idx]!;
  return (
    <>
      <nav className="chip-row" aria-label="Headline">
        {heads.map((x, i) => (
          <a key={i} className="pill" href={tabHref(p.ws, p.query, { headline: String(i) })} aria-current={i === idx ? "true" : undefined}>
            {METRIC_LABEL[x.metric]} {p.scenarioLabel(x.scenarioId)}
          </a>
        ))}
      </nav>
      <figure className="card viz" aria-label="Attribution waterfall">
        <div className="viz-head"><div className="card-title">{METRIC_LABEL[h.metric]}, {p.scenarioLabel(h.scenarioId)} against base</div></div>
        <Waterfall layout={waterfallLayout(h)} unit="USD" format={signedMM} anchorFormat={usdMM} />
        <dl className="kv">
          <dt>Total change (stored)</dt><dd className="num">{signedMM(h.totalDelta)}</dd>
          <dt>Residual (stored)</dt><dd className="num">{sig(h.residual)} USD</dd>
        </dl>
        <figcaption className="card-foot">
          Source: attribution.headlines[{idx}]. Contributions stored as exactly 0 are not drawn; the table lists every stored contribution. The residual is the engine's sum of contributions minus the total change, printed as stored and never drawn.
        </figcaption>
      </figure>
      <section className="card table-card" aria-label="Contributions">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Family</th><th scope="col">Driver</th><th scope="col" className="num">Contribution</th></tr></thead>
            <tbody>
              {h.contributions.map((c, i) => (
                <tr key={i} className="attr-row"><th scope="row" className="mono">{c.familyId}</th><td>{driverLabel(c.driver)}</td><td className="num">{signedMM(c.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
