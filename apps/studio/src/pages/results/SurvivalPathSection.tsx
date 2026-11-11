// apps/studio/src/pages/results/SurvivalPathSection.tsx
/**
 * Results > Liquidity, the survival path. Under the run's stress ladder: the ladder's
 * row carried past month 12 on the run's own balances (deposits, wholesale funding, certificates of deposit and loan
 * inflows), read against the ladder's buffer and against the buffer plus a borrowing line. Survival is shown in
 * months, interpolated, and in days (months x 365 / 12). The commitment dials are edited here too: with the link on,
 * the severe draw rate is U99 - Ubar.
 *
 * The path can also be typed in ("Type your own path"), or opened from a preset a content pack registers, with its
 * reference checks (registry.ts). Everything on the page is computed in the browser by the engine's own
 * functions on every edit. Nothing is written, so the page works on a locked workspace and changes no stored run.
 */
import { useMemo, useState, type ReactNode } from "react";
import type {
  BookPathResult,
  CommitmentDials,
  CommitmentDialsResult,
  LiquidityStressParams,
  LiquidityStressResult,
  LiquidityStressScenario,
  SurvivalPathLegs,
  SurvivalPathResult,
} from "@alm/engine";
import {
  DAYS_PER_MONTH,
  computeBookPathLiquidity,
  computeCommitmentDials,
  computeSurvivalPath,
  type SurvivalPathInput,
} from "@alm/engine/src/liquidity";
import { exportCsvUrl } from "@alm/reader";
import { LinePlot } from "../../charts/LinePlot";
import type { Point } from "../../charts/plotScale";
import { money, moneyTick, signedMoney } from "../../format/figures";
import { registeredSurvivalPathPresets, type ReferenceCheck, type RegisteredSurvivalPathPresets, type SurvivalPathPresetGroup } from "../../registry";
import {
  dialsFormOf,
  dialsOf,
  formOf,
  inputOf,
  statedForm,
  type BookPathForm,
  type DialsForm,
  type PointForm,
} from "../../rows/survivalPathRows";
import { useLoad } from "../../useLoad";

export type Calc<T> = { ok: true; value: T } | { ok: false; reason: string };

function calc<T>(f: () => T): Calc<T> {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const M = 1e6;
const SCENARIO_LABEL: Record<LiquidityStressScenario["id"], string> = { bau: "Business as usual", moderate: "Moderate stress", severe: "Severe stress" };
const monthsText = (v: number | null): string => (v === null ? "not crossed" : `${v.toFixed(2)} months`);
const daysText = (v: number | null): string => (v === null ? "not crossed" : `${Math.round(v).toLocaleString("en-US")} days`);
const ratio = (v: number | null): string => (v === null ? "no outflow" : v.toFixed(2));
const pctText = (v: number): string => `${Number((v * 100).toPrecision(10))}%`;
const text = (v: number): string => String(Number(v.toPrecision(12)));

// ---------------------------------------------------------------------------
// Pure parts: the run's legs, the run form and its input
// ---------------------------------------------------------------------------

/** The run's balances the path reads: the stored survival path's legs, or the ladder's own 12 months. */
export function runLegs(b: LiquidityStressResult): SurvivalPathLegs {
  if (b.survivalPath !== undefined) return b.survivalPath.legs;
  const bau = b.scenarios.find((s) => s.id === "bau")!;
  const severe = b.scenarios.find((s) => s.id === "severe")!;
  return {
    horizonMonths: b.horizonMonths,
    pools: { ...b.pools },
    inflow: [...bau.inflow],
    inflowStress: [...severe.inflow],
    wholesaleMaturities: [...b.wholesaleMaturities],
    cdMaturities: b.cdMaturities !== undefined ? [...b.cdMaturities] : new Array<number>(b.horizonMonths).fill(0),
    undrawnFace: b.undrawnFace,
  };
}

/** What the run form holds, as typed. */
export interface RunPathForm {
  scenarioId: LiquidityStressScenario["id"];
  months: string;
  facilityOn: boolean;
  facilityLabel: string;
  capacityMusd: string;
  haircutPct: string;
  /** True: the severe draw rate is U99 - Ubar from the dials on this page. */
  linked: boolean;
}

/** The form a run opens on: the stored path's settings, or the severe row at 12 months with no borrowing line. */
export function runFormOf(b: LiquidityStressResult): RunPathForm {
  const sp = b.survivalPath;
  return {
    scenarioId: sp?.scenarioId ?? "severe",
    months: String(sp?.horizonMonths ?? b.horizonMonths),
    facilityOn: sp?.facility !== undefined,
    facilityLabel: sp?.facility?.label ?? "Borrowing capacity",
    capacityMusd: text((sp?.facility?.capacity ?? 0) / M),
    haircutPct: text((sp?.facility?.haircut ?? 0.2) * 100),
    linked: b.commitmentDials !== undefined,
  };
}

/**
 * The dials a run opens on: its own, or round starting values (S3d fix round, M1: the card says so). Either way their
 * amount is the run's undrawn face, the amount undrawn now (ruling 2026-11-05); the face is U / (1 - Ubar).
 */
export function runDialsOf(b: LiquidityStressResult): CommitmentDials {
  return b.commitmentDials?.dials ?? { undrawn: b.undrawnFace > 0 ? b.undrawnFace : 100 * M, expectedUtilization: 0.15, tailUtilization: 0.35, fundingSpreadBp: 50, lcrFactor: 0.1, thirtyDayShare: 1 / 12 };
}

/**
 * The row's rates the path runs: the ladder's; the severe draw rate the table's, or, linked, the dials' requirement
 * over the undrawn face, (U99 - Ubar) x U / (1 - Ubar) / U, so the path draws the requirement over 12 months.
 */
export function rowParams(b: LiquidityStressResult, id: LiquidityStressScenario["id"], linked: boolean, dials: CommitmentDials | null): LiquidityStressParams {
  const s = b.scenarios.find((x) => x.id === id)!;
  if (id !== "severe") return { ...s.params };
  const stated = b.commitmentDials?.statedSevereDrawRate ?? s.params.drawRate;
  if (!linked || dials === null || b.undrawnFace <= 0) return { ...s.params, drawRate: stated };
  return { ...s.params, drawRate: computeCommitmentDials({ ...dials, face: undefined, undrawn: b.undrawnFace }).bufferRequirement / b.undrawnFace };
}

function num(raw: string, what: string): Calc<number> {
  const t = raw.trim();
  const v = Number(t);
  return t === "" || !Number.isFinite(v) ? { ok: false, reason: `${what}: "${raw}" is not a number.` } : { ok: true, value: v };
}

/** The engine input the run form states, or the first thing wrong with it in plain words. */
export function runInputOf(b: LiquidityStressResult, form: RunPathForm, dials: Calc<CommitmentDials>): Calc<SurvivalPathInput> {
  const legs = runLegs(b);
  const months = Number(form.months.trim());
  if (!Number.isInteger(months) || months < 1 || months > legs.horizonMonths) {
    return { ok: false, reason: `Months: give a whole number from 1 to ${legs.horizonMonths}, the months this run's balances reach.${legs.horizonMonths === 12 ? " Turn the survival path on in the run setup for a longer one." : ""}` };
  }
  if (form.linked && !dials.ok) return { ok: false, reason: `The dials set the severe draw rate, and ${dials.reason}` };
  const input: SurvivalPathInput = {
    scenarioId: form.scenarioId,
    params: rowParams(b, form.scenarioId, form.linked, dials.ok ? dials.value : null),
    legs,
    horizonMonths: months,
    buffer: b.buffer,
  };
  if (form.facilityOn) {
    const cap = num(form.capacityMusd, "Borrowing capacity");
    if (!cap.ok) return cap;
    const cut = num(form.haircutPct, "Haircut on the borrowing line");
    if (!cut.ok) return cut;
    if (cap.value < 0 || cut.value < 0 || cut.value > 100) return { ok: false, reason: "The borrowing capacity is $M, zero or more, and its haircut a percent from 0 to 100." };
    input.facility = { label: form.facilityLabel, capacity: cap.value * M, haircut: Number((cut.value / 100).toPrecision(12)) };
  }
  return { ok: true, value: input };
}

const sameDials = (a: DialsForm, b: DialsForm): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

function Field(props: { label: string; value: string; onChange: (v: string) => void; help?: string }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input className="input" aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      {props.help === undefined ? null : <span className="field-help">{props.help}</span>}
    </label>
  );
}

function Toggle(props: { label: string; on: boolean; onChange: (on: boolean) => void; help?: string }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <select aria-label={props.label} value={props.on ? "on" : "off"} onChange={(e) => props.onChange(e.target.value === "on")}>
        <option value="off">Off</option>
        <option value="on">On</option>
      </select>
      {props.help === undefined ? null : <span className="field-help">{props.help}</span>}
    </label>
  );
}

function NotComputed(props: { reason: string }) {
  return (
    <section className="card unobs-panel" role="alert" aria-label="Not computed">
      <span className="status status-unobs">Not computed</span>
      <p className="unobs-text">{props.reason}</p>
    </section>
  );
}

function Verdict(props: { pass: boolean }) {
  return props.pass ? <span className="status status-pass">PASS</span> : <span className="status status-breach">FAIL</span>;
}

/** The reference checks a preset carries, beside the calculator's figures. */
export function ChecksCard(props: { title: string; checks: ReferenceCheck[]; asStored: boolean; onReset: () => void }) {
  if (props.checks.length === 0) return null;
  const failed = props.checks.filter((c) => !c.pass).length;
  return (
    <section className="card table-card" aria-label={props.title}>
      <div className="card-title">{props.title}</div>
      {props.asStored ? (
        <p className="kv-status">
          <span className={failed === 0 ? "status status-pass" : "status status-breach"}>{failed === 0 ? "Every reference cell ties" : "Reference cells that do not tie"}</span>{" "}
          {props.checks.length - failed} of {props.checks.length} cells tie
        </p>
      ) : (
        <p className="kv-status">
          <span className="status status-unobs">Edited</span> The reference cells are for the stored case. <button type="button" className="btn" onClick={props.onReset}>Back to the stored inputs</button>
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th scope="col">Cell</th><th scope="col" className="num">Studio</th><th scope="col" className="num">Reference</th><th scope="col">Unit</th><th scope="col">Where</th><th scope="col">Verdict</th></tr>
          </thead>
          <tbody>
            {props.checks.map((c, i) => (
              <tr key={i}>
                <th scope="row">{c.label}</th>
                <td className="num">{c.studio}</td>
                <td className="num">{c.reference}</td>
                <td>{c.unit}</td>
                <td>{c.source}</td>
                <td>{props.asStored ? <Verdict pass={c.pass} /> : <span className="status status-unobs">not compared</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-foot">A cell passes when the Studio figure is within half a unit of the reference's last digit. The Studio column shows two more decimals.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The commitment dials
// ---------------------------------------------------------------------------

export function DialsCard(props: {
  form: DialsForm;
  dials: Calc<CommitmentDialsResult>;
  onChange: (patch: Partial<DialsForm>) => void;
  onReset?: () => void;
  edited: boolean;
  /** The run's undrawn face and whether the severe draw reads the dials, when the dials sit beside a run. */
  ladder?: { undrawnFace: number; linked: boolean; onLink: (on: boolean) => void };
  /** S3d fix round (M1): the run set no dials, so these are starting values. */
  starting?: boolean;
  note?: string;
}) {
  const { form, dials } = props;
  const d = dials.ok ? dials.value : null;
  const undrawnNow = form.amountKind === "undrawn";
  // M1: the run set no dials; until a dial is edited or the link is on, its LCR reference is not shown as the run's.
  const hideLcr = props.starting === true && !props.edited && props.ladder?.linked !== true;
  return (
    <section className="card table-card" aria-label="Commitment dials">
      <div className="card-title">Commitment dials</div>
      {props.starting === true ? <p className="kv-status"><span className="status status-unobs">Starting values. This run set no dials.</span></p> : null}
      <p className="card-desc">The committed lines the bank has extended, their expected and tail use, and what that costs in buffer and in contingent liquidity FTP.{undrawnNow ? " The dials read the amount undrawn now; the commitment face is it over (1 - Ubar), and Ubar and U99 are shares of that face." : ""}</p>
      <div className="filter-row">
        {undrawnNow && props.ladder !== undefined ? (
          <label className="field">
            <span className="field-label">Undrawn now, USD M</span>
            <input className="input" aria-label="Undrawn now, USD M" value={form.amountMusd} disabled readOnly />
            <span className="field-help">The run's undrawn face; change it in the run setup.</span>
          </label>
        ) : (
          <Field label={undrawnNow ? "Undrawn now, USD M" : "Commitment face, USD M"} value={form.amountMusd} onChange={(v) => props.onChange({ amountMusd: v })} />
        )}
        <Field label="Expected utilization (Ubar), %" value={form.expectedPct} onChange={(v) => props.onChange({ expectedPct: v })} />
        <Field label="Tail utilization (U99), %" value={form.tailPct} onChange={(v) => props.onChange({ tailPct: v })} />
        <Field label="Funding spread, bp" value={form.spreadBp} onChange={(v) => props.onChange({ spreadBp: v })} />
        <Field label="LCR factor, %" value={form.lcrPct} onChange={(v) => props.onChange({ lcrPct: v })} help="12 CFR 249: 10% for a credit line to a company, 5% to a person." />
        <Field label="Tail draw inside 30 days, %" value={form.thirtyDayPct} onChange={(v) => props.onChange({ thirtyDayPct: v })} />
      </div>
      {props.ladder !== undefined ? (
        <Toggle label="Severe draw from the dials" on={props.ladder.linked} onChange={props.ladder.onLink} help="On: the severe row draws the buffer requirement, (U99 - Ubar) x face, spread evenly over 12 months." />
      ) : null}
      {props.edited && props.onReset !== undefined ? (
        <p className="kv-status"><span className="status status-unobs">Edited</span> <button type="button" className="btn" onClick={props.onReset}>Back to the stored dials</button></p>
      ) : null}
      {d === null ? (
        <p className="unobs-text" role="alert">{(dials as { reason: string }).reason}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr><th scope="row">Undrawn now</th><td className="num">{money(d.undrawn)}</td></tr>
              <tr><th scope="row">Commitment face{undrawnNow ? ", undrawn / (1 - Ubar)" : ""}</th><td className="num">{money(d.face)}</td></tr>
              <tr><th scope="row">Expected drawn, Ubar x face</th><td className="num">{money(d.expectedDrawn)}</td></tr>
              <tr><th scope="row">Drawn at the tail</th><td className="num">{money(d.tailDrawn)}</td></tr>
              <tr><th scope="row">Buffer requirement, (U99 - Ubar) x face</th><td className="num">{money(d.bufferRequirement)}</td></tr>
              <tr><th scope="row">Contingent charge, (U99 - Ubar) / (1 - Ubar) x spread</th><td className="num">{d.contingentChargeBp.toFixed(2)} bp, ${(d.contingentChargeAnnual / 1e6).toFixed(3)}M a year on the undrawn line</td></tr>
              {hideLcr ? null : <tr><th scope="row">LCR reference outflow, factor x undrawn now</th><td className="num">{money(d.lcrReferenceOutflow)}</td></tr>}
              <tr><th scope="row">Internal 30-day draw</th><td className="num">{money(d.internalThirtyDayDraw)}{d.internalOverLcr === null || hideLcr ? "" : `, ${d.internalOverLcr.toFixed(2)} times the LCR reference`}</td></tr>
              {props.ladder !== undefined ? (
                <tr><th scope="row">The ladder's severe draw, the buffer requirement</th><td className="num">{props.ladder.linked ? `${money(d.bufferRequirement)} over 12 months` : "not linked: the table's draw rate"}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-foot">
        The tail draw enters the buffer only as U99 - Ubar; the expected part is already in the base case.
        {hideLcr ? " Edit a dial or turn the link on to read the LCR reference on these values." : ""}
        {props.note === undefined ? "" : ` ${props.note}`}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The run's path
// ---------------------------------------------------------------------------

function RunPathCards(props: { p: SurvivalPathResult; dials: CommitmentDialsResult | null; runId?: string; stored: boolean }) {
  const { p, dials } = props;
  const withF = p.withFacility;
  const firstDraw = p.rows[0]?.draws ?? 0;
  return (
    <>
      <section className="card table-card" aria-label="Survival on the run's path">
        <div className="card-title">Survival on the run's path</div>
        <p className="card-desc">{SCENARIO_LABEL[p.scenarioId]}, {p.horizonMonths} months. Survival is the first month the buffer plus the cumulative net flow turns negative, interpolated between months; days are months times 365/12.</p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Against</th><th scope="col" className="num">Buffer</th><th scope="col" className="num">Survival, months</th><th scope="col" className="num">Survival, days</th><th scope="col" className="num">Term-funding need</th></tr></thead>
            <tbody>
              <tr>
                <th scope="row">The ladder's buffer</th>
                <td className="num">{money(p.ladderBuffer.buffer)}</td>
                <td className="num">{monthsText(p.ladderBuffer.survivalMonths)}</td>
                <td className="num">{daysText(p.ladderBuffer.survivalDays)}</td>
                <td className="num">{money(p.ladderBuffer.termFundingNeed)}</td>
              </tr>
              {withF === undefined || p.facility === undefined ? null : (
                <tr>
                  <th scope="row">Buffer plus {p.facility.label}</th>
                  <td className="num">{money(withF.buffer)}</td>
                  <td className="num">{monthsText(withF.survivalMonths)}</td>
                  <td className="num">{daysText(withF.survivalDays)}</td>
                  <td className="num">{money(withF.termFundingNeed)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr><th scope="row">Peak shortfall</th><td className="num">{signedMoney(p.peakShortfall)}</td><td>{p.peakMonth === null ? "no outflow" : `month ${p.peakMonth}`}</td></tr>
              {p.facility === undefined ? null : (
                <tr><th scope="row">{p.facility.label}</th><td className="num">{money(p.facility.counted)}</td><td>{money(p.facility.capacity)} less a {pctText(p.facility.haircut)} haircut; counted here only, never in the ladder's buffer</td></tr>
              )}
              <tr><th scope="row">Draws</th><td className="num">{money(firstDraw)} a month</td><td>undrawn face x draw rate {pctText(p.params.drawRate)}, spread evenly over months 1 to 12, nothing after{dials !== null && Math.abs(firstDraw * 12 - dials.bufferRequirement) < 1 ? ": the dials' buffer requirement" : ""}</td></tr>
              {dials === null ? null : (
                <tr><th scope="row">LCR reference, beside</th><td className="num">{money(dials.lcrReferenceOutflow)}</td><td>the 30-day outflow the LCR prescribes on the amount undrawn now (factor x undrawn, 12 CFR 249 demonstration factor); this path draws {money(firstDraw)} in its first month</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="card-foot">
          {props.stored ? "As the run stored it." : "Computed on this page from the run's balances; nothing is saved."}
          {props.stored && props.runId !== undefined ? <>{" "}<a className="btn btn-quiet" href={exportCsvUrl(props.runId, "survival-path")} download>Export survival-path.csv</a></> : null}
        </p>
      </section>
      <figure className="card viz" aria-label="The survival path against the buffer">
        <div className="viz-head"><div className="card-title">The survival path against the buffer</div></div>
        <p className="card-desc">The dashed lines are the buffer{withF === undefined ? "" : " and the buffer with the borrowing line"}, drawn below zero. Where the path falls under one, that buffer is used up.</p>
        <LinePlot
          series={[
            { id: "path", label: "Cumulative net funding", tone: "third", points: [[0, 0] as Point, ...p.rows.map((r): Point => [r.month, r.cumulative])] },
            { id: "buffer", label: "Buffer", tone: "muted", dash: true, points: [0, ...p.rows.map((r) => r.month)].map((m): Point => [m, -p.ladderBuffer.buffer]) },
            ...(withF === undefined ? [] : [{ id: "with-facility", label: "Buffer plus the borrowing line", tone: "accent" as const, dash: true, points: [0, ...p.rows.map((r) => r.month)].map((m): Point => [m, -withF.buffer]) }]),
          ]}
          xScale="linear" xTicks={[0, ...p.rows.map((r) => r.month)].filter((m) => m % (p.horizonMonths > 24 ? 6 : 3) === 0).map((m) => ({ value: m, label: `M${m}` }))}
          xLabel={(m) => `M${m}`} yTick={moneyTick} unit="USD, cumulative net funding" format={signedMoney}
        />
        <figcaption className="card-foot">Month 0 starts with nothing used. Month k is the k-th month after the as-of date.</figcaption>
      </figure>
      <section className="card table-card" aria-label="The survival path, month by month">
        <div className="card-title">The survival path, month by month</div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="num">Month</th><th scope="col" className="num">Day</th><th scope="col" className="num">Inflow</th>
                <th scope="col" className="num">Savings pool out</th><th scope="col" className="num">Checking pool out</th><th scope="col" className="num">Wholesale out</th>
                <th scope="col" className="num">CDs out</th><th scope="col" className="num">Draws</th><th scope="col" className="num">Net</th><th scope="col" className="num">Cumulative</th><th scope="col" className="num">Net position</th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r) => (
                <tr key={r.month}>
                  <th scope="row" className="num">{r.month}</th>
                  <td className="num">{Math.round(r.days)}</td>
                  <td className="num">{money(r.inflow)}</td>
                  <td className="num">{money(r.hysOut)}</td>
                  <td className="num">{money(r.nibOut)}</td>
                  <td className="num">{money(r.wholesaleOut)}</td>
                  <td className="num">{money(r.cdOut)}</td>
                  <td className="num">{money(r.draws)}</td>
                  <td className="num">{signedMoney(r.net)}</td>
                  <td className="num">{signedMoney(r.cumulative)}</td>
                  <td className="num">{signedMoney(p.ladderBuffer.buffer + r.cumulative)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-foot">Months 1 to 12 are the ladder's row. The savings pool holds the deposits tagged hys-pool, the checking pool those tagged nib-pool. CDs out is what matures less the renewal share, plus every early withdrawal. Net position is the ladder's buffer plus the cumulative.</p>
      </section>
    </>
  );
}

function RunInputs(props: { form: RunPathForm; maxMonths: number; on: (patch: Partial<RunPathForm>) => void; edited: boolean; onReset: () => void }) {
  const { form, on } = props;
  return (
    <section className="card" aria-label="The run's path">
      <div className="card-title">The run's path</div>
      <div className="filter-row">
        <label className="field">
          <span className="field-label">Ladder row</span>
          <select aria-label="Ladder row" value={form.scenarioId} onChange={(e) => on({ scenarioId: e.target.value as RunPathForm["scenarioId"] })}>
            {(["bau", "moderate", "severe"] as const).map((id) => <option key={id} value={id}>{SCENARIO_LABEL[id]}</option>)}
          </select>
        </label>
        <Field label="Months" value={form.months} onChange={(v) => on({ months: v })} help={`From 1 to ${props.maxMonths}, the months this run's balances reach.`} />
        <Toggle label="Borrowing line" on={form.facilityOn} onChange={(v) => on({ facilityOn: v })} help="Counted in this path only, after its haircut." />
        {form.facilityOn ? (
          <>
            <Field label="Borrowing capacity, USD M" value={form.capacityMusd} onChange={(v) => on({ capacityMusd: v })} />
            <Field label="Haircut on the borrowing line, %" value={form.haircutPct} onChange={(v) => on({ haircutPct: v })} />
          </>
        ) : null}
      </div>
      {props.edited ? <p className="kv-status"><span className="status status-unobs">Edited</span> <button type="button" className="btn" onClick={props.onReset}>Back to the run's settings</button></p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The calculator: a typed path or a preset
// ---------------------------------------------------------------------------

function PathInputs(props: { form: BookPathForm; on: (patch: Partial<BookPathForm>) => void; point: (i: number, v: string) => void; built: (patch: Partial<NonNullable<BookPathForm["built"]>>) => void }) {
  const { form, on } = props;
  const b = form.built;
  return (
    <section className="card" aria-label="Path inputs">
      <div className="card-title">Path inputs</div>
      <div className="filter-row">
        <Field label="Buffer (HQLA), USD M" value={form.hqlaMusd} onChange={(v) => on({ hqlaMusd: v })} />
        <Field label="Borrowing capacity, USD M" value={form.receivedMusd} onChange={(v) => on({ receivedMusd: v })} />
        <Field label="Haircut on the borrowing capacity, %" value={form.haircutPct} onChange={(v) => on({ haircutPct: v })} help="The buffer itself is never haircut here." />
      </div>
      {b === null ? (
        <>
          <p className="field-help">Cumulative net funding at each point, USD M. A shortfall is negative.</p>
          <div className="filter-row">
            {form.points.map((p: PointForm, i) => (
              <Field key={p.label} label={p.label} value={p.cumulativeMusd} onChange={(v) => props.point(i, v)} />
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="field-help">The path built from its legs. Deposits run off at one whole-book rate: the stable share times the stable rate plus the rest times the non-stable rate, on the starting shares.</p>
          <div className="filter-row">
            <Field label="Deposit balance, USD M" value={b.savingsMusd} onChange={(v) => props.built({ savingsMusd: v })} />
            <Field label="Stable share, %" value={b.stableSharePct} onChange={(v) => props.built({ stableSharePct: v })} />
            <Field label="Stable runoff, % a month" value={b.stableRatePct} onChange={(v) => props.built({ stableRatePct: v })} />
            <Field label="Non-stable runoff, % a month" value={b.nonStableRatePct} onChange={(v) => props.built({ nonStableRatePct: v })} />
            <Field label="Wholesale balance, USD M" value={b.wholesaleMusd} onChange={(v) => props.built({ wholesaleMusd: v })} />
          </div>
          <Field label={`Wholesale timing: share gone by each month, %, ${b.horizonMonths} values`} value={b.wholesaleSharePct} onChange={(v) => props.built({ wholesaleSharePct: v })} />
          <Field label={`Inflow, cumulative, USD M, ${b.horizonMonths} values`} value={b.inflowMusd} onChange={(v) => props.built({ inflowMusd: v })} />
        </>
      )}
      <Toggle label="Stressed commitment draw" on={form.drawOn} onChange={(v) => on({ drawOn: v })} />
      {form.drawOn ? (
        <div className="filter-row">
          <Field label="Draw, USD M" value={form.drawMusd} onChange={(v) => on({ drawMusd: v })} help="(U99 - Ubar) x face, from the dials." />
          <Field label="Share drawn by each point, %" value={form.drawSharePct} onChange={(v) => on({ drawSharePct: v })} help="One cumulative share per point, separated by spaces." />
        </div>
      ) : null}
    </section>
  );
}

function CalcResultCards(props: { r: BookPathResult }) {
  const { r } = props;
  const built = r.built;
  return (
    <>
      <section className="card table-card" aria-label="Survival on the path">
        <div className="card-title">Survival on the path</div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr><th scope="row">Buffer</th><td className="num">{money(r.buffer)}</td><td>the buffer plus {money(r.receivedCounted)} of borrowing capacity</td></tr>
              <tr><th scope="row">Buffer crossed</th><td className="num">{monthsText(r.crossingMonth)}</td><td>{r.crossingMonth === null ? "first crossing, linear between the points" : `${daysText(r.crossingMonth * DAYS_PER_MONTH)}; first crossing, linear between the points`}</td></tr>
              <tr><th scope="row">Full months survived</th><td className="num">{r.fullMonthsSurvived === null ? `more than ${Math.floor(r.rows[r.rows.length - 1]?.month ?? 0)}` : String(r.fullMonthsSurvived)}</td><td>the crossing rounded down</td></tr>
              <tr><th scope="row">Peak shortfall</th><td className="num">{signedMoney(r.peakShortfall)}</td><td>{r.peakLabel ?? "no outflow"}</td></tr>
              <tr><th scope="row">Term-funding need</th><td className="num">{money(r.termFundingNeed)}</td><td>peak shortfall less the buffer</td></tr>
              <tr><th scope="row">Coverage, day 1-7</th><td className="num">{r.firstWeek === null ? "no day 1-7 point" : ratio(r.firstWeek.coverageRatio)}</td><td>buffer over the cumulative net outflow</td></tr>
              {built === undefined ? null : <tr><th scope="row">Deposit runoff</th><td className="num">{(built.depositRateMonthly * 100).toFixed(2)}% a month</td><td>the whole-book rate the stable share forms</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <figure className="card viz" aria-label="Cumulative net funding against the buffer">
        <div className="viz-head"><div className="card-title">Cumulative net funding against the buffer</div></div>
        <p className="card-desc">The dashed line is the buffer, {money(r.buffer)}, drawn below zero. Where the path falls under it the buffer is used up.</p>
        <LinePlot
          series={[
            { id: "path", label: "Cumulative net funding", tone: "accent", points: [[0, 0] as Point, ...r.rows.map((x): Point => [x.month, x.cumulative])] },
            { id: "buffer", label: "Buffer", tone: "muted", dash: true, points: [[0, -r.buffer] as Point, ...r.rows.map((x): Point => [x.month, -r.buffer])] },
          ]}
          xScale="linear" xTicks={[{ value: 0, label: "M0" }, ...r.rows.filter((x) => x.days === undefined).map((x) => ({ value: x.month, label: `M${x.month}` }))]}
          xLabel={(m) => `M${Number(m.toFixed(2))}`} yTick={moneyTick} unit="USD, cumulative net funding" format={signedMoney}
        />
        <figcaption className="card-foot">Month 0 starts with nothing used. The line between points is straight.</figcaption>
      </figure>
      <section className="card table-card" aria-label="The path, point by point">
        <div className="card-title">The path, point by point</div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Point</th>
                {built === undefined ? null : <><th scope="col" className="num">Deposits out</th><th scope="col" className="num">Wholesale out</th><th scope="col" className="num">Inflow</th></>}
                <th scope="col" className="num">Path</th><th scope="col" className="num">Draw</th><th scope="col" className="num">Cumulative</th>
                <th scope="col" className="num">Net position</th><th scope="col" className="num">Coverage ratio</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((x, i) => (
                <tr key={x.label}>
                  <th scope="row">{x.label}</th>
                  {built === undefined ? null : <><td className="num">{money(built.depositOutflow[i]!)}</td><td className="num">{money(built.wholesaleOutflow[i]!)}</td><td className="num">{money(built.inflow[i]!)}</td></>}
                  <td className="num">{signedMoney(x.pathCumulative)}</td>
                  <td className="num">{money(x.draw)}</td>
                  <td className="num">{signedMoney(x.cumulative)}</td>
                  <td className="num">{signedMoney(x.netPosition)}</td>
                  <td className="num">{ratio(x.coverageRatio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-foot">Net position is the buffer plus the cumulative net funding. The coverage ratio is the buffer over the cumulative net outflow.</p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** One registered preset entry, loaded. */
export interface LoadedPresets {
  entry: RegisteredSurvivalPathPresets;
  groups: SurvivalPathPresetGroup[];
  dials?: CommitmentDials;
}

/** Where the path comes from: the run, a typed path, or one case of a preset. */
export type PathSource = { kind: "run" } | { kind: "stated" } | { kind: "preset"; entryId: string; groupId: string; caseId: string };

const sourceKey = (s: PathSource): string => (s.kind === "preset" ? `preset|${s.entryId}|${s.groupId}|${s.caseId}` : s.kind);
function sourceOf(key: string): PathSource {
  if (key === "run" || key === "stated") return { kind: key };
  const [, entryId, groupId, caseId] = key.split("|");
  return { kind: "preset", entryId: entryId!, groupId: groupId!, caseId: caseId! };
}

function presetCase(presets: readonly LoadedPresets[], s: PathSource) {
  if (s.kind !== "preset") return undefined;
  const p = presets.find((x) => x.entry.id === s.entryId);
  const g = p?.groups.find((x) => x.id === s.groupId);
  const c = g?.cases.find((x) => x.id === s.caseId);
  return p === undefined || g === undefined || c === undefined ? undefined : { p, g, c };
}

/** The first source a panel opens on: the run's path when there is a run, else the first preset, else a typed path. */
export function firstSource(block: LiquidityStressResult | undefined, presets: readonly LoadedPresets[]): PathSource {
  if (block !== undefined) return { kind: "run" };
  const p = presets.find((x) => x.groups.length > 0 && x.groups[0]!.cases.length > 0);
  return p === undefined ? { kind: "stated" } : { kind: "preset", entryId: p.entry.id, groupId: p.groups[0]!.id, caseId: p.groups[0]!.cases[0]!.id };
}

function typedForm(block: LiquidityStressResult | undefined): BookPathForm {
  const severe = block?.scenarios.find((s) => s.id === "severe");
  const f = block?.survivalPath?.facility;
  return statedForm(severe?.cumulative ?? new Array<number>(12).fill(0), { hqla: block?.buffer ?? 0, receivedFacilities: f?.capacity ?? 0, receivedHaircut: f?.haircut ?? 0.2 });
}

/**
 * The stateful panel. `block` is the run's ladder (absent on a page that reads no run); `presets` the registered
 * presets, loaded; `initial` the source to open on.
 */
export function SurvivalPathPanel(props: { block?: LiquidityStressResult; runId?: string; presets: readonly LoadedPresets[]; initial?: PathSource; intro?: ReactNode }) {
  const { block, presets } = props;
  const [source, setSource] = useState<PathSource>(() => props.initial ?? firstSource(block, presets));
  // The run's path.
  const [runForm, setRunForm] = useState<RunPathForm | null>(() => (block === undefined ? null : runFormOf(block)));
  const storedDials = block === undefined ? null : dialsFormOf(runDialsOf(block));
  const [runDials, setRunDials] = useState<DialsForm | null>(storedDials);
  // The calculator.
  const opened = presetCase(presets, source);
  const [calcForm, setCalcForm] = useState<BookPathForm>(() => (opened !== undefined ? formOf(opened.c.input) : typedForm(block)));
  const [calcEdited, setCalcEdited] = useState(false);
  const presetDialsForm = opened?.p.dials !== undefined ? dialsFormOf(opened.p.dials) : null;
  const [presetDials, setPresetDials] = useState<DialsForm | null>(presetDialsForm);

  const runDialsCalc: Calc<CommitmentDials> | null = useMemo(() => (runDials === null || block === undefined ? null : dialsOf(runDials, runDialsOf(block))), [runDials, block]);
  const runResult: Calc<SurvivalPathResult> | null = useMemo(() => {
    if (block === undefined || runForm === null || runDialsCalc === null) return null;
    const input = runInputOf(block, runForm, runDialsCalc);
    return input.ok ? calc(() => computeSurvivalPath(input.value)) : input;
  }, [block, runForm, runDialsCalc]);
  const calcResult: Calc<BookPathResult> = useMemo(() => {
    const parsed = inputOf(calcForm);
    return parsed.ok ? calc(() => computeBookPathLiquidity(parsed.value)) : parsed;
  }, [calcForm]);

  const dialsFormNow = source.kind === "preset" ? presetDials : runDials;
  const dialsResult: Calc<CommitmentDialsResult> | null = useMemo(() => {
    if (dialsFormNow === null) return null;
    const stored = source.kind === "preset" ? opened?.p.dials : block === undefined ? undefined : runDialsOf(block);
    if (stored === undefined) return null;
    const parsed = dialsOf(dialsFormNow, stored);
    return parsed.ok ? calc(() => computeCommitmentDials(parsed.value)) : parsed;
  }, [dialsFormNow, source.kind, opened, block]);

  const pick = (key: string) => {
    const next = sourceOf(key);
    setSource(next);
    const c = presetCase(presets, next);
    if (c !== undefined) {
      setCalcForm(formOf(c.c.input));
      setPresetDials(c.p.dials !== undefined ? dialsFormOf(c.p.dials) : null);
    } else if (next.kind === "stated") setCalcForm(typedForm(block));
    setCalcEdited(false);
  };
  const editCalc = (next: BookPathForm) => {
    setCalcForm(next);
    setCalcEdited(true);
  };

  const storedRun = block !== undefined && runForm !== null && runDials !== null && JSON.stringify(runForm) === JSON.stringify(runFormOf(block)) && sameDials(runDials, storedDials!);
  const storedPath = storedRun && block?.survivalPath !== undefined;
  // S3d fix round (M1): a run that set no dials opens them on starting values; their LCR reference is shown beside the
  // path only once a dial is edited or the link is on.
  const startingDials = block !== undefined && block.commitmentDials === undefined;
  const runDialsEdited = runDials !== null && storedDials !== null && !sameDials(runDials, storedDials);
  const runLcrShown = !startingDials || runDialsEdited || runForm?.linked === true;

  return (
    <>
      <section className="card" aria-label="Survival path">
        <div className="card-title">Survival path</div>
        {props.intro ?? (
          <p className="card-desc">
            How long the buffer lasts on one row of the stress, month by month, and past the ladder's 12 months when the run carries its balances that far. Built from this run by default; you can also type your own path.
          </p>
        )}
        <label className="field">
          <span className="field-label">Path</span>
          <select aria-label="Path" value={sourceKey(source)} onChange={(e) => pick(e.target.value)}>
            {block !== undefined ? <option value="run">Built from this run</option> : null}
            <option value="stated">Type your own path</option>
            {presets.map((p) => (
              <optgroup key={p.entry.id} label={p.entry.label}>
                {p.groups.flatMap((g) => g.cases.map((c) => <option key={`${g.id}|${c.id}`} value={`preset|${p.entry.id}|${g.id}|${c.id}`}>{g.label}: {c.label}</option>))}
              </optgroup>
            ))}
          </select>
        </label>
        {opened !== undefined ? <p className="field-help">{opened.g.note}</p> : null}
      </section>
      {source.kind === "run" && block !== undefined && runForm !== null ? (
        <>
          <RunInputs form={runForm} maxMonths={runLegs(block).horizonMonths} on={(patch) => setRunForm({ ...runForm, ...patch })} edited={JSON.stringify(runForm) !== JSON.stringify(runFormOf(block))} onReset={() => setRunForm(runFormOf(block))} />
          {runResult === null ? null : runResult.ok ? <RunPathCards p={runResult.value} dials={dialsResult?.ok === true && runLcrShown ? dialsResult.value : null} runId={props.runId} stored={storedPath} /> : <NotComputed reason={runResult.reason} />}
        </>
      ) : (
        <>
          <PathInputs
            form={calcForm}
            on={(patch) => editCalc({ ...calcForm, ...patch })}
            point={(i, v) => editCalc({ ...calcForm, points: calcForm.points.map((p, j) => (j === i ? { ...p, cumulativeMusd: v } : p)) })}
            built={(patch) => editCalc({ ...calcForm, built: calcForm.built === null ? null : { ...calcForm.built, ...patch } })}
          />
          {calcResult.ok ? <CalcResultCards r={calcResult.value} /> : <NotComputed reason={calcResult.reason} />}
          {opened !== undefined && calcResult.ok ? (
            <ChecksCard title={opened.p.entry.checksTitle} checks={opened.p.entry.checks(opened.g.id, opened.c.id, calcResult.value)} asStored={!calcEdited} onReset={() => { setCalcForm(formOf(opened.c.input)); setCalcEdited(false); }} />
          ) : null}
        </>
      )}
      {dialsFormNow !== null && dialsResult !== null ? (
        <DialsCard
          form={dialsFormNow}
          dials={dialsResult}
          onChange={(patch) => (source.kind === "preset" ? setPresetDials({ ...dialsFormNow, ...patch }) : setRunDials({ ...dialsFormNow, ...patch }))}
          edited={source.kind === "preset" ? presetDialsForm !== null && !sameDials(dialsFormNow, presetDialsForm) : storedDials !== null && !sameDials(dialsFormNow, storedDials)}
          onReset={() => (source.kind === "preset" ? setPresetDials(presetDialsForm) : setRunDials(storedDials))}
          {...(source.kind === "run" && block !== undefined && runForm !== null ? { ladder: { undrawnFace: block.undrawnFace, linked: runForm.linked, onLink: (on: boolean) => setRunForm({ ...runForm, linked: on }) } } : {})}
          {...(source.kind === "preset" && opened?.p.entry.dialsNote !== undefined ? { note: opened.p.entry.dialsNote } : {})}
          {...(source.kind !== "preset" && startingDials ? { starting: true } : {})}
        />
      ) : null}
      {source.kind === "preset" && opened?.p.entry.dialsChecks !== undefined && dialsResult?.ok === true && presetDials !== null && presetDialsForm !== null ? (
        <ChecksCard title={opened.p.entry.dialsChecksTitle ?? "Commitment dials checks"} checks={opened.p.entry.dialsChecks(dialsResult.value)} asStored={sameDials(presetDials, presetDialsForm)} onReset={() => setPresetDials(presetDialsForm)} />
      ) : null}
    </>
  );
}

/** Load every registered preset entry; an entry the store does not hold is left out, with its reason. */
export async function loadPresets(entries: readonly RegisteredSurvivalPathPresets[]): Promise<{ loaded: LoadedPresets[]; missing: Array<{ label: string; reason: string }> }> {
  const loaded: LoadedPresets[] = [];
  const missing: Array<{ label: string; reason: string }> = [];
  for (const entry of entries) {
    try {
      const v = await entry.load();
      loaded.push({ entry, groups: v.groups, ...(v.dials !== undefined ? { dials: v.dials } : {}) });
    } catch (e) {
      missing.push({ label: entry.label, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { loaded, missing };
}

/** Results > Liquidity's section: the panel on the run's ladder, with the registered presets once they are read. */
export function SurvivalPathSection(props: { block: LiquidityStressResult; runId: string }) {
  const entries = registeredSurvivalPathPresets();
  const load = useLoad(() => loadPresets(entries), [entries.length]);
  const presets = load.state === "ok" ? load.value.loaded : [];
  // The panel keys on the preset count, so it opens again with the presets once they arrive.
  return <SurvivalPathPanel key={`${props.runId}-${presets.length}`} block={props.block} runId={props.runId} presets={presets} />;
}
