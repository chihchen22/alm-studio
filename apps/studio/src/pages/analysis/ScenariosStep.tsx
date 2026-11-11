// apps/studio/src/pages/analysis/ScenariosStep.tsx
/**
 * Step 7, Scenarios (S2a spec point 8). One builder in the guided setup: presets (the parallel grid, the six
 * standardized shocks, twists), custom shocks by tenor with a preview on the analysis's own market, all saved into
 * the setup. The base scenario always runs. Ramps are not offered: no rate path runs a time-varying shock yet.
 */
import { useState } from "react";
import { previewShock, type ShockPreview } from "@alm/reader";
import { LinePlot } from "../../charts/LinePlot";
import { yearTicks } from "./charts";
import { errText } from "../../errText";
import { choiceOf, PRESETS, scenarioCount, withScenarios, type CustomShock, type ScenarioChoice, type ScenarioPreset } from "../../guided/setup";
import { ActionLines, saveGuided, useAction, useUnsavedGuard, type StepContext } from "./common";

interface KnotText { tenor: string; bp: string }

const ID_OK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const NUM = /^-?\d+(\.\d+)?$/;
const TAKEN = new Set(["S0", "S100", "S-100", "S200", "S-200", "STEEP100", "FLAT100", "SRP-PUP", "SRP-PDN", "SRP-SUP", "SRP-SDN", "SRP-STEEP", "SRP-FLAT", "t", "month", "base"]);

/** The typed shock read into knots, or the problems in words. */
export function readShock(id: string, label: string, knots: KnotText[], existing: readonly CustomShock[]): { shock: CustomShock | null; problems: string[] } {
  const problems: string[] = [];
  if (!ID_OK.test(id)) problems.push("Give the shock a short name: letters, digits, dash or underscore, starting with a letter or digit.");
  else if (TAKEN.has(id) || existing.some((c) => c.id === id)) problems.push(`The name ${id} is taken; choose another.`);
  // A row counts once it has a shock: the tenors the card suggests stay unused until a shock is typed beside them (L1).
  const rows = knots.filter((k) => k.bp.trim() !== "");
  if (rows.length === 0) problems.push("Type a shock beside at least one tenor.");
  const out: CustomShock["knots"] = [];
  rows.forEach((k, i) => {
    if (!NUM.test(k.tenor.trim()) || !(Number(k.tenor) > 0)) problems.push(`Row ${i + 1}: type the tenor in years, above zero.`);
    else if (!NUM.test(k.bp.trim())) problems.push(`Row ${i + 1}: type the shock in basis points.`);
    else out.push({ tenorYears: Number(k.tenor.trim()), shockBp: Number(k.bp.trim()) });
  });
  for (let i = 1; i < out.length; i++) if (!(out[i]!.tenorYears > out[i - 1]!.tenorYears)) problems.push("List the tenors from shortest to longest, each once.");
  return problems.length > 0 ? { shock: null, problems: [...new Set(problems)] } : { shock: { id, label: label.trim() === "" ? id : label.trim(), knots: out }, problems: [] };
}

export function ScenariosStep(props: { ctx: StepContext }) {
  const { ctx } = props;
  const read = ctx.guided === null ? null : choiceOf(ctx.guided.scenarios);
  const [choice, setChoice] = useState<ScenarioChoice>(read ?? { presets: ["parallel"], custom: [] });
  const act = useAction();
  const dirty = JSON.stringify(read) !== JSON.stringify(choice);
  useUnsavedGuard(dirty && read !== null);
  if (ctx.guided === null) return <section className="card"><p className="guided-warn">Answer the New volume step's question first: that starts your analysis setup, and the scenarios are saved into it.</p></section>;
  const toggle = (p: ScenarioPreset) => setChoice({ ...choice, presets: choice.presets.includes(p) ? choice.presets.filter((x) => x !== p) : [...choice.presets, p] });
  const onSave = () => act.run("Save", async () => {
    await saveGuided(ctx, (s) => withScenarios(s, choice));
    ctx.refresh();
    return `Saved: the run measures ${scenarioCount(choice)} scenarios, the base included.`;
  });
  return (
    <>
      <section className="card" aria-label="Scenario presets">
        <div className="card-title">Standard sets</div>
        <p className="card-desc">The base scenario, today's curve unshocked, always runs. Tick the sets to measure beside it.</p>
        {read === null ? <p className="guided-note">The setup's scenarios were chosen under Advanced. Saving here replaces them with the choice below.</p> : null}
        <fieldset className="guided-fieldset">
          <legend>Presets</legend>
          {PRESETS.map((p) => (
            <label key={p.id} className="guided-option">
              <input type="checkbox" checked={choice.presets.includes(p.id)} onChange={() => toggle(p.id)} />
              <span className="guided-option-text"><span>{p.label}</span><span className="field-help">{p.sentence}</span></span>
            </label>
          ))}
        </fieldset>
        {choice.custom.length > 0 ? (
          <div className="table-wrap guided-tall">
            <table className="table">
              <thead><tr><th scope="col">Your shock</th><th scope="col">Shock by tenor</th><th scope="col"></th></tr></thead>
              <tbody>
                {choice.custom.map((c) => (
                  <tr key={c.id}>
                    <td>{c.label}<div className="mono muted">{c.id}</div></td>
                    <td className="guided-wrap">{c.knots.map((k) => `${k.tenorYears}Y ${k.shockBp > 0 ? "+" : ""}${k.shockBp} bp`).join(", ")}</td>
                    <td><button type="button" className="btn btn-quiet" onClick={() => setChoice({ ...choice, custom: choice.custom.filter((x) => x.id !== c.id) })}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="guided-actions">
          <button type="button" className="btn btn-primary" disabled={act.busy || (!dirty && read !== null)} onClick={onSave}>{`Save ${scenarioCount(choice)} scenarios into the analysis`}</button>
          {dirty ? <span className="guided-badge" role="status">Not saved yet</span> : null}
        </div>
        <ActionLines busy={act.busy} error={act.error} done={act.done} />
      </section>
      <CustomShockCard ctx={ctx} existing={choice.custom} onAdd={(c) => setChoice({ ...choice, custom: [...choice.custom, c] })} />
    </>
  );
}

function CustomShockCard(props: { ctx: StepContext; existing: readonly CustomShock[]; onAdd: (c: CustomShock) => void }) {
  const marketId = props.ctx.head.blocks.market.snapshot?.id ?? null;
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [knots, setKnots] = useState<KnotText[]>([{ tenor: "1", bp: "" }, { tenor: "5", bp: "" }, { tenor: "10", bp: "" }, { tenor: "30", bp: "" }]);
  const [shown, setShown] = useState<ShockPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const r = readShock(id, label, knots, props.existing);
  const shapeOnly = readShock("x", "", knots, []);
  const onPreview = () => {
    if (marketId === null || shapeOnly.shock === null) return;
    setErr(null);
    previewShock(marketId, { kind: "custom", shocks: shapeOnly.shock.knots }).then(setShown, (e: unknown) => setErr(errText(e)));
  };
  return (
    <section className="card" aria-label="Custom shock">
      <div className="card-title">Your own shock, by tenor</div>
      <p className="card-desc">Type a shock in basis points beside the tenors you want; rows left without a shock are not used. The engine joins the shocks across the curve. Preview it on your market, then add it.</p>
      <div className="guided-row">
        <label className="field"><span className="field-label">Shock name</span><input className="input" value={id} onChange={(e) => setId(e.target.value)} /><span className="field-help">Short: letters, digits and dashes, for example BEAR-STEEP.</span></label>
        <label className="field"><span className="field-label">Shock label</span><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} /><span className="field-help">Optional: the words a report shows.</span></label>
      </div>
      <div className="table-wrap guided-tall">
        <table className="table guided-table">
          <thead><tr><th scope="col">Tenor, years</th><th scope="col">Shock, bp</th></tr></thead>
          <tbody>
            {knots.map((k, i) => (
              <tr key={i}>
                <td><input className="input input-short" aria-label={`Row ${i + 1} tenor`} value={k.tenor} onChange={(e) => setKnots(knots.map((x, j) => (j === i ? { ...x, tenor: e.target.value } : x)))} /></td>
                <td>
                  <input className="input input-short" aria-label={`Row ${i + 1} shock`} value={k.bp} onChange={(e) => setKnots(knots.map((x, j) => (j === i ? { ...x, bp: e.target.value } : x)))} />{" "}
                  <button type="button" className="btn btn-quiet" aria-label={`Remove row ${i + 1}`} onClick={() => setKnots(knots.filter((_, j) => j !== i))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="guided-actions">
        <button type="button" className="btn btn-quiet" onClick={() => setKnots([...knots, { tenor: "", bp: "" }])}>Add a row</button>
        <button type="button" className="btn" disabled={marketId === null || shapeOnly.shock === null} onClick={onPreview}>Preview on my market</button>
        <button type="button" className="btn btn-primary" disabled={r.shock === null} onClick={() => { if (r.shock !== null) { props.onAdd(r.shock); setId(""); setLabel(""); setShown(null); } }}>Add this shock</button>
      </div>
      {id !== "" || knots.some((k) => k.bp !== "") ? (r.problems.length > 0 ? <ul className="guided-missing">{r.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null) : null}
      {err !== null ? <p className="guided-bad" role="alert">{err}</p> : null}
      {shown !== null ? (
        <figure className="viz">
          <LinePlot
            series={[
              { id: "base", label: "Today's curve", tone: "muted", points: shown.base.t.map((t, i) => [t, shown.base.z[i]! * 100]) },
              { id: "shocked", label: "Shocked", tone: "accent", points: shown.shocked.t.map((t, i) => [t, shown.shocked.z[i]! * 100]) },
            ]}
            xScale="sqrt" xTicks={yearTicks} xLabel={(t) => `${t.toFixed(t < 1 ? 2 : 0)}Y`} yTick={(v) => `${v.toFixed(2)}%`} format={(v) => `${v.toFixed(4)}%`} unit="zero rate, percent"
          />
          <figcaption className="field-help">Zero rates, today's and shocked, at the curve's own nodes.</figcaption>
        </figure>
      ) : null}
      <p className="field-help">Added shocks are saved into the analysis with the button above.</p>
    </section>
  );
}
