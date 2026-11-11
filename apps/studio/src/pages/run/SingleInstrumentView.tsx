// apps/studio/src/pages/run/SingleInstrumentView.tsx
/**
 * The Single instrument screen, drawn from props (ALM Studio A+E Slice 1, Task E6; spec v3.1 Section 5.3 and 6.2).
 * One position of this workspace's book is projected on demand by the drill route and nothing is stored, so the
 * screen has no write control and is enabled on a locked workspace (ruling 15). Every number is the engine's own:
 * the discount factors and the row PVs come back on each schedule row (contract 8) and the PV totals are the
 * scenario's, so no PV is multiplied or summed here. A cell prints a rounded text and carries the full value in its
 * title. Colours are tokens, in singleInstrument.css.
 */
import { modelConventionNoteText } from "../results/GridAsOf";
import type { ReactNode } from "react";
import { legTables, pct, sig, usd, type InstrumentDrill, type InstrumentScenarioProjectionView, type InstrumentScheduleRowView, type PositionsPage, type WorkspaceManifest } from "@alm/reader";
import { LinePlot } from "../../charts/LinePlot";
import { monthTicks, type Point } from "../../charts/plotScale";
import {
  csvFileName, csvHref, marketOptions, pageWindow, scheduleCsv, MAX_HORIZON_MONTHS,
  type InstrumentForm, type LibraryState, type PositionFilter, type ScenarioArm, type TypedForm,
} from "../../rows/instrumentRows";
import { plural } from "../../rows/plural";

export type PositionsState =
  | { state: "loading" }
  | { state: "none" }
  | { state: "error"; message: string }
  | { state: "ok"; page: PositionsPage };

export type RunState =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "error"; message: string }
  | { state: "ok"; drill: InstrumentDrill; scenarioIndex: number };

/** The meta line of every result: what one run of this screen is, and that it is not kept. */
export const META_LINE =
  "single position, contractual runoff; the balance sheet basis is a book-level setting. This screen stores nothing.";

/** A number cell: the rounded text, the engine's full value in the title. */
function Num(props: { value: number; text: string; lvl?: boolean }) {
  return <td className={props.lvl === true ? "num lvl" : "num"} title={String(props.value)}>{props.text}</td>;
}

// --- Position picker -----------------------------------------------------------

export function PositionPickerView(props: {
  bookId: string | null;
  filter: PositionFilter;
  positions: PositionsState;
  selectedId: string;
  onFilter: (patch: Partial<PositionFilter>) => void;
  onPick: (id: string) => void;
}) {
  const { bookId, filter, positions, selectedId } = props;
  if (bookId === null || positions.state === "none") {
    return (
      <p className="unobs-text">
        This workspace holds no positions, so there is no book to pick from. Import positions under Balance Sheet, or use the typed terms.
      </p>
    );
  }
  const win = positions.state === "ok" ? pageWindow(positions.page) : null;
  return (
    <div className="si-picker">
      <div className="si-filters">
        <label className="field">
          <span className="field-label">Position id starts with</span>
          <input
            className="input"
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls="si-options"
            aria-autocomplete="list"
            value={filter.q ?? ""}
            placeholder="Type the start of the position id"
            onChange={(e) => props.onFilter({ q: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-label">Family</span>
          <input className="input" value={filter.familyId ?? ""} placeholder="any" onChange={(e) => props.onFilter({ familyId: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Instrument type</span>
          <input className="input" value={filter.instrumentType ?? ""} placeholder="any" onChange={(e) => props.onFilter({ instrumentType: e.target.value })} />
        </label>
      </div>
      <p className="field-help">{`The list reads the positions of ${bookId}, 50 at a time; the text matches the start of the position id.`}</p>
      {positions.state === "loading" ? <p className="muted">{`Reading the positions of ${bookId}`}</p> : null}
      {positions.state === "error" ? <p role="alert" className="unobs-text">{positions.message}</p> : null}
      {positions.state === "ok" && positions.page.rows.length === 0 ? (
        <p className="unobs-text">No position of this book starts with that text.</p>
      ) : null}
      {positions.state === "ok" && positions.page.rows.length > 0 ? (
        <ul id="si-options" className="si-options" role="listbox" aria-label={`Positions of ${bookId}`}>
          {positions.page.rows.map((r) => (
            <li key={r.id} role="presentation">
              <button type="button" role="option" aria-selected={r.id === selectedId} className="si-option" onClick={() => props.onPick(r.id)}>
                {r.id}
                <span className="si-opt-meta">{`${r.instrumentType}, ${r.familyId}, ${usd(r.notional)}`}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {win !== null ? (
        <div className="si-pager">
          <span className="head-meta">{win.total === 0 ? "Showing 0 of 0 positions" : `Showing ${win.from} to ${win.to} of ${win.total} positions`}</span>
          <button type="button" className="btn" disabled={!win.hasPrev} onClick={() => props.onFilter({ offset: win.prevOffset })}>Previous</button>
          <button type="button" className="btn" disabled={!win.hasNext} onClick={() => props.onFilter({ offset: win.nextOffset })}>Next</button>
        </div>
      ) : null}
      <p className="head-meta">
        {selectedId === "" ? "No position picked yet." : `Picked: ${selectedId}`}
      </p>
    </div>
  );
}

// --- Typed terms ---------------------------------------------------------------

function TextField(props: { label: string; value: string; help?: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input className="input" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      {props.help === undefined ? null : <span className="field-help">{props.help}</span>}
    </label>
  );
}

export function TypedTermsView(props: { typed: TypedForm; onChange: (patch: Partial<TypedForm>) => void }) {
  const t = props.typed;
  const set = (patch: Partial<TypedForm>) => props.onChange(patch);
  return (
    <div className="si-typed">
      <div className="si-filters">
        <label className="field">
          <span className="field-label">Type</span>
          <select value={t.type} onChange={(e) => set({ type: e.target.value as TypedForm["type"] })}>
            <option value="fixed-loan">fixed-loan</option>
            <option value="floating-loan">floating-loan</option>
          </select>
        </label>
        <TextField label="Id" value={t.id} onChange={(v) => set({ id: v })} />
        <TextField label="Family" value={t.familyId} onChange={(v) => set({ familyId: v })} />
        <label className="field">
          <span className="field-label">Side</span>
          <select value={t.side} onChange={(e) => set({ side: e.target.value as TypedForm["side"] })}>
            <option value="asset">asset</option>
            <option value="liability">liability</option>
          </select>
        </label>
      </div>
      <div className="si-filters">
        <TextField label="Notional" value={t.notional} onChange={(v) => set({ notional: v })} />
        <TextField label="Maturity (months)" value={t.maturityMonths} onChange={(v) => set({ maturityMonths: v })} />
        <TextField label="Origination offset (months)" value={t.originationOffsetMonths} onChange={(v) => set({ originationOffsetMonths: v })} />
        <label className="field">
          <span className="field-label">Amortization</span>
          <select value={t.amortType} onChange={(e) => set({ amortType: e.target.value as TypedForm["amortType"] })}>
            <option value="level-pay">level-pay</option>
            <option value="bullet">bullet</option>
          </select>
        </label>
        {t.type === "fixed-loan" ? (
          <TextField label="Coupon (decimal)" value={t.coupon} onChange={(v) => set({ coupon: v })} />
        ) : (
          <>
            <TextField label="Margin (decimal)" value={t.margin} onChange={(v) => set({ margin: v })} />
            <TextField label="Reset (months)" value={t.resetFrequencyMonths} onChange={(v) => set({ resetFrequencyMonths: v })} />
          </>
        )}
      </div>
      <p className="field-help">
        The typed form covers fixed and floating loans. Mortgages, non-maturity deposits and CDs carry a parameter set or a cohort table, so they are picked from the book.
      </p>
    </div>
  );
}

// --- Scenario picker -----------------------------------------------------------

const ARM_LABEL: Record<ScenarioArm, string> = {
  slate: "Workspace slates",
  shock: "One parallel shock",
  library: "Library scenarios of the chosen setup",
};

export function ScenarioPickerView(props: {
  arm: ScenarioArm;
  slateIds: string[];
  slateId: string;
  shockBp: string;
  setupIds: string[];
  setupLineageId: string;
  library: LibraryState;
  onChange: (patch: Partial<InstrumentForm>) => void;
}) {
  const { arm, library } = props;
  const arms: ScenarioArm[] = ["slate", "shock", "library"];
  const off = (a: ScenarioArm) => (a === "slate" ? props.slateIds.length === 0 : a === "library" ? library.state !== "refs" : false);
  return (
    <div className="si-scenarios">
      <div className="seg" role="group" aria-label="Scenario source">
        {arms.map((a) => (
          <button key={a} type="button" aria-pressed={arm === a} disabled={off(a)} onClick={() => props.onChange({ arm: a })}>
            {ARM_LABEL[a]}
          </button>
        ))}
      </div>
      {arm === "slate" ? (
        <label className="field">
          <span className="field-label">Slate</span>
          <select value={props.slateId} onChange={(e) => props.onChange({ slateId: e.target.value })}>
            {props.slateIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          <span className="field-help">Each scenario of the slate is projected as runoff on the one position.</span>
        </label>
      ) : null}
      {arm === "shock" ? (
        <label className="field">
          <span className="field-label">Parallel shock</span>
          <span className="input-wrap">
            <input className="input" inputMode="decimal" value={props.shockBp} onChange={(e) => props.onChange({ shockBp: e.target.value })} />
            <span className="input-suffix">bp</span>
          </span>
        </label>
      ) : null}
      {arm === "library" ? (
        <div className="si-library">
          {props.setupIds.length > 0 ? (
            <label className="field">
              <span className="field-label">Run setup</span>
              <select value={props.setupLineageId} onChange={(e) => props.onChange({ setupLineageId: e.target.value })}>
                {props.setupIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
          ) : null}
          {library.state === "loading" ? <p className="muted">Reading the setup</p> : null}
          {library.state === "none" ? <p className="unobs-text">{library.reason}</p> : null}
          {library.state === "refs" ? (
            <>
              <p className="field-help">{`Scenarios of ${library.setupName}, resolved by the engine from the shipped libraries:`}</p>
              <div className="chip-row">
                {library.refs.map((r) => <span key={r} className="chip mono">{r}</span>)}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --- Result --------------------------------------------------------------------

function ScheduleTable(props: { rows: InstrumentScheduleRowView[]; totals?: { label: string; pvAllIn: number; pvRiskFree: number } }) {
  const { rows } = props;
  return (
    <div className="table-wrap si-table">
      <table className="table">
        <thead>
          <tr>
            <th scope="col" className="num">Month</th>
            <th scope="col" className="num">Path rate</th>
            <th scope="col" className="num">Coupon</th>
            <th scope="col" className="num">Balance</th>
            <th scope="col" className="num">Principal</th>
            <th scope="col" className="num">Interest</th>
            <th scope="col" className="num">Payment</th>
            <th scope="col" className="num">DF all-in</th>
            <th scope="col" className="num">DF risk-free</th>
            <th scope="col" className="num">PV all-in</th>
            <th scope="col" className="num">PV risk-free</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <th scope="row" className="num">{r.month}</th>
              <Num value={r.pathRate} text={pct(r.pathRate, 3)} />
              <Num value={r.couponRate} text={pct(r.couponRate, 3)} />
              <Num value={r.balance} text={usd(r.balance)} lvl />
              <Num value={r.principal} text={usd(r.principal)} />
              <Num value={r.interest} text={usd(r.interest)} />
              <Num value={r.payment} text={usd(r.payment)} />
              <Num value={r.discountFactorAllIn} text={sig(r.discountFactorAllIn, 6)} />
              <Num value={r.discountFactorRiskFree} text={sig(r.discountFactorRiskFree, 6)} />
              <Num value={r.pvAllIn} text={usd(r.pvAllIn)} />
              <Num value={r.pvRiskFree} text={usd(r.pvRiskFree)} />
            </tr>
          ))}
        </tbody>
        {props.totals === undefined ? null : (
          <tfoot>
            <tr>
              <th scope="row" colSpan={9}>{props.totals.label}</th>
              <Num value={props.totals.pvAllIn} text={usd(props.totals.pvAllIn)} />
              <Num value={props.totals.pvRiskFree} text={usd(props.totals.pvRiskFree)} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export function InstrumentResultView(props: {
  drill: InstrumentDrill;
  cutoffDate: string;
  scenarioIndex: number;
  onScenario: (i: number) => void;
}) {
  const { drill, cutoffDate } = props;
  const shown: InstrumentScenarioProjectionView | undefined = drill.byScenario[props.scenarioIndex] ?? drill.byScenario[0];
  if (shown === undefined) {
    return (
      <section className="card" aria-label="Discounted cash flows">
        <p className="unobs-text"><span className="status status-unobs">Unobservable</span> The route returned no scenario projection.</p>
      </section>
    );
  }
  const idx = drill.byScenario.indexOf(shown);
  const legs = legTables(shown);
  const csv = scheduleCsv(shown);
  const points = (pick: (r: InstrumentScheduleRowView) => number): Point[] => shown.rows.map((r): Point => [r.month, pick(r)]);
  return (
    <section className="card si-result" aria-label="Discounted cash flows">
      <div className="card-title">
        {`${drill.terms.id} (${drill.terms.type})`} <span className="chip">Not saved</span>
      </div>
      <p className="card-desc">
        {`Family ${drill.familyId}, ${drill.side}. Market ${drill.marketId}; scenarios from ${drill.scenarioSource}; horizon ${drill.horizonMonths} months; duration measured at a plus and minus ${drill.durationBumpBp} bp parallel bump of each scenario's own curve; overlay applied: ${drill.overlayApplied}.`}
      </p>
      {modelConventionNoteText(drill.modelConvention) !== null ? <p className="card-desc" role="note">{modelConventionNoteText(drill.modelConvention)}</p> : null}
      <p className="head-meta si-meta">{META_LINE}</p>
      <p className="si-asof">{`Present value as of ${cutoffDate}. Each total below is the engine's figure for the scenario, not a sum of the rows shown.`}</p>

      <div className="table-wrap si-table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col" className="num">PV all-in</th>
              <th scope="col" className="num">PV risk-free</th>
              <th scope="col" className="num">WAL (months)</th>
              <th scope="col" className="num">Effective duration</th>
              <th scope="col" className="num">Resets</th>
            </tr>
          </thead>
          <tbody>
            {drill.byScenario.map((p) => (
              <tr key={p.scenarioId}>
                <th scope="row" className="mono">{p.scenarioId}</th>
                <Num value={p.pvAllIn} text={usd(p.pvAllIn)} />
                <Num value={p.pvRiskFree} text={usd(p.pvRiskFree)} />
                {p.walMonths === undefined ? <td className="num" title="no in-horizon principal to weight"><span className="status status-unobs">Unobservable</span></td> : <Num value={p.walMonths} text={sig(p.walMonths, 4)} />}
                {p.effectiveDuration === undefined ? (
                  <td className="num" title="base PV is zero"><span className="status status-unobs">Unobservable</span></td>
                ) : (
                  <Num value={p.effectiveDuration} text={`${sig(p.effectiveDuration, 4)}${p.durationBasis === "notional" ? ", per unit of notional" : ""}`} />
                )}
                <td className="num">{p.repricingMonths.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="tabs" role="tablist" aria-label="Scenario shown">
        {drill.byScenario.map((p, i) => (
          <button key={p.scenarioId} type="button" role="tab" aria-selected={i === idx} className="tab" onClick={() => props.onScenario(i)}>
            {p.scenarioId}
          </button>
        ))}
      </div>

      {shown.discountBasisNote === undefined ? null : <p className="si-note"><span className="status status-stale">Discount basis</span> {shown.discountBasisNote}</p>}

      {shown.rows.length >= 2 ? (
        <figure className="viz si-figure" aria-label="Row present values by month">
          <div className="viz-head"><div className="card-title">{`Present value of each month's cash flow, ${shown.scenarioId}`}</div></div>
          <LinePlot
            series={[
              { id: "all-in", label: "PV all-in", tone: "accent", points: points((r) => r.pvAllIn) },
              { id: "risk-free", label: "PV risk-free", tone: "second", dash: true, points: points((r) => r.pvRiskFree) },
            ]}
            xScale="linear"
            xTicks={monthTicks}
            xLabel={(m) => `M${m}`}
            yTick={(v) => usd(v)}
            format={usd}
            unit="USD, present value of the month's payment"
            zoom
          />
          <figcaption className="card-foot">Source: byScenario[{shown.scenarioId}].rows, pvAllIn and pvRiskFree as served.</figcaption>
        </figure>
      ) : null}

      <div className="si-export">
        <a className="btn" href={csvHref(csv)} download={csvFileName(drill.terms.id, shown.scenarioId, cutoffDate)}>Download CSV</a>
        <span className="head-meta">{`${plural(shown.rows.length, "row", "rows")}, exactly as served; built in this browser from the rows on screen.`}</span>
      </div>

      <div className="card-title">{legs.length > 0 ? "Net schedule" : "Schedule"}</div>
      <ScheduleTable rows={shown.rows} totals={{ label: `Scenario total at ${cutoffDate}`, pvAllIn: shown.pvAllIn, pvRiskFree: shown.pvRiskFree }} />
      {legs.map((l) => (
        <div key={l.leg}>
          <div className="card-title">{`${l.leg === "receive" ? "Receive leg" : "Pay leg"} (${plural(l.rows.length, "row", "rows")}, signed as served)`}</div>
          <ScheduleTable rows={l.rows} />
        </div>
      ))}
    </section>
  );
}

// --- The screen ----------------------------------------------------------------

export interface SingleInstrumentViewProps {
  head: WorkspaceManifest;
  form: InstrumentForm;
  filter: PositionFilter;
  positions: PositionsState;
  library: LibraryState;
  run: RunState;
  on: {
    form: (patch: Partial<InstrumentForm>) => void;
    filter: (patch: Partial<PositionFilter>) => void;
    project: () => void;
    scenario: (i: number) => void;
  };
}

export function SingleInstrumentView(props: SingleInstrumentViewProps): ReactNode {
  const { head, form, run, on } = props;
  const bookId = head.blocks.positions.book?.id ?? null;
  const locked = head.status === "locked" || head.lock !== null;
  const markets = marketOptions(head);
  const sets = head.blocks.assumptions.sets;
  const defaultSet = head.blocks.assumptions.defaultSetId;
  return (
    <>
      <section className="card" aria-label="Single instrument run">
        <div className="card-title">Single instrument <span className="chip">Not saved</span></div>
        <p className="card-desc">
          Project one position of this workspace's book over a scenario and read its monthly cash flows with both discount factors. The run is computed on the fly from the workspace inputs and this screen stores nothing.
        </p>
        {locked ? (
          <p className="si-lock">
            <span className="status status-stale">Locked</span> This workspace is locked. The single-instrument run reads inputs and stores nothing, so it stays open.
          </p>
        ) : null}
      </section>

      <section className="card" aria-label="Instrument">
        <div className="card-title">Instrument</div>
        <div className="seg" role="group" aria-label="Instrument source">
          <button type="button" aria-pressed={form.source === "book"} onClick={() => on.form({ source: "book" })}>From the workspace book</button>
          <button type="button" aria-pressed={form.source === "typed"} onClick={() => on.form({ source: "typed" })}>Typed terms</button>
        </div>
        {form.source === "book" ? (
          <PositionPickerView
            bookId={bookId}
            filter={props.filter}
            positions={props.positions}
            selectedId={form.positionId}
            onFilter={on.filter}
            onPick={(id) => on.form({ positionId: id })}
          />
        ) : (
          <TypedTermsView typed={form.typed} onChange={(patch) => on.form({ typed: { ...form.typed, ...patch } })} />
        )}
      </section>

      <section className="card" aria-label="Scenarios">
        <div className="card-title">Scenarios</div>
        <ScenarioPickerView
          arm={form.arm}
          slateIds={head.blocks.scenarios.slates.map((s) => s.id)}
          slateId={form.slateId}
          shockBp={form.shockBp}
          setupIds={head.blocks.run.setups.map((s) => s.setupLineageId)}
          setupLineageId={form.setupLineageId}
          library={props.library}
          onChange={on.form}
        />
      </section>

      <section className="card" aria-label="Run">
        <div className="card-title">Run</div>
        <div className="si-filters">
          <label className="field">
            <span className="field-label">Market</span>
            <select value={form.marketId} onChange={(e) => on.form({ marketId: e.target.value })}>
              {markets.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Assumption set</span>
            <select value={form.assumptionSetId} onChange={(e) => on.form({ assumptionSetId: e.target.value })}>
              <option value="">none (contractual)</option>
              {sets.map((s) => <option key={s.id} value={s.id}>{s.id === defaultSet ? `${s.id} (workspace default)` : s.id}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Horizon (months)</span>
            <input className="input" inputMode="numeric" value={form.horizonMonths} onChange={(e) => on.form({ horizonMonths: e.target.value })} />
            <span className="field-help">{`Up to ${MAX_HORIZON_MONTHS}, the grid cap.`}</span>
          </label>
          <label className="field">
            <span className="field-label">Duration bump (bp)</span>
            <input className="input" inputMode="decimal" value={form.durationBumpBp} onChange={(e) => on.form({ durationBumpBp: e.target.value })} />
          </label>
        </div>
        <div className="si-actions">
          <button type="button" className="btn btn-primary" disabled={run.state === "busy"} onClick={on.project}>
            {run.state === "busy" ? "Projecting" : "Project"}
          </button>
          <span className="head-meta">Nothing is saved: the result lives on this page until you leave it.</span>
        </div>
        {run.state === "error" ? <p role="alert" className="si-error">{run.message}</p> : null}
      </section>

      {run.state === "ok" ? (
        <InstrumentResultView drill={run.drill} cutoffDate={head.cutoffDate} scenarioIndex={run.scenarioIndex} onScenario={on.scenario} />
      ) : null}
    </>
  );
}
