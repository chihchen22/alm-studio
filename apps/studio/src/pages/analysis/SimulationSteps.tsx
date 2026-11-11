// apps/studio/src/pages/analysis/SimulationSteps.tsx
/**
 * Steps 5 and 6, Calibration and Simulation (S2a spec point 7) on today's engine. Simulation: one deterministic path
 * per scenario, or a stochastic run with its model, paths and seed, stored in the guided setup and launched from the
 * same Launch button on the Run step (the workspace launch's stochastic arm). Calibration: fit
 * the model on its own, read the parameters and the fit against its gate, save the fit (outside its gate only with a
 * reason) and use it for the stochastic run; the fit of the newest stochastic run is shown below.
 */
import { Fragment, useState } from "react";
import { getStochasticSummary } from "@alm/reader";
import { useKeptLoad as useLoad } from "../../useLoad";
import { errText } from "../../errText";
import { hrefFor } from "../../router";
import {
  DEFAULT_PATHS, DEFAULT_SEED, DISCOUNT_LABEL, GOING_CONCERN_DEFAULT_MONTHS, MIN_PATHS, MODEL_LABEL, horizonProblems, newVolumeViewsOf, readHorizons, simulationOf, simulationProblems, withCalibration, withDiscount, withHorizon, withNewVolumeViews, withSimulation,
  type GuidedDiscount, type SimulationModel,
} from "../../guided/setup";
import { ActionLines, Details, linkedRunText, saveGuided, useAction, useUnsavedGuard, type StepContext } from "./common";
import { CalibrationPanel } from "./CalibrationPanel";

export function CalibrationStep(props: { ctx: StepContext }) {
  const { ctx } = props;
  const newest = ctx.stochastic.find((r) => r.status?.state === "done") ?? null;
  const sim = ctx.guided === null ? null : simulationOf(ctx.guided);
  const g = ctx.guided;
  const use = {
    model: sim === null || sim.kind === "deterministic" ? null : sim.model,
    selected: g?.eve.stochastic?.calibrationId ?? null,
    onUse: async (id: string | null) => {
      await saveGuided(ctx, (s) => withCalibration(s, id));
      ctx.refresh();
    },
  };
  return (
    <>
      <section className="card" aria-label="What is fitted">
        <div className="card-title">What is fitted, and against what</div>
        <ul className="guided-missing">
          <li>Hull-White one factor: fitted to the at-the-money cap volatilities of the snapshot. The fit passes when its error is within 5 bp.</li>
          <li>BGM two factor: fitted to a 28-point subset of the swaption volatilities. Its gate is 10 bp; on the public snapshot the fit error is about 12 bp, outside its gate, and every run on it says so.</li>
          <li>Fit here to see the parameters and the fit against the market, and save the fit for your stochastic run to use. Without a saved fit, the run fits its model when it starts.</li>
        </ul>
        <div className="guided-actions">
          <a className="btn" href={hrefFor({ ws: ctx.ws, section: "market", screen: "vols" })}>See the volatility surfaces and the smile preview</a>
        </div>
      </section>
      <CalibrationPanel marketId={ctx.head.blocks.market.snapshot?.id ?? null} defaultModel={use.model ?? "hull-white-1f"} {...(g === null ? {} : { use })} />
      {newest === null ? null : <FitCard runId={newest.runId} label={linkedRunText(newest)} />}
    </>
  );
}

function FitCard(props: { runId: string; label: string }) {
  const load = useLoad(() => getStochasticSummary(props.runId), [props.runId]);
  if (load.state === "loading") return <div className="card muted">Reading the newest fit</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  const c = load.value.calibration as unknown as Record<string, unknown> | undefined;
  if (c === undefined) return null;
  const rmse = typeof c.rmseBp === "number" ? c.rmseBp : null;
  const gate = typeof c.rmseGateBp === "number" ? c.rmseGateBp : null;
  const breached = c.rmseGateBreached === true;
  const params = Object.entries(c).filter(([k, v]) => typeof v === "number" && !["rmseBp", "rmseGateBp", "nQuotes", "iterations", "underlyingTau"].includes(k));
  return (
    <section className="card" aria-label="Newest fit">
      <div className="card-title">{`The fit of your newest stochastic run: ${props.label}`}</div>
      <p className={breached ? "guided-warn" : "guided-ok"} role="status">
        {rmse === null ? "The run stores no fit error." : `Fit error ${rmse.toFixed(2)} bp against a ${gate ?? "stated"} bp gate: ${breached ? "above the gate, disclosed on the run" : "within the gate"}.`}
      </p>
      <dl className="kv">
        {params.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="num">{(v as number).toPrecision(6)}</dd></Fragment>)}
        {typeof c.nQuotes === "number" ? <><dt>Quotes fitted</dt><dd className="num">{c.nQuotes as number}</dd></> : null}
      </dl>
      <Details><p>{`Run ${props.runId}; source ${String(c.source ?? "not stated")}. Full precision is in the run's summary CSV.`}</p></Details>
    </section>
  );
}

export function SimulationStep(props: { ctx: StepContext }) {
  const { ctx } = props;
  const sim = ctx.guided === null ? null : simulationOf(ctx.guided);
  const [kind, setKind] = useState<"deterministic" | "stochastic">(sim?.kind ?? "deterministic");
  const [model, setModel] = useState<SimulationModel>(sim?.kind === "stochastic" ? sim.model : "hull-white-1f");
  const [paths, setPaths] = useState(sim?.kind === "stochastic" ? String(sim.nPaths) : String(DEFAULT_PATHS));
  const [seed, setSeed] = useState(sim?.kind === "stochastic" ? sim.seed : DEFAULT_SEED);
  const act = useAction();
  const problems = kind === "stochastic" ? simulationProblems(paths, seed) : [];
  const curveActive = ctx.head.blocks.market.curveSetups?.active !== undefined;
  if (ctx.guided === null) return <section className="card"><p className="guided-warn">Answer the New volume step's question first: that starts your analysis setup, and the simulation choice is saved into it.</p></section>;
  const onSave = () => act.run("Save", async () => {
    const choice = kind === "deterministic" ? { kind: "deterministic" as const } : { kind: "stochastic" as const, model, nPaths: Number(paths.trim()), seed: seed.trim() };
    await saveGuided(ctx, (s) => withSimulation(s, choice));
    ctx.refresh();
    return kind === "deterministic" ? "Saved: one deterministic path per scenario." : `Saved: a stochastic run of ${paths.trim()} paths on ${MODEL_LABEL[model]}, seed ${seed.trim()}.`;
  });
  return (
    <section className="card" aria-label="Simulation">
      <fieldset className="guided-fieldset">
        <legend>How should rates move?</legend>
        <label className="guided-option">
          <input type="radio" name="sim" checked={kind === "deterministic"} onChange={() => setKind("deterministic")} />
          <span className="guided-option-text"><span>One deterministic path per scenario</span><span className="field-help">Each scenario moves the curve once and the positions are projected on the forwards. Net interest income, value, the gap ladders and FTP for every scenario. The usual choice.</span></span>
        </label>
        <label className="guided-option">
          <input type="radio" name="sim" checked={kind === "stochastic"} onChange={() => setKind("stochastic")} />
          <span className="guided-option-text"><span>Many simulated paths of the base scenario</span><span className="field-help">A rate model fitted to the volatility surface draws many paths; the run reports the distribution of value and of 12-month net interest income. Base scenario only, the positions run off on every path.</span></span>
        </label>
      </fieldset>
      {kind === "stochastic" ? (
        <div className="guided-row">
          <label className="field">
            <span className="field-label">Rate model</span>
            <select className="guided-select" aria-label="Rate model" value={model} onChange={(e) => setModel(e.target.value as SimulationModel)}>
              {(Object.keys(MODEL_LABEL) as SimulationModel[]).map((m) => <option key={m} value={m}>{MODEL_LABEL[m]}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Paths</span>
            <input className="input" aria-label="Paths" value={paths} onChange={(e) => setPaths(e.target.value)} />
            <span className="field-help">{`An even number from ${MIN_PATHS} to ${DEFAULT_PATHS}. More paths, steadier numbers, longer run.`}</span>
          </label>
          <label className="field">
            <span className="field-label">Seed</span>
            <input className="input" aria-label="Seed" value={seed} onChange={(e) => setSeed(e.target.value)} />
            <span className="field-help">The same seed draws the same paths, so a run repeats exactly.</span>
          </label>
        </div>
      ) : null}
      {problems.length > 0 ? <ul className="guided-missing">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      {kind === "stochastic" && curveActive ? <p className="guided-note">A stochastic run builds its curve from the snapshot's own quotes; your edited curve variant applies to the deterministic run.</p> : null}
      <div className="guided-actions">
        <button type="button" className="btn btn-primary" disabled={act.busy || problems.length > 0} onClick={onSave}>Save the simulation choice</button>
      </div>
      <ActionLines busy={act.busy} error={act.error} done={act.done} />
    </section>
  );
}

/**
 * The earnings horizon and the value basis (S2b-1 spec points 5 and 6): the NII window and report horizons, from 12 to
 * 360 months, and EVE's discount curve. The projection grid stays where the setup has it (360 months, under Advanced),
 * so value always counts every cash flow to the end of each position's life whatever the horizon.
 */
export function HorizonCard(props: { ctx: StepContext }) {
  const { ctx } = props;
  const g = ctx.guided;
  const [windowText, setWindowText] = useState(String(g?.nii.horizonMonths ?? 60));
  const [horizonsText, setHorizonsText] = useState((g?.nii.reportHorizons ?? [12, 24, 60]).join(", "));
  const saved: GuidedDiscount | "other" = g === null ? "risk-free" : g.eve.discountBasis === "risk-free" || g.eve.discountBasis === "all-in" ? g.eve.discountBasis : "other";
  const [discount, setDiscount] = useState<GuidedDiscount | "other">(saved);
  const act = useAction();
  // Fix round L5: an edit not saved arms the leave-page guard, as on the New volume step; a landed save disarms it.
  const typed = `${windowText.trim()}|${horizonsText.split(/[\s,]+/).filter((p) => p !== "").join(",")}|${discount}`;
  const stored = g === null ? typed : `${g.nii.horizonMonths}|${g.nii.reportHorizons.join(",")}|${saved}`;
  useUnsavedGuard(typed !== stored);
  if (g === null) return null;
  const grid = g.gridHorizonMonths;
  const problems = horizonProblems(windowText, horizonsText, grid);
  const changed = problems.length === 0 && (Number(windowText.trim()) !== g.nii.horizonMonths || readHorizons(horizonsText).join(",") !== g.nii.reportHorizons.join(",") || discount !== saved);
  const onSave = () => act.run("Horizon", async () => {
    await saveGuided(ctx, (s) => {
      const h = withHorizon(s, Number(windowText.trim()), readHorizons(horizonsText));
      return discount === "other" ? h : withDiscount(h, discount);
    });
    ctx.refresh();
    return `Saved: earnings over ${windowText.trim()} months, reported at ${readHorizons(horizonsText).join(", ")} months${discount === "other" ? "" : `; value discounted on the ${discount === "risk-free" ? "risk-free curve" : "all-in curve"}`}.`;
  });
  return (
    <section className="card" aria-label="Horizon and value">
      <div className="card-title">Earnings horizon and value</div>
      <div className="guided-row">
        <label className="field">
          <span className="field-label">Earnings horizon, months</span>
          <input className="input" aria-label="Earnings horizon in months" value={windowText} onChange={(e) => setWindowText(e.target.value)} />
          <span className="field-help">How many months of net interest income the results show and sum, from 12 to 360.</span>
        </label>
        <label className="field">
          <span className="field-label">Report horizons, months</span>
          <input className="input" aria-label="Report horizons in months" value={horizonsText} onChange={(e) => setHorizonsText(e.target.value)} />
          <span className="field-help">The horizons net interest income is totalled at, for example 12, 24, 60.</span>
        </label>
      </div>
      <p className="field-help">{`Value (EVE) always counts every cash flow to the end of each position's life: the projection runs ${grid} months whatever the earnings horizon.`}</p>
      <fieldset className="guided-fieldset">
        <legend>Which curve discounts value?</legend>
        {(["risk-free", "all-in"] as const).map((k) => (
          <label key={k} className="guided-option">
            <input type="radio" name="discount" checked={discount === k} onChange={() => setDiscount(k)} />
            <span className="guided-option-text">
              <span>{DISCOUNT_LABEL[k]}</span>
              <span className="field-help">{k === "risk-free" ? "The regulatory reading of interest rate risk in the banking book: cash flows discounted on the risk-free (swap) curve, with no product or funding spread." : "Cash flows discounted on the risk-free curve plus the bank's term funding spread. Value is lower for long assets and liabilities alike, and the change under each shock is smaller; it is a management view, not the regulatory one."}</span>
            </span>
          </label>
        ))}
        {saved === "other" ? <p className="field-help">{`Your analysis discounts on the ${g.eve.discountBasis} basis, set under Advanced; choose one above to change it.`}</p> : null}
      </fieldset>
      {g.eve.stochastic !== undefined ? <p className="guided-note">A stochastic run discounts every path on the all-in basis and reports 12-month net interest income; the horizon and the curve chosen here apply to the deterministic run.</p> : null}
      {problems.length > 0 ? <ul className="guided-missing">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      <div className="guided-actions">
        <button type="button" className="btn btn-primary" disabled={act.busy || !changed} onClick={onSave}>Save the horizon and value basis</button>
        {typed !== stored ? <span className="field-help">Not saved yet</span> : null}
      </div>
      <ActionLines busy={act.busy} error={act.error} done={act.done} />
    </section>
  );
}

/**
 * New volume in value and the gap (S2b-2 spec points 2 and 3): two opt-ins, both off by default. Run-off EVE
 * and the contractual gap ladders are always computed and stay the default view; each opt-in adds a labelled view
 * beside them, read on the Reports step.
 */
export function NewVolumeViewsCard(props: { ctx: StepContext }) {
  const { ctx } = props;
  const g = ctx.guided;
  const saved = g === null ? { goingConcern: false, forecastGap: false, span: "default" as const } : newVolumeViewsOf(g);
  const [goingConcern, setGoingConcern] = useState(saved.goingConcern);
  const [forecastGap, setForecastGap] = useState(saved.forecastGap);
  const [span, setSpan] = useState<"default" | "horizon">(saved.span);
  const act = useAction();
  const dirty = goingConcern !== saved.goingConcern || forecastGap !== saved.forecastGap || (goingConcern && span !== saved.span);
  useUnsavedGuard(dirty);
  if (g === null) return null;
  const runoff = g.nii.basis.kind === "runoff";
  const window = g.nii.horizonMonths;
  const firstMonths = Math.min(GOING_CONCERN_DEFAULT_MONTHS, window);
  const spanMonths = span === "horizon" ? window : firstMonths;
  const onSave = () => act.run("Views", async () => {
    await saveGuided(ctx, (s) => withNewVolumeViews(s, { goingConcern, forecastGap, span }));
    ctx.refresh();
    const on = [goingConcern ? `going-concern value (new volume made in the first ${spanMonths} months)` : null, forecastGap ? "the forecast gap" : null].filter((x) => x !== null);
    return on.length === 0 ? "Saved: value and the gap ladders run the balance sheet you hold off, the default." : `Saved: the run adds ${on.join(" and ")} beside the default views.`;
  });
  return (
    <section className="card" aria-label="New volume in value and the gap">
      <div className="card-title">New volume in value and the gap</div>
      <p className="card-desc">Value (EVE) and the gap ladders run the balance sheet you hold today off: the regulatory reading, and the default. Each choice below adds a second, labelled view beside it with the new volume your plan makes.</p>
      <fieldset className="guided-fieldset">
        <legend>Add new volume to</legend>
        <label className="guided-option">
          <input type="checkbox" aria-label="Going-concern value beside run-off value" checked={goingConcern} onChange={(e) => setGoingConcern(e.target.checked)} />
          <span className="guided-option-text">
            <span>Going-concern value beside run-off value</span>
            <span className="field-help">Adds the value of the new volume, each tranche over its whole life on the same discount curve, to run-off EVE. A management view: the regulatory measure stays run-off EVE.</span>
          </span>
        </label>
        {goingConcern ? (
          <fieldset className="guided-fieldset">
            <legend>Which new volume it counts</legend>
            <label className="guided-option">
              <input type="radio" name="gc-span" checked={span === "default"} onChange={() => setSpan("default")} />
              <span className="guided-option-text"><span>{`First ${firstMonths} months (default)`}</span><span className="field-help">The usual choice: forecast errors compound further out, so the plan's first year is the part worth valuing.</span></span>
            </label>
            {window > GOING_CONCERN_DEFAULT_MONTHS ? (
              <label className="guided-option">
                <input type="radio" name="gc-span" checked={span === "horizon"} onChange={() => setSpan("horizon")} />
                <span className="guided-option-text"><span>{`The whole earnings horizon (${window} months)`}</span><span className="field-help">Every tranche the plan makes over the months you simulate earnings on, never past them.</span></span>
              </label>
            ) : null}
          </fieldset>
        ) : null}
        <label className="guided-option">
          <input type="checkbox" aria-label="Forecast gap beside the contractual gap" checked={forecastGap} onChange={(e) => setForecastGap(e.target.checked)} />
          <span className="guided-option-text">
            <span>Forecast gap beside the contractual gap</span>
            <span className="field-help">Repeats the repricing and liquidity ladders with each new tranche: its principal and repricing from the month it is made, and its funding as an outflow for a loan or an inflow for a deposit in the month the runoff it replaces comes back.</span>
          </span>
        </label>
      </fieldset>
      {runoff && (goingConcern || forecastGap) ? <p className="guided-note">Your maturing balances run off, so no new volume is made: each added view equals its default view.</p> : null}
      {g.eve.stochastic !== undefined ? <p className="guided-note">Both views are read on the deterministic run; a stochastic run makes no new volume.</p> : null}
      <div className="guided-actions">
        <button type="button" className="btn btn-primary" disabled={act.busy || !dirty} onClick={onSave}>Save these views</button>
        {dirty ? <span className="field-help">Not saved yet</span> : null}
      </div>
      <ActionLines busy={act.busy} error={act.error} done={act.done} />
    </section>
  );
}
