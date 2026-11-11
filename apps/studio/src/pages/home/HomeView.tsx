/**
 * Home. Every figure is a value a route returned, formatted by @alm/reader,
 * with a source line naming the route and field. Nothing is computed here.
 * Rendered as children of the shell's .content grid.
 */
import type { ReactNode } from "react";
import { formatValue, signClass, signedMM, signedPct, usd, usdMM } from "@alm/reader";
import { BarPairs } from "../../charts/BarPairs";
import { baseRow } from "../../rows/homeRows";
import type { HomeModel } from "./loadHome";

function Stat(props: { label: string; exact?: string; value: ReactNode; delta?: ReactNode; source: ReactNode }) {
  return (
    <div className="stat" title={props.exact}>
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      {props.delta}
      <div className="stat-source">{props.source}</div>
    </div>
  );
}

function Unobs(props: { text: string }) {
  return <span className="status status-unobs">{props.text}</span>;
}

export function HomeView(props: { model: HomeModel; viewerBase: string }) {
  const { model, viewerBase } = props;
  const { bookId, intake, run } = model;
  const aggRoute = `/api/catalog/portfolios/${bookId}/positions/aggregate`;
  const assets = intake.assetsNotional;

  const intakeTiles = (
    <>
      <Stat
        label="Assets"
        exact={assets == null ? `basis: ${intake.assetsBasis}` : `${usd(assets)}, basis: ${intake.assetsBasis}`}
        value={assets == null ? <Unobs text="Unobservable" /> : <span className="num">{usdMM(assets)}</span>}
        source={`${aggRoute}?groupBy=side, groups[key=asset].totalNotional`}
      />
      <Stat
        label="Positions"
        value={<><span className="num">{formatValue("count", intake.positionCount)}</span><span className="stat-unit">positions</span></>}
        source={`${aggRoute} positionCount`}
      />
    </>
  );

  if (run === null) {
    return (
      <>
        <div className="tiles">{intakeTiles}</div>
        <section className="card unobs-panel" aria-label="Last run">
          <p className="unobs-text">Unobservable: no run stored for this book.</p>
          <p className="card-foot">Source: /api/catalog/lineage/portfolios/{bookId} consumedBy, no entry in state done</p>
          <a className="btn btn-quiet btn-flush" href={`${viewerBase}#/run`}>Run this book in the workbench</a>
        </section>
      </>
    );
  }

  const { runId, baseScenarioId: base } = run;
  const eveRoute = `/api/runs/${runId}/result/eve`;
  const niiRoute = `/api/runs/${runId}/result/nii`;
  const eveBase = baseRow(run.eve, base);
  const eveShock = run.eve.find((r) => r.scenarioId !== base);
  const niiBase = baseRow(run.nii, base);
  const niiShock = run.nii.find((r) => r.scenarioId !== base);

  return (
    <>
      <div className="tiles">
        {intakeTiles}
        <Stat
          label="Base EVE"
          exact={eveBase === undefined ? undefined : usd(eveBase.eve)}
          value={eveBase === undefined ? <Unobs text="Unobservable" /> : <span className="num">{usdMM(eveBase.eve)}</span>}
          delta={eveShock === undefined || signClass(eveShock.deltaEvePct) === "zero" ? undefined : (
            <span className={`stat-delta is-${signClass(eveShock.deltaEvePct)}`}>
              <span className="num">{signedPct(eveShock.deltaEvePct)}</span> vs base, {eveShock.scenarioId}
            </span>
          )}
          source={<>
            {eveRoute} byScenario[{base}].eve
            {eveShock === undefined || signClass(eveShock.deltaEvePct) === "zero" ? null : <>; chip byScenario[{eveShock.scenarioId}].deltaEvePct (engine field, deltaEveVsBase / base eve)</>}
          </>}
        />
        <Stat
          label="Base NII, 12m"
          exact={niiBase === undefined ? undefined : usd(niiBase.totalNet12)}
          value={niiBase === undefined ? <Unobs text="Unobservable" /> : <span className="num">{usdMM(niiBase.totalNet12)}</span>}
          source={`${niiRoute} byScenario[${base}].totalNet12`}
        />
      </div>

      <div className="grid-2">
        <figure className="card viz">
          <div className="viz-head">
            <div className="card-title">EVE by scenario</div>
            <p className="viz-sub">
              {eveBase === undefined ? `Base ${base}: Unobservable` : <>Base {base} <span className="num">{usdMM(eveBase.eve)}</span></>}
              {eveShock === undefined ? null : <>; {eveShock.scenarioId} <span className="num">{usdMM(eveShock.eve)}</span>, change <span className="num">{signedMM(eveShock.deltaEveVsBase)}</span></>}
            </p>
          </div>
          <BarPairs rows={run.eve.map((r) => ({ label: r.scenarioId, a: r.eve, b: r.deltaEveVsBase }))} aLabel="EVE" bLabel="Change vs base" unit="mm USD" />
          <figcaption>Source: eve.byScenario, run <span className="run">{runId}</span></figcaption>
        </figure>
        <figure className="card viz">
          <div className="viz-head">
            <div className="card-title">NII by scenario</div>
            <p className="viz-sub">
              {niiBase === undefined ? `Base ${base}: Unobservable` : <>Base {base} 12m <span className="num">{usdMM(niiBase.totalNet12)}</span></>}
              {niiShock === undefined ? null : <>; {niiShock.scenarioId} 12m <span className="num">{usdMM(niiShock.totalNet12)}</span></>}
            </p>
          </div>
          <BarPairs rows={run.nii.map((r) => ({ label: r.scenarioId, a: r.totalNet12, b: r.totalNet24 }))} aLabel="12m" bLabel="24m" unit="mm USD" />
          <figcaption>Source: nii.byScenario, run <span className="run">{runId}</span></figcaption>
        </figure>
      </div>

      <section className="card half" aria-labelledby="run-title">
        <div className="card-title" id="run-title">Last run</div>
        <dl className="kv kv-stack">
          <dt>Run id</dt><dd className="mono">{runId}</dd>
          <dt>Finished</dt><dd className="mono">{run.endedAt ?? "Unobservable"}</dd>
          <dt>Request hash</dt><dd className="mono">{run.platformRequestHash}</dd>
          <dt>Inputs hash</dt><dd className="mono">{run.engineInputsHash ?? "Unobservable"}</dd>
        </dl>
        <div className="run-actions">
          <a className="btn btn-quiet btn-flush" href={`${viewerBase}#/results/${runId}`}>Open in workbench</a>
        </div>
        <p className="card-foot">Source: /api/catalog/runs/{runId}/inputs</p>
      </section>

      <section className="card half" aria-labelledby="lenses-title">
        <div className="card-title" id="lenses-title">Lenses</div>
        <ul className="lenses">
          {run.lenses.map((l) => (
            <li className="lens" key={l.lensId}>
              <div className="lens-head">
                <span className="lens-name mono">{l.lensId}</span>
                <span className={`status ${l.status === "unobservable" ? "status-unobs" : `status-${l.status}`}`}>{l.status}</span>
              </div>
              <span className="lens-note">Min headroom vs limit: <span className="num">{l.headline === undefined ? "Unobservable" : signedPct(l.headline)}</span></span>
              <span className="lens-note">{l.objective}, {l.status}</span>
              <a className="btn btn-quiet btn-flush lens-action" href={`${viewerBase}#/results/${runId}`}>Open lens</a>
            </li>
          ))}
        </ul>
        <p className="card-foot">Source: /api/runs/{runId}/lenses, base {base}</p>
      </section>
    </>
  );
}
