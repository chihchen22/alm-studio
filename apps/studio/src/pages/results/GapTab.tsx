// apps/studio/src/pages/results/GapTab.tsx
/**
 * Gap tab (Studio S3a): the repricing and liquidity ladders of the selected
 * scenario as stored, including the engine's cumulative gap. The bars are
 * the stored assets and liabilities per band; nothing is summed here.
 * Slice three (spec decisions 107, 108, 113): a ladder that carries
 * `userBuckets` shows the run's own buckets first and the nine standard bands
 * second; each ladder decides for itself.
 * Slice 4a (spec rulings 2 and 6, Amendment A1): a liquidity ladder that
 * carries `withInterest` gets a second card, the interest-inclusive ladder,
 * with its own buckets, the payment-date and swap sentences and a CSV of its
 * rows. A ladder
 * without it shows nothing new.
 * Amendment A2: that card switches between three views on the `liqview` hash
 * key, Principal (the outstanding gap of the card above), Interest (income,
 * expense and net, `withInterest.interest`) and Total (`withInterest.rows`),
 * Total by default; its CSV carries the total and the interest columns.
 * Teaching slice A4: a bucketed ladder links to its server CSV (every
 * scenario, full precision), and a stored `withInterest` without `interest`
 * (an envelope from before Amendment A2) no longer blanks the tab: the
 * Interest view says so and the CSV leaves the interest columns blank.
 * A run that carries gap.fixedRate gets one more card,
 * the fixed-rate ladder, in the same table as the next-reset ladder, so the
 * two questions of the ALCO view sit side by side. A run without it
 * shows nothing new.
 * A Life by family card, each family's stored weighted average life on the selected scenario.
 */
import type { FixedRateLadder, GapLadder, NextResetLadder } from "@alm/engine";
import { exportCsvUrl, signedMM, usdMM } from "@alm/reader";
import { useEffect, useRef, useState } from "react";
import { BarPairs } from "../../charts/BarPairs";
import { FamilyLifeCard } from "./DepositReadouts";
import { LinePlot } from "../../charts/LinePlot";
import { monthTicks, type Point } from "../../charts/plotScale";
import { moneyTick } from "../../format/figures";
import { blockOf, NotInRun, ScenarioPicker, selectedScenario, type TabProps } from "./common";
import { downloadCsv } from "./NiiMonthlyCard";
import { setHashParam } from "./niiWindow";

type GapRow = GapLadder["rows"][number];
type UserBuckets = NonNullable<GapLadder["userBuckets"]>;
type WithInterest = NonNullable<GapLadder["withInterest"]>;
/** As stored: an envelope written before the interest view may carry withInterest without `interest`. */
type StoredWithInterest = Omit<WithInterest, "interest"> & { interest?: WithInterest["interest"] };

/** Rows a page of the monthly bucket table shows: two years of months, so 360 months is 15 pages. */
export const GAP_PAGE_SIZE = 24;

/** The page `page` (0-based, clamped) of `n` rows: its first and last row, 1-based, and the page count. */
export function gapPage(n: number, page: number, size = GAP_PAGE_SIZE): { page: number; pages: number; from: number; to: number } {
  const pages = Math.max(1, Math.ceil(n / size));
  const at = Math.min(Math.max(0, page), pages - 1);
  return { page: at, pages, from: n === 0 ? 0 : at * size + 1, to: Math.min(n, (at + 1) * size) };
}

/** The four column heads of a gap table; the interest view of the slice 4a card names its own (Amendment A2). */
interface GapCols { a: string; b: string; gap: string; cum: string; line: string }
const GAP_COLS: GapCols = { a: "Assets", b: "Liabilities", gap: "Gap", cum: "Cumulative (engine)", line: "Cumulative gap" };
const INTEREST_COLS: GapCols = { a: "Interest income", b: "Interest expense", gap: "Net interest", cum: "Cumulative net (engine)", line: "Cumulative net interest" };

/** Assets, liabilities, the stored gap and the stored cumulative gap, one row per bucket. */
function GapRowsTable(props: { rows: GapRow[]; catLabel: string; cols?: GapCols }) {
  const c = props.cols ?? GAP_COLS;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th scope="col">{props.catLabel}</th><th scope="col" className="num">{c.a}</th><th scope="col" className="num">{c.b}</th><th scope="col" className="num">{c.gap}</th><th scope="col" className="num">{c.cum}</th></tr></thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.band.label}>
              <th scope="row">{r.band.label}</th>
              <td className="num">{usdMM(r.assets)}</td>
              <td className="num">{usdMM(r.liabilities)}</td>
              <td className="num">{signedMM(r.gap)}</td>
              <td className="num">{signedMM(r.cumulativeGap)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One page of the monthly bucket rows with Prev and Next; the page lives in the caller. `name` names the ladder in
 * each button's accessible name ("Prev, repricing months"). A click that reaches the first or last page disables the
 * button it came from, so focus moves to the other one once the new page has rendered.
 */
export function MonthlyPagedTable(props: { rows: GapRow[]; page: number; name: string; onPage(page: number): void; cols?: GapCols }) {
  const at = gapPage(props.rows.length, props.page);
  const prev = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const refocus = useRef<"prev" | "next" | null>(null);
  useEffect(() => {
    const to = refocus.current;
    refocus.current = null;
    if (to !== null) (to === "prev" ? prev : next).current?.focus();
  });
  const go = (page: number) => {
    if (page === 0) refocus.current = "next";
    else if (page === at.pages - 1) refocus.current = "prev";
    props.onPage(page);
  };
  return (
    <>
      <GapRowsTable rows={props.rows.slice(at.from === 0 ? 0 : at.from - 1, at.to)} catLabel="Month" cols={props.cols} />
      <div className="table-foot table-pager">
        <span className="num" aria-live="polite">Rows {at.from} to {at.to} of {props.rows.length}</span>
        <span className="pager">
          <button ref={prev} type="button" className="btn btn-quiet" aria-label={`Prev, ${props.name}`} disabled={at.page === 0} onClick={() => go(at.page - 1)}>Prev</button>
          <button ref={next} type="button" className="btn btn-quiet" aria-label={`Next, ${props.name}`} disabled={at.page === at.pages - 1} onClick={() => go(at.page + 1)}>Next</button>
        </span>
      </div>
    </>
  );
}

/**
 * The run's own buckets: monthly as a line of cumulative gap and a paged table, custom as bars and a table. `name`
 * names the pager ("liquidity months"), so two monthly blocks on one page keep their buttons apart.
 */
function UserBucketsBlock(props: { user: UserBuckets; name: string; cols?: GapCols }) {
  const { user } = props;
  const c = props.cols ?? GAP_COLS;
  const [page, setPage] = useState(0);
  if (user.kind === "custom") {
    return (
      <>
        <h3 className="viz-title">Custom buckets</h3>
        {user.edgesMonths === undefined ? null : <p className="card-desc">The run&apos;s own bucket edges, in months: {user.edgesMonths.join(", ")}.</p>}
        <BarPairs rows={user.rows.map((r) => ({ label: r.band.label, a: r.assets, b: r.liabilities }))} aLabel={c.a} bLabel={c.b} unit="USD by bucket" catLabel="Bucket" />
        <GapRowsTable rows={user.rows} catLabel="Bucket" cols={props.cols} />
      </>
    );
  }
  return (
    <>
      <h3 className="viz-title">Monthly buckets</h3>
      <p className="card-desc">Cumulative gap at the end of each month, then every month&apos;s row, {GAP_PAGE_SIZE} rows a page.</p>
      {/* Bucket k is calendar month k + 1, so the line plots each row at its end month. Signed values: no area. */}
      <LinePlot
        series={[{ id: "cumulative", label: c.line, tone: "accent", points: user.rows.map((r): Point => [r.band.endMonth, r.cumulativeGap]) }]}
        xScale="linear"
        xTicks={monthTicks}
        xLabel={(m) => `M${m}`}
        yTick={moneyTick}
        zoom
        unit="USD at month end"
        format={signedMM}
        table={false}
      />
      <MonthlyPagedTable rows={user.rows} page={page} name={props.name} onPage={setPage} cols={props.cols} />
    </>
  );
}

/** Decision 113's sentence, printed once at page level when neither ladder carries userBuckets. */
export const NINE_BANDS_ONLY = "This run stores the nine standard bands only.";
/** The ladder-scoped sentence for a card without userBuckets beside a ladder that carries them. */
export const nineBandsOnlyFor = (kind: "repricing" | "liquidity") => `This run stores the ${kind} gap in the nine standard bands only.`;

/** `scopedNote`: the other ladder carries userBuckets, so this one, without them, says so for itself. */
function LadderCard(props: { kind: "repricing" | "liquidity"; ladder: GapLadder | undefined; runId: string; scenarioId: string; label: string; scopedNote: boolean }) {
  const title = props.kind === "repricing" ? "Repricing gap" : "Liquidity gap";
  const l = props.ladder;
  if (l === undefined) return <NotInRun title={title} reason={`gap.${props.kind} has no ladder for scenario ${props.scenarioId}.`} />;
  const at = `gap.${props.kind}[scenarioId=${props.scenarioId}]`;
  const user = l.userBuckets;
  return (
    <figure className="card viz" aria-label={title}>
      <div className="viz-head"><div className="card-title">{title}, {props.label}</div></div>
      {user !== undefined ? <UserBucketsBlock key={props.scenarioId} user={user} name={`${props.kind} months`} /> : props.scopedNote ? <p className="card-desc" role="note">{nineBandsOnlyFor(props.kind)}</p> : null}
      {user === undefined ? null : (
        <p className="card-desc">
          <a className="btn btn-quiet" href={exportCsvUrl(props.runId, `${props.kind}-gap-buckets`)} download>Export {props.kind}-gap-buckets.csv</a>
          {" "}The CSV carries the {user.kind} buckets of every scenario, every figure at full precision.
        </p>
      )}
      {user === undefined ? null : <h3 className="viz-title">Nine standard bands</h3>}
      <BarPairs rows={l.rows.map((r) => ({ label: r.band.label, a: r.assets, b: r.liabilities }))} aLabel="Assets" bLabel="Liabilities" unit="USD by band" catLabel="Band" />
      <GapRowsTable rows={l.rows} catLabel="Band" />
      <figcaption className="card-foot">
        {user === undefined
          ? `Source: ${at}.rows. Gap and cumulative gap are the stored fields.`
          : `Source: ${at}.userBuckets.rows (kind ${user.kind}) for the ${user.kind} buckets and ${at}.rows for the nine standard bands. Gap and cumulative gap are the stored fields.`}
      </figcaption>
    </figure>
  );
}

export const WITH_INTEREST_TITLE = "Liquidity gap with interest";
/** Spec Amendment A1: interest lands on its payment date; credited deposit interest monthly, CD interest with principal. */
export const INTEREST_TIMING_NOTE =
  "Interest counts on its payment date: credited deposit interest counts as paid monthly, and CD interest is paid with principal.";
/** Spec ruling 6: the swap's signed net settlement bands into assets on this ladder only. */
export const SWAP_SETTLEMENT_NOTE = "Net swap settlement is included here, not in the principal ladder.";

/** RFC 4180 cell; String() keeps full float precision, no rounding. */
const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The interest-inclusive ladder of one scenario as CSV: the nine standard bands (`buckets` standard), then the run's
 * own buckets when stored (`buckets` monthly or custom). Each line carries the total (principal plus interest) row,
 * then the interest row of the same band (Amendment A2): income, expense, net and cumulative net. Every number is the
 * stored one. A total row and an interest row on different bands are refused rather than paired by position. A ladder
 * stored with no interest rows at all (slice A4 guard) leaves the four interest cells blank, never 0.
 */
export function withInterestCsv(scenarioId: string, w: StoredWithInterest): string {
  const lines = ["scenarioId,buckets,band,startMonth,endMonth,assets,liabilities,gap,cumulativeGap,interestIncome,interestExpense,netInterest,cumulativeNetInterest"];
  const add = (buckets: string, rows: GapRow[], interest: GapRow[] | undefined) => {
    if (w.interest === undefined) {
      for (const r of rows) {
        lines.push([scenarioId, buckets, r.band.label, r.band.startMonth, r.band.endMonth, r.assets, r.liabilities, r.gap, r.cumulativeGap].map(csvCell).join(",") + ",,,,");
      }
      return;
    }
    if (interest === undefined || interest.length !== rows.length) {
      throw new Error(`withInterestCsv: the ${buckets} interest rows do not match the ${buckets} total rows`);
    }
    rows.forEach((r, b) => {
      const i = interest[b]!;
      if (i.band.label !== r.band.label || i.band.startMonth !== r.band.startMonth || i.band.endMonth !== r.band.endMonth) {
        throw new Error(`withInterestCsv: interest band ${i.band.label} does not match total band ${r.band.label}`);
      }
      lines.push(
        [scenarioId, buckets, r.band.label, r.band.startMonth, r.band.endMonth, r.assets, r.liabilities, r.gap, r.cumulativeGap, i.assets, i.liabilities, i.gap, i.cumulativeGap]
          .map(csvCell)
          .join(","),
      );
    });
  };
  add("standard", w.rows, w.interest?.rows);
  if (w.userBuckets !== undefined) add(w.userBuckets.kind, w.userBuckets.rows, w.interest?.userBuckets?.rows);
  return lines.join("\n") + "\n";
}

/** Amendment A2: the three views of the slice 4a card, on the `liqview` hash key; Total by default. */
export const LIQ_VIEW_KEY = "liqview";
export const LIQ_VIEWS = [
  { id: "principal", label: "Principal" },
  { id: "interest", label: "Interest" },
  { id: "total", label: "Total" },
] as const;
type LiqView = (typeof LIQ_VIEWS)[number]["id"];
const liqViewOf = (query: Record<string, string>): LiqView => LIQ_VIEWS.find((v) => v.id === query[LIQ_VIEW_KEY])?.id ?? "total";

/**
 * The second view of the liquidity ladder. Amendment A2: three views of the same run-off on one card,
 * Principal (the principal ladder of the card above: the outstanding gap), Interest (`withInterest.interest`: income,
 * expense and net) and Total (`withInterest.rows`), switched on the `liqview` hash key.
 */
/** Slice A4 guard: the Interest view of a stored withInterest that carries no interest rows. */
export const NO_INTEREST_ROWS =
  "This run stores the interest-inclusive ladder without its interest rows (withInterest.interest is absent), so the Interest view has nothing to show. Principal and Total read as stored.";

function WithInterestCard(props: { ladder: GapLadder; w: StoredWithInterest; view: LiqView; runId: string; scenarioId: string; label: string }) {
  const { ladder, w, view } = props;
  const base = `gap.liquidity[scenarioId=${props.scenarioId}]`;
  const missing = view === "interest" && w.interest === undefined;
  const shown =
    view === "principal"
      ? { rows: ladder.rows, user: ladder.userBuckets, at: base, cols: GAP_COLS, tail: ", the outstanding gap", stored: "Gap and cumulative gap" }
      : view === "interest" && w.interest !== undefined
        ? { rows: w.interest.rows, user: w.interest.userBuckets, at: `${base}.withInterest.interest`, cols: INTEREST_COLS, tail: "", stored: "Net and cumulative net" }
        : { rows: w.rows, user: w.userBuckets, at: `${base}.withInterest`, cols: GAP_COLS, tail: "", stored: "Gap and cumulative gap" };
  const { user, at } = shown;
  return (
    <figure className="card viz" aria-label={WITH_INTEREST_TITLE}>
      <div className="viz-head"><div className="card-title">{WITH_INTEREST_TITLE}, {props.label}</div></div>
      <p className="card-desc" role="note">Three views of the same run-off: Principal is the outstanding gap of the liquidity card above, Interest is the contractual interest cash flow on its own (income in assets, expense in liabilities, net as the gap), and Total is the two together, band by band. {INTEREST_TIMING_NOTE} {SWAP_SETTLEMENT_NOTE}</p>
      <nav className="chip-row" aria-label="Liquidity with interest view">
        {LIQ_VIEWS.map((v) => (
          <button key={v.id} type="button" className="pill" aria-pressed={view === v.id} onClick={() => setHashParam(LIQ_VIEW_KEY, v.id === "total" ? null : v.id)}>{v.label}</button>
        ))}
      </nav>
      {missing ? <p className="card-desc" role="note">{NO_INTEREST_ROWS}</p> : (
        <>
          {user !== undefined ? <UserBucketsBlock key={`${props.scenarioId}-${view}`} user={user} name="liquidity with interest months" cols={shown.cols} /> : null}
          {user === undefined ? null : <h3 className="viz-title">Nine standard bands</h3>}
          <BarPairs rows={shown.rows.map((r) => ({ label: r.band.label, a: r.assets, b: r.liabilities }))} aLabel={shown.cols.a} bLabel={shown.cols.b} unit="USD by band" catLabel="Band" />
          <GapRowsTable rows={shown.rows} catLabel="Band" cols={shown.cols} />
        </>
      )}
      <p className="card-desc">
        <button type="button" className="pill" onClick={() => downloadCsv(`liquidity-gap-interest-${props.runId}-${props.scenarioId}.csv`, withInterestCsv(props.scenarioId, w))}>Download CSV</button>
        {" "}The CSV carries the nine standard bands{w.userBuckets === undefined ? "" : ` and the ${w.userBuckets.kind} buckets`}, the total and the interest on its own, every figure as stored.
      </p>
      <figcaption className="card-foot">
        {missing
          ? `Source: ${base}.withInterest, which carries no interest field.`
          : user === undefined
          ? `Source: ${at}.rows${shown.tail}. ${shown.stored} are the stored fields.`
          : `Source: ${at}.userBuckets.rows (kind ${user.kind}) for the ${user.kind} buckets and ${at}.rows for the nine standard bands${shown.tail}. ${shown.stored} are the stored fields.`}
      </figcaption>
    </figure>
  );
}

const NEXT_RESET_TITLE = "Next reset or maturity (ALCO convention)";

/**
 * The next-reset ALCO ladder, one per run on the base scenario. A floater sits at
 * its first reset, a fixed instrument at its maturity, and deposit core is held out; every figure is the stored one.
 */
/** The band table the next-reset and fixed-rate cards share: every figure is the stored one. */
function BandTable(props: { rows: NextResetLadder["rows"] }) {
  return (
    <>
      <BarPairs rows={props.rows.map((r) => ({ label: r.band, a: r.assets, b: r.liabilities }))} aLabel="Assets" bLabel="Liabilities" unit="USD by band" catLabel="Band" />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Band</th><th scope="col" className="num">Assets</th><th scope="col" className="num">Liabilities</th><th scope="col" className="num">Gap</th><th scope="col" className="num">Cumulative (engine)</th></tr></thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.band}>
                <th scope="row">{r.band}</th>
                <td className="num">{usdMM(r.assets)}</td>
                <td className="num">{usdMM(r.liabilities)}</td>
                <td className="num">{signedMM(r.gap)}</td>
                <td className="num">{signedMM(r.cumulativeGap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NextResetCard(props: { ladder: NextResetLadder | undefined }) {
  const l = props.ladder;
  if (l === undefined) {
    return <NotInRun title={NEXT_RESET_TITLE} reason="gap.nextReset is absent: the run did not opt in to the next-reset ladder (setup Gap, Next reset or maturity ladder)." />;
  }
  return (
    <figure className="card viz" aria-label={NEXT_RESET_TITLE}>
      <div className="viz-head"><div className="card-title">{NEXT_RESET_TITLE}, base scenario</div></div>
      <BandTable rows={l.rows} />
      <p className="card-desc">Core deposits held out of the ladder: {usdMM(l.coreExcluded)}.</p>
      {l.uncovered.length > 0 ? (
        <ul className="card-desc" aria-label="Positions the next-reset ladder does not place">
          {l.uncovered.map((u) => (
            <li key={u.positionId}><span className="mono">{u.positionId}</span>: {u.reason}</li>
          ))}
        </ul>
      ) : null}
      <figcaption className="card-foot">Source: gap.nextReset.rows, coreExcluded and uncovered. A floater sits at its first reset, a fixed instrument at its maturity with no amortisation, an interest-bearing deposit&apos;s beta slice in 0-1M.</figcaption>
    </figure>
  );
}

const FIXED_RATE_TITLE = "Fixed-rate gap (rate-locked principal by payment month)";

/**
 * The fixed-rate ladder (the rate-locked half of the ALCO view), one per run on the base scenario.
 * Each rate-locked position's principal sits in the band of the month it is paid; the last band is open.
 */
function FixedRateCard(props: { ladder: FixedRateLadder }) {
  const l = props.ladder;
  return (
    <figure className="card viz" aria-label={FIXED_RATE_TITLE}>
      <div className="viz-head"><div className="card-title">{FIXED_RATE_TITLE}, scenario {l.scenarioId}</div></div>
      <BandTable rows={l.rows} />
      {l.uncovered.length > 0 ? (
        <ul className="card-desc" aria-label="Positions the fixed-rate ladder does not place">
          {l.uncovered.map((u) => (
            <li key={u.positionId}><span className="mono">{u.positionId}</span>: {u.reason}</li>
          ))}
        </ul>
      ) : null}
      <figcaption className="card-foot">Source: gap.fixedRate.rows and uncovered. Fixed loans, mortgages, CDs and deposit slices held at a fixed rate, by payment month on the base path; floaters and managed-rate deposits are not rate-locked and are left out.</figcaption>
    </figure>
  );
}

export function GapTab(p: TabProps) {
  const gap = blockOf(p.result, "gap");
  if (gap === undefined) return <NotInRun title="Gap" reason="The envelope carries no gap block." />;
  const ids: string[] = [];
  for (const l of [...gap.repricing, ...gap.liquidity]) if (!ids.includes(l.scenarioId)) ids.push(l.scenarioId);
  const sel = selectedScenario(ids, p.query);
  if (sel === null) return <NotInRun title="Gap" reason="The gap block carries no ladder for any scenario." />;
  const rep = gap.repricing.find((l) => l.scenarioId === sel);
  const liq = gap.liquidity.find((l) => l.scenarioId === sel);
  // Decision 113's sentence is about the run, so it prints once, and only when neither ladder carries userBuckets;
  // beside a bucketed ladder, the other card says it for itself.
  const anyUser = rep?.userBuckets !== undefined || liq?.userBuckets !== undefined;
  return (
    <>
      <ScenarioPicker ws={p.ws} ids={ids} selected={sel} query={p.query} label={p.scenarioLabel} />
      {anyUser ? null : <p className="card-desc" role="note">{NINE_BANDS_ONLY}</p>}
      <LadderCard kind="repricing" ladder={rep} runId={p.runId} scenarioId={sel} label={p.scenarioLabel(sel)} scopedNote={anyUser} />
      <LadderCard kind="liquidity" ladder={liq} runId={p.runId} scenarioId={sel} label={p.scenarioLabel(sel)} scopedNote={anyUser} />
      {liq?.withInterest === undefined ? null : <WithInterestCard ladder={liq} w={liq.withInterest} view={liqViewOf(p.query)} runId={p.runId} scenarioId={sel} label={p.scenarioLabel(sel)} />}
      <NextResetCard ladder={gap.nextReset} />
      {gap.fixedRate === undefined ? null : <FixedRateCard ladder={gap.fixedRate} />}
      {/* Each family's life on this scenario, the full runoff where the engine reads it. */}
      <FamilyLifeCard result={p.result} scenarioId={sel} label={p.scenarioLabel(sel)} />
    </>
  );
}
