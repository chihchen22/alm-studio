// apps/studio/src/pages/results/DepositReadouts.tsx
/**
 * Two cards of core Results for the deposit forms, each shown only when the run carries
 * what it reads:
 *
 *  - Life by family (Gap and liquidity): each family's weighted average life on the selected scenario, as stored. A
 *    component decay run restamps its deposits' families on the full runoff and says so in a note, printed here.
 *  - Deposit credits (FTP): the replicating-portfolio credit of each deposit family that carries one, the base
 *    reading, its tranches, and, for a credit read at every scenario, one row per scenario.
 *
 * Every number is a stored engine value (results/depositReadouts.ts); the cards round for display only.
 */
import type { FtpFamilyRow, RunResult } from "@alm/engine";
import { pct } from "@alm/reader";
import { creditRows, fullRunoffNote, scenarioCreditTables, trancheText, walRows } from "../../results/depositReadouts";

const ONE = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const TWO = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/**
 * S3c fix round (L1): credit rates print to four decimals, as the FTP table above prints its rates, so the rate and
 * liquidity parts add to the total as shown on the desk's credits (3.8342% + 0.3016% = 4.1358%). Every figure is the
 * stored one, rounded for display; nothing is derived to force the sum.
 */
const RATE_DP = 4;

/** Life by family on one scenario; nothing when no family carries a stored life there. */
export function FamilyLifeCard(props: { result: RunResult; scenarioId: string; label: string }) {
  const rows = walRows(props.result, props.scenarioId);
  if (rows.length === 0) return null;
  const note = fullRunoffNote(props.result);
  return (
    <section className="card table-card" aria-label="Life by family">
      <div className="card-title">Life by family, {props.label}</div>
      <p className="card-desc">The weighted average life of each family's principal, in years from the cut-off date: each dollar weighted by the month it is paid.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Family</th><th scope="col" className="num">Life, years</th><th scope="col" className="num">Life, months</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.familyId}>
                <th scope="row" className="mono">{r.familyId}</th>
                <td className="num" title={String(r.walYears)}>{TWO.format(r.walYears)}</td>
                <td className="num">{ONE.format(r.walYears * 12)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note !== null ? <p className="card-desc" role="note">{note}</p> : <p className="card-desc" role="note">Each life counts the principal paid inside the run's grid only.</p>}
      <p className="card-foot">Source: cashflows.byScenario[{props.scenarioId}].byFamily[].walYears</p>
    </section>
  );
}

/** The deposit credits of an FTP block; nothing when no family carries one. */
export function DepositCreditsCard(props: { byFamily: readonly FtpFamilyRow[]; scenarioLabel: (id: string) => string }) {
  const rows = creditRows(props.byFamily);
  if (rows.length === 0) return null;
  const tables = scenarioCreditTables(props.byFamily);
  return (
    <section className="card table-card" aria-label="Deposit credits">
      <div className="card-title">Deposit credits</div>
      <p className="card-desc">
        A deposit's credit is the rate a portfolio of fixed-rate bullets earns when its life matches the deposit's, plus the term liquidity premium at that life.
        The share that reprices with the market (the beta) rolls overnight.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr>
            <th scope="col">Family</th><th scope="col">Life from</th><th scope="col" className="num">Life, months</th><th scope="col" className="num">Beta</th>
            <th scope="col">Portfolio</th><th scope="col" className="num">Rate credit</th><th scope="col" className="num">Liquidity credit</th><th scope="col" className="num">Total credit</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.familyId}-${r.positionId}`}>
                <th scope="row" className="mono">{r.familyId}</th>
                <td>{r.lifeSource}, {r.construction}</td>
                <td className="num" title={String(r.lifeMonths)}>{ONE.format(r.lifeMonths)}</td>
                <td className="num" title={String(r.beta)}>{TWO.format(r.beta)}</td>
                <td>{r.tranches.map(trancheText).join("; ")}</td>
                <td className="num" title={String(r.rateCredit)}>{pct(r.rateCredit, RATE_DP)}</td>
                <td className="num" title={String(r.liquidityCredit)}>{pct(r.liquidityCredit, RATE_DP)}</td>
                <td className="num" title={String(r.totalCredit)}>{pct(r.totalCredit, RATE_DP)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tables.map((t) => (
        <div className="table-wrap" key={t.familyId}>
          <table className="table" aria-label={`Credit by scenario, ${t.familyId}`}>
            <caption className="card-desc">
              {t.familyId} at every scenario, {t.scenarioCurve === "shift" ? "each re-priced on its own shifted curve" : "the curve held at the base, only the deposit moving"}
            </caption>
            <thead><tr>
              <th scope="col">Scenario</th><th scope="col" className="num">Life, months</th><th scope="col" className="num">Beta</th>
              <th scope="col" className="num">Rate credit</th><th scope="col" className="num">Liquidity credit</th><th scope="col" className="num">Total credit</th>
            </tr></thead>
            <tbody>
              {t.rows.map((s) => (
                <tr key={s.scenarioId}>
                  <th scope="row">{props.scenarioLabel(s.scenarioId)}</th>
                  <td className="num" title={String(s.lifeMonths)}>{ONE.format(s.lifeMonths)}</td>
                  <td className="num" title={String(s.beta)}>{TWO.format(s.beta)}</td>
                  <td className="num" title={String(s.rateCredit)}>{pct(s.rateCredit, RATE_DP)}</td>
                  <td className="num" title={String(s.liquidityCredit)}>{pct(s.liquidityCredit, RATE_DP)}</td>
                  <td className="num" title={String(s.totalCredit)}>{pct(s.totalCredit, RATE_DP)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="card-desc" role="note">The family's IR, liquidity and all-in rates in the table above are these credits on the base scenario. The FTP series itself stays on the base scenario. Rates print to four decimals; a part and the total can still differ in the last digit by rounding.</p>
      <p className="card-foot">Source: ftp.byFamily[].replicatingPortfolio and ftp.byFamily[].scenarioCredit</p>
    </section>
  );
}
