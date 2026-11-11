// apps/studio/src/pages/scenarios/ScenariosViews.tsx
/**
 * Scenarios page views (Studio S3b), props only: one scenario card, the
 * library scenarios the plan lacks, the plan default set, the balance plan
 * picker and stage banner (P2) and the hint carried from the Assumptions and Behavioral shocks pages. Nothing here fetches or
 * computes a number; every text is a stored field or a Task 6 card string.
 */
import type { RunPlan } from "@alm/engine";
import { isStackId, type AssumptionSetListItem, type BalancePlanListItem } from "@alm/reader";
import type { ScenarioCard } from "../../scenarios/scenarioCards";
import { ShockPicture } from "../../charts/ShockPicture";
import { bindsBalancePlan, hasBalanceStage } from "../../scenarios/scenarioEdits";

const NOT_LISTED = "not in /api/assumption-sets";

/** Stored stacks first (the Assumptions page saves them for this page), then the other sets, each in listed order. */
export function orderSets(sets: AssumptionSetListItem[]): AssumptionSetListItem[] {
  return [...sets.filter((s) => isStackId(s.id)), ...sets.filter((s) => !isStackId(s.id))];
}

const setOptionText = (s: AssumptionSetListItem): string => (s.label !== "" && s.label !== s.id ? `${s.id}: ${s.label}` : s.id);

/** The ref of a card whose library ref no library holds; null for every other card. */
export function unknownRefOf(card: ScenarioCard): string | null {
  return card.refKnown ? null : card.ref;
}

/** The library ref a card names when some library holds it; null for an inline scenario or an unknown ref. */
export function libraryRefOf(card: ScenarioCard): string | null {
  return card.refKnown ? card.ref : null;
}

function SetOptions(props: { sets: AssumptionSetListItem[]; current: string | null }) {
  const { sets, current } = props;
  return (
    <>
      {current !== null && !sets.some((s) => s.id === current) ? <option value={current}>{current} ({NOT_LISTED})</option> : null}
      {orderSets(sets).map((s) => <option key={s.id} value={s.id}>{setOptionText(s)}</option>)}
    </>
  );
}

/**
 * One scenario. A plan card carries a set picker and, in its head, a builder
 * link (P3: Edit shock or Copy shock) and Remove scenario, which is off for the
 * plan's only base scenario; a library card carries Add. A card whose ref no
 * library holds gets a disabled picker, since giving it a set would need the
 * definition the library lacks.
 */
export function ScenarioCardView(props: {
  card: ScenarioCard;
  sets: AssumptionSetListItem[];
  /** The scenario's own assumptionSetId; null when it follows the plan default. */
  ownSet: string | null;
  onSet?(setId: string | null): void;
  onRemove?(): void;
  onAdd?(): void;
  /** The scenario's new business binding: its scenarioBalancePlans entry (null follows the plan default), or own rules stored on it. */
  nb?: { value: string | null; ownRules: boolean; listed: BalancePlanListItem[]; onChange(id: string | null): void };
  /** P3: the builder link, "Edit shock" or "Copy shock", with its href; absent on a base scenario or a ref no library holds. */
  shockLink?: { text: string; href: string };
  /** P3: why Remove scenario is off (the plan's only base scenario); absent when it is on. */
  removeBlocked?: string;
}) {
  const { card, onSet, onRemove, onAdd } = props;
  const unknown = unknownRefOf(card);
  return (
    <article className="card" aria-label={`Scenario ${card.id}`}>
      <div className="card-head">
        <div className="card-title"><span className="mono">{card.id}</span>{card.label !== card.id ? <> {card.label}</> : null}</div>
        {props.shockLink !== undefined || onRemove !== undefined ? (
          <span className="card-head-actions">
            {props.shockLink !== undefined ? <a className="btn btn-quiet" href={props.shockLink.href}>{props.shockLink.text}</a> : null}
            {onRemove !== undefined ? (
              <button type="button" className="btn btn-quiet" onClick={onRemove} disabled={props.removeBlocked !== undefined} title={props.removeBlocked}>Remove scenario</button>
            ) : null}
          </span>
        ) : null}
      </div>
      <dl className="kv">
        <dt>Source</dt><dd className="mono">{card.source}</dd>
        <dt>Rate</dt><dd>{card.rateText}</dd>
        <dt>Timing</dt><dd>{card.timingText}</dd>
        <dt>Set</dt><dd className="mono">{card.setText}</dd>
      </dl>
      <ShockPicture picture={card.picture} label={card.label} />
      {onSet !== undefined || onAdd !== undefined || props.nb !== undefined ? (
        <div className="sheet-actions">
          {onSet !== undefined ? (
            <label className="field">
              <span className="field-label">Assumption set</span>
              <select
                value={props.ownSet ?? ""}
                disabled={unknown !== null}
                title={unknown !== null ? `No library holds ${unknown}, so it cannot take a set: remove it or add a library scenario` : undefined}
                onChange={(e) => onSet(e.target.value === "" ? null : e.target.value)}
              >
                <option value="">plan default</option>
                <SetOptions sets={props.sets} current={props.ownSet} />
              </select>
            </label>
          ) : null}
          {props.nb !== undefined ? (
            <label className="field" aria-label="New business">
              <span className="field-label">New business</span>
              {props.nb.ownRules ? (
                <span className="muted">Own rules (stored on the scenario, read-only here)</span>
              ) : (
                <select value={props.nb.value ?? ""} onChange={(e) => props.nb!.onChange(e.target.value === "" ? null : e.target.value)}>
                  <option value="">plan default</option>
                  {props.nb.value !== null && !props.nb.listed.some((b) => b.id === props.nb!.value) ? <option value={props.nb.value}>{props.nb.value} (not listed)</option> : null}
                  {props.nb.listed.map((b) => <option key={b.id} value={b.id}>{b.label !== "" && b.label !== b.id ? `${b.id}: ${b.label}` : b.id}</option>)}
                </select>
              )}
            </label>
          ) : null}
          {onAdd !== undefined ? <button type="button" className="btn btn-quiet" onClick={onAdd}>Add</button> : null}
        </div>
      ) : null}
    </article>
  );
}

/** The library scenarios the plan lacks, each with Add. */
export function LibraryList(props: { cards: ScenarioCard[]; onAdd(ref: string): void }) {
  return (
    <section className="stack" aria-label="Library scenarios">
      <div className="card-title">Library scenarios not in the plan</div>
      {props.cards.length === 0 ? <p className="card-desc">Every library scenario is in the plan.</p> : null}
      {props.cards.map((c) => {
        const ref = libraryRefOf(c);
        return <ScenarioCardView key={c.source} card={c} sets={[]} ownSet={null} onAdd={ref === null ? undefined : () => props.onAdd(ref)} />;
      })}
      <p className="card-foot">Source: /api/plans/library</p>
    </section>
  );
}

/** The plan default: the first entry of inputs.assumptionSets, which the compiler binds to every scenario without its own set. */
export function DefaultSetPicker(props: { plan: RunPlan; sets: AssumptionSetListItem[]; onChange(setId: string): void }) {
  const current = props.plan.inputs.assumptionSets?.[0] ?? null;
  return (
    <section className="card" aria-label="Plan default set">
      <div className="card-title">Plan default set</div>
      <label className="field">
        <span className="field-label">Every scenario without its own set uses</span>
        <select value={current ?? ""} onChange={(e) => { if (e.target.value !== "") props.onChange(e.target.value); }}>
          {current === null ? <option value="" disabled>none stated: validate refuses the plan until a default set is named</option> : null}
          <SetOptions sets={props.sets} current={current} />
        </select>
      </label>
      <p className="card-foot">Source: /api/assumption-sets</p>
    </section>
  );
}

/** The plan default balance plan: every scenario with no entry and no own rules takes it. */
export function BalancePlanPicker(props: { plan: RunPlan; listed: BalancePlanListItem[]; onChange(id: string | null): void }) {
  const current = props.plan.balancePlan ?? null;
  const listed = props.listed.filter((b) => b.asOf === props.plan.asOf);
  return (
    <section className="card" aria-label="Balance plan">
      <div className="card-title">Plan default balance plan</div>
      <label className="field">
        <span className="field-label">Scenarios set to plan default use</span>
        <select value={current ?? ""} onChange={(e) => props.onChange(e.target.value === "" ? null : e.target.value)}>
          <option value="">None: every scenario runs off unless it has its own</option>
          {current !== null && !listed.some((b) => b.id === current) ? <option value={current}>{`${current} (not in /api/balance-plans for as-of ${props.plan.asOf})`}</option> : null}
          {listed.map((b) => <option key={b.id} value={b.id}>{b.label !== "" && b.label !== b.id ? `${b.id}: ${b.label}` : b.id}</option>)}
        </select>
      </label>
      <p className="card-foot">Source: /api/balance-plans (as-of {props.plan.asOf}). Author targets on Data, Balance sheet, Targets and new business.</p>
    </section>
  );
}

/** Shown when a balance plan is bound and no stage would run it (spec Section 5.2 item 4). */
export function BalanceStageBanner(props: { plan: RunPlan; onAdd(): void; refusal: string | null }) {
  if (!bindsBalancePlan(props.plan) || hasBalanceStage(props.plan)) return null;
  return (
    <div className="card plan-banner" role="alert">
      <div><span className="status status-breach">✕ No balance stage</span> This chain has no balance stage, so the targets would not run.</div>
      <div className="sheet-actions"><button type="button" className="btn" onClick={props.onAdd}>Add balance stage</button></div>
      {props.refusal !== null ? <div>{props.refusal}</div> : null}
    </div>
  );
}

/** The set the Assumptions or Behavioral shocks page handed over in query.set, if any. */
export function SetHint(props: { query: Record<string, string> }) {
  const id = props.query.set;
  if (id === undefined || id === "") return null;
  return <div className="card card-desc">{`Set ${id}: pick it on a scenario or as the plan default.`}</div>;
}
