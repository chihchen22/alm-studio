/**
 * CSV export from a stored RunResult. Rules:
 *
 *  - No recompute, no rounding: every cell is the verbatim envelope value,
 *    numbers rendered by String() at full float precision (rounding is a
 *    computation and belongs to the practitioner's spreadsheet).
 *  - Every CSV opens with comment rows carrying runId, inputsHash, the curve
 *    line (the curve the run built on, export/curveLine.ts),
 *    schemaVersion, engineVersion, and the generation timestamp, so a pasted
 *    table stays traceable to its run.
 *  - The comparison CSV's delta columns are the ONE permitted result-plane
 *    arithmetic: B - A, always beside both originals, labeled "derived".
 *    A delta cell is blank unless both sides carry a number.
 *  - Teaching build slice A4 adds four tables: the run's own gap buckets
 *    (monthly or custom), the interest-inclusive liquidity ladder and FTP.
 *    Each says in a note row that its values are at full precision; the six
 *    older tables keep their bytes and carry no note row. A table the run
 *    does not store is refused by name (tableRefusal), never written empty.
 */
import type { RunResult } from "@alm/engine";
import type { RunCurveLine } from "./curveLine";

export const EXPORT_TABLES = [
  "nii",
  "eve",
  "repricing-gap",
  "liquidity-gap",
  "attribution",
  "cashflows",
  "repricing-gap-buckets",
  "liquidity-gap-buckets",
  "liquidity-gap-interest",
  "ftp",
  // The stress ladder and the survival path. Compare does not align them yet.
  "liquidity-stress",
  "survival-path",
] as const;

/** The tables the compare routes refuse, with the reason. */
export const NOT_COMPARED: Readonly<Partial<Record<ExportTable, string>>> = {
  "liquidity-stress": "the stress ladder is not compared across runs yet; export liquidity-stress.csv from each run",
  "survival-path": "the survival path is not compared across runs yet; export survival-path.csv from each run",
};
export type ExportTable = (typeof EXPORT_TABLES)[number];

export function isExportTable(x: string): x is ExportTable {
  return (EXPORT_TABLES as readonly string[]).includes(x);
}

export type Cell = string | number | boolean | null | undefined;

interface ColumnSpec {
  name: string;
  /** key: row identity (join column in compare); num: numeric value column
   * (gets a derived delta in compare); text: non-numeric value column. */
  role: "key" | "num" | "text";
}

export interface CsvTable {
  columns: ColumnSpec[];
  rows: Record<string, Cell>[];
  /** Comment rows after generatedAt, as "# note,<text>"; the six older tables carry none. */
  notes?: string[];
}

/** The note row of every slice A4 table. */
const FULL_PRECISION = "Every value is the stored engine figure at full precision; the screen rounds for display.";

/** Marker for the scenario-level row in per-family tables. */
const SCENARIO_LEVEL = "";

// --- table builders (verbatim envelope reads, stable envelope order) ---------

function niiTable(result: RunResult): CsvTable {
  const columns: ColumnSpec[] = [
    { name: "scenarioId", role: "key" },
    { name: "familyId", role: "key" },
    { name: "interestIncome12", role: "num" },
    { name: "interestExpense12", role: "num" },
    { name: "net12", role: "num" },
    { name: "interestIncome24", role: "num" },
    { name: "interestExpense24", role: "num" },
    { name: "net24", role: "num" },
  ];
  const rows: Record<string, Cell>[] = [];
  for (const scn of result.nii.byScenario) {
    for (const fam of scn.byFamily) {
      rows.push({
        scenarioId: scn.scenarioId,
        familyId: fam.familyId,
        interestIncome12: fam.interestIncome12,
        interestExpense12: fam.interestExpense12,
        net12: fam.net12,
        interestIncome24: fam.interestIncome24,
        interestExpense24: fam.interestExpense24,
        net24: fam.net24,
      });
    }
    rows.push({
      scenarioId: scn.scenarioId,
      familyId: "TOTAL",
      net12: scn.totalNet12,
      net24: scn.totalNet24,
    });
  }
  return { columns, rows };
}

function eveTable(result: RunResult): CsvTable {
  const columns: ColumnSpec[] = [
    { name: "scenarioId", role: "key" },
    { name: "familyId", role: "key" },
    { name: "pv", role: "num" },
    { name: "effectiveDuration", role: "num" },
    { name: "pvAssets", role: "num" },
    { name: "pvLiabilities", role: "num" },
    { name: "eve", role: "num" },
    { name: "deltaEveVsBase", role: "num" },
    { name: "deltaEvePct", role: "num" },
    { name: "effectiveDurationEquity", role: "num" },
    { name: "durationSanityPassed", role: "text" },
  ];
  const rows: Record<string, Cell>[] = [];
  for (const scn of result.eve.byScenario) {
    rows.push({
      scenarioId: scn.scenarioId,
      familyId: SCENARIO_LEVEL,
      pvAssets: scn.pvAssets,
      pvLiabilities: scn.pvLiabilities,
      eve: scn.eve,
      deltaEveVsBase: scn.deltaEveVsBase,
      deltaEvePct: scn.deltaEvePct,
      effectiveDurationEquity: scn.effectiveDurationEquity,
      durationSanityPassed: scn.durationSanityPassed,
    });
    for (const fam of scn.byFamily) {
      rows.push({
        scenarioId: scn.scenarioId,
        familyId: fam.familyId,
        pv: fam.pv,
        effectiveDuration: fam.effectiveDuration,
      });
    }
  }
  return { columns, rows };
}

function gapTable(result: RunResult, kind: "repricing" | "liquidity"): CsvTable {
  const columns: ColumnSpec[] = [
    { name: "scenarioId", role: "key" },
    { name: "coaNodeId", role: "key" },
    { name: "band", role: "key" },
    { name: "startMonth", role: "key" },
    { name: "endMonth", role: "key" },
    { name: "assets", role: "num" },
    { name: "liabilities", role: "num" },
    { name: "gap", role: "num" },
    { name: "cumulativeGap", role: "num" },
  ];
  const rows: Record<string, Cell>[] = [];
  const ladders = kind === "repricing" ? result.gap.repricing : result.gap.liquidity;
  for (const ladder of ladders) {
    for (const row of ladder.rows) {
      rows.push({
        scenarioId: ladder.scenarioId,
        coaNodeId: "",
        band: row.band.label,
        startMonth: row.band.startMonth,
        endMonth: row.band.endMonth,
        assets: row.assets,
        liabilities: row.liabilities,
        gap: row.gap,
        cumulativeGap: row.cumulativeGap,
      });
    }
    for (const node of ladder.byCoaNode) {
      for (const row of node.rows) {
        rows.push({
          scenarioId: ladder.scenarioId,
          coaNodeId: node.coaNodeId,
          band: row.band.label,
          startMonth: row.band.startMonth,
          endMonth: row.band.endMonth,
          assets: row.assets,
          liabilities: row.liabilities,
          gap: row.gap,
          cumulativeGap: row.cumulativeGap,
        });
      }
    }
  }
  return { columns, rows };
}

function attributionTable(result: RunResult): CsvTable {
  const columns: ColumnSpec[] = [
    { name: "metric", role: "key" },
    { name: "scenarioId", role: "key" },
    { name: "rowType", role: "key" },
    { name: "familyId", role: "key" },
    { name: "driver", role: "key" },
    { name: "amount", role: "num" },
    { name: "baseValue", role: "num" },
    { name: "scenarioValue", role: "num" },
    { name: "totalDelta", role: "num" },
    { name: "residual", role: "num" },
  ];
  const rows: Record<string, Cell>[] = [];
  for (const h of result.attribution.headlines) {
    rows.push({
      metric: h.metric,
      scenarioId: h.scenarioId,
      rowType: "headline",
      familyId: "",
      driver: "",
      baseValue: h.baseValue,
      scenarioValue: h.scenarioValue,
      totalDelta: h.totalDelta,
      residual: h.residual,
    });
    for (const c of h.contributions) {
      rows.push({
        metric: h.metric,
        scenarioId: h.scenarioId,
        rowType: "contribution",
        familyId: c.familyId,
        driver: c.driver,
        amount: c.amount,
      });
    }
  }
  return { columns, rows };
}

function cashflowsTable(result: RunResult): CsvTable {
  const columns: ColumnSpec[] = [
    { name: "scenarioId", role: "key" },
    { name: "familyId", role: "key" },
    { name: "monthOffset", role: "key" },
    { name: "balance", role: "num" },
    { name: "principal", role: "num" },
    { name: "interest", role: "num" },
  ];
  const rows: Record<string, Cell>[] = [];
  for (const scn of result.cashflows.byScenario) {
    for (const fam of scn.byFamily) {
      const n = fam.series.balance.length;
      for (let m = 0; m < n; m++) {
        rows.push({
          scenarioId: scn.scenarioId,
          familyId: fam.familyId,
          monthOffset: m,
          balance: fam.series.balance[m],
          principal: fam.series.principal[m],
          interest: fam.series.interest[m],
        });
      }
    }
  }
  return { columns, rows };
}

// --- slice A4 tables -----------------------------------------------------------

type GapLadder = RunResult["gap"]["liquidity"][number];
type GapRow = GapLadder["rows"][number];
type WithInterest = NonNullable<GapLadder["withInterest"]>;
/** As stored: an envelope written before the interest view (Amendment A2) may carry withInterest without `interest`. */
type StoredWithInterest = Omit<WithInterest, "interest"> & { interest?: WithInterest["interest"] };

const BAND_COLS: ColumnSpec[] = [
  { name: "scenarioId", role: "key" },
  { name: "buckets", role: "key" },
  { name: "band", role: "key" },
  { name: "startMonth", role: "key" },
  { name: "endMonth", role: "key" },
  { name: "assets", role: "num" },
  { name: "liabilities", role: "num" },
  { name: "gap", role: "num" },
  { name: "cumulativeGap", role: "num" },
];

const bandRow = (scenarioId: string, buckets: string, r: GapRow): Record<string, Cell> => ({
  scenarioId,
  buckets,
  band: r.band.label,
  startMonth: r.band.startMonth,
  endMonth: r.band.endMonth,
  assets: r.assets,
  liabilities: r.liabilities,
  gap: r.gap,
  cumulativeGap: r.cumulativeGap,
});

/** The run's own bucket rows (monthly or custom), top level only: the engine stores no node arm for them. */
function bucketsTable(result: RunResult, kind: "repricing" | "liquidity"): CsvTable {
  const rows: Record<string, Cell>[] = [];
  for (const ladder of kind === "repricing" ? result.gap.repricing : result.gap.liquidity) {
    const user = ladder.userBuckets;
    if (user !== undefined) for (const r of user.rows) rows.push(bandRow(ladder.scenarioId, user.kind, r));
  }
  return { columns: BAND_COLS, rows, notes: [FULL_PRECISION] };
}

/**
 * The interest-inclusive liquidity ladder, the Studio card's CSV for every scenario: the nine standard bands, then
 * the run's own buckets when stored. Each row is the total (principal plus interest), then the interest of the same
 * band on its own. tableRefusal has already checked that the two line up; with no interest rows stored, those four
 * cells are blank.
 */
function interestTable(result: RunResult): CsvTable {
  const columns: ColumnSpec[] = [
    ...BAND_COLS,
    { name: "interestIncome", role: "num" },
    { name: "interestExpense", role: "num" },
    { name: "netInterest", role: "num" },
    { name: "cumulativeNetInterest", role: "num" },
  ];
  const rows: Record<string, Cell>[] = [];
  for (const ladder of result.gap.liquidity) {
    const w = ladder.withInterest as StoredWithInterest | undefined;
    if (w === undefined) continue;
    const add = (buckets: string, total: GapRow[], interest: GapRow[] | undefined) =>
      total.forEach((r, b) => {
        const i = interest?.[b];
        rows.push({
          ...bandRow(ladder.scenarioId, buckets, r),
          interestIncome: i?.assets,
          interestExpense: i?.liabilities,
          netInterest: i?.gap,
          cumulativeNetInterest: i?.cumulativeGap,
        });
      });
    add("standard", w.rows, w.interest?.rows);
    if (w.userBuckets !== undefined) add(w.userBuckets.kind, w.userBuckets.rows, w.interest?.userBuckets?.rows);
  }
  return { columns, rows, notes: [FULL_PRECISION] };
}

/**
 * The stress ladder as Results, Liquidity shows it: one row per scenario and month, then one summary row per
 * scenario (the rates it ran, its survival and its peak), then the buffer and, when derived, one row per counted
 * hqla-stock position. A term-deposit column is blank on a row that states no renewal. S3d fix round (L2): then the two
 * pools, one row per month of the wholesale and term-deposit series, and the commitment dials when the run set them.
 */
function liquidityStressTable(result: RunResult): CsvTable {
  const num = (name: string): ColumnSpec => ({ name, role: "num" });
  const ls = result.liquidityStress!;
  const columns: ColumnSpec[] = [
    { name: "rowType", role: "key" },
    { name: "scenarioId", role: "key" },
    { name: "month", role: "key" },
    { name: "positionId", role: "key" },
    ...["inflow", "hysOut", "nibOut", "wholesaleOut", "cdOut", "draws", "net", "cumulative"].map(num),
    ...["hysOutflowMonthly", "wholesaleRenewal", "nibOutflowMonthly", "drawRate", "cdRenewal", "survivalMonths", "peakShortfall", "peakMonth"].map(num),
    ...["buffer", "undrawnFace", "notional", "haircut", "counted"].map(num),
    { name: "level", role: "text" },
    ...["wholesaleMaturity", "cdMaturity", "cdEarlyWithdrawal"].map(num),
    ...["undrawnNow", "face", "expectedUtilization", "tailUtilization", "bufferRequirement", "lcrFactor", "lcrReferenceOutflow", "contingentChargeBp", "contingentChargeAnnual", "statedSevereDrawRate", "severeDrawRate"].map(num),
  ];
  const rows: Record<string, Cell>[] = [];
  for (const s of ls.scenarios) {
    for (let m = 0; m < s.net.length; m++) {
      rows.push({
        rowType: "month", scenarioId: s.id, month: m + 1, positionId: "",
        inflow: s.inflow[m], hysOut: s.hysOut[m], nibOut: s.nibOut[m], wholesaleOut: s.wholesaleOut[m], cdOut: s.cdOut?.[m], draws: s.draws[m], net: s.net[m], cumulative: s.cumulative[m],
      });
    }
  }
  for (const s of ls.scenarios) {
    rows.push({
      rowType: "scenario", scenarioId: s.id, month: "", positionId: "",
      ...s.params, survivalMonths: s.survivalMonths, peakShortfall: s.peakShortfall, peakMonth: s.peakMonth,
    });
  }
  rows.push({ rowType: "buffer", scenarioId: "", month: "", positionId: "", buffer: ls.buffer, undrawnFace: ls.undrawnFace });
  for (const p of ls.bufferDerivation?.positions ?? []) {
    rows.push({ rowType: "buffer-position", scenarioId: "", month: "", positionId: p.positionId, notional: p.notional, level: p.level, haircut: p.haircut, counted: p.counted });
  }
  for (const p of ls.bufferDerivation?.notCounted ?? []) {
    rows.push({ rowType: "buffer-not-counted", scenarioId: "", month: "", positionId: p.positionId, notional: p.notional, level: p.reason });
  }
  rows.push({ rowType: "pool", scenarioId: "", month: "", positionId: "hys-pool", notional: ls.pools.hys, level: "savings pool" });
  rows.push({ rowType: "pool", scenarioId: "", month: "", positionId: "nib-pool", notional: ls.pools.nib, level: "checking pool" });
  for (let m = 0; m < ls.wholesaleMaturities.length; m++) {
    rows.push({ rowType: "maturities", scenarioId: "", month: m + 1, positionId: "", wholesaleMaturity: ls.wholesaleMaturities[m], cdMaturity: ls.cdMaturities?.[m], cdEarlyWithdrawal: ls.cdEarlyWithdrawals?.[m] });
  }
  const cd = ls.commitmentDials;
  if (cd !== undefined) {
    rows.push({
      rowType: "dials", scenarioId: "severe", month: "", positionId: "",
      undrawnNow: cd.result.undrawn, face: cd.result.face, expectedUtilization: cd.dials.expectedUtilization, tailUtilization: cd.dials.tailUtilization,
      bufferRequirement: cd.result.bufferRequirement, lcrFactor: cd.dials.lcrFactor, lcrReferenceOutflow: cd.result.lcrReferenceOutflow,
      contingentChargeBp: cd.result.contingentChargeBp, contingentChargeAnnual: cd.result.contingentChargeAnnual,
      statedSevereDrawRate: cd.statedSevereDrawRate, severeDrawRate: cd.severeDrawRate,
    });
  }
  return {
    columns,
    rows,
    notes: [
      FULL_PRECISION,
      "A survivalMonths cell left blank is a buffer never pierced inside the 12 months.",
      "hysOut is the savings pool (positions tagged hys-pool); nibOut is the checking pool (tagged nib-pool, interest checking included when the book puts it there).",
      "cdOut is what matures less the renewal share, plus every early withdrawal; the dials row's face is undrawnNow / (1 - expectedUtilization).",
    ],
  };
}

/**
 * The survival path the run stored, month by month, then one row per reading: against the ladder's buffer, and
 * against the buffer plus the received facility when the run counted one. Days are months x 365 / 12.
 */
function survivalPathTable(result: RunResult): CsvTable {
  const num = (name: string): ColumnSpec => ({ name, role: "num" });
  const sp = result.liquidityStress!.survivalPath!;
  const columns: ColumnSpec[] = [
    { name: "rowType", role: "key" },
    { name: "month", role: "key" },
    { name: "scenarioId", role: "text" },
    ...["days", "inflow", "hysOut", "nibOut", "wholesaleOut", "cdOut", "draws", "net", "cumulative"].map(num),
    ...["buffer", "survivalMonths", "survivalDays", "termFundingNeed", "peakShortfall", "peakMonth", "capacity", "haircut", "counted"].map(num),
    { name: "label", role: "text" },
  ];
  const rows: Record<string, Cell>[] = sp.rows.map((r) => ({ rowType: "month", scenarioId: sp.scenarioId, ...r }));
  const reading = (rowType: string, x: NonNullable<typeof sp.withFacility>) => ({
    rowType, month: "", scenarioId: sp.scenarioId, buffer: x.buffer, survivalMonths: x.survivalMonths, survivalDays: x.survivalDays, termFundingNeed: x.termFundingNeed, peakShortfall: sp.peakShortfall, peakMonth: sp.peakMonth,
  });
  rows.push(reading("ladder-buffer", sp.ladderBuffer));
  if (sp.withFacility !== undefined && sp.facility !== undefined) {
    rows.push({ ...reading("with-facility", sp.withFacility), capacity: sp.facility.capacity, haircut: sp.facility.haircut, counted: sp.facility.counted, label: sp.facility.label });
  }
  return { columns, rows, notes: [FULL_PRECISION, "A survivalMonths cell left blank is a buffer never crossed on the path.", "hysOut is the savings pool (hys-pool); nibOut is the checking pool (nib-pool). cdOut is what matures less the renewal share, plus every early withdrawal."] };
}

/** FTP as the tab shows it: one row per family, then the book roll-up, then the NIM bridge. An absent rate is blank. */
function ftpTable(result: RunResult): CsvTable {
  const num = (name: string): ColumnSpec => ({ name, role: "num" });
  const columns: ColumnSpec[] = [
    { name: "scenarioId", role: "key" },
    { name: "rowType", role: "key" },
    { name: "familyId", role: "key" },
    { name: "side", role: "text" },
    ...["positionCount", "notional", "couponRate", "irFtpRate", "lpFtpRate", "allInFtpRate", "ftpMarginRate", "couponInterest12", "ftpAccrual12", "margin12"].map(num),
    { name: "irBasis", role: "text" },
    { name: "allInBasis", role: "text" },
    ...["bookNimRate", "charges12", "credits12", "mismatchCenter12"].map(num),
    ...["horizonMonths", "lendingMargin12", "fundingMargin12", "derivativesNet12", "bridgeNet12", "newBusinessNet12", "niiNet12"].map(num),
  ];
  const ftp = result.ftp!;
  const rows: Record<string, Cell>[] = [];
  for (const f of ftp.byFamily) {
    rows.push({
      scenarioId: ftp.scenarioId,
      rowType: "family",
      familyId: f.familyId,
      side: f.side,
      positionCount: f.positionCount,
      notional: f.notional,
      couponRate: f.couponRate,
      irFtpRate: f.irFtpRate,
      lpFtpRate: f.lpFtpRate,
      allInFtpRate: f.allInFtpRate,
      ftpMarginRate: f.ftpMarginRate,
      couponInterest12: f.couponInterest12,
      ftpAccrual12: f.ftpAccrual12,
      margin12: f.margin12,
    });
  }
  rows.push({
    scenarioId: ftp.scenarioId,
    rowType: "book",
    familyId: "",
    irBasis: ftp.irBasis,
    allInBasis: ftp.allInBasis,
    bookNimRate: ftp.book.bookNimRate,
    charges12: ftp.book.charges12,
    credits12: ftp.book.credits12,
    mismatchCenter12: ftp.book.mismatchCenter12,
  });
  const nb = ftp.nimBridge;
  rows.push({
    scenarioId: ftp.scenarioId,
    rowType: "bridge",
    familyId: "",
    mismatchCenter12: nb.mismatchCenter12,
    horizonMonths: nb.horizonMonths,
    lendingMargin12: nb.lendingMargin12,
    fundingMargin12: nb.fundingMargin12,
    derivativesNet12: nb.derivativesNet12,
    bridgeNet12: nb.bridgeNet12,
    newBusinessNet12: nb.newBusinessNet12,
    niiNet12: nb.niiNet12,
  });
  return { columns, rows, notes: [FULL_PRECISION] };
}

/** The first band where an interest row and its total row differ, as a sentence; null when they line up. */
function interestMismatch(buckets: string, total: GapRow[], interest: GapRow[] | undefined): string | null {
  if (interest === undefined) return null;
  if (interest.length !== total.length) {
    return `the ${buckets} interest rows (${interest.length}) do not line up with the ${buckets} total rows (${total.length})`;
  }
  for (let b = 0; b < total.length; b++) {
    const i = interest[b]!.band;
    const r = total[b]!.band;
    if (i.label !== r.label || i.startMonth !== r.startMonth || i.endMonth !== r.endMonth) {
      return `the ${buckets} interest rows do not line up with the ${buckets} total rows (band ${i.label} against ${r.label})`;
    }
  }
  return null;
}

/**
 * Why a run cannot give `table`, as a sentence; null when it can. The six older tables always can. A slice A4
 * table the run does not store is refused rather than written as a header with no rows.
 */
export function tableRefusal(result: RunResult, table: ExportTable): string | null {
  switch (table) {
    case "repricing-gap-buckets":
    case "liquidity-gap-buckets": {
      const kind = table === "repricing-gap-buckets" ? "repricing" : "liquidity";
      const ladders = kind === "repricing" ? result.gap.repricing : result.gap.liquidity;
      return ladders.some((l) => l.userBuckets !== undefined)
        ? null
        : `this run stores the ${kind} gap in the nine standard bands only (no gap.${kind} userBuckets); export ${kind}-gap.csv instead`;
    }
    case "liquidity-gap-interest": {
      const ladders = result.gap.liquidity.filter((l) => l.withInterest !== undefined);
      if (ladders.length === 0) {
        return 'this run stores no interest-inclusive liquidity ladder (gap.liquidity withInterest is absent): the run did not ask for liquidity flows "principal-plus-interest"';
      }
      for (const l of ladders) {
        const w = l.withInterest as StoredWithInterest;
        const off =
          interestMismatch("standard", w.rows, w.interest?.rows) ??
          (w.userBuckets === undefined ? null : interestMismatch(w.userBuckets.kind, w.userBuckets.rows, w.interest?.userBuckets?.rows));
        if (off !== null) return `scenario ${l.scenarioId}: ${off}`;
      }
      return null;
    }
    case "ftp":
      return result.ftp === undefined
        ? "this run's result carries no ftp block (the run setup turned FTP off, or the envelope predates the block)"
        : null;
    case "liquidity-stress":
      return result.liquidityStress === undefined ? "this run stores no liquidity stress ladder (the run setup did not turn the liquidity stress on)" : null;
    case "survival-path":
      return result.liquidityStress?.survivalPath === undefined
        ? "this run stores no survival path (the run setup's liquidity stress did not turn the survival path on); Results, Liquidity builds one on the page from the ladder"
        : null;
    default:
      return null;
  }
}

export function buildTable(result: RunResult, table: ExportTable): CsvTable {
  switch (table) {
    case "nii":
      return niiTable(result);
    case "eve":
      return eveTable(result);
    case "repricing-gap":
      return gapTable(result, "repricing");
    case "liquidity-gap":
      return gapTable(result, "liquidity");
    case "attribution":
      return attributionTable(result);
    case "cashflows":
      return cashflowsTable(result);
    case "repricing-gap-buckets":
      return bucketsTable(result, "repricing");
    case "liquidity-gap-buckets":
      return bucketsTable(result, "liquidity");
    case "liquidity-gap-interest":
      return interestTable(result);
    case "ftp":
      return ftpTable(result);
    case "liquidity-stress":
      return liquidityStressTable(result);
    case "survival-path":
      return survivalPathTable(result);
  }
}

// --- rendering ---------------------------------------------------------------

/** RFC 4180 cell encoding; String(n) keeps full float precision, no rounding. */
export function cell(value: Cell): string {
  if (value === null || value === undefined) return "";
  // A text cell a spreadsheet would read as a formula (=, +, -, @; a tag value from a CSV can be
  // anything) is prefixed with a quote. Numbers are written by String() and never prefixed, so a negative figure stays a number.
  const s = typeof value === "string" ? (/^[=+\-@]/.test(value) ? `'${value}` : value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ExportProvenance {
  runId: string;
  inputsHash: string;
  /** The curve line's value (curveLine.ts), for example "platform default v2, log-linear on discount factor". */
  curve: string;
  schemaVersion: string;
  engineVersion: string;
}

/** The header fields of a stored run: its result's provenance and the curve line the caller read for it. */
export function provenanceOf(result: RunResult, curve: RunCurveLine): ExportProvenance {
  return {
    runId: result.provenance.runId,
    inputsHash: result.provenance.inputsHash,
    curve: curve.value,
    schemaVersion: result.schemaVersion,
    engineVersion: result.provenance.engineVersion,
  };
}

function commentRows(tag: string, p: ExportProvenance): string[] {
  return [
    `# runId${tag},${cell(p.runId)}`,
    `# inputsHash${tag},${cell(p.inputsHash)}`,
    `# curve${tag},${cell(p.curve)}`,
    `# schemaVersion${tag},${cell(p.schemaVersion)}`,
    `# engineVersion${tag},${cell(p.engineVersion)}`,
  ];
}

/** Render one run's table with its traceability header. */
export function renderCsv(table: CsvTable, prov: ExportProvenance, generatedAt: string): string {
  const lines: string[] = [
    ...commentRows("", prov),
    `# generatedAt,${cell(generatedAt)}`,
    ...(table.notes ?? []).map((n) => `# note,${cell(n)}`),
    table.columns.map((c) => cell(c.name)).join(","),
  ];
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => cell(row[c.name])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** The compare column shape is the table's own column spec, so the two cannot drift. */
export type CompareColumn = ColumnSpec;

export interface CompareRow {
  key: Record<string, Cell>;
  a: Record<string, Cell> | null;
  b: Record<string, Cell> | null;
  delta: Record<string, number | null>;
}

export interface CompareAligned {
  columns: CompareColumn[];
  rows: CompareRow[];
}

/**
 * The two-run alignment compare.csv and GET /api/compare share. Rows
 * join on the key columns of A's table (outer join: A's rows in envelope
 * order, then B-only rows). A numeric column's delta is B - A when both sides
 * carry a number, else null. Nothing else is computed.
 */
export function alignCompare(a: CsvTable, b: CsvTable): CompareAligned {
  const columns = a.columns;
  const keyCols = columns.filter((c) => c.role === "key");
  const numCols = columns.filter((c) => c.role === "num");
  const keyOf = (row: Record<string, Cell>): string => keyCols.map((c) => cell(row[c.name])).join("\u0000");
  const bByKey = new Map<string, Record<string, Cell>>();
  for (const row of b.rows) bByKey.set(keyOf(row), row);
  const make = (rowA: Record<string, Cell> | undefined, rowB: Record<string, Cell> | undefined): CompareRow => {
    const src = rowA ?? rowB ?? {};
    const key: Record<string, Cell> = {};
    for (const c of keyCols) key[c.name] = src[c.name];
    const delta: Record<string, number | null> = {};
    for (const c of numCols) {
      const va = rowA?.[c.name];
      const vb = rowB?.[c.name];
      delta[c.name] = typeof va === "number" && typeof vb === "number" ? vb - va : null;
    }
    return { key, a: rowA ?? null, b: rowB ?? null, delta };
  };
  const rows: CompareRow[] = [];
  const seen = new Set<string>();
  for (const rowA of a.rows) {
    const k = keyOf(rowA);
    seen.add(k);
    rows.push(make(rowA, bByKey.get(k)));
  }
  for (const rowB of b.rows) if (!seen.has(keyOf(rowB))) rows.push(make(undefined, rowB));
  return { columns, rows };
}

/**
 * Render the two-run aligned comparison from alignCompare. Numeric columns
 * emit [A], [B], and [derived: B - A]; text columns emit [A] and [B] only.
 */
export function renderCompareCsv(
  a: { table: CsvTable; prov: ExportProvenance },
  b: { table: CsvTable; prov: ExportProvenance },
  generatedAt: string,
): string {
  const aligned = alignCompare(a.table, b.table);
  const keyCols = aligned.columns.filter((c) => c.role === "key");
  const valCols = aligned.columns.filter((c) => c.role !== "key");

  const header = [
    ...keyCols.map((c) => cell(c.name)),
    ...valCols.flatMap((c) =>
      c.role === "num"
        ? [`${c.name} [A]`, `${c.name} [B]`, `${c.name} [derived: B - A]`]
        : [`${c.name} [A]`, `${c.name} [B]`],
    ).map(cell),
  ].join(",");

  const emit = (row: CompareRow): string => {
    const cells: string[] = keyCols.map((c) => cell(row.key[c.name]));
    for (const c of valCols) {
      cells.push(cell(row.a?.[c.name]), cell(row.b?.[c.name]));
      if (c.role === "num") cells.push(cell(row.delta[c.name]));
    }
    return cells.join(",");
  };

  const lines: string[] = [
    ...commentRows(" [A]", a.prov),
    ...commentRows(" [B]", b.prov),
    `# generatedAt,${cell(generatedAt)}`,
    `# note,"derived columns are B - A, displayed beside both originals"`,
    header,
    ...aligned.rows.map(emit),
  ];
  return `${lines.join("\r\n")}\r\n`;
}
