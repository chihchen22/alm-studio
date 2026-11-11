// apps/studio/src/pages/scenarios/ScenariosPage.tsx
/**
 * Scenarios route (Studio S3b): load a stored plan, add or remove its
 * scenarios, give a scenario its own assumption set or change the plan
 * default, see the gates after every edit, save it under a new id. Nothing
 * runs from this page: Run this plan opens the Run page for the stored plan.
 * The page shape follows the Plan page's editor (load, edit state, validate,
 * save as, reset); only `scenarios`, `inputs`, the balance plan bindings
 * (`balancePlan`, `scenarioBalancePlans`) and `stages` (the balance stage
 * edit) are edited. The custom section holds the rate shock builder.
 * pageFor renders one ScenariosPage with no key for all three Scenarios
 * layers, so they share this editor and an unsaved edit made on one layer is
 * there on the others.
 */
import { useEffect, useMemo, useState } from "react";
import type { RunPlan } from "@alm/engine";
import { getRunPlan, listScenarioSlates, saveRunPlan, type WorkspaceManifest } from "@alm/reader";
import { AttachStored } from "../../controls/AttachStored";
import { authoredSlateOptions, slateAddBody, writeBlock } from "../../controls/attachBodies";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import { paint } from "../../plan/gatePaint";
import { nextEditId, withPlanId } from "../../plan/planEdits";
import { screenHref } from "../../pageLinks";
import type { ScreenId } from "../../router";
import { runHref } from "../../run/runList";
import { libraryCards, planCards } from "../../scenarios/scenarioCards";
import { addBalanceStage, addLibraryScenario, isOnlyBase, lookupRef, ONLY_BASE, removeScenario, scenarioIdOf, setDefaultSet, setPlanBalancePlan, setScenarioBalancePlan, setScenarioSet } from "../../scenarios/scenarioEdits";
import { editRule } from "../../scenarios/shockForm";
import { INFORMATIONAL_LAYERS } from "../results/informational";
import { defaultPlanId } from "../plan/loadPlan";
import { GateBar } from "../plan/GateBar";
import { planOptionText, runButton } from "../plan/PlanPage";
import { useValidate, type ValidateState } from "../plan/useValidate";
import { loadScenarios, type ScenariosData } from "./loadScenarios";
import { BalancePlanPicker, BalanceStageBanner, DefaultSetPicker, LibraryList, ScenarioCardView, SetHint } from "./ScenariosViews";
import { ShockBuilder } from "./ShockBuilder";

/** A Scenarios sub-layer: sets (the plan's scenarios, default set, balance plan), library (scenarios the plan lacks) or custom (the shock builder). */
export type ScenariosSection = "sets" | "library" | "custom";

/** Where each sub-layer sits in the frame: the scenario choice of Run setups, or a tab of the Scenario library. */
const AT_OF: Record<ScenariosSection, { screen: ScreenId; tab: string }> = {
  sets: { screen: "setups", tab: "scenarios" },
  library: { screen: "scenarios", tab: "rate" },
  custom: { screen: "scenarios", tab: "custom" },
};

/** The href for one stored plan on one sub-layer; every other query key passes through. */
const scenariosHref = (ws: string, query: Record<string, string>, planId: string, section: ScenariosSection) =>
  screenHref({ ws, section: "run", screen: AT_OF[section].screen }, { ...query, tab: AT_OF[section].tab, plan: planId });

/**
 * Where Save as lands (Studio Polish 1 S7): the saved plan on the same layer. On Custom rate shocks the
 * scenario= key is dropped, since the builder would otherwise reopen on the scenario the user started from
 * (a copy of it, after a Copy shock). Every other key passes through.
 */
export function savedHref(ws: string, query: Record<string, string>, saved: string, section: ScenariosSection): string {
  const q = { ...query };
  if (section === "custom") delete q.scenario;
  return scenariosHref(ws, q, saved, section);
}

/** Edited means a field this page edits differs from the stored plan's: scenarios, inputs, the balance plan bindings, or the stages (the balance stage edit). */
export function isEdited(loaded: RunPlan, plan: RunPlan): boolean {
  const pick = (p: RunPlan) => JSON.stringify([p.scenarios, p.inputs, p.balancePlan ?? null, p.scenarioBalancePlans ?? null, p.stages]);
  return pick(loaded) !== pick(plan);
}

/** A refused Add balance stage, stamped with the plan it was refused on. */
export interface StageRefusal { text: string; plan: RunPlan }

/**
 * The refusal to show (Piece 2 bugs): only while the plan on screen is the one it was refused on, so Reset or any
 * later edit clears it. Reset also drops it outright, since Reset can put back the very plan it was refused on.
 */
export function stageRefusalShown(r: StageRefusal | null, plan: RunPlan): string | null {
  return r !== null && r.plan === plan ? r.text : null;
}

/**
 * The page once the plan is read: toolbar and gates on all three sections;
 * the sets section shows the plan's cards on the left and sets and balance
 * plan on the right, the library section shows the library single-column, and
 * the custom section shows the shock builder on the left and its preview on
 * the right.
 */
export function ScenariosBody(props: {
  ws: string;
  data: ScenariosData;
  planId: string;
  query: Record<string, string>;
  loaded: RunPlan;
  plan: RunPlan;
  v: ValidateState;
  saveMsg: string | null;
  onEdit(plan: RunPlan): void;
  onSave(saveId: string): void;
  section: ScenariosSection;
}) {
  const { data, plan, loaded, v, section } = props;
  const edited = isEdited(loaded, plan);
  const [stageRefusal, setStageRefusal] = useState<StageRefusal | null>(null);
  const painted = useMemo(() => paint(plan.stages.map((s) => s.id), v.state === "ok" ? v.reply : null), [plan, v]);
  const stageLines = Object.entries(painted.byStage).filter(([, s]) => s.kind === "refused" || s.kind === "not-implemented");
  // The id the plan saves under, shown on the button before the POST.
  const saveId = nextEditId(plan.planId, new Set(data.plans.map((p) => p.id)));
  const run = runButton(edited ? 1 : 0);
  const cards = planCards(plan, data.libraries);

  return (
    <>
      <SetHint query={props.query} />
      <div className="plan-toolbar">
        <label>
          Plan{" "}
          <select value={props.planId} onChange={(e) => { window.location.hash = scenariosHref(props.ws, props.query, e.target.value, section); }}>
            {data.plans.map((p) => <option key={p.id} value={p.id}>{planOptionText(p)}</option>)}
          </select>
        </label>
        <button type="button" className="btn" onClick={() => props.onSave(saveId)} disabled={!edited}>Save as <span className="mono">{saveId}</span></button>
        <button type="button" className="btn" onClick={() => { setStageRefusal(null); props.onEdit(loaded); }} disabled={!edited}>Reset</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={run.disabled}
          title={run.title}
          onClick={() => { window.location.hash = runHref(props.ws, props.query, props.planId); }}
        >
          Run this plan
        </button>
        <span className="muted">{edited ? "Scenarios, sets or new business edited" : "No edits"}</span>
        {props.saveMsg !== null ? <span role="alert">{props.saveMsg}</span> : null}
      </div>
      <GateBar v={v} gates={painted.gates} />
      <BalanceStageBanner
        plan={plan}
        refusal={stageRefusalShown(stageRefusal, plan)}
        onAdd={() => {
          const r = addBalanceStage(plan);
          if (r.kind === "ok") { setStageRefusal(null); props.onEdit(r.plan); } else setStageRefusal({ text: r.text, plan });
        }}
      />
      {painted.banner.length > 0 ? (
        <div className="card plan-banner" role="alert">
          {painted.banner.map((b, i) => <div key={i}><span className="status status-breach">✕ {b.code}</span> {b.message}</div>)}
        </div>
      ) : null}
      {stageLines.length > 0 ? (
        <div className="card plan-notes">
          {stageLines.map(([id, s]) => (
            <div key={id}>
              {s.kind === "refused"
                ? <><span className="status status-breach">✕ {s.code}</span> stage <span className="mono">{id}</span> {s.message}</>
                : <><span className="status status-unobs">○ Not implemented</span> stage <span className="mono">{id}</span> {s.kind === "not-implemented" ? s.message : null}</>}
            </div>
          ))}
        </div>
      ) : null}
      {painted.notes.length > 0 ? (
        <div className="card plan-notes">
          {painted.notes.map((n) => <div key={n.layer}><span className="status status-unobs">{INFORMATIONAL_LAYERS.has(n.layer) ? "○ Informational" : "○ Not implemented"}</span> <span className="mono">{n.layer}</span> {n.reason}</div>)}
        </div>
      ) : null}
      <p className="card-foot">Gates: POST /api/plans/validate</p>
      {section === "library" ? (
        <LibraryList cards={libraryCards(plan, data.libraries)} onAdd={(ref) => props.onEdit(addLibraryScenario(plan, ref))} />
      ) : section === "custom" ? (
        <ShockBuilder plan={plan} libraries={data.libraries} query={props.query} onEdit={props.onEdit} />
      ) : (
        <div className="grid-2">
          <div className="stack">
            <section className="stack" aria-label="Plan scenarios">
              <div className="card-title">Scenarios in plan <span className="mono">{plan.planId}</span></div>
              {cards.length === 0 ? <p className="card-desc">The plan names no scenario.</p> : null}
              {cards.map((c, i) => {
                const s = plan.scenarios[i]!;
                const ownSet = "ref" in s ? null : s.assumptionSetId ?? null;
                const rule = editRule(s, data.libraries);
                return (
                  <ScenarioCardView
                    key={`${i}-${c.id}`}
                    card={c}
                    sets={data.sets}
                    ownSet={ownSet}
                    onSet={(setId) => props.onEdit(setScenarioSet(plan, i, setId, data.libraries))}
                    onRemove={() => props.onEdit(removeScenario(plan, i, data.libraries))}
                    removeBlocked={isOnlyBase(plan, i, data.libraries) ? ONLY_BASE : undefined}
                    // The query as it stands plus scenario=. A plan= the query lacks would change the
                    // selection, and App reloads the catalog on that change, which drops the unsaved edits.
                    shockLink={rule === "none" ? undefined : {
                      text: rule === "edit" ? "Edit shock" : "Copy shock",
                      href: screenHref({ ws: props.ws, section: "run", screen: "scenarios" }, { ...props.query, tab: "custom", scenario: scenarioIdOf(s) }),
                    }}
                    nb={{
                      value: plan.scenarioBalancePlans?.[scenarioIdOf(s)] ?? null,
                      ownRules: ("ref" in s ? lookupRef(s.ref, data.libraries)?.newBusiness : s.newBusiness) !== undefined,
                      listed: data.balancePlans.filter((b) => b.asOf === plan.asOf),
                      onChange: (id) => props.onEdit(setScenarioBalancePlan(plan, scenarioIdOf(s), id)),
                    }}
                  />
                );
              })}
              <p className="card-foot">Source: /api/run-plans/{props.planId} and /api/plans/library</p>
            </section>
          </div>
          <div className="stack scen-side">
            <DefaultSetPicker plan={plan} sets={data.sets} onChange={(id) => props.onEdit(setDefaultSet(plan, id))} />
            <BalancePlanPicker plan={plan} listed={data.balancePlans} onChange={(id) => props.onEdit(setPlanBalancePlan(plan, id))} />
          </div>
        </div>
      )}
    </>
  );
}

function Editor(props: { ws: string; data: ScenariosData; planId: string; query: Record<string, string>; section: ScenariosSection; onSaved(id: string): void }) {
  const loadedLoad = useLoad(() => getRunPlan(props.planId), [props.planId]);
  // One plan object per edit: the validate loop keys its answer on this identity.
  const [plan, setPlan] = useState<RunPlan | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const loaded = loadedLoad.state === "ok" ? loadedLoad.value : null;
  useEffect(() => { setPlan(loaded); setSaveMsg(null); }, [loaded]);
  const v = useValidate(plan);

  if (loadedLoad.state === "loading") return <div className="card muted">Reading plan {props.planId}</div>;
  if (loadedLoad.state === "error") return <div className="card" role="alert">{errText(loadedLoad.error)}</div>;
  if (plan === null || loaded === null) return <div className="card muted">Reading plan {props.planId}</div>;

  const saveAs = async (saveId: string) => {
    try {
      await saveRunPlan(withPlanId(plan, saveId));
      props.onSaved(saveId);
    } catch (e) {
      setSaveMsg(errText(e));
    }
  };
  return (
    <ScenariosBody
      ws={props.ws}
      data={props.data}
      planId={props.planId}
      query={props.query}
      loaded={loaded}
      plan={plan}
      v={v}
      saveMsg={saveMsg}
      onEdit={(next) => { setPlan(next); setSaveMsg(null); }}
      onSave={(id) => void saveAs(id)}
      section={props.section}
    />
  );
}

/**
 * The slates of this workspace's scenarios block, and the control that adds a stored one (final review M1). A run
 * setup's slate choice lists the slates this block names.
 */
export function SlatesAttach(props: { head: WorkspaceManifest; onChanged: () => void }) {
  const held = props.head.blocks.scenarios.slates.map((s) => s.id);
  return (
    <AttachStored
      head={props.head}
      title="Scenario slates of this workspace"
      selectLabel="Attach a stored slate"
      current={held.length === 0 ? "No slate is attached. A run setup's Slate choice lists the slates attached here." : <>Attached: <span className="mono">{held.join(", ")}</span>.</>}
      foot="Source: GET /api/scenario-slates (the launch slates a plan run writes are left out); the write is POST /api/workspaces/<id>/blocks, scenarios add."
      attachedIds={held}
      loadingText="Reading the stored scenario slates"
      list={() => listScenarioSlates().then(authoredSlateOptions)}
      body={slateAddBody}
      done={(id) => `Attached slate ${id}`}
      onChanged={props.onChanged}
      blocked={writeBlock(props.head, "its scenario slates")}
    />
  );
}

/**
 * One page for the library and custom tabs. The attach card sits before the editor on the library tab only; the
 * editor keeps its place in the tree on both, so an unsaved edit survives the tab change.
 */
export function ScenariosPage(props: { ws: string; bookId: string | null; query: Record<string, string>; section: ScenariosSection; head?: WorkspaceManifest | null; onChanged?: () => void }) {
  const head = props.head ?? null;
  return (
    <>
      {props.section === "library" && head !== null ? <SlatesAttach head={head} onChanged={props.onChanged ?? (() => {})} /> : null}
      <ScenariosStore ws={props.ws} bookId={props.bookId} query={props.query} section={props.section} />
    </>
  );
}

function ScenariosStore(props: { ws: string; bookId: string | null; query: Record<string, string>; section: ScenariosSection }) {
  const [refresh, setRefresh] = useState(0);
  const load = useLoad(() => loadScenarios(), [refresh]);
  if (load.state === "loading") return <div className="card muted">Reading the plan store</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  const id = defaultPlanId(load.value.plans, props.bookId, props.query.plan);
  if (id === null) {
    return (
      <div className="card unobs-panel">
        <span className="status status-unobs">Unobservable</span>
        <p className="unobs-text">No run plan stored: /api/run-plans returned none. Run the seed to store the demo plans.</p>
      </div>
    );
  }
  return (
    <Editor
      ws={props.ws}
      data={load.value}
      planId={id}
      query={props.query}
      section={props.section}
      onSaved={(saved) => { setRefresh((n) => n + 1); window.location.hash = savedHref(props.ws, props.query, saved, props.section); }}
    />
  );
}
