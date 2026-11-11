// apps/studio/src/run/SetupEditor.tsx
/**
 * The run setup editor (spec v3.1 Section 5.2). It edits a copy of the stored, immutable document and hands
 * the copy to `onSave`, which writes a successor; nothing it holds changes the stored one. Four tabs: Measures (NII,
 * EVE and gap as three separate settings cards, FTP and instrument-level results beneath), Scenarios, Path and Batch.
 * Beneath the tabs the summary strip prints the newest validation, the compiled chain (read-only) and the Launch
 * strip. A setting the engine cannot honour in this release is a disabled choice that names the piece that will; the
 * validation report repeats it as a warning, so it is never a plausible number.
 */
import { useState, type ReactNode } from "react";
import type { ScenarioLibrary } from "@alm/engine";
import type { ReadinessItem, RunSetup, ScenarioSlate, SetupScenarios, SetupValidationEntry, ValidateSetupReply } from "@alm/reader";
import {
  BASE_MARKET_CHOICE, BASIS_CHOICES, CUSTOM_NEEDS_PLAN, EVE_DISCOUNT_CHOICES, EVE_DURATION_CHOICES, EVE_VALUATION_CHOICES, FTP_BRIDGE_HELP, GAP_BUCKET_CHOICES,
  LIQUIDITY_FLOW_CHOICES, LIQUIDITY_INTERVAL_CHOICES, LIQUIDITY_OFF_NOTE, LIQUIDITY_RESERVED_NOTE, MODEL_CONVENTION_CHOICES, NII_PATH_NOTE, NMD_CONVENTION_CHOICES, PATH_CHOICES, SETUP_TABS,
  modelConventionLine, modelConventionOf, withModelConvention,
  STOCHASTIC_PATH_NOTE, STOCHASTIC_PATH_REFUSAL, STRESS_COLUMNS, STRESS_SCENARIOS,
  assumptionSelectValue, assumptionSetIdsFrom, assumptionSetOptions, basisFromValue, basisNote, basisValueOf, draftForSave, templatesNote,
  edgesText, horizonProblem, isDirty, nextSetupViewId, withSetupView, withoutSetupView, keepListOption, keepMarketOption, marketInputFrom, marketSelectValue, nmdConventionOf, parseBucketEdges, parseReportHorizons,
  parseStressAmount, parseStressRate, planScenarioText, rateSpecText, sameScenarios, scenarioRefsOf, scenarioText, setupTabOf, stressAmountText,
  stressRateText, toggleRef, validationOutcomeText, withBasis, withInstrumentNode, withInstrumentSave, withLiquidityStress, withNmdConvention,
  withNextReset, withSeg, withSegKnob, withStressAmount, withStressRate, SEG_KNOBS, parseSegKnob, segKnobText, segOverlayLines,
  DIAL_FIELDS, DIALS_AMOUNT_HELP, cdRenewalOn, parseBp, parseSurvivalMonths, withBufferFromTags, withCdRenewal, withDials, withDialsField, withFacility, withFacilityField, withSurvivalMonths, withSurvivalPath,
  type SelectChoice, type SetupTab,
} from "../rows/setupRows";
import { CompiledChainPanel, refusalGates, type ChainGates } from "./CompiledChainPanel";
import { ViewsCard, type ViewDraft } from "../pages/plan/ViewsCard";
import type { ViewDimOption } from "../plan/planViews";
import { LaunchStrip, type SlotLaunchable } from "./LaunchStrip";

/** What the editor reads from the workspace beside the setup: the sets, plans, scenario sources and chart nodes. */
export interface SetupEditorContext {
  defaultSetId: string | null;
  setIds: string[];
  balancePlanIds: string[];
  libraries: ScenarioLibrary[];
  slates: ScenarioSlate[];
  coaNodes: Array<{ id: string; label: string }>;
  /** The Market choices; absent offers the base snapshot alone. */
  markets?: SelectChoice[];
  /** The dimensions a view may group by on the workspace's book; null while unread, absent when not offered. */
  viewOptions?: ViewDimOption[] | null;
  /** The workspace's book id, named on the Views tab. */
  bookId?: string | null;
}

export interface SetupEditorProps {
  setup: RunSetup;
  context: SetupEditorContext;
  tab?: SetupTab;
  onTab?: (tab: SetupTab) => void;
  /** The newest validation of this setup in this session; null when there is none. */
  validation: ValidateSetupReply | null;
  /** The stored validations of this setup, newest first; null until they are read (or when the read failed). */
  history?: SetupValidationEntry[] | null;
  /** The server's message when the history read failed; null otherwise. The editor stays usable. */
  historyError?: string | null;
  readiness: { items: ReadinessItem[]; launchable: SlotLaunchable } | null;
  by: string;
  onBy: (by: string) => void;
  /** Why the form is switched off (a locked, archived or superseded workspace); null when it is editable. */
  readOnlyReason: string | null;
  busy: boolean;
  /** The last save's or validation's answer in words. */
  message: string | null;
  /** The last launch's answer in words, printed beside the Launch button; null or absent when there is none. */
  launchMessage?: string | null;
  onSave: (draft: Omit<RunSetup, "id">) => void;
  onValidate: () => void;
  onLaunch: (acknowledge: string[], batch: boolean) => void;
}

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

function ChoiceSelect(props: { label: string; value: string; choices: readonly SelectChoice[]; disabled: boolean; onChange: (v: string) => void; extra?: SelectChoice | null }) {
  // A choice the engine does not run yet is hidden, not greyed, unless the setup holds it.
  const all = props.extra === undefined || props.extra === null ? props.choices : [...props.choices, props.extra];
  const choices = all.filter((c) => c.disabled !== true || c.value === props.value);
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <select className="input" aria-label={props.label} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
        {choices.map((c) => (
          <option key={c.value} value={c.value} disabled={c.disabled}>{c.label}</option>
        ))}
      </select>
    </label>
  );
}

function Switch(props: { label: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="setup-switch">
      <input aria-label={props.label} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />{" "}
      <span>On</span>
    </label>
  );
}

/**
 * The NII, EVE and gap switch: on and disabled, because the engine cannot skip these measures (decision 120: the
 * compile's required slots run them and the run result requires their blocks).
 */
function MeasureSwitch(props: { label: string }) {
  return (
    <label className="setup-switch">
      <input aria-label={props.label} type="checkbox" checked readOnly disabled />{" "}
      <span>On</span>
      <span className="muted">Always runs.</span>
    </label>
  );
}

function Check(props: { label: string; text?: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="setup-check">
      <input aria-label={props.label} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />{" "}
      <span>{props.text ?? props.label}</span>
    </label>
  );
}

/** A months-list field: keeps what is typed, and hands the list up only while it reads as a valid one. */
function EdgesField(props: { label: string; edges: number[]; gridHorizonMonths: number; disabled: boolean; onValid: (edges: number[]) => void }) {
  const [text, setText] = useState(edgesText(props.edges));
  const read = parseBucketEdges(text, props.gridHorizonMonths);
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        aria-label={props.label}
        className="input"
        type="text"
        value={text}
        disabled={props.disabled}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseBucketEdges(e.target.value, props.gridHorizonMonths);
          if (next.problem === null) props.onValid(next.edges);
        }}
      />
      <span className={read.problem === null ? "field-help" : "field-help field-error"}>
        {read.problem ?? "Bucket edges are whole months, rising, from 1; no bucket is finer than a month."}
      </span>
    </label>
  );
}

/** The default NII window (decision 118): keeps what is typed, hands the months up only while they read as valid. */
function WindowField(props: { months: number; gridHorizonMonths: number; disabled: boolean; onValid: (months: number) => void }) {
  const [text, setText] = useState(String(props.months));
  const problem = horizonProblem(text, props.gridHorizonMonths);
  return (
    <label className="field">
      <span className="field-label">Default NII window, months</span>
      <input
        aria-label="NII horizon in months"
        className="input"
        type="number"
        min={12}
        max={props.gridHorizonMonths}
        value={text}
        disabled={props.disabled}
        onChange={(e) => {
          setText(e.target.value);
          if (horizonProblem(e.target.value, props.gridHorizonMonths) === null) props.onValid(Number(e.target.value));
        }}
      />
      <span className={problem === null ? "field-help" : "field-help field-error"}>{problem ?? "Results > NII opens on this window. Default 60 months."}</span>
    </label>
  );
}

/** The NII report horizons (decisions 115 to 117): the server parser's rules, restated; the list is handed up only while it reads as valid. */
function HorizonsField(props: { horizons: number[]; gridHorizonMonths: number; disabled: boolean; onValid: (horizons: number[]) => void }) {
  const [text, setText] = useState(edgesText(props.horizons));
  const read = parseReportHorizons(text, props.gridHorizonMonths);
  return (
    <label className="field">
      <span className="field-label">Report horizons, months</span>
      <input
        aria-label="NII report horizons in months"
        className="input"
        type="text"
        value={text}
        disabled={props.disabled}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseReportHorizons(e.target.value, props.gridHorizonMonths);
          if (next.problem === null) props.onValid(next.horizons);
        }}
      />
      <span className={read.problem === null ? "field-help" : "field-help field-error"}>
        {read.problem ?? "Results > NII sums net interest income to each of these months."}
      </span>
      <span className="field-help">{FTP_BRIDGE_HELP}</span>
    </label>
  );
}

/** A numeric text field: keeps what is typed, hands the parsed value up only while the text reads as valid, and says why when it does not. */
function NumberField(props: { label: string; text: string; parse: (text: string) => { value: number } | { problem: string }; help: string; disabled: boolean; onValid: (value: number) => void }) {
  const [text, setText] = useState(props.text);
  const read = props.parse(text);
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        aria-label={props.label}
        className="input"
        type="text"
        inputMode="decimal"
        value={text}
        disabled={props.disabled}
        onChange={(e) => {
          setText(e.target.value);
          const next = props.parse(e.target.value);
          if ("value" in next) props.onValid(next.value);
        }}
      />
      <span className={"problem" in read ? "field-help field-error" : "field-help"}>{"problem" in read ? read.problem : props.help}</span>
    </label>
  );
}

function Card(props: { label: string; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card setup-card" aria-label={props.label}>
      <div className="setup-card-head">
        <div className="card-title">{props.title}</div>
        {props.right}
      </div>
      <div className="stack">{props.children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

type Patch = (f: (s: RunSetup) => RunSetup) => void;

function MeasuresTab(props: { setup: RunSetup; context: SetupEditorContext; locked: boolean; patch: Patch }) {
  const { setup, context, locked, patch } = props;
  const { nii, eve, gap } = setup;
  const keep = keepListOption(setup.inputs.assumptionSetIds);
  const setChoices = assumptionSetOptions(context.defaultSetId, context.setIds);
  const noPlans = context.balancePlanIds.length === 0;
  const basis = nii.basis;
  const rb = gap.repricingBuckets;
  const liq = gap.liquidity;
  const instrument = setup.instrumentResults;
  // Absent means every position; the checklist reads it as none ticked.
  const instrumentNodes = instrument.coaNodeIds ?? [];
  const stress = setup.liquidityStress;
  return (
    <div className="stack">
      <Card label="Inputs" title="Inputs">
        <ChoiceSelect
          label="Market"
          value={marketSelectValue(setup.inputs.market)}
          choices={context.markets ?? [BASE_MARKET_CHOICE]}
          extra={keepMarketOption(setup.inputs.market, context.markets ?? [BASE_MARKET_CHOICE])}
          disabled={locked}
          onChange={(v) => patch((s) => ({ ...s, inputs: { ...s.inputs, market: marketInputFrom(v) } }))}
        />
        <ChoiceSelect
          label="Assumption set"
          value={assumptionSelectValue(setup.inputs.assumptionSetIds)}
          choices={setChoices}
          extra={keep}
          disabled={locked}
          onChange={(v) => patch((s) => ({ ...s, inputs: { ...s.inputs, assumptionSetIds: assumptionSetIdsFrom(v, s.inputs.assumptionSetIds) } }))}
        />
      </Card>

      <div className="grid-3 setup-measures">
        <Card label="NII settings" title="Net interest income" right={<MeasureSwitch label="NII on" />}>
          <WindowField months={nii.horizonMonths} gridHorizonMonths={setup.gridHorizonMonths} disabled={locked} onValid={(n) => patch((s) => ({ ...s, nii: { ...s.nii, horizonMonths: n } }))} />
          <HorizonsField horizons={nii.reportHorizons} gridHorizonMonths={setup.gridHorizonMonths} disabled={locked} onValid={(h) => patch((s) => ({ ...s, nii: { ...s.nii, reportHorizons: h } }))} />
          <fieldset className="setup-basis" disabled={locked}>
            <legend className="field-label">Balance sheet basis</legend>
            {BASIS_CHOICES.map((c) => {
              const unavailable = c.kind === "custom" && noPlans && basis.kind !== "custom";
              return (
                <label key={c.kind} className="setup-radio">
                  <input
                    type="radio"
                    name="nii-basis"
                    value={c.kind}
                    checked={basis.kind === c.kind}
                    disabled={unavailable}
                    onChange={() => patch((s) => ({ ...s, nii: withBasis(s.nii, c.kind, context.balancePlanIds[0] ?? null) }))}
                  />{" "}
                  <span>{c.label}</span>
                </label>
              );
            })}
            {noPlans && basis.kind !== "custom" ? <span className="field-help">{CUSTOM_NEEDS_PLAN}</span> : null}
          </fieldset>
          {basis.kind === "custom" ? (
            <ChoiceSelect
              label="Balance plan"
              value={basis.balancePlanId}
              choices={[...new Set([...context.balancePlanIds, basis.balancePlanId])].map((id) => ({ value: id, label: id, disabled: false }))}
              disabled={locked}
              onChange={(v) => patch((s) => ({ ...s, nii: { ...s.nii, basis: { kind: "custom", balancePlanId: v } } }))}
            />
          ) : null}
          <p className="setup-note">{basisNote(basis)}</p>
          {templatesNote(nii.templates) !== null ? <p className="setup-note">{templatesNote(nii.templates)}</p> : null}
          <p className="field-help">{NII_PATH_NOTE}</p>
        </Card>

        <Card label="EVE settings" title="Economic value of equity" right={<MeasureSwitch label="EVE on" />}>
          <ChoiceSelect label="EVE valuation dates" value={eve.valuationDates} choices={EVE_VALUATION_CHOICES} disabled={locked} onChange={(v) => patch((s) => ({ ...s, eve: { ...s.eve, valuationDates: v as typeof s.eve.valuationDates } }))} />
          <ChoiceSelect label="EVE discount basis" value={eve.discountBasis} choices={EVE_DISCOUNT_CHOICES} disabled={locked} onChange={(v) => patch((s) => ({ ...s, eve: { ...s.eve, discountBasis: v as typeof s.eve.discountBasis } }))} />
          <ChoiceSelect label="EVE duration" value={eve.durationMode} choices={EVE_DURATION_CHOICES} disabled={locked} onChange={(v) => patch((s) => ({ ...s, eve: { ...s.eve, durationMode: v as typeof s.eve.durationMode } }))} />
          <Check label="Key-rate durations" checked={eve.keyRate} disabled={locked} onChange={(on) => patch((s) => ({ ...s, eve: { ...s.eve, keyRate: on } }))} />
          <Check label="Channel attribution" checked={eve.channels} disabled={locked} onChange={(on) => patch((s) => ({ ...s, eve: { ...s.eve, channels: on } }))} />
          <p className="field-help">Present value as of the grid date, on the contractual runoff under every basis.</p>
        </Card>

        <Card label="Gap settings" title="Gap" right={<MeasureSwitch label="Gap on" />}>
          <ChoiceSelect
            label="Repricing gap bucket size"
            value={rb.kind}
            choices={GAP_BUCKET_CHOICES}
            disabled={locked}
            onChange={(v) =>
              patch((s) => ({
                ...s,
                gap: { ...s.gap, repricingBuckets: v === "custom" ? { kind: "custom", edgesMonths: s.gap.repricingBuckets.kind === "custom" ? s.gap.repricingBuckets.edgesMonths : [3, 6, 12, 24, 60] } : v === "standard" ? { kind: "standard" } : { kind: "monthly" } },
              }))
            }
          />
          {rb.kind === "custom" ? (
            <EdgesField label="Bucket edges in months" edges={rb.edgesMonths} gridHorizonMonths={setup.gridHorizonMonths} disabled={locked} onValid={(edges) => patch((s) => ({ ...s, gap: { ...s.gap, repricingBuckets: { kind: "custom", edgesMonths: edges } } }))} />
          ) : null}
          <Check
            label="Fixed-rate gap ladder"
            text="Fixed-rate gap ladder (rate-locked principal by payment month)"
            checked={gap.fixedRateLadder}
            disabled={locked}
            onChange={(on) => patch((s) => ({ ...s, gap: { ...s.gap, fixedRateLadder: on } }))}
          />
          <p className="field-help">A ladder of when the money on rate-locked positions comes back: fixed loans, mortgages and CDs by the month each principal dollar is paid on the base scenario. Off: the run carries no fixed-rate ladder.</p>
          <Check
            label="Next reset or maturity ladder (ALCO convention)"
            text="Next reset or maturity ladder (ALCO convention)"
            checked={gap.nextReset === true}
            disabled={locked}
            onChange={(on) => patch((s) => withNextReset(s, on))}
          />
          <p className="field-help">A second repricing ladder: a floater at its first reset, a fixed instrument at its maturity, deposit core held out. Off: the run carries no next-reset ladder.</p>
          <div className="setup-sub">
            <div className="setup-sub-head">
              <span className="field-label">Liquidity gap</span>
              <Switch label="Liquidity gap on" checked={liq.enabled} disabled={locked} onChange={(on) => patch((s) => ({ ...s, gap: { ...s.gap, liquidity: { ...s.gap.liquidity, enabled: on } } }))} />
            </div>
            {liq.enabled ? null : <p className="field-help">{LIQUIDITY_OFF_NOTE}</p>}
            <ChoiceSelect label="Liquidity gap flows" value={liq.flows} choices={LIQUIDITY_FLOW_CHOICES} disabled={locked} onChange={(v) => patch((s) => ({ ...s, gap: { ...s.gap, liquidity: { ...s.gap.liquidity, flows: v as typeof liq.flows } } }))} />
            <ChoiceSelect
              label="Liquidity gap interval"
              value={liq.interval.kind}
              choices={LIQUIDITY_INTERVAL_CHOICES}
              disabled={locked}
              onChange={(v) =>
                patch((s) => ({
                  ...s,
                  gap: { ...s.gap, liquidity: { ...s.gap.liquidity, interval: v === "custom-months" ? { kind: "custom-months", edgesMonths: s.gap.liquidity.interval.kind === "custom-months" ? s.gap.liquidity.interval.edgesMonths : [3, 6, 12] } : v === "standard" ? { kind: "standard" } : { kind: "monthly" } } },
                }))
              }
            />
            {liq.interval.kind === "custom-months" ? (
              <EdgesField label="Interval edges in months" edges={liq.interval.edgesMonths} gridHorizonMonths={setup.gridHorizonMonths} disabled={locked} onValid={(edges) => patch((s) => ({ ...s, gap: { ...s.gap, liquidity: { ...s.gap.liquidity, interval: { kind: "custom-months", edgesMonths: edges } } } }))} />
            ) : null}
            <p className="field-help">{LIQUIDITY_RESERVED_NOTE}</p>
          </div>
        </Card>
      </div>

      <div className="grid-2">
        <Card label="FTP settings" title="Funds transfer pricing" right={<Switch label="FTP on" checked={setup.ftp.enabled} disabled={locked} onChange={(on) => patch((s) => ({ ...s, ftp: { ...s.ftp, enabled: on } }))} />}>
          <p className="field-help">{setup.ftp.enabled ? "FTP runs on the base scenario only." : "Off: the run computes no FTP and carries no FTP block."}</p>
        </Card>
        <Card label="Instrument-level results" title="Instrument-level results">
          <Check
            label="Save instrument-level results"
            text="Save instrument-level results"
            checked={instrument.save}
            disabled={locked}
            onChange={(on) => patch((s) => withInstrumentSave(s, on))}
          />
          {instrument.save ? (
            <>
              <p className="field-help">Saved beside the run as instruments.json, one row per position per scenario.</p>
              <div className="setup-nodes" role="group" aria-label="Chart of account nodes to store">
                {context.coaNodes.length === 0 ? <span className="field-help">The workspace book carries no chart of account nodes to choose from.</span> : null}
                {context.coaNodes.map((n) => (
                  <Check
                    key={n.id}
                    label={`Store instrument results for ${n.label}`}
                    text={n.label}
                    checked={instrumentNodes.includes(n.id)}
                    disabled={locked}
                    onChange={(on) => patch((s) => withInstrumentNode(s, n.id, on))}
                  />
                ))}
              </div>
              {instrumentNodes.length === 0 ? <p className="field-help">No node ticked: every position is stored.</p> : null}
            </>
          ) : (
            <p className="field-help">Off: nothing is stored at instrument level.</p>
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card label="Deposit convention and SEG" title="Deposit convention and SEG">
          <ChoiceSelect
            label="Model convention"
            value={modelConventionOf(setup)}
            choices={MODEL_CONVENTION_CHOICES}
            disabled={locked}
            onChange={(v) => patch((s) => withModelConvention(s, v as "corrected-v1" | "book"))}
          />
          {modelConventionLine(setup) !== null ? <p className="field-help" role="note">{modelConventionLine(setup)}</p> : null}
          <ChoiceSelect
            label="NMD convention"
            value={nmdConventionOf(setup)}
            choices={NMD_CONVENTION_CHOICES}
            disabled={locked}
            onChange={(v) => patch((s) => withNmdConvention(s, v as "behavioral" | "regulatory" | "shocked-level"))}
          />
          <p className="field-help">Regulatory ladders the core share of each non-maturity deposit and holds core out of the repricing gap only; liquidity, NII, EVE and SEG still read the ladder. Shocked level slots a full-form deposit at its shocked level: it runs only on a book whose deposits carry the full beta form.</p>
          <Check
            label="Compute SEG, EBP and constant-balance NII"
            text="Compute SEG, EBP and constant-balance NII (constant balance sheet convention)"
            checked={setup.seg?.enabled === true}
            disabled={locked}
            onChange={(on) => patch((s) => withSeg(s, on))}
          />
          <p className="field-help">Adds the SEG / EBP tab and the second NII card. Off: the run carries no seg block.</p>
          {setup.seg?.enabled === true ? (
            <>
              {SEG_KNOBS.map((k) => (
                <NumberField
                  key={k.key}
                  label={k.label}
                  text={segKnobText(setup, k.key)}
                  parse={(text) => parseSegKnob(k.key, text)}
                  help={k.help}
                  disabled={locked}
                  onValid={(v) => patch((s) => withSegKnob(s, k.key, v))}
                />
              ))}
              {segOverlayLines(setup).map((line) => (
                <p className="field-help" key={line}>Cohort-0 prepayment overlay, {line}</p>
              ))}
            </>
          ) : null}
        </Card>
        <Card label="Liquidity stress" title="Liquidity stress ladder" right={<Switch label="Liquidity stress on" checked={stress !== undefined} disabled={locked} onChange={(on) => patch((s) => withLiquidityStress(s, on))} />}>
          {stress === undefined ? (
            <p className="field-help">Off: the run computes no liquidity stress ladder.</p>
          ) : (
            <>
              <label className="field">
                <span className="field-label">Certificates of deposit in the ladder</span>
                <Switch label="Certificates of deposit in the ladder on" checked={cdRenewalOn(stress)} disabled={locked} onChange={(on) => patch((s) => withCdRenewal(s, on))} />
                <span className="field-help">On: positions tagged term-deposit leave as they pay out, less the share that renews. Off: they enter nothing.</span>
              </label>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Scenario</th>
                      {STRESS_COLUMNS.map((c) => <th key={c.key} scope="col">{c.short}, percent</th>)}
                      {cdRenewalOn(stress) ? <th scope="col">Certificate of deposit renewal, percent</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {STRESS_SCENARIOS.map((sc) => (
                      <tr key={sc.id}>
                        <th scope="row">{sc.label}</th>
                        {STRESS_COLUMNS.map((c) => (
                          <td key={c.key}>
                            <NumberField
                              label={`${sc.label}: ${c.label}, percent`}
                              text={stressRateText(stress.table[sc.id][c.key])}
                              parse={parseStressRate}
                              help=""
                              disabled={locked}
                              onValid={(v) => patch((s) => withStressRate(s, sc.id, c.key, v))}
                            />
                          </td>
                        ))}
                        {cdRenewalOn(stress) ? (
                          <td>
                            <NumberField
                              label={`${sc.label}: certificate of deposit renewal, percent`}
                              text={stressRateText(stress.table[sc.id].cdRenewal ?? 0)}
                              parse={parseStressRate}
                              help=""
                              disabled={locked}
                              onValid={(v) => patch((s) => withStressRate(s, sc.id, "cdRenewal", v))}
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label className="field">
                <span className="field-label">Buffer from the HQLA tags</span>
                <Switch label="Buffer from the HQLA tags on" checked={stress.buffer === undefined} disabled={locked} onChange={(on) => patch((s) => withBufferFromTags(s, on))} />
                <span className="field-help">On: the run adds up the positions tagged hqla-stock, each at its face less its level's haircut (level 1 none, 2A 15 percent, 2B 50 percent). Off: you state the buffer.</span>
              </label>
              {stress.buffer !== undefined ? (
                <NumberField label="Liquidity buffer, $M" text={stressAmountText(stress.buffer)} parse={parseStressAmount} help="The cash and securities counted against the cumulative shortfall. A borrowing line goes in the survival path below, never here." disabled={locked} onValid={(v) => patch((s) => withStressAmount(s, "buffer", v))} />
              ) : null}
              <NumberField label="Undrawn commitment face, $M" text={stressAmountText(stress.undrawnFace)} parse={parseStressAmount} help="Monthly draw is this face times the draw rate over twelve." disabled={locked} onValid={(v) => patch((s) => withStressAmount(s, "undrawnFace", v))} />
              <p className="field-help">The savings pool holds the deposits the book tags hys-pool; the checking pool those it tags nib-pool, interest checking included when the book puts it there. Wholesale renewal 100 percent means every maturity rolls.</p>
              <label className="field">
                <span className="field-label">Commitment dials</span>
                <Switch label="Commitment dials on" checked={stress.dials !== undefined} disabled={locked} onChange={(on) => patch((s) => withDials(s, on))} />
                <span className="field-help">On: the severe row draws the dials' requirement, (U99 minus Ubar) times the commitment face, and Results, Liquidity shows what the dials cost.</span>
              </label>
              {stress.dials !== undefined ? <p className="field-help">{DIALS_AMOUNT_HELP}</p> : null}
              {stress.dials !== undefined
                ? DIAL_FIELDS.map((f) => (
                    <NumberField
                      key={f.key}
                      label={f.label}
                      text={f.unit === "bp" ? String(stress.dials![f.key]) : stressRateText(stress.dials![f.key])}
                      parse={f.unit === "bp" ? parseBp : parseStressRate}
                      help={f.help}
                      disabled={locked}
                      onValid={(v) => patch((s) => withDialsField(s, f.key, v))}
                    />
                  ))
                : null}
              <label className="field">
                <span className="field-label">Survival path</span>
                <Switch label="Survival path on" checked={stress.survivalPath !== undefined} disabled={locked} onChange={(on) => patch((s) => withSurvivalPath(s, on))} />
                <span className="field-help">On: the run carries the severe row past month 12 on its own balances, and can count a borrowing line.</span>
              </label>
              {stress.survivalPath !== undefined ? (
                <>
                  <NumberField label="Survival path, months" text={String(stress.survivalPath.horizonMonths)} parse={parseSurvivalMonths} help="From 12 to 120 months." disabled={locked} onValid={(v) => patch((s) => withSurvivalMonths(s, v))} />
                  <label className="field">
                    <span className="field-label">A borrowing line in the survival path</span>
                    <Switch label="Borrowing line on" checked={stress.survivalPath.facility !== undefined} disabled={locked} onChange={(on) => patch((s) => withFacility(s, on))} />
                    <span className="field-help">Counted in the survival path only, after its haircut; never in the ladder's buffer.</span>
                  </label>
                  {stress.survivalPath.facility !== undefined ? (
                    <>
                      <NumberField label="Borrowing capacity, $M" text={stressAmountText(stress.survivalPath.facility.capacity)} parse={parseStressAmount} help="What the bank can borrow against its pledged collateral." disabled={locked} onValid={(v) => patch((s) => withFacilityField(s, "capacity", v))} />
                      <NumberField label="Haircut on the borrowing line, percent" text={stressRateText(stress.survivalPath.facility.haircut)} parse={parseStressRate} help="The share not counted in the stress." disabled={locked} onValid={(v) => patch((s) => withFacilityField(s, "haircut", v))} />
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SOURCES: ReadonlyArray<{ kind: SetupScenarios["kind"]; label: string }> = [
  { kind: "library", label: "Shipped library" },
  { kind: "slate", label: "User-defined (a slate in this workspace)" },
  { kind: "plan-scenarios", label: "Imported plan's own list" },
];

function ScenariosTab(props: { setup: RunSetup; context: SetupEditorContext; locked: boolean; patch: Patch }) {
  const { setup, context, locked, patch } = props;
  const sc = setup.scenarios;
  const allRefs = context.libraries.flatMap(scenarioRefsOf);
  const setSource = (kind: SetupScenarios["kind"]) => {
    if (kind === sc.kind) return;
    if (kind === "library") patch((s) => ({ ...s, scenarios: { kind: "library", refs: allRefs.slice(0, 1) } }));
    if (kind === "slate") {
      const first = context.slates[0];
      if (first !== undefined) patch((s) => ({ ...s, scenarios: { kind: "slate", slateId: first.id, include: "all" } }));
    }
  };
  return (
    <div className="stack">
      <Card label="Scenario source" title="Scenario source">
        <fieldset className="setup-basis" disabled={locked}>
          <legend className="field-label">Where this setup's scenarios come from</legend>
          {SOURCES.map((o) => {
            const unavailable = (o.kind === "slate" && context.slates.length === 0 && sc.kind !== "slate") || (o.kind === "plan-scenarios" && sc.kind !== "plan-scenarios");
            return (
              <label key={o.kind} className="setup-radio">
                <input type="radio" name="scenario-source" value={o.kind} checked={sc.kind === o.kind} disabled={unavailable} onChange={() => setSource(o.kind)} />{" "}
                <span>{o.label}</span>
                {unavailable ? <span className="field-help">{o.kind === "slate" ? " (no slate is attached: attach one on Run > Scenario library)" : " (only a setup imported from a plan carries its list)"}</span> : null}
              </label>
            );
          })}
        </fieldset>
        <p className="field-help">Each scenario carries the assumption set the setup names; a slate's own balance strategy is dropped so the setup's basis applies.</p>
      </Card>

      {sc.kind === "library" ? (
        <Card label="Shipped library scenarios" title="Shipped library">
          {context.libraries.filter((lib) => lib.scenarios.some((def) => def.timing?.kind !== "ramp" || sc.refs.includes(`${lib.id}#${def.id}`))).map((lib) => (
            <div key={lib.id} className="setup-lib">
              <div className="field-label">{lib.label}</div>
              <ul className="setup-scenarios">
                {lib.scenarios.map((def) => {
                  const ref = `${lib.id}#${def.id}`;
                  // A ramp is typed and refused at validation (no rate path runs a time-varying shock): hidden unless the setup holds it.
                  if (def.timing?.kind === "ramp" && !sc.refs.includes(ref)) return null;
                  return (
                    <li key={ref}>
                      <Check
                        label={`Include ${ref}`}
                        text={def.label ?? def.id}
                        checked={sc.refs.includes(ref)}
                        disabled={locked}
                        onChange={(on) => patch((s) => ({ ...s, scenarios: { kind: "library", refs: toggleRef(s.scenarios.kind === "library" ? s.scenarios.refs : [], ref, on, allRefs) } }))}
                      />
                      <span className="muted">{scenarioText(def)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <p className="field-help">The six standardized shocks and custom shocks by tenor are on the Analysis path's Scenarios step.</p>
        </Card>
      ) : null}

      {sc.kind === "slate" ? <SlateCard setup={setup} context={context} locked={locked} patch={patch} /> : null}

      {sc.kind === "plan-scenarios" ? (
        <Card label="Imported plan scenarios" title="Imported plan's own list">
          <p className="field-help">Read-only: the plan's list is kept as it was imported. Choose another source to replace it.</p>
          <ul className="setup-scenarios">
            {sc.items.map((item, i) => {
              const row = planScenarioText(item);
              return (
                <li key={`${row.id}-${i}`}>
                  <span className="mono">{row.id}</span>
                  <span className="muted">{row.text}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function SlateCard(props: { setup: RunSetup; context: SetupEditorContext; locked: boolean; patch: Patch }) {
  const { setup, context, locked, patch } = props;
  const sc = setup.scenarios;
  if (sc.kind !== "slate") return null;
  const slate = context.slates.find((s) => s.id === sc.slateId);
  const included = (id: string) => sc.include === "all" || sc.include.includes(id);
  return (
    <Card label="User-defined slate" title="User-defined slate">
      <ChoiceSelect
        label="Scenario slate"
        value={sc.slateId}
        choices={[...new Set([...context.slates.map((s) => s.id), sc.slateId])].map((id) => ({ value: id, label: context.slates.find((s) => s.id === id)?.label ?? id, disabled: false }))}
        disabled={locked}
        onChange={(v) => patch((s) => ({ ...s, scenarios: { kind: "slate", slateId: v, include: "all" } }))}
      />
      {slate === undefined ? (
        <p className="field-help field-error">{`The slate ${sc.slateId} is not in this workspace's scenario block.`}</p>
      ) : (
        <ul className="setup-scenarios">
          {slate.scenarios.map((def) => (
            <li key={def.id}>
              <Check
                label={`Include ${def.id}`}
                text={def.label ?? def.id}
                checked={included(def.id)}
                disabled={locked}
                onChange={(on) =>
                  patch((s) => {
                    if (s.scenarios.kind !== "slate") return s;
                    const all = slate.scenarios.map((x) => x.id);
                    const now = s.scenarios.include === "all" ? all : s.scenarios.include;
                    const next = on ? all.filter((id) => id === def.id || now.includes(id)) : now.filter((id) => id !== def.id);
                    return { ...s, scenarios: { ...s.scenarios, include: next.length === all.length ? "all" : next } };
                  })
                }
              />
              <span className="muted">{rateSpecText(def.rateSpec)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

function PathTab(props: { setup: RunSetup; locked: boolean; patch: Patch }) {
  const { setup, locked, patch } = props;
  return (
    <div className="stack">
      <Card label="Path" title="Path">
        <ChoiceSelect label="EVE path" value={setup.eve.path} choices={PATH_CHOICES} disabled={locked} onChange={(v) => patch((s) => ({ ...s, eve: { ...s.eve, path: v === "stochastic" ? "stochastic" : "single" } }))} />
        <p className="field-help">{setup.eve.path === "stochastic" ? STOCHASTIC_PATH_REFUSAL : STOCHASTIC_PATH_NOTE}</p>
        <p className="field-help">{NII_PATH_NOTE}</p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function ViewsTab(props: { setup: RunSetup; context: SetupEditorContext; locked: boolean; patch: Patch }) {
  const { setup, context, locked, patch } = props;
  const [draft, setDraft] = useState<ViewDraft>({ label: "", picks: [] });
  const bookId = context.bookId ?? "the workspace's book";
  return (
    <fieldset className="stack setup-views" disabled={locked}>
      <ViewsCard
        views={setup.plan.views ?? []}
        bookId={bookId}
        options={context.viewOptions ?? null}
        optionsError={context.viewOptions === undefined ? "The book's tags were not read." : null}
        emptyText="No view declared on this setup."
        note="A view groups the run's results by one or more tags. A run of this setup stores each view; Results > Views and the guided Reports step's Tag grouping read it."
        draft={draft}
        nextId={nextSetupViewId(setup)}
        onDraft={setDraft}
        onAdd={() => {
          patch((s) => withSetupView(s, draft.label, draft.picks));
          setDraft({ label: "", picks: [] });
        }}
        onRemove={(id) => patch((s) => withoutSetupView(s, id))}
      />
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

function rowScenarioValue(setup: RunSetup, scenarios: SetupScenarios, libraries: ScenarioLibrary[]): string {
  if (sameScenarios(scenarios, setup.scenarios)) return "setup";
  if (scenarios.kind === "slate" && scenarios.include === "all") return `slate:${scenarios.slateId}`;
  if (scenarios.kind === "library") {
    const lib = libraries.find((l) => JSON.stringify(scenarioRefsOf(l)) === JSON.stringify(scenarios.refs));
    if (lib !== undefined) return `lib:${lib.id}`;
  }
  return "custom";
}

function BatchTab(props: { setup: RunSetup; context: SetupEditorContext; locked: boolean; patch: Patch }) {
  const { setup, context, locked, patch } = props;
  const rows = setup.batch;
  const setChoices = assumptionSetOptions(context.defaultSetId, context.setIds);
  const basisChoices = [
    { value: "flat", label: "Flat (simple top-up)", disabled: false },
    { value: "runoff", label: "Runoff (no new business)", disabled: false },
    ...context.balancePlanIds.map((id) => ({ value: `custom:${id}`, label: `Custom dynamic (${id})`, disabled: false })),
  ];
  const scenarioChoices: SelectChoice[] = [
    { value: "setup", label: "The setup's scenarios", disabled: false },
    ...context.libraries.map((l) => ({ value: `lib:${l.id}`, label: `Library: ${l.label}`, disabled: false })),
    ...context.slates.map((s) => ({ value: `slate:${s.id}`, label: `Slate: ${s.label}`, disabled: false })),
  ];
  const edit = (i: number, f: (row: RunSetup["batch"][number]) => RunSetup["batch"][number]) =>
    patch((s) => ({ ...s, batch: s.batch.map((r, j) => (j === i ? f(r) : r)) }));
  return (
    <div className="stack">
      <Card label="Batch rows" title="Batch rows">
        <p className="card-desc">Each row is one launch: a label, scenarios, an assumption set and a basis. Launch validates every row first and submits nothing if any row fails.</p>
        {rows.length === 0 ? <p className="field-help">No batch rows.</p> : null}
        {rows.map((row, i) => {
          const n = i + 1;
          const keep = keepListOption(row.assumptionSetIds);
          const current = rowScenarioValue(setup, row.scenarios, context.libraries);
          return (
            <div key={i} className="setup-batch-row">
              <label className="field">
                <span className="field-label">{`Row ${n} label`}</span>
                <input aria-label={`Row ${n} label`} className="input" type="text" value={row.label} disabled={locked} onChange={(e) => edit(i, (r) => ({ ...r, label: e.target.value }))} />
              </label>
              <ChoiceSelect
                label={`Row ${n} scenarios`}
                value={current}
                choices={scenarioChoices}
                extra={current === "custom" ? { value: "custom", label: "Custom list kept from import", disabled: false } : null}
                disabled={locked}
                onChange={(v) =>
                  edit(i, (r) => {
                    if (v === "setup") return { ...r, scenarios: setup.scenarios };
                    if (v.startsWith("lib:")) {
                      const lib = context.libraries.find((l) => l.id === v.slice(4));
                      return lib === undefined ? r : { ...r, scenarios: { kind: "library", refs: scenarioRefsOf(lib) } };
                    }
                    if (v.startsWith("slate:")) return { ...r, scenarios: { kind: "slate", slateId: v.slice(6), include: "all" } };
                    return r;
                  })
                }
              />
              <ChoiceSelect
                label={`Row ${n} assumption set`}
                value={assumptionSelectValue(row.assumptionSetIds)}
                choices={setChoices}
                extra={keep}
                disabled={locked}
                onChange={(v) => edit(i, (r) => ({ ...r, assumptionSetIds: assumptionSetIdsFrom(v, r.assumptionSetIds) }))}
              />
              <ChoiceSelect label={`Row ${n} basis`} value={basisValueOf(row.basis)} choices={basisChoices} disabled={locked} onChange={(v) => edit(i, (r) => ({ ...r, basis: basisFromValue(v) }))} />
              <button type="button" className="btn btn-quiet" aria-label={`Remove row ${n}`} disabled={locked} onClick={() => patch((s) => ({ ...s, batch: s.batch.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
          );
        })}
        <div>
          <button
            type="button"
            className="btn"
            disabled={locked}
            onClick={() =>
              patch((s) => ({
                ...s,
                batch: [...s.batch, { label: `Row ${s.batch.length + 1}`, scenarios: s.scenarios, assumptionSetIds: s.inputs.assumptionSetIds, basis: s.nii.basis }],
              }))
            }
          >
            Add a row
          </button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------------------

/** The gate reports of a validation: a compiled one's own, or the pair a refused compile carries in its error detail. */
function gatesOf(v: ValidateSetupReply): ChainGates | null {
  if ("error" in v.reports) return refusalGates(v.reports.error.detail);
  // The pass shape carries the pair directly; a stored line of another shape gives no gates rather than throwing.
  return refusalGates(v.reports);
}

const NOT_VALIDATED_TAIL = "Validate to compile the setup, check the gates and label the basis.";

/** What the strip shows when this session holds no validation: the latest stored one, honest about an edit since. */
function StoredValidation(props: { history: SetupValidationEntry[] | null; error: string | null; setupId: string }) {
  const latest = props.history?.[0];
  if (props.history === null || props.error !== null) {
    return (
      <section className="card" aria-label="Validation">
        <div className="card-title">Validation</div>
        <p className="card-desc">{`Not validated in this session. ${NOT_VALIDATED_TAIL}`}</p>
        {props.error !== null ? <p className="field-help field-error" role="alert">{props.error}</p> : null}
      </section>
    );
  }
  if (latest === undefined) {
    return (
      <section className="card" aria-label="Validation">
        <div className="card-title">Validation</div>
        <p className="card-desc">{`Not validated yet. ${NOT_VALIDATED_TAIL}`}</p>
      </section>
    );
  }
  // The server's flag and the document id both have to agree: after a Save the editor sits on the new document
  // while the stored history still names the old one until the refetch lands.
  if (!latest.current || latest.setupDocId !== props.setupId) {
    return (
      <section className="card" aria-label="Validation">
        <div className="card-title">Validation</div>
        <p className="card-desc">
          {`The setup changed since its last validation (${latest.at}, by ${latest.by}) and must be validated again before it is launched.`}
        </p>
      </section>
    );
  }
  return (
    <section className="card" aria-label="Validation">
      <div className="card-title">Validated earlier</div>
      <dl className="kv">
        <dt>Outcome</dt>
        <dd>{validationOutcomeText(latest.outcome)}</dd>
        <dt>When</dt>
        <dd>{latest.at}</dd>
        <dt>By</dt>
        <dd>{latest.by}</dd>
        {latest.basisLabel !== "" ? (
          <>
            <dt>NII basis</dt>
            <dd>{latest.basisLabel}</dd>
          </>
        ) : null}
        {latest.skippedFamilies.length > 0 ? (
          <>
            <dt>Families skipped</dt>
            <dd>{latest.skippedFamilies.join(", ")}</dd>
          </>
        ) : null}
      </dl>
      {latest.outcome === "fail" ? (
        latest.reason !== undefined ? (
          <p className="field-help field-error">{latest.reason}</p>
        ) : (
          <p className="field-help">No gate refusal was stored with this validation.</p>
        )
      ) : null}
    </section>
  );
}

function ValidationLine(props: { validation: ValidateSetupReply | null; history: SetupValidationEntry[] | null; historyError: string | null; setupId: string }) {
  const v = props.validation;
  if (v === null) return <StoredValidation history={props.history} error={props.historyError} setupId={props.setupId} />;
  const refused = "error" in v.reports ? v.reports.error.message : null;
  const warnings = "warnings" in v.reports ? v.reports.warnings : [];
  return (
    <section className="card" aria-label="Validation">
      <div className="card-title">Validation</div>
      <dl className="kv">
        <dt>Outcome</dt>
        <dd>{validationOutcomeText(v.outcome)}</dd>
        {v.basisLabel !== "" ? (
          <>
            <dt>NII basis</dt>
            <dd>{v.basisLabel}</dd>
          </>
        ) : null}
        {v.skippedFamilies.length > 0 ? (
          <>
            <dt>Families skipped</dt>
            <dd>{v.skippedFamilies.join(", ")}</dd>
          </>
        ) : null}
        {v.planId !== null ? (
          <>
            <dt>Plan id</dt>
            <dd className="mono">{v.planId}</dd>
          </>
        ) : null}
      </dl>
      {refused !== null ? <p className="field-help field-error" role="alert">{refused}</p> : null}
      {warnings.length > 0 ? (
        <ul className="chain-gate-list">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

export function SetupEditor(props: SetupEditorProps) {
  const { setup, context } = props;
  const [draft, setDraft] = useState<RunSetup>(setup);
  const [tabState, setTabState] = useState<SetupTab>(props.tab ?? "measures");
  // The text fields keep what is typed in their own state; keying each tab body on this counter remounts them from the
  // stored setup when the edits are discarded.
  const [discards, setDiscards] = useState(0);
  const tab = setupTabOf(tabState);
  const locked = props.readOnlyReason !== null || props.busy;
  const patch: Patch = (f) => setDraft((d) => f(d));
  const dirty = isDirty(setup, draft);
  const named = props.by.trim() !== "";
  const gates = props.validation === null ? null : gatesOf(props.validation);
  const stages = props.validation?.compiledChain ?? [];
  const launchReason =
    props.readOnlyReason !== null ? props.readOnlyReason : dirty ? "Save the edits first: a launch runs the stored setup, not the draft." : !named ? "Type who is launching (typed, not verified)." : null;
  const chooseTab = (t: SetupTab) => {
    setTabState(t);
    props.onTab?.(t);
  };
  return (
    <div className="stack setup-editor">
      {props.readOnlyReason !== null ? <div className="banner" role="status">{props.readOnlyReason}</div> : null}
      <section className="card" aria-label="Setup header">
        <div className="grid-2">
          <label className="field">
            <span className="field-label">Setup name</span>
            <input aria-label="Setup name" className="input" type="text" value={draft.name} disabled={locked} onChange={(e) => patch((d) => ({ ...d, name: e.target.value, plan: { ...d.plan, label: e.target.value } }))} />
          </label>
          <label className="field">
            <span className="field-label">Recorded by (typed, not verified)</span>
            <input aria-label="Recorded by" className="input" type="text" value={props.by} maxLength={80} autoComplete="off" onChange={(e) => props.onBy(e.target.value)} />
          </label>
        </div>
        <div className="setup-actions">
          <button type="button" className="btn btn-primary" disabled={!dirty || !named || locked} onClick={() => props.onSave(draftForSave(setup, draft))}>Save as a new version</button>
          <button type="button" className="btn" disabled={!dirty || locked} onClick={() => {
            setDraft(setup);
            setDiscards((n) => n + 1);
          }}>Discard edits</button>
          <button type="button" className="btn" disabled={dirty || !named || props.readOnlyReason !== null || props.busy} onClick={props.onValidate}>Validate</button>
          <span className="field-help">{dirty ? (named ? "Unsaved edits." : "Unsaved edits. Type a name in Recorded by to save them.") : "Saved."}</span>
        </div>
        {props.message !== null ? <p className="setup-message" role="status">{props.message}</p> : null}
      </section>

      <div className="tabs" role="tablist" aria-label="Setup sections">
        {SETUP_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => chooseTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === "measures" ? <MeasuresTab key={discards} setup={draft} context={context} locked={locked} patch={patch} /> : null}
      {tab === "scenarios" ? <ScenariosTab key={discards} setup={draft} context={context} locked={locked} patch={patch} /> : null}
      {tab === "path" ? <PathTab key={discards} setup={draft} locked={locked} patch={patch} /> : null}
      {tab === "batch" ? <BatchTab key={discards} setup={draft} context={context} locked={locked} patch={patch} /> : null}
      {tab === "views" ? <ViewsTab key={discards} setup={draft} context={context} locked={locked} patch={patch} /> : null}

      <div className="setup-summary" aria-label="Setup summary">
        <ValidationLine validation={props.validation} history={props.history ?? null} historyError={props.historyError ?? null} setupId={setup.id} />
        <CompiledChainPanel stages={stages} gates={gates} stored={props.validation === null ? (props.history?.[0] ?? null) : null} />
        {props.readiness !== null ? (
          <LaunchStrip
            items={props.readiness.items}
            launchable={props.readiness.launchable}
            batchRows={setup.batch.length}
            disabledReason={launchReason}
            busy={props.busy}
            message={props.launchMessage ?? null}
            onLaunch={props.onLaunch}
          />
        ) : (
          <section className="card" aria-label="Launch">
            <div className="card-title">Launch</div>
            <p className="card-desc">Readiness is not available, so the launch gate cannot be shown. Reload the page.</p>
          </section>
        )}
      </div>
    </div>
  );
}
