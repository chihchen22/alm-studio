// apps/studio/src/pages/results/LiquidityTab.tsx
/**
 * Liquidity tab: the liquidity stress block as stored. Three ladders
 * (business as usual, moderate, severe), the cumulative net funding against the buffer line, and the survival horizon
 * and peak shortfall per scenario. A survival horizon of null is the buffer never pierced inside the horizon.
 *
 * The certificates of deposit as a ladder column when the run states their renewal, the
 * buffer's derivation from the HQLA tags when the setup stated none, the draw rule, and the survival path with the
 * commitment dials under the ladder (SurvivalPathSection.tsx).
 */
import type { LiquidityStressResult, LiquidityStressScenario } from "@alm/engine";
import { pct } from "@alm/reader";
import { DAYS_PER_MONTH } from "@alm/engine/src/liquidity";
import { LinePlot } from "../../charts/LinePlot";
import type { Point } from "../../charts/plotScale";
import { money, moneyTick, signedMoney } from "../../format/figures";
import { exportCsvUrl } from "@alm/reader";
import { blockOf, NotInRun, type TabProps } from "./common";
import { SurvivalPathSection } from "./SurvivalPathSection";

const LABELS: Record<LiquidityStressScenario["id"], string> = { bau: "Business as usual", moderate: "Moderate stress", severe: "Severe stress" };
const TONES = { bau: "accent", moderate: "second", severe: "third" } as const;

/** S3d fix round (M2): one name per pool on the page; each holds what the book tags into it. */
export const POOL_WORDS = "pools (the savings pool holds the deposits tagged hys-pool, the checking pool those tagged nib-pool, interest checking included when the book puts it there)";

/** The survival horizon as the tab prints it: the stored months, or beyond the horizon when the buffer was never pierced. */
function survivalText(s: LiquidityStressScenario, horizon: number): string {
  return s.survivalMonths === null ? `Beyond ${horizon} months` : `${s.survivalMonths.toFixed(1)} months`;
}

function SummaryCard(props: { b: LiquidityStressResult }) {
  const { b } = props;
  return (
    <section className="card table-card" aria-label="Survival horizon">
      <div className="card-title">Survival horizon</div>
      <p className="card-desc">The first month in which the buffer of {money(b.buffer)} plus the cumulative net flow turns negative, interpolated between months. Undrawn commitments {money(b.undrawnFace)}; {POOL_WORDS}: savings pool {money(b.pools.hys)}, checking pool {money(b.pools.nib)}{b.cdMaturities === undefined ? "" : `; certificates of deposit maturing ${money(b.cdMaturities.reduce((x, y) => x + y, 0))} and withdrawn early ${money((b.cdEarlyWithdrawals ?? []).reduce((x, y) => x + y, 0))} over the 12 months`}.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Scenario</th><th scope="col" className="num">Survival horizon</th><th scope="col" className="num">Peak shortfall</th><th scope="col" className="num">Peak month</th></tr></thead>
          <tbody>
            {b.scenarios.map((s) => (
              <tr key={s.id}>
                <th scope="row">{LABELS[s.id]}</th>
                <td className="num" title={`liquidityStress.scenarios[id=${s.id}].survivalMonths`}>{survivalText(s, b.horizonMonths)}{s.survivalMonths === null ? "" : `, ${Math.round(s.survivalMonths * DAYS_PER_MONTH)} days`}</td>
                <td className="num" title={`liquidityStress.scenarios[id=${s.id}].peakShortfall`}>{signedMoney(s.peakShortfall)}</td>
                <td className="num">month {s.peakMonth}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-foot">Source: liquidityStress.scenarios[].survivalMonths, .peakShortfall, .peakMonth. Peak shortfall is the most negative cumulative net flow.</p>
    </section>
  );
}

function ChartCard(props: { b: LiquidityStressResult }) {
  const { b } = props;
  const months = Array.from({ length: b.horizonMonths }, (_, i) => i + 1);
  return (
    <figure className="card viz" aria-label="Cumulative net funding against the buffer">
      <div className="viz-head"><div className="card-title">Cumulative net funding against the buffer</div></div>
      <p className="card-desc">The dashed line is the buffer, {money(b.buffer)}, drawn below zero: a scenario whose cumulative net flow falls under it has used the whole buffer.</p>
      <LinePlot
        series={[
          ...b.scenarios.map((s) => ({ id: s.id, label: LABELS[s.id], tone: TONES[s.id], points: s.cumulative.map((v, i): Point => [i + 1, v]) })),
          { id: "buffer", label: "Buffer", tone: "muted" as const, dash: true, points: months.map((m): Point => [m, -b.buffer]) },
        ]}
        xScale="linear" xTicks={months.map((m) => ({ value: m, label: `M${m}` }))} xLabel={(m) => `M${m}`} yTick={moneyTick}
        unit="USD, cumulative net flow" format={signedMoney}
      />
      <figcaption className="card-foot">Source: liquidityStress.scenarios[].cumulative and liquidityStress.buffer. Month k is the k-th month after the as-of date.</figcaption>
    </figure>
  );
}

function LadderCard(props: { s: LiquidityStressScenario; runId: string }) {
  const { s } = props;
  return (
    <section className="card table-card" aria-label={`Ladder, ${LABELS[s.id]}`}>
      <div className="card-title">Ladder, {LABELS[s.id]}</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col" className="num">Month</th><th scope="col" className="num">Inflow</th><th scope="col" className="num">Savings pool out</th>
              <th scope="col" className="num">Checking pool out</th><th scope="col" className="num">Wholesale out</th>
              {s.cdOut === undefined ? null : <th scope="col" className="num">CDs out</th>}
              <th scope="col" className="num">Draws</th>
              <th scope="col" className="num">Net</th><th scope="col" className="num">Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {s.net.map((net, i) => (
              <tr key={i}>
                <th scope="row" className="num">{i + 1}</th>
                <td className="num">{money(s.inflow[i]!)}</td>
                <td className="num">{money(s.hysOut[i]!)}</td>
                <td className="num">{money(s.nibOut[i]!)}</td>
                <td className="num">{money(s.wholesaleOut[i]!)}</td>
                {s.cdOut === undefined ? null : <td className="num">{money(s.cdOut[i]!)}</td>}
                <td className="num">{money(s.draws[i]!)}</td>
                <td className="num">{signedMoney(net)}</td>
                <td className="num">{signedMoney(s.cumulative[i]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-foot">Source: /api/runs/{props.runId}/result liquidityStress.scenarios[id={s.id}]. Net is inflow less every outflow and draw; cumulative is the running sum.</p>
    </section>
  );
}

function ParamsCard(props: { b: LiquidityStressResult }) {
  const cd = props.b.cdMaturities !== undefined;
  const dials = props.b.commitmentDials;
  return (
    <section className="card table-card" aria-label="Stress table">
      <div className="card-title">Stress table</div>
      <p className="card-desc">The parameters each ladder ran on. Outflow rates are per month on the pool; wholesale renewal is the share that rolls; the draw rate is the share of undrawn commitments drawn over a year.{cd ? " Certificate of deposit renewal is the share of what matures that rolls over; early withdrawals leave in full." : ""}</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Scenario</th><th scope="col" className="num">Savings pool outflow</th><th scope="col" className="num">Wholesale renewal</th><th scope="col" className="num">Checking pool outflow</th><th scope="col" className="num">Draw rate</th>
              {cd ? <th scope="col" className="num">CD renewal</th> : null}
            </tr>
          </thead>
          <tbody>
            {props.b.scenarios.map((s) => (
              <tr key={s.id}>
                <th scope="row">{LABELS[s.id]}</th>
                <td className="num">{pct(s.params.hysOutflowMonthly)}</td>
                <td className="num">{pct(s.params.wholesaleRenewal)}</td>
                <td className="num">{pct(s.params.nibOutflowMonthly)}</td>
                <td className="num">{pct(s.params.drawRate)}</td>
                {cd ? <td className="num">{s.params.cdRenewal === undefined ? "not stated" : pct(s.params.cdRenewal)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-foot">
        Draws: each month is the undrawn face times the draw rate over twelve, the same in every month of the year.
        {dials === undefined
          ? " The draw rates are the table's."
          : ` The severe row draws the commitment dials' requirement, (U99 - Ubar) x face = ${money(dials.result.bufferRequirement)}, where the face is the ${money(dials.result.undrawn)} undrawn now over (1 - Ubar), ${money(dials.result.face)}: a rate of ${pct(dials.severeDrawRate)} on the undrawn face, in place of the table's ${pct(dials.statedSevereDrawRate)}.`}
        {" "}Source: liquidityStress.scenarios[].params
      </p>
    </section>
  );
}

/** Where the buffer comes from: stated by the setup, or each hqla-stock position at its face less its level's haircut. */
function BufferCard(props: { b: LiquidityStressResult }) {
  const d = props.b.bufferDerivation;
  const LEVEL = { l1: "Level 1", l2a: "Level 2A", l2b: "Level 2B" } as const;
  return (
    <section className="card table-card" aria-label="The buffer">
      <div className="card-title">The buffer</div>
      {d === undefined ? (
        <p className="card-desc">The setup states the buffer, {money(props.b.buffer)}. Turn on "Buffer from the HQLA tags" in the setup to read it from the positions tagged hqla-stock instead.</p>
      ) : (
        <>
          <p className="card-desc">Read from the positions tagged hqla-stock: each at its face less its level's haircut (Level 1 none, Level 2A 15 percent, Level 2B 50 percent). The buffer is {money(d.total)}.</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Position</th><th scope="col">Family</th><th scope="col">Level</th><th scope="col" className="num">Face</th><th scope="col" className="num">Haircut</th><th scope="col" className="num">Counted</th></tr></thead>
              <tbody>
                {d.positions.map((x) => (
                  <tr key={x.positionId}>
                    <th scope="row" className="mono">{x.positionId}</th>
                    <td className="mono">{x.familyId}</td>
                    <td>{LEVEL[x.level]}</td>
                    <td className="num">{money(x.notional)}</td>
                    <td className="num">{pct(x.haircut)}</td>
                    <td className="num">{money(x.counted)}</td>
                  </tr>
                ))}
                {d.notCounted.map((x) => (
                  <tr key={x.positionId}>
                    <th scope="row" className="mono">{x.positionId}</th>
                    <td className="mono">{x.familyId}</td>
                    <td>not counted: {x.reason}</td>
                    <td className="num">{money(x.notional)}</td>
                    <td className="num"></td>
                    <td className="num">{money(0)}</td>
                  </tr>
                ))}
                <tr><th scope="row">Buffer</th><td></td><td></td><td></td><td></td><td className="num">{money(d.total)}</td></tr>
              </tbody>
            </table>
          </div>
          {d.notCounted.some((x) => x.reason.startsWith("no "))
            ? <p className="card-desc" role="note">{d.notCounted.filter((x) => x.reason.startsWith("no ")).length} positions tagged hqla-stock carry no HQLA level, so they count for nothing. On Quillfield Bank, import version 1.3 again (a fresh store holds it): it tags every buffer asset with its level.</p>
            : null}
          <p className="card-foot">Faces are the as-of balances, not market values. The regulatory caps on Level 2 assets (40 percent of the stock, 15 percent for Level 2B) are not applied. Source: liquidityStress.bufferDerivation</p>
        </>
      )}
    </section>
  );
}

export function LiquidityTab(p: TabProps) {
  const b = blockOf(p.result, "liquidityStress");
  if (b === undefined) {
    return <NotInRun title="Liquidity" reason="This run did not opt in to the liquidity stress block, so no stress ladder was computed. Turn on the liquidity stress table in the run setup." />;
  }
  return (
    <>
      <SummaryCard b={b} />
      <ChartCard b={b} />
      <BufferCard b={b} />
      {b.scenarios.map((s) => <LadderCard key={s.id} s={s} runId={p.runId} />)}
      <ParamsCard b={b} />
      <div className="export-bar"><a className="btn btn-quiet" href={exportCsvUrl(p.runId, "liquidity-stress")} download>Export liquidity-stress.csv</a></div>
      <SurvivalPathSection block={b} runId={p.runId} />
    </>
  );
}
