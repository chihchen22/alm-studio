// apps/studio/src/pages/results/SegTab.tsx
/**
 * SEG / EBP tab: the seg block as stored. The bank SEG series is signed positive when the balance
 * sheet is liability-sensitive; the book and family series are signed by side, assets positive. The one selection
 * made here is the peak: the largest absolute bank value and its month (results/readouts).
 */
import type { SegResult } from "@alm/engine";
import { LinePlot } from "../../charts/LinePlot";
import { monthTicks, type Point } from "../../charts/plotScale";
import { money, moneyTick, signedMoney } from "../../format/figures";
import { bankSegPeak } from "../../results/readouts";
import { blockOf, NotInRun, type TabProps } from "./common";

const monthLabel = (m: number): string => `M${m}`;

function ConventionCard(props: { seg: SegResult; runId: string }) {
  const s = props.seg;
  return (
    <section className="card" aria-label="SEG convention">
      <div className="card-title">Convention</div>
      <p className="card-desc">
        Constant balance sheet: the existing book plus replacement vintages for runoff, so the balance sheet stays constant. The shock starts at
        step 1, so month 1 is unshocked. SEG and EBP use a {s.shockBp}bp shock over {s.horizonMonths} months; NII uses a {s.niiShockBp}bp
        shock over {s.niiHorizonMonths} months. The bank series reads positive when the balance sheet is liability-sensitive; the book and
        family series are signed by side, assets positive.
      </p>
      <p className="card-foot">Source: /api/runs/{props.runId}/result seg, computed on scenario {s.scenarioId}</p>
    </section>
  );
}

function BankCard(props: { seg: SegResult }) {
  const peak = bankSegPeak(props.seg.segBank);
  const points = props.seg.segBank.map((v, i): Point => [i + 1, v]);
  return (
    <figure className="card viz" aria-label="Bank SEG">
      <div className="viz-head"><div className="card-title">Bank SEG, outstanding</div></div>
      {peak === null ? <p className="unobs-text">The seg block stores no bank series.</p> : (
        <>
          <dl className="kv">
            <dt>Peak</dt><dd className="num" title="seg.segBank, largest absolute value">{signedMoney(peak.value)}</dd>
            <dt>At</dt><dd>month {peak.month} (index {peak.index})</dd>
            <dt>Sign</dt><dd>{peak.value >= 0 ? "liability-sensitive" : "asset-sensitive"}</dd>
          </dl>
          <LinePlot
            series={[{ id: "bank", label: "Bank SEG", points, tone: "accent" }]}
            xScale="linear" xTicks={monthTicks} xLabel={monthLabel} yTick={moneyTick} zoom
            unit="USD, positive is liability-sensitive" format={signedMoney}
          />
        </>
      )}
      <figcaption className="card-foot">Source: seg.segBank. Index i is month i + 1; positive means liability-sensitive.</figcaption>
    </figure>
  );
}

function BookCard(props: { seg: SegResult }) {
  const b = props.seg.book;
  return (
    <figure className="card viz" aria-label="Book SEG, outstanding and periodic">
      <div className="viz-head"><div className="card-title">Book SEG, outstanding and periodic</div></div>
      <p className="card-desc">Signed by side: a fixed asset reads positive at t = 0, a fixed liability negative. Periodic is the change in outstanding from the month before.</p>
      <LinePlot
        series={[
          { id: "outstanding", label: "Outstanding", points: b.segOutstanding.map((v, t): Point => [t, v]), tone: "accent" },
          { id: "periodic", label: "Periodic", points: b.segPeriodic.map((v, t): Point => [t, v]), tone: "second" },
        ]}
        xScale="linear" xTicks={monthTicks} xLabel={monthLabel} yTick={moneyTick} zoom
        unit="USD, signed by side" format={signedMoney}
      />
      <figcaption className="card-foot">Source: seg.book.segOutstanding and seg.book.segPeriodic, t = 0 to {props.seg.horizonMonths}.</figcaption>
    </figure>
  );
}

function EbpCard(props: { seg: SegResult }) {
  const b = props.seg.book;
  return (
    <figure className="card viz" aria-label="Equivalent balance profile">
      <div className="viz-head"><div className="card-title">Equivalent balance profile</div></div>
      <p className="card-desc">The existing instruments' opening balances averaged over the up and down shocks, no replacement vintages. Unsigned.</p>
      <LinePlot
        series={[
          { id: "assets", label: "Assets", points: b.ebpAssets.map((v, i): Point => [i + 1, v]), tone: "accent" },
          { id: "liabilities", label: "Liabilities", points: b.ebpLiabilities.map((v, i): Point => [i + 1, v]), tone: "second" },
        ]}
        xScale="linear" xTicks={monthTicks} xLabel={monthLabel} yTick={moneyTick} zoom
        unit="USD" format={money}
      />
      <figcaption className="card-foot">Source: seg.book.ebpAssets and seg.book.ebpLiabilities, month t = 1 to {props.seg.horizonMonths}.</figcaption>
    </figure>
  );
}

function NiiCard(props: { seg: SegResult }) {
  const s = props.seg;
  const n = s.book.nii;
  return (
    <section className="card" aria-label="Constant balance NII">
      <div className="card-title">Constant balance NII, {s.niiHorizonMonths} months</div>
      <dl className="kv">
        <dt>Base</dt><dd className="num" title="seg.book.nii.base12">{money(n.base12)}</dd>
        <dt>+{s.niiShockBp}bp, change vs base</dt><dd className="num" title="seg.book.nii.up12">{signedMoney(n.up12 - n.base12)}</dd>
        <dt>−{s.niiShockBp}bp, change vs base</dt><dd className="num" title="seg.book.nii.down12">{signedMoney(n.down12 - n.base12)}</dd>
        <dt>NIM</dt><dd className="num" title="seg.nimPct">{s.nimPct.toFixed(2)}%</dd>
        <dt>Total asset notional</dt><dd className="num" title="seg.totalAssetNotional">{money(s.totalAssetNotional)}</dd>
      </dl>
      <p className="card-foot">Source: seg.book.nii, seg.nimPct. The changes versus base are the stored shocked level less the stored base level.</p>
    </section>
  );
}

function FamilyCard(props: { seg: SegResult }) {
  const rows = Object.entries(props.seg.byFamily);
  return (
    <section className="card table-card" aria-label="SEG by family">
      <div className="card-title">By family</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Family</th><th scope="col" className="num">NII base</th><th scope="col" className="num">+{props.seg.niiShockBp}bp, change</th>
              <th scope="col" className="num">−{props.seg.niiShockBp}bp, change</th><th scope="col" className="num">SEG peak</th><th scope="col" className="num">Peak month</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([family, f]) => (
              <tr key={family}>
                <th scope="row" className="mono">{family}</th>
                <td className="num">{money(f.nii.base12)}</td>
                <td className="num">{signedMoney(f.nii.up12 - f.nii.base12)}</td>
                <td className="num">{signedMoney(f.nii.down12 - f.nii.base12)}</td>
                <td className="num">{signedMoney(f.segPeak.value)}</td>
                <td className="num">{f.segPeak.month}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-foot">Source: seg.byFamily[].nii and .segPeak, signed by side.</p>
    </section>
  );
}

function UncoveredCard(props: { seg: SegResult }) {
  const u = props.seg.uncovered;
  return (
    <section className="card table-card" aria-label="Positions the seg block does not cover">
      <div className="card-title">Not covered</div>
      {u.length === 0 ? <p className="kv-status"><span className="status status-pass">Every position covered</span></p> : (
        <>
          <p className="card-desc">These positions enter no SEG, EBP or NII total here, for the reason beside each.</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Position</th><th scope="col">Reason</th></tr></thead>
              <tbody>{u.map((x) => <tr key={x.positionId}><th scope="row" className="mono">{x.positionId}</th><td>{x.reason}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
      <p className="card-foot">Source: seg.uncovered</p>
    </section>
  );
}

export function SegTab(p: TabProps) {
  const seg = blockOf(p.result, "seg");
  if (seg === undefined) {
    return <NotInRun title="SEG / EBP" reason="This run did not opt in to the seg block, so no SEG, EBP or constant balance NII was computed. Turn on SEG in the run setup." />;
  }
  return (
    <>
      <ConventionCard seg={seg} runId={p.runId} />
      <BankCard seg={seg} />
      <BookCard seg={seg} />
      <EbpCard seg={seg} />
      <NiiCard seg={seg} />
      <FamilyCard seg={seg} />
      <UncoveredCard seg={seg} />
    </>
  );
}
