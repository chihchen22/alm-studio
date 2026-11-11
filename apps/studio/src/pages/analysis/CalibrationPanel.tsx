// apps/studio/src/pages/analysis/CalibrationPanel.tsx
/**
 * Calibration as its own action, shared by the guided Calibration step and the Advanced
 * Market > Rate model screen. Fit Hull-White or BGM on the workspace's snapshot (the server calls the kernel's own
 * fitters on the inputs a run fits on), read the parameters and the fit error against the gate in plain words, see the
 * model's volatilities drawn against the market's, and save the fit. A fit outside its gate saves only with a written
 * reason and reads "outside its gate" wherever it is listed. BGM solver options (the iteration cap and the starting
 * points) are offered here only. The guided step adds "Use for runs": the stochastic run then uses the saved fit
 * instead of fitting when it starts. SABR has no fitter; its smile stays a preview on Volatility surfaces.
 */
import { Fragment, useState } from "react";
import { fitRateModel, listCalibrations, saveCalibration, type CalibrationFitReply } from "@alm/reader";
import type { BgmSolverOptions, SavedCalibration } from "@alm/engine";
import { LinePlot } from "../../charts/LinePlot";
import { useKeptLoad as useLoad } from "../../useLoad";
import { errText } from "../../errText";
import { MODEL_LABEL, type SimulationModel } from "../../guided/setup";
import { ActionLines, byName, Details, useAction, useUnsavedGuard } from "./common";

/** The parameters of a fit in plain words, each value at six significant digits (full precision behind Details). */
export function parameterLines(p: SavedCalibration["fit"]["parameters"]): Array<{ label: string; value: string }> {
  const f = (v: number) => v.toPrecision(6);
  if (p.model === "hull-white-1f") return [{ label: "Mean reversion a (per year)", value: f(p.a) }, { label: "Volatility sigma (normal, per year)", value: f(p.sigma) }];
  return [
    { label: "Volatility shape a, b, c, d", value: [p.a, p.b, p.c, p.d].map(f).join(", ") },
    { label: "Correlation decay beta", value: f(p.beta) },
    { label: "Volatility scale", value: f(p.volScalar) },
    { label: "Displacement and CEV exponent (held fixed)", value: `${p.displacement}, ${p.cevBeta}` },
  ];
}

/** One saved fit in a sentence: its label, model, verdict and, outside its gate, the reason it was saved with. */
export function savedText(c: SavedCalibration): string {
  const verdict = `${c.fit.rmseBp.toFixed(2)} bp against a ${c.fit.gateBp} bp gate, ${c.fit.breached ? "outside its gate" : "within its gate"}`;
  return `${c.label}: ${MODEL_LABEL[c.fit.model]}, ${verdict}${c.acceptance.kind === "outside-gate" ? `. Saved with the reason: ${c.acceptance.reason.replace(/[.!?]+$/, "")}` : ""}.`;
}

/** A tenor in years as a reader writes it: months under a year (1m, 6m), else years (2y, 10y). */
export function tenorText(years: number): string {
  return years < 1 ? `${Math.round(years * 12)}m` : `${Number(years.toFixed(2))}y`;
}

/** The typed BGM solver options, or the problems in words. */
export function solverOf(text: { maxIterations: string; a: string; b: string; c: string; d: string }): { solver: BgmSolverOptions } | { problems: string[] } {
  const out: BgmSolverOptions = {};
  const problems: string[] = [];
  if (text.maxIterations.trim() !== "") {
    const n = Number(text.maxIterations.trim());
    if (!Number.isInteger(n) || n < 1 || n > 2000) problems.push("Type the iteration cap as a whole number from 1 to 2000.");
    else out.maxIterations = n;
  }
  const starts = [text.a, text.b, text.c, text.d].map((x) => x.trim());
  if (starts.some((x) => x !== "")) {
    if (starts.some((x) => x === "" || !Number.isFinite(Number(x)))) problems.push("Type all four starting points a, b, c and d as numbers, or leave all four blank.");
    else [out.aInit, out.bInit, out.cInit, out.dInit] = starts.map(Number) as [number, number, number, number];
  }
  return problems.length > 0 ? { problems } : { solver: out };
}

export interface CalibrationUse {
  /** The model the analysis's stochastic run names; null when the analysis runs one deterministic path. */
  model: SimulationModel | null;
  /** The saved fit the run uses now; null when it fits at run time. */
  selected: string | null;
  onUse: (id: string | null) => Promise<void>;
}

export function CalibrationPanel(props: { marketId: string | null; defaultModel: SimulationModel; use?: CalibrationUse; readOnly?: string | null }) {
  const { marketId } = props;
  const [model, setModel] = useState<SimulationModel>(props.defaultModel);
  const [solverText, setSolverText] = useState({ maxIterations: "", a: "", b: "", c: "", d: "" });
  const [fit, setFit] = useState<{ reply: CalibrationFitReply; solver: BgmSolverOptions } | null>(null);
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const act = useAction();
  const saved = useLoad(() => (marketId === null ? Promise.resolve([]) : listCalibrations(marketId)), [marketId, tick]);
  // A fit on screen that is not saved is unsaved work: leaving the page asks first.
  useUnsavedGuard(fit !== null && savedId === null);
  if (marketId === null) return <section className="card"><p className="guided-warn">Choose the market on the Market step first: a fit is made on the workspace's snapshot.</p></section>;
  const solver = model === "bgm-lmm-2f" ? solverOf(solverText) : { solver: {} };
  const problems = "problems" in solver ? solver.problems : [];
  const breached = fit?.reply.fit.breached === true;
  const locked = props.readOnly != null;

  const onFit = () => act.run("Fit", async () => {
    if ("problems" in solver) return;
    const reply = await fitRateModel({ marketId, model, ...(Object.keys(solver.solver).length > 0 ? { solver: solver.solver } : {}) });
    setFit({ reply, solver: solver.solver });
    setSavedId(null);
    setLabel(`${model === "hull-white-1f" ? "Hull-White" : "BGM"} fit on ${marketId}${Object.keys(solver.solver).length > 0 ? ", own solver options" : ""}`);
    setReason("");
    return "Fitted: the fit is below.";
  });
  const onSave = () => act.run("Save", async () => {
    if (fit === null) return;
    const doc = await saveCalibration({ marketId, model: fit.reply.fit.model, ...(Object.keys(fit.solver).length > 0 ? { solver: fit.solver } : {}), label, by: byName(), ...(reason.trim() !== "" ? { reason: reason.trim() } : {}) });
    setSavedId(doc.id);
    setTick((t) => t + 1);
    return `Saved: ${doc.label}.`;
  });
  const onUse = (id: string | null) => act.run("Use", async () => {
    await props.use!.onUse(id);
    return id === null ? "Saved: the stochastic run fits its model when it starts." : "Saved: the stochastic run uses this fit.";
  });

  const f = fit?.reply.fit;
  const bgm = f?.model === "bgm-lmm-2f";
  const points = (sel: (q: NonNullable<typeof f>["quotes"][number]) => number) => (f?.quotes ?? []).map((q, i) => [bgm ? i + 1 : q.expiryYears, sel(q)] as [number, number]);
  const ticks = f === undefined ? [] : bgm ? f.quotes.map((q, i) => ({ value: i + 1, label: `${tenorText(q.expiryYears)} x ${tenorText(q.tenorYears ?? 0)}` })).filter((_, i) => i % 4 === 0) : f.quotes.map((q) => ({ value: q.expiryYears, label: tenorText(q.expiryYears) }));
  const savedList = saved.state === "ok" ? saved.value : [];
  return (
    <>
      <section className="card" aria-label="Fit the rate model">
        <div className="card-title">Fit the rate model</div>
        <p className="card-desc">A fit reads the volatilities of the market snapshot {marketId}: Hull-White the at-the-money cap volatilities, BGM a 28-point subset of the swaption volatilities. It is the fit a stochastic run makes when it starts.</p>
        <div className="guided-row">
          <label className="field">
            <span className="field-label">Model</span>
            <select className="guided-select" aria-label="Model" value={model} disabled={act.busy} onChange={(e) => { setModel(e.target.value as SimulationModel); setFit(null); }}>
              {(["hull-white-1f", "bgm-lmm-2f"] as const).map((m) => <option key={m} value={m}>{MODEL_LABEL[m]}</option>)}
            </select>
          </label>
        </div>
        {model === "bgm-lmm-2f" ? (
          <Details summary="Solver options (BGM only): the iteration cap and the starting points">
            <p className="field-help">Leave these blank to fit exactly as a run does (150 iterations, six starting points, the best kept). A higher cap or other starting points may lower the fit error; a run uses them only through a saved fit.</p>
            <div className="guided-row">
              <label className="field"><span className="field-label">Iteration cap</span><input className="input" aria-label="Iteration cap" inputMode="numeric" value={solverText.maxIterations} onChange={(e) => setSolverText({ ...solverText, maxIterations: e.target.value })} /></label>
              {(["a", "b", "c", "d"] as const).map((k) => (
                <label key={k} className="field"><span className="field-label">{`Start ${k}`}</span><input className="input" aria-label={`Start ${k}`} inputMode="decimal" value={solverText[k]} onChange={(e) => setSolverText({ ...solverText, [k]: e.target.value })} /></label>
              ))}
            </div>
          </Details>
        ) : null}
        {problems.length > 0 ? <ul className="guided-missing" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
        <div className="guided-actions">
          <button type="button" className="btn btn-primary" disabled={act.busy || problems.length > 0} onClick={onFit}>Fit the model</button>
          <span className="field-help">A BGM fit takes a few seconds.</span>
        </div>
        <ActionLines busy={act.busy} busyText="Working" error={act.error} done={act.done} />
      </section>
      {f !== undefined && fit !== null ? (
        <section className="card" aria-label="The fit">
          <div className="card-title">{`${MODEL_LABEL[f.model]}: the fit`}</div>
          <p className={breached ? "guided-warn" : "guided-ok"} role="status">{`Fit error ${fit.reply.verdict}.`}</p>
          <dl className="kv">{parameterLines(f.parameters).map((l) => <Fragment key={l.label}><dt>{l.label}</dt><dd className="num">{l.value}</dd></Fragment>)}</dl>
          <figure className="viz guided-fit-plot">
            <LinePlot
              series={[
                { id: "market", label: "Market", tone: "accent", points: points((q) => q.marketVolBp) },
                { id: "model", label: "Model", tone: "second", dash: true, points: points((q) => q.modelVolBp) },
              ]}
              xScale="linear" xTicks={ticks} xLabel={(x) => (bgm ? `Point ${x}: ${tenorText(f.quotes[x - 1]?.expiryYears ?? 0)} into ${tenorText(f.quotes[x - 1]?.tenorYears ?? 0)}` : `Expiry ${tenorText(x)}`)}
              yTick={(v) => `${v.toFixed(0)}`} format={(v) => `${v.toFixed(2)} bp`} unit="bp of normal volatility" markers
            />
            <figcaption className="field-help">{bgm ? "The model's volatility against the market's at each swaption point (expiry into tenor, in years)." : "The model's caplet volatility against the market's at each cap expiry."}</figcaption>
          </figure>
          <Details>
            <p>{`${f.nQuotes} quotes, ${f.iterations} solver iterations${Object.keys(f.solver).length > 0 ? `, solver options ${JSON.stringify(f.solver)}` : ", the run's own solver settings"}. Pinned to snapshot ${fit.reply.pins.marketId} (bytes ${fit.reply.pins.marketHash.slice(0, 12)}) and curve ${fit.reply.pins.curveFingerprint.slice(0, 12)}.`}</p>
            <p>{`Parameters at full precision: ${JSON.stringify(f.parameters)}`}</p>
          </Details>
          <label className="field guided-wide-field">
            <span className="field-label">Name</span>
            <input className="input" aria-label="Fit name" value={label} maxLength={120} disabled={locked} onChange={(e) => setLabel(e.target.value)} />
          </label>
          {breached ? (
            <label className="field">
              <span className="field-label">Why you accept a fit outside its gate (required to save it)</span>
              <textarea className="input" aria-label="Reason" rows={2} maxLength={1000} value={reason} disabled={locked} onChange={(e) => setReason(e.target.value)} />
            </label>
          ) : null}
          <div className="guided-actions">
            <button type="button" className="btn btn-primary" disabled={act.busy || locked || savedId !== null || label.trim() === "" || (breached && reason.trim() === "")} onClick={onSave}>Save this fit</button>
            <span className="field-help" role="status">{savedId !== null ? "Saved." : breached && reason.trim() === "" ? "Not saved: write the reason first." : "Not saved yet."}</span>
          </div>
        </section>
      ) : null}
      <section className="card" aria-label="Saved fits">
        <div className="card-title">Saved fits on this market</div>
        {saved.state === "error" ? <p className="guided-bad" role="alert">{errText(saved.error)}</p> : null}
        {savedList.length === 0 ? <p className="muted">No fit is saved on this market yet.</p> : (
          <ul className="guided-list">
            {savedList.map((c) => (
              <li key={c.id}>
                <span>{savedText(c)}</span>
                {c.fit.breached ? <span className="guided-badge">Outside its gate</span> : null}
                {props.use !== undefined && props.use.selected === c.id ? <span className="guided-badge guided-badge-quiet">Used by your stochastic run</span> : null}
                {props.use !== undefined && props.use.model === c.fit.model && props.use.selected !== c.id ? (
                  <button type="button" className="btn btn-quiet" disabled={act.busy || locked} onClick={() => onUse(c.id)}>Use for runs</button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {props.use !== undefined ? (
          <p className="field-help">
            {props.use.model === null
              ? "Your analysis runs one deterministic path, which fits no rate model. Choose a stochastic run on the Simulation step to use a saved fit."
              : props.use.selected === null
                ? `Your stochastic run (${MODEL_LABEL[props.use.model]}) fits its model when it starts. Use a saved fit of the same model to run on it instead.`
                : saved.state === "ok" && !savedList.some((c) => c.id === props.use!.selected)
                  // Fix round L6: the chosen fit was made on another snapshot (the market changed since): say so, plainly.
                  ? `Your stochastic run names the saved fit ${props.use.selected}, made on another market snapshot, and a launch refuses it. Fit at run time instead, or fit and use one on this market.`
                  : "Your stochastic run uses the saved fit marked above. A run on another snapshot or curve refuses it."}
          </p>
        ) : null}
        {props.use?.selected != null ? <div className="guided-actions"><button type="button" className="btn" disabled={act.busy || locked} onClick={() => onUse(null)}>Fit at run time instead</button></div> : null}
      </section>
    </>
  );
}
