// apps/studio/src/pages/analysis/RunStep.tsx
/**
 * Step 8, Run. The guided setup in plain words, one check, the notes to confirm in plain words, and one Launch button.
 * Both choices launch through the workspace launch gate: a deterministic choice the setup itself, a stochastic choice
 * its stochastic arm (a base-only slate, the workspace's book, snapshot and default
 * assumption set, pinned like any launch and attached to the workspace, so it is listed in the run history and in
 * Advanced Results). The run's progress shows here until it is done; its reports open on the next step.
 */
import { useEffect, useState } from "react";
import {
  ApiError, getRun, launchSetup, listAssumptionSets, listMarket, listPortfolios, previewNewVolume, validateSetup,
  type LaunchGateRefusal, type ReadinessReport, type RunSetup, type ValidateSetupReply,
} from "@alm/reader";
import { useKeptLoad as useLoad } from "../../useLoad";
import { GUIDED_SLOT } from "../../guided/steps";
import { answerOf, choiceOf, MODEL_LABEL, PRESETS, scenarioCount, simulationOf } from "../../guided/setup";
import { ActionLines, byName, Details, linkedRunText, runText, saveGuided, useAction, type StepContext } from "./common";
import { modelConventionLine } from "../../rows/setupRows";

/** A readiness item id ("<section>/<item>") in plain words, with the server's own words for Details. */
function noteOf(id: string, readiness: ReadinessReport | null): { plain: string; detail: string } {
  if (id === "run/setup-warnings") return { plain: "The check has warnings about the setup; they are listed in its details.", detail: id };
  const [section, item] = [id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)];
  const found = readiness?.items.find((i) => i.section === section && i.item === item);
  const detail = found?.detail ?? id;
  if (id === "balance/Positions") return { plain: "The balance sheet's date is not the workspace date. Confirm to run the positions as dated.", detail };
  if (id === "market/Base snapshot") return { plain: "The market snapshot's date is not the workspace date. Confirm to run on it.", detail };
  return { plain: `${item}: ${found?.state ?? "needs a look"}.`, detail };
}

/** The names a learner reads in place of ids (L4): the snapshot's, the balance sheet's and the models' labels. */
interface Names {
  market: string | null;
  book: string | null;
  models: string | null;
  /** Fix round L6: the families whose saved product runs its model, as the server's preview reads it; null while unread. */
  behaviorApplied: string[] | null;
}

/** Fix round L6: which products run their family's model, by name, once the preview has read them; else how many ask. */
function behaviorLine(g: RunSetup, names: Names): string {
  const asking = (g.nii.templates ?? []).filter((t) => t.behavior === "family").length;
  if (names.behaviorApplied === null) return `Behavior on new volume: ${asking} of the products ask for their family's model; it runs where the family has one (the New volume step lists which).`;
  if (names.behaviorApplied.length === 0) return "Behavior on new volume: no product runs a behavioral model; the new volume is contractual.";
  return `Behavior on new volume: ${names.behaviorApplied.join(", ")} ${names.behaviorApplied.length === 1 ? "runs its" : "run their"} family's model, aged from the month each tranche is made; the other products are contractual.`;
}

function summaryLines(ctx: StepContext, g: RunSetup, names: Names): string[] {
  const head = ctx.head;
  const sim = simulationOf(g);
  const choice = choiceOf(g.scenarios);
  const answer = answerOf(g.nii.basis);
  const maturing = answer.kind === "runoff" ? "run off" : answer.kind === "flat" ? "are replaced to keep every balance flat" : "follow your targets";
  const stochastic = sim.kind === "stochastic";
  const market = names.market ?? head.blocks.market.snapshot?.id ?? "none chosen";
  // A stochastic run builds from the snapshot's own quotes and runs the positions off on every path (L16): the summary says so.
  const curve = head.blocks.market.curveSetups?.active === undefined ? "" : stochastic ? "; a stochastic run uses the snapshot's own curve, not your edited variant" : ", with your edited curve variant";
  return [
    `Market: ${market}${curve}.`,
    `Balance sheet: ${names.book ?? head.blocks.positions.book?.id ?? "none loaded"}.`,
    `Behavior: ${head.blocks.assumptions.defaultSetId === null ? "no models saved" : names.models ?? "your saved models"}.`,
    stochastic ? "Maturing balances: a stochastic run runs the positions off on every path, whatever the New volume answer." : `Maturing balances ${maturing}.`,
    // The products, the earnings horizon and the value basis, in words.
    ...(stochastic || answer.kind === "runoff" ? [] : [(g.nii.templates ?? []).length > 0 ? `New volume: ${(g.nii.templates ?? []).length} famil${(g.nii.templates ?? []).length === 1 ? "y has its" : "ies have their"} own product; any other family gets a fixed-rate bullet at the par swap rate, at its term and spread.` : "New volume: a fixed-rate bullet at the par swap rate for every family, at each family's term and spread (today's rule)."]),
    // How many products carry their family's behavior, and the two opt-in views.
    ...(stochastic || answer.kind === "runoff" || !(g.nii.templates ?? []).some((t) => t.behavior === "family") ? [] : [behaviorLine(g, names)]),
    ...(stochastic ? [] : [`Value: run-off EVE${g.eve.goingConcern === true ? ", with going-concern EVE beside it" : ""}; gap ladders: contractual${g.gap.forecast === true ? ", with the forecast gap beside them" : ""}.`]),
    `Earnings horizon: ${g.nii.horizonMonths} months, reported at ${g.nii.reportHorizons.join(", ")} months; value counts every cash flow to the end of each position's life.`,
    `Value discounted on the ${g.eve.discountBasis === "risk-free" ? "risk-free curve, no product spread" : g.eve.discountBasis === "all-in" ? "all-in curve (risk-free plus the funding spread)" : `${g.eve.discountBasis} basis`}${stochastic ? " (a stochastic run discounts on the all-in basis)" : ""}.`,
    sim.kind === "deterministic" ? "Simulation: one deterministic path per scenario." : `Simulation: ${sim.nPaths} paths on ${MODEL_LABEL[sim.model]}, seed ${sim.seed}, base scenario only; ${g.eve.stochastic?.calibrationId !== undefined ? "the rate model uses your saved calibration" : "the rate model is fitted when the run starts"}.`,
    sim.kind === "deterministic"
      ? `Scenarios: ${scenarioCount(choice ?? { presets: [], custom: [] })} (${choice === null ? "chosen under Advanced" : ["the base", ...choice.presets.map((p) => PRESETS.find((x) => x.id === p)!.label.toLowerCase()), ...choice.custom.map((c) => c.label)].join(", ")}).`
      : "Scenarios: the base only, as a stochastic run measures.",
    `Per-position results: ${g.instrumentResults.save ? "saved" : "not saved (the Reports step can re-run with them)"}.`,
  ];
}

function useRunWatch(runId: string | null, onDone: () => void): string | null {
  const [state, setState] = useState<string | null>(null);
  useEffect(() => {
    if (runId === null) return;
    let stop = false;
    const tick = () => {
      getRun(runId).then((d) => {
        if (stop) return;
        setState(d.state);
        if (d.state === "done" || d.state === "error" || d.state === "cancelled" || d.state === "interrupted") onDone();
        else window.setTimeout(tick, 1500);
      }, () => { if (!stop) window.setTimeout(tick, 3000); });
    };
    tick();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);
  return state;
}

export function RunStep(props: { ctx: StepContext }) {
  const { ctx } = props;
  const g = ctx.guided;
  // Fix round L6: the preview of the saved products names the families whose new volume runs its model.
  const appliedFamilies = async (): Promise<string[] | null> => {
    const templates = g?.nii.templates ?? [];
    if (templates.length === 0) return null;
    try {
      const p = await previewNewVolume(ctx.ws, { templates });
      return p.families.filter((f) => f.preview?.behavior?.applied === true).map((f) => f.label);
    } catch {
      return null;
    }
  };
  const namesLoad = useLoad(async (): Promise<Names> => {
    const [markets, books, sets] = await Promise.all([listMarket().catch(() => []), listPortfolios().catch(() => []), listAssumptionSets().catch(() => [])]);
    const m = markets.find((x) => x.id === ctx.head.blocks.market.snapshot?.id);
    return {
      market: m === undefined ? null : `${m.label ?? m.id}${m.calibrationDate === undefined ? "" : `, ${m.calibrationDate}`}`,
      book: books.find((x) => x.id === ctx.head.blocks.positions.book?.id)?.label ?? null,
      models: sets.find((x) => x.id === ctx.head.blocks.assumptions.defaultSetId)?.label ?? null,
      behaviorApplied: await appliedFamilies(),
    };
  }, [ctx.head.revision]);
  const names: Names = namesLoad.state === "ok" ? namesLoad.value : { market: null, book: null, models: null, behaviorApplied: null };
  const [check, setCheck] = useState<ValidateSetupReply | null>(null);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const act = useAction();
  const state = useRunWatch(runId, ctx.refresh);
  if (g === null) return <section className="card"><p className="guided-warn">Answer the New volume step's question first: that starts your analysis setup.</p></section>;
  const sim = simulationOf(g);
  const launch = ctx.readiness?.launchable[GUIDED_SLOT] ?? { ok: false, blocking: [], acknowledgeable: [] };
  const stochBlocking = launch.blocking.filter((id) => !id.startsWith("run/"));
  const blocking = sim.kind === "stochastic" ? stochBlocking : launch.blocking;
  const ackIds = sim.kind === "stochastic" ? launch.acknowledgeable.filter((id) => !id.startsWith("run/")) : launch.acknowledgeable;
  const allAcked = ackIds.every((id) => acks[id] === true);

  // A setup on the original convention moves to the corrections in one save; the next launch reads them.
  const onCorrect = () => act.run("Correct", async () => {
    await saveGuided(ctx, (s) => ({ ...s, modelConvention: "corrected-v1" }));
    ctx.refresh();
    return "The analysis now runs with the corrections. Launch it again to update the numbers.";
  });
  const onCheck = () => act.run("Check", async () => {
    const r = await validateSetup(ctx.ws, GUIDED_SLOT, { by: byName() });
    setCheck(r);
    ctx.refresh();
    return r.outcome === "fail" ? undefined : r.outcome === "warn" ? "The check passed with notes." : "The check passed.";
  });
  const onLaunch = () => act.run("Launch", async () => {
    try {
      const r = await launchSetup(ctx.ws, GUIDED_SLOT, { by: byName(), acknowledge: ackIds, ...(sim.kind === "stochastic" ? { mode: "stochastic" as const } : {}) });
      const id = r.runIds[0] ?? null;
      setRunId(id);
      ctx.refresh();
      if (id === null) return "The launch queued no run.";
      return sim.kind === "stochastic" ? `Launched: stochastic run ${id}, ${sim.nPaths} paths. It is attached to this workspace and listed in the run history.` : `Launched: run ${id}.`;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as LaunchGateRefusal | undefined;
        throw new Error(body?.blocking?.length ? `The launch is blocked: ${body.blocking.map((b) => noteOf(b, ctx.readiness).plain).join(" ")}` : e.message);
      }
      throw e;
    }
  });

  const det = ctx.runs.filter((r) => r.setupLineageId === GUIDED_SLOT).slice(0, 5);
  const sto = ctx.stochastic.slice(0, 5);
  return (
    <>
      <section className="card" aria-label="Your analysis">
        <div className="card-title">Your analysis</div>
        <ul className="guided-missing">{summaryLines(ctx, g, names).map((l) => <li key={l}>{l}</li>)}</ul>
        {modelConventionLine(g) !== null ? (
          <p className="guided-note" role="note">
            {modelConventionLine(g)}{" "}
            <button type="button" className="btn btn-quiet btn-flush" disabled={act.busy} onClick={onCorrect}>Use the corrections</button>
          </p>
        ) : null}
        {blocking.length > 0 ? (
          <div className="guided-bad" role="alert">
            <p>Before the run can start:</p>
            <ul className="guided-missing">{blocking.map((b) => <li key={b}>{noteOf(b, ctx.readiness).plain}</li>)}</ul>
          </div>
        ) : null}
        {ackIds.length > 0 ? (
          <fieldset className="guided-fieldset">
            <legend>Confirm before launching</legend>
            {ackIds.map((id) => {
              const n = noteOf(id, ctx.readiness);
              return (
                <label key={id} className="guided-option">
                  <input type="checkbox" checked={acks[id] === true} onChange={(e) => setAcks({ ...acks, [id]: e.target.checked })} />
                  <span className="guided-option-text"><span>{n.plain}</span><span className="field-help">{n.detail}</span></span>
                </label>
              );
            })}
          </fieldset>
        ) : null}
        <div className="guided-actions">
          {sim.kind === "deterministic" ? <button type="button" className="btn" disabled={act.busy} onClick={onCheck}>Check the analysis</button> : null}
          <button type="button" className="btn btn-primary" disabled={act.busy || blocking.length > 0 || !allAcked || (state === "queued" || state === "running")} onClick={onLaunch}>Launch</button>
          {state !== null ? <span className="guided-badge guided-badge-quiet" role="status">{`Run ${state}`}</span> : null}
          {state === "done" ? <button type="button" className="btn" onClick={() => ctx.go("reports")}>Open the reports</button> : null}
        </div>
        {sim.kind === "stochastic" ? <p className="field-help">A stochastic run of the base scenario: the positions run off on every path, and the run reports the distribution of value and 12-month net interest income.</p> : null}
        <ActionLines busy={act.busy} busyText="Working" error={act.error} done={act.done} />
        {check !== null ? <CheckResult r={check} /> : null}
      </section>
      {det.length + sto.length > 0 ? (
        <section className="card table-card" aria-label="Runs of this analysis">
          <div className="card-title">Runs of this analysis</div>
          <div className="table-wrap guided-tall">
            <table className="table">
              <thead><tr><th scope="col">Run</th><th scope="col">Kind</th><th scope="col">State</th></tr></thead>
              <tbody>
                {det.map((r) => <tr key={r.runId}><td>{runText({ runId: r.runId, label: r.status?.label, endedAt: r.status?.endedAt })}</td><td>Deterministic</td><td>{r.status?.state ?? "unknown"}</td></tr>)}
                {sto.map((r) => <tr key={r.runId}><td>{linkedRunText(r)}</td><td>{r.setupDocId === g.id ? "Stochastic" : "Stochastic, an earlier version of the setup"}</td><td>{r.status?.state ?? "unknown"}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="field-help">Every run of this analysis is attached to the workspace: it is listed here, on the Reports step, in the run history (Run, Queue and history) and in Advanced Results.</p>
        </section>
      ) : null}
    </>
  );
}

function CheckResult(props: { r: ValidateSetupReply }) {
  const { r } = props;
  const refused = "error" in r.reports;
  const warnings = "warnings" in r.reports ? r.reports.warnings : [];
  return (
    <div className={r.outcome === "fail" ? "guided-bad" : r.outcome === "warn" ? "guided-warn" : "guided-ok"} role="status">
      <p>{r.outcome === "fail" ? `The check failed: ${refused ? (r.reports as { error: { message: string } }).error.message : "see the details"}` : `The check passed${r.outcome === "warn" ? " with notes" : ""}. Balance sheet: ${r.basisLabel}.`}</p>
      {warnings.length > 0 ? <ul className="guided-missing">{warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      <Details><p>{`Compiled ${r.compiledChain.length} stages${r.skippedFamilies.length > 0 ? `; families with nothing to run: ${r.skippedFamilies.join(", ")}` : ""}.`}</p></Details>
    </div>
  );
}

