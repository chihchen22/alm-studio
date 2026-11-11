/**
 * The macro factor ops the seed writes onto macro-demo-v1.
 *
 * Two histories cut from raw FRED downloads under apps/server/data/macro/ (each
 * file checked against its manifest hash before it is read), and three
 * authored house-price projections. A history ends at the base market's as-of
 * month and feeds no run; a projection is synthetic, authored for
 * demonstration, and never an engine forecast. A month the provider did not
 * publish stays null, is listed in the manifest's knownGaps, and is never
 * filled.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MacroSeriesKind, MacroSeriesSetOp } from "@alm/engine";
import { monthAdd } from "@alm/engine/src/macro/macroFactors";

/** One row of macro_source_manifest.json. */
export interface MacroManifestRow {
  seriesId: string;
  provider: string;
  url: string;
  file: string;
  retrievedOn: string;
  vintage: string;
  endMonth: string;
  sha256: string;
  knownGaps: string[];
}

/** One parsed FRED observation: month YYYY-MM, value null where the provider published none. */
export interface FredRow {
  month: string;
  value: number | null;
}

const FRED_DATE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
/** A plain decimal: optional minus, digits, and an optional fraction with digits on both sides. No exponent, hex, sign plus or padding. */
const FRED_VALUE = /^-?\d+(\.\d+)?$/;

/** Parses a FRED graph CSV (header `observation_date,<seriesId>`, rows `YYYY-MM-01,value`); an empty value is null, any other value a plain decimal. */
export function parseFredCsv(text: string, seriesId: string): FredRow[] {
  const lines = text.split("\n");
  const header = (lines[0] ?? "").replace(/\r$/, "");
  if (header !== `observation_date,${seriesId}`) {
    throw new Error(`FRED file for ${seriesId}: line 1 is ${JSON.stringify(header)}; expected "observation_date,${seriesId}"`);
  }
  const out: FredRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line === "") continue;
    const parts = line.split(",");
    if (parts.length !== 2 || !FRED_DATE.test(parts[0]!)) {
      throw new Error(`FRED file for ${seriesId}: line ${i + 1} ${JSON.stringify(line)} is not YYYY-MM-01,value`);
    }
    const raw = parts[1]!;
    if (raw !== "" && !FRED_VALUE.test(raw)) {
      throw new Error(`FRED file for ${seriesId}: line ${i + 1} value ${JSON.stringify(raw)} is not a plain decimal number`);
    }
    out.push({ month: parts[0]!.slice(0, 7), value: raw === "" ? null : Number(raw) });
  }
  return out;
}

/** The rows up to and including endMonth, which must be consecutive months: a missing or repeated row is refused, never filled. */
export function cutAt(rows: FredRow[], endMonth: string): FredRow[] {
  const kept = rows.filter((r) => r.month <= endMonth);
  for (let i = 1; i < kept.length; i++) {
    const want = monthAdd(kept[i - 1]!.month, 1);
    if (kept[i]!.month !== want) throw new Error(`FRED rows are not consecutive months: ${kept[i]!.month} follows ${kept[i - 1]!.month}; expected ${want}`);
  }
  return kept;
}

/** The id, label, kind and unit each shipped history is stored under. */
const HISTORY_SERIES: Readonly<Record<string, { id: string; label: (endMonth: string) => string; kind: MacroSeriesKind; unit: (endMonth: string) => string }>> = {
  HPIPONM226S: {
    id: "hpi-fhfa-po",
    label: (end) => `FHFA purchase-only house price index, seasonally adjusted, rebased ${end} = 1 (FHFA via FRED)`,
    kind: "index",
    unit: (end) => `ratio to ${end}`,
  },
  UNRATE: {
    id: "unrate",
    label: () => "Civilian unemployment rate (BLS via FRED)",
    kind: "rate",
    unit: () => "decimal",
  },
};

/** A set-macro-series op for one history: the rows as given (cut by the caller), each published value transformed, each gap kept null. */
export function historyOp(row: MacroManifestRow, rows: FredRow[], transform: (v: number) => number): MacroSeriesSetOp {
  const spec = HISTORY_SERIES[row.seriesId];
  if (spec === undefined) throw new Error(`no macro history is defined for FRED series ${row.seriesId}`);
  if (rows.length === 0) throw new Error(`FRED series ${row.seriesId} has no rows up to ${row.endMonth}`);
  return {
    op: "set-macro-series",
    id: spec.id,
    label: spec.label(row.endMonth),
    kind: spec.kind,
    role: "history",
    unit: spec.unit(row.endMonth),
    firstMonth: rows[0]!.month,
    values: rows.map((r) => (r.value === null ? null : transform(r.value))),
    source: {
      seriesId: row.seriesId,
      provider: row.provider,
      url: row.url,
      retrievedOn: row.retrievedOn,
      vintage: row.vintage,
      endMonth: row.endMonth,
      rawFileSha256: row.sha256,
      knownGaps: [...row.knownGaps],
    },
  };
}

/** Rebases an index so the anchor month is 1, to 12 significant digits. */
export const HPI_REBASE = (anchor: number) => (v: number) => Number((v / anchor).toPrecision(12));

/** A FRED percent as a decimal, to 12 significant digits. */
export const PERCENT_TO_DECIMAL = (v: number) => Number((v / 100).toPrecision(12));

/** 360 monthly values, H[i] = 1 + (end - 1) * min(1, (i + 1) / 24), each to 12 significant digits. */
export function projectionValues(end: number): number[] {
  return Array.from({ length: 360 }, (_, i) => Number((1 + (end - 1) * Math.min(1, (i + 1) / 24)).toPrecision(12)));
}

const PROJECTION_NOTE = "Synthetic and authored for demonstration; never an engine forecast.";

const PROJECTIONS: ReadonlyArray<{ id: string; label: string; end: number }> = [
  { id: "hpi-flat", label: "House prices flat (authored projection)", end: 1 },
  { id: "hpi-down-30", label: "House prices down 30 percent over 24 months, then flat (authored projection)", end: 0.7 },
  { id: "hpi-up-15", label: "House prices up 15 percent over 24 months, then flat (authored projection)", end: 1.15 },
];

export const MACRO_DEMO_LABEL =
  "FHFA house prices and BLS unemployment to 2026-03, three authored house-price projections (demonstration values)";

/** The five set-macro-series ops of macro-demo-v1: the two histories in manifest order, then the three projections. */
export function buildMacroDemoOps(repoRoot: string): Array<MacroSeriesSetOp> {
  const dir = join(repoRoot, "apps", "server", "data", "macro");
  const manifest = JSON.parse(readFileSync(join(dir, "macro_source_manifest.json"), "utf8")) as { series: MacroManifestRow[] };
  const ops: MacroSeriesSetOp[] = [];
  let asOf: string | null = null;
  for (const row of manifest.series) {
    const bytes = readFileSync(join(dir, row.file));
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== row.sha256) throw new Error(`${row.file} hashes to ${sha}; the manifest records ${row.sha256}`);
    const rows = cutAt(parseFredCsv(bytes.toString("utf8"), row.seriesId), row.endMonth);
    let transform: (v: number) => number;
    if (row.seriesId === "HPIPONM226S") {
      const anchor = rows.find((r) => r.month === row.endMonth)?.value;
      if (typeof anchor !== "number" || !(anchor > 0)) throw new Error(`${row.file} carries no positive value at ${row.endMonth} to rebase on`);
      transform = HPI_REBASE(anchor);
    } else {
      transform = PERCENT_TO_DECIMAL;
    }
    ops.push(historyOp(row, rows, transform));
    asOf = row.endMonth;
  }
  if (asOf === null) throw new Error("macro_source_manifest.json lists no series");
  for (const p of PROJECTIONS) {
    ops.push({
      op: "set-macro-series",
      id: p.id,
      label: p.label,
      kind: "index",
      role: "projection",
      unit: `ratio to ${asOf}`,
      firstMonth: monthAdd(asOf, 1),
      values: projectionValues(p.end),
      source: { authored: true, note: PROJECTION_NOTE },
    });
  }
  return ops;
}
