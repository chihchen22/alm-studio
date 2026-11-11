/**
 * CSV position intake: the assisted path.
 *
 * One file, one row per position. Columns: the four platform meta columns
 * (position_id, family_id, coa_node_id, terms_type) plus the term columns
 * GENERATED from the kernel term interfaces (columnContract.ts). CSV cannot
 * carry a chart of accounts, so the caller resolves a stored COA by coaId and
 * passes it in; full custom books use the JSON path.
 *
 * Parameter blocks (cprParams, nmdParams, sCurve) are object-typed kernel
 * fields no CSV cell can express. The CSV path fills them from the kernel's
 * published defaults, mirrors the synthetic generator's stance (a position
 * embeds no authored behavior; the run's assumption set is the behavioral
 * layer), reports the fill as a warning, and REFUSES loudly if the generated
 * contract surfaces a block with no registered default: an unknown block is
 * never silently defaulted.
 *
 * With a taxonomy the file may carry `dim.<id>` tag columns, one per authorable
 * dimension. A blank cell is an absent tag, a multi-valued cell
 * splits on `|`, and a row whose tag cells are all blank gets no bag at all, so
 * a tagless book is byte-identical to the pre-2d one. Nothing here checks a tag
 * value: the taxonomy rides on the spec and the engine's D1 to D4 decide.
 * Without a taxonomy, the `dim.<id>` columns declare an
 * open one, inferred from the header (`inferTaxonomy`).
 *
 * Errors are per-row with the physical line number and the column name, and
 * every error is reported, not just the first. The parser is a small RFC 4180
 * reader: quoted fields, doubled-quote escapes, embedded commas and newlines,
 * CRLF or LF line ends. No dependency.
 */
import type {
  ChartOfAccounts,
  DimensionBag,
  DimensionDef,
  DimensionTaxonomy,
  Position,
} from "@alm/engine";
import { UNAUTHORABLE_DIMENSION_IDS } from "@alm/engine";
import {
  BETA_S_CURVE_DEFAULTS,
  IB_BUCKETS,
  MBS_DEFAULTS,
  NMD_DEFAULTS,
} from "@alm/kernel";
import { getCsvColumnContract, META_COLUMNS, type ColumnSpec, type ParamBlockSpec } from "./columnContract";
import {
  ENGINE_CSV_COLUMNS,
  ENGINE_TERMS_TYPES,
  KERNEL_EXTRA_CSV_COLUMNS,
  LINEAR_DECAY_CSV_COLUMN,
  cdStylizedBalance,
  engineCsvColumnNames,
  type EngineTermsType,
} from "./engineTerms";
import {
  validatePortfolioSpec,
  type IntakeResult,
  type RowError,
} from "./validationReport";

/**
 * What one CSV row type reads: a kernel type's generated columns and parameter blocks, plus the engine-side
 * scalar a kernel type may carry; or an engine-side type's own columns (no parameter block).
 */
interface RowType {
  termsType: string;
  columns: ColumnSpec[];
  paramBlocks: ParamBlockSpec[];
  engine: EngineTermsType | null;
}

/** One cd cohort book being assembled from its rows: the first row's place, ids and shared cells. */
interface CdBook {
  position: Position;
  firstRow: number;
  cohortRows: number[];
}

/** Portfolio header fields the CSV file itself cannot carry. */
export interface CsvPortfolioHeader {
  portfolioId: string;
  label: string;
  /** ISO snapshot date of the book of record; never defaulted by the platform. */
  asOf: string;
}

/**
 * Kernel-default parameter blocks per (terms type, field). Keys must cover
 * every param block the generated contract reports, or the CSV path refuses.
 * The nmd-b block mirrors the synthetic generator: interest-bearing books use
 * the IB account-size buckets.
 */
const PARAM_BLOCK_DEFAULTS: Record<string, Record<string, () => unknown>> = {
  mortgage: { cprParams: () => MBS_DEFAULTS },
  nmd: { nmdParams: () => NMD_DEFAULTS },
  "nmd-b": {
    sCurve: () => BETA_S_CURVE_DEFAULTS,
    nmdParams: () => ({ ...NMD_DEFAULTS, buckets: IB_BUCKETS }),
  },
};

/**
 * The tag-column prefix: `dim.<DimensionDef.id>`, one column per authorable
 * tag. Which ids are authorable is the ENGINE's call, not this module's:
 * UNAUTHORABLE_DIMENSION_IDS is the same set rule D2 refuses an authored bag
 * against, so a legal column and a legal bag cannot drift apart.
 */
const DIM_PREFIX = "dim.";

/** The CSV column a cd cohort field is read from (one row per cohort). */
const COHORT_CSV_COLUMN: Record<string, string> = { termMonths: "termMonths", monthsToMaturity: "maturityMonths", balance: "notional", contractRate: "contractRate" };

interface CsvRecord {
  /** Physical line number where the record starts (header is line 1). */
  line: number;
  cells: string[];
}

/** RFC 4180 reader. Returns records or a single unrecoverable parse error. */
function parseCsvText(text: string): { records: CsvRecord[] } | { parseError: string } {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let sawAny = false;

  const endField = () => {
    cells.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // Skip fully blank records (trailing newline, stray empty lines).
    if (!(cells.length === 1 && cells[0] === "")) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
    recordLine = line;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.length > 0) {
        return { parseError: `line ${line}: quote character inside an unquoted field` };
      }
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      line++;
      endRecord();
    } else if (ch === "\n") {
      line++;
      endRecord();
    } else {
      field += ch;
    }
  }
  if (inQuotes) return { parseError: "unterminated quoted field at end of file" };
  if (field.length > 0 || cells.length > 0) endRecord();
  if (!sawAny || records.length === 0) return { parseError: "CSV file is empty" };
  return { records };
}

const NUMBER_SHAPE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A tag id an inferred dimension may carry: a letter, then letters, digits, "-" or "_". */
const INFERRED_DIM_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** The value a blank cell of an inferred tag column takes, so every position carries the tag (fix round M2). */
export const UNASSIGNED_TAG = "Unassigned";

/** What `inferTaxonomy` found: the taxonomy (none without a read tag column) and the tag columns blank on every row. */
export interface InferredTags {
  taxonomy: DimensionTaxonomy | undefined;
  /** `dim.<id>` columns blank on every data row: legal in the header, read as no tag. */
  blankColumns: string[];
}

/**
 * The open taxonomy a file's `dim.<id>` columns declare, in column order, or none when
 * the file has no such column. Every dimension is open (any non-empty value) and single-valued, except
 * `behavioralClasses`, which the engine requires multi-valued. Its id is `<portfolioId>-tags`. Fix round: a column
 * blank on every row declares nothing (M2); two columns whose names differ only in case are refused (L8).
 */
export function inferTaxonomy(headerRec: { line: number; cells: string[] }, dataRecs: ReadonlyArray<{ cells: string[] }>, header: CsvPortfolioHeader): InferredTags | { errors: RowError[] } {
  const errors: RowError[] = [];
  const dimensions: DimensionDef[] = [];
  const blankColumns: string[] = [];
  headerRec.cells.forEach((raw, col) => {
    const name = raw.trim();
    if (!name.startsWith(DIM_PREFIX)) return;
    const id = name.slice(DIM_PREFIX.length);
    if (UNAUTHORABLE_DIMENSION_IDS.has(id)) {
      errors.push({ row: headerRec.line, column: name, message: `column "${name}" names a tag the engine derives from the chart of accounts; drop the column` });
      return;
    }
    if (!INFERRED_DIM_ID.test(id)) {
      errors.push({ row: headerRec.line, column: name, message: `column "${name}": a tag name starts with a letter and holds letters, digits, "-" or "_" (at most 64)` });
      return;
    }
    if (dimensions.some((d) => d.id === id) || blankColumns.includes(name)) return; // the header check names the duplicate
    const twin = [...dimensions.map((d) => `${DIM_PREFIX}${d.id}`), ...blankColumns].find((c) => c.toLowerCase() === name.toLowerCase());
    if (twin !== undefined) {
      errors.push({ row: headerRec.line, column: name, message: `columns "${twin}" and "${name}" differ only in case; name a tag once` });
      return;
    }
    if (dataRecs.every((r) => (r.cells[col] ?? "").trim() === "")) {
      blankColumns.push(name);
      return;
    }
    dimensions.push(id === "behavioralClasses" ? { id, label: id, multiValued: true } : { id, label: id });
  });
  if (errors.length > 0) return { errors };
  if (dimensions.length === 0) return { taxonomy: undefined, blankColumns };
  return { taxonomy: { schemaVersion: "1.0.0", id: `${header.portfolioId}-tags`, label: `Tags read from the columns of ${header.label}`, dimensions }, blankColumns };
}

/**
 * Parse a CSV position file against a stored chart of accounts. Returns the
 * assembled, fully validated PortfolioSpec (kernel dry instantiation included)
 * or ALL row errors. With a taxonomy the file may also carry `dim.<id>` tag
 * columns; the taxonomy rides on the assembled spec, so the engine's
 * D1 to D4 inside validatePortfolioSpec are the only tag validation there is.
 */
export function parsePositionsCsv(
  text: string,
  coa: ChartOfAccounts,
  header: CsvPortfolioHeader,
  taxonomy?: DimensionTaxonomy,
): IntakeResult {
  const contract = getCsvColumnContract();
  const typeByName = new Map<string, RowType>([
    ...contract.contracts.map((c): [string, RowType] => [
      c.termsType,
      { termsType: c.termsType, columns: [...c.columns, ...(KERNEL_EXTRA_CSV_COLUMNS[c.termsType] ?? [])], paramBlocks: c.paramBlocks, engine: null },
    ]),
    ...ENGINE_TERMS_TYPES.map((t): [string, RowType] => [t, { termsType: t, columns: ENGINE_CSV_COLUMNS[t], paramBlocks: [], engine: t }]),
  ]);
  const errors: RowError[] = [];
  const warnings: string[] = [];

  const parsed = parseCsvText(text);
  if ("parseError" in parsed) return { errors: [{ message: parsed.parseError }] };
  const [headerRec, ...dataRecs] = parsed.records;

  // A file that names no taxonomy and carries `dim.<id>` columns gets an open taxonomy
  // inferred from those columns (one open dimension per column, labelled by its id). It rides on the book, as a JSON
  // book's embedded taxonomy does; no taxonomy document is written. A column naming a tag the engine derives (the
  // family or the side) is refused by name. A file with no dim. column stays taxonomy-free, byte for byte.
  let inferredTags: InferredTags | null = null;
  if (taxonomy === undefined) {
    const inferred = inferTaxonomy(headerRec, dataRecs, header);
    if ("errors" in inferred) return inferred;
    inferredTags = inferred;
    taxonomy = inferred.taxonomy;
  }

  // The legal tag columns, keyed by the column name the author writes.
  const dimColumns = new Map<string, DimensionDef>(
    (taxonomy?.dimensions ?? [])
      .filter((d) => !UNAUTHORABLE_DIMENSION_IDS.has(d.id))
      .map((d) => [`${DIM_PREFIX}${d.id}`, d]),
  );

  // --- Header row ------------------------------------------------------------
  const headerCells = headerRec.cells.map((c) => c.trim());
  const legal = new Set<string>([
    ...META_COLUMNS,
    ...contract.termColumnNames,
    ...engineCsvColumnNames().filter((c) => !contract.termColumnNames.includes(c)),
    ...dimColumns.keys(),
    ...(inferredTags?.blankColumns ?? []),
  ]);
  const colIndex = new Map<string, number>();
  headerCells.forEach((name, i) => {
    if (name === "") return;
    if (name.startsWith(DIM_PREFIX) && taxonomy === undefined && !(inferredTags?.blankColumns.includes(name) ?? false)) {
      errors.push({
        row: headerRec.line,
        column: name,
        message: `column "${name}" needs a taxonomy; pass taxonomyId=`,
      });
      return;
    }
    if (!legal.has(name)) {
      errors.push({
        row: headerRec.line,
        column: name,
        message: `unknown column "${name}"; legal columns are ${[...legal].join(", ")}`,
      });
      return;
    }
    if (colIndex.has(name)) {
      errors.push({ row: headerRec.line, column: name, message: `duplicate column "${name}"` });
      return;
    }
    colIndex.set(name, i);
  });
  for (const meta of META_COLUMNS) {
    if (!colIndex.has(meta)) {
      errors.push({ row: headerRec.line, column: meta, message: `missing required column "${meta}"` });
    }
  }
  if (errors.length > 0) return { errors };
  if (dataRecs.length === 0) return { errors: [{ message: "CSV has a header but no data rows" }] };

  const familyById = new Map(coa.families.map((f) => [f.id, f]));
  const columnsByType = new Map(
    [...typeByName.values()].map((c) => [
      c.termsType,
      new Set([...contract.baseColumns, ...c.columns].map((col) => col.name)),
    ]),
  );
  // Cd cohort books assembled from their rows, by position id; and the commitments that carry no draw path.
  const cdBooks = new Map<string, CdBook>();
  let undrawn = 0;

  // --- Data rows -------------------------------------------------------------
  const positions: Position[] = [];
  const lineOfPosition: number[] = [];
  const defaultFillCounts = new Map<string, number>();
  const unassigned = new Map<string, number>();
  const sideFillCount = { n: 0 };

  for (const rec of dataRecs) {
    const row = rec.line;
    let clean = true;
    const push = (column: string | undefined, message: string, positionId?: string) => {
      errors.push({ row, column, positionId, message });
      clean = false;
    };
    const cell = (name: string): string | undefined => {
      const i = colIndex.get(name);
      if (i === undefined) return undefined;
      const v = rec.cells[i];
      return v === undefined ? undefined : v.trim();
    };
    if (rec.cells.length > headerCells.length) {
      push(undefined, `row has ${rec.cells.length} cells but the header declares ${headerCells.length}`);
    }

    const positionId = cell("position_id") || undefined;
    const familyId = cell("family_id") || undefined;
    const coaNodeId = cell("coa_node_id") || undefined;
    const termsType = cell("terms_type") || undefined;

    if (!positionId) push("position_id", "position_id is empty");
    if (!familyId) push("family_id", "family_id is empty", positionId);
    if (!coaNodeId) push("coa_node_id", "coa_node_id is empty", positionId);
    const tc = termsType ? typeByName.get(termsType) : undefined;
    if (!termsType) {
      push("terms_type", "terms_type is empty", positionId);
    } else if (!tc) {
      push("terms_type", `terms_type "${termsType}" is not one of ${[...typeByName.keys()].join(", ")}`, positionId);
    }
    if (!clean || !tc || !positionId || !familyId || !coaNodeId) continue;

    // Cells present in columns that do not apply to this terms type must be
    // blank; a silent ignore would hide a mis-mapped file.
    const applicable = columnsByType.get(tc.termsType)!;
    for (const name of colIndex.keys()) {
      if ((META_COLUMNS as readonly string[]).includes(name)) continue;
      if (dimColumns.has(name)) continue; // A tag column applies to every row
      if (applicable.has(name)) continue;
      const v = cell(name);
      if (v !== undefined && v !== "") {
        push(name, `column "${name}" does not apply to terms_type "${tc.termsType}" but carries "${v}"`, positionId);
      }
    }

    // Typed scalar fields from the generated contract.
    const terms: Record<string, unknown> = { id: positionId, type: tc.termsType };
    for (const col of [...contract.baseColumns, ...tc.columns]) {
      const raw = cell(col.name);
      if (raw === undefined || raw === "") {
        if (col.name === "side") continue; // filled from the family below
        if (col.required) push(col.name, `required cell "${col.name}" is empty`, positionId);
        continue;
      }
      if (col.kind === "number") {
        if (!NUMBER_SHAPE.test(raw)) {
          push(col.name, `cell "${col.name}" must be a number, got "${raw}"`, positionId);
          continue;
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          push(col.name, `cell "${col.name}" is not a finite number: "${raw}"`, positionId);
          continue;
        }
        terms[col.name] = n;
      } else if (col.kind === "enum") {
        if (!col.enumValues!.includes(raw)) {
          push(col.name, `cell "${col.name}" must be one of ${col.enumValues!.join(" | ")}, got "${raw}"`, positionId);
          continue;
        }
        terms[col.name] = raw;
      } else {
        terms[col.name] = raw;
      }
    }

    // side: fill from the family when blank; a stated side that contradicts
    // the family is an error, not a silent override. A swap's family is "derivative" and its terms carry no side.
    const fam = familyById.get(familyId);
    if (tc.engine === "swap") {
      if (terms.side !== undefined) push("side", `leave "side" blank on a swap row: a swap's side comes from its family, "derivative"`, positionId);
    } else if (fam && (fam.side === "asset" || fam.side === "liability")) {
      if (terms.side === undefined) {
        terms.side = fam.side;
        // A cd book counts once, on its first row.
        if (!(tc.engine === "cd" && cdBooks.has(positionId))) sideFillCount.n++;
      } else if (terms.side !== fam.side) {
        push("side", `side "${String(terms.side)}" contradicts family "${fam.id}"'s side "${fam.side}"`, positionId);
      }
    }
    // Unknown familyId is reported by the shared validator with this row's line.

    // Parameter blocks from registered kernel defaults; unknown blocks refuse.
    for (const block of tc.paramBlocks) {
      const makeDefault = PARAM_BLOCK_DEFAULTS[tc.termsType]?.[block.field];
      if (!makeDefault) {
        push(
          block.field,
          `the CSV path cannot supply "${block.field}" (${block.typeName}) for terms_type "${tc.termsType}" and no kernel default is registered; import this book via the JSON path`,
          positionId,
        );
        continue;
      }
      terms[block.field] = makeDefault();
      const key = `${tc.termsType}.${block.field}`;
      defaultFillCounts.set(key, (defaultFillCounts.get(key) ?? 0) + 1);
    }

    // The tag bag. A blank cell (after trim) is an absent tag, and a
    // row whose tag cells are all blank gets no `dimensions` field at all. A
    // multi-valued cell splits on "|" with each piece trimmed; an empty piece
    // ("a||b", "a|") is KEPT as the empty string so the engine's D3 refuses it
    // with the row and the column named, rather than being dropped here. A
    // single-valued cell is stored verbatim, a "|" in it included: D3 decides
    // its fate against the declared values. Nothing here reads the taxonomy's
    // values; the taxonomy rides on the spec and D1 to D4 are the validation.
    let bag: DimensionBag | undefined;
    for (const [column, def] of dimColumns) {
      const raw = cell(column);
      // Fix round M2: on an inferred tag a blank cell is the tag's "Unassigned" value, so a view by it partitions the book.
      // Not on liquidityRole, which the stress ladder reads: a blank role leaves the position out of the ladder, and
      // "Unassigned" is not one of its six roles.
      if ((raw === undefined || raw === "") && inferredTags !== null && def.multiValued !== true && def.id !== "liquidityRole") {
        bag ??= {};
        bag[def.id] = UNASSIGNED_TAG;
        unassigned.set(def.id, (unassigned.get(def.id) ?? 0) + 1);
        continue;
      }
      if (raw === undefined || raw === "") continue;
      bag ??= {};
      bag[def.id] = def.multiValued === true ? raw.split("|").map((v) => v.trim()) : raw;
    }

    // An nmd's straight-line runoff from its one column, as the JSON path states it; the
    // shared validator then checks it against the deposit's maturity, as it checks a JSON book's.
    if (tc.termsType === "nmd" && terms[LINEAR_DECAY_CSV_COLUMN] !== undefined) {
      terms.linearDecay = { horizonMonths: terms[LINEAR_DECAY_CSV_COLUMN] };
      delete terms[LINEAR_DECAY_CSV_COLUMN];
    }

    // A commitment's draw path from its two columns.
    if (tc.engine === "commitment") {
      const rampCell = terms.drawRampRates as string | undefined;
      const steady = terms.drawSteadyRate as number | undefined;
      delete terms.drawRampRates;
      delete terms.drawSteadyRate;
      const rampRates: number[] = [];
      for (const [k, piece] of (rampCell === undefined ? [] : rampCell.split("|")).entries()) {
        const v = piece.trim();
        if (!NUMBER_SHAPE.test(v) || !Number.isFinite(Number(v))) {
          push("drawRampRates", `cell "drawRampRates": month ${k + 1} must be a number, got "${v}"; join the months with "|"`, positionId);
          continue;
        }
        rampRates.push(Number(v));
      }
      if (rampCell === undefined && steady === undefined) undrawn++;
      terms.draw = { rampRates, steadyRate: steady ?? 0 };
    }

    if (!clean) continue;
    // A cd row is one cohort of the book its position_id names; the book takes the first row's place.
    if (tc.engine === "cd") {
      // Fix round L6: a cohort's dollars are checked on its own row, before they join the book's sum.
      if (!((terms.notional as number) > 0)) {
        push("notional", `cd cohort row: "notional" is the cohort's dollars and must be positive, got ${String(terms.notional)}`, positionId);
        continue;
      }
      const cohort = { termMonths: terms.termMonths as number, monthsToMaturity: terms.maturityMonths as number, balance: cdStylizedBalance(terms.notional as number), contractRate: terms.contractRate as number };
      const book = cdBooks.get(positionId);
      if (book === undefined) {
        const { termMonths: _t, contractRate: _r, ...shared } = terms;
        const position: Position = {
          id: positionId,
          familyId,
          coaNodeId,
          terms: { ...shared, cohorts: [cohort] } as unknown as Position["terms"],
          ...(bag !== undefined ? { dimensions: bag } : {}),
        };
        cdBooks.set(positionId, { position, firstRow: row, cohortRows: [row] });
        positions.push(position);
        lineOfPosition.push(row);
        continue;
      }
      const t = book.position.terms as unknown as Record<string, unknown> & { cohorts: Array<typeof cohort> };
      const first = `(row ${book.firstRow} starts the book)`;
      if (familyId !== book.position.familyId) { push("family_id", `cd book "${positionId}": every cohort row names the family of its first row, "${book.position.familyId}" ${first}`, positionId); continue; }
      if (coaNodeId !== book.position.coaNodeId) { push("coa_node_id", `cd book "${positionId}": every cohort row names the node of its first row, "${book.position.coaNodeId}" ${first}`, positionId); continue; }
      for (const k of ["originationOffsetMonths", "amortType", "side"] as const) {
        if (terms[k] !== t[k]) { push(k, `cd book "${positionId}": "${k}" must be the same on every cohort row, "${String(t[k])}" ${first}`, positionId); }
      }
      if (JSON.stringify(bag ?? null) !== JSON.stringify(book.position.dimensions ?? null)) {
        push(undefined, `cd book "${positionId}": every cohort row carries the tags of its first row ${first}`, positionId);
      }
      if (!clean) continue;
      t.cohorts.push(cohort);
      t.notional = (t.notional as number) + (terms.notional as number);
      t.maturityMonths = Math.max(t.maturityMonths as number, cohort.monthsToMaturity);
      book.cohortRows.push(row);
      continue;
    }
    positions.push({
      id: positionId,
      familyId,
      coaNodeId,
      terms: terms as unknown as Position["terms"],
      ...(bag !== undefined ? { dimensions: bag } : {}),
    });
    lineOfPosition.push(row);
  }

  const spec = {
    id: header.portfolioId,
    label: header.label,
    asOf: header.asOf,
    coa,
    ...(taxonomy !== undefined ? { taxonomy } : {}),
    positions,
  };
  const { errors: deepErrors, warnings: deepWarnings } = validatePortfolioSpec(spec, {
    rowOf: (i) => lineOfPosition[i],
  });
  // A bag problem names the column the AUTHOR sees. The validator
  // reports "dimensions.<id>", the JSON field; on the CSV path the author wrote
  // "dim.<id>". A taxonomy-level problem is reported as "taxonomy.<id>" and is
  // left alone: it names the stored document, not a column of this file.
  errors.push(
    ...deepErrors.map((e) => {
      if (e.column !== undefined && e.column.startsWith("dimensions.")) return { ...e, column: `${DIM_PREFIX}${e.column.slice("dimensions.".length)}` };
      // A cohort's problem is reported on its own row, against the column that row's author wrote.
      const cohort = e.column === undefined ? null : /^cohorts\[(\d+)\]\.(\w+)$/.exec(e.column);
      const book = e.positionId === undefined ? undefined : cdBooks.get(e.positionId);
      if (cohort !== null && book !== undefined) {
        const line = book.cohortRows[Number(cohort[1])] ?? book.firstRow;
        return { ...e, row: line, column: COHORT_CSV_COLUMN[cohort[2]!] ?? cohort[2]! };
      }
      // A commitment's draw path is two columns on this path.
      if (e.column !== undefined && e.column.startsWith("draw.")) return { ...e, column: e.column.startsWith("draw.steadyRate") ? "drawSteadyRate" : "drawRampRates" };
      return e;
    }),
  );
  if (errors.length > 0) return { errors };

  for (const [key, n] of defaultFillCounts) {
    warnings.push(
      `${key} filled from the kernel default for ${n} position${n === 1 ? "" : "s"}; authored behavior belongs in the run's assumption set`,
    );
  }
  if (undrawn > 0) {
    warnings.push(`${undrawn} commitment${undrawn === 1 ? " carries" : "s carry"} no draw path, so ${undrawn === 1 ? "it draws" : "they draw"} nothing until an assumption set binds a draw model`);
  }
  if (sideFillCount.n > 0) {
    warnings.push(`side filled from the owning family for ${sideFillCount.n} position${sideFillCount.n === 1 ? "" : "s"}`);
  }
  warnings.push(...deepWarnings);
  // Fix round M2: what the inferred tags did with blank cells, one plain line each.
  for (const [id, n] of unassigned) warnings.push(`${n} position${n === 1 ? " has" : "s have"} no ${id}; ${n === 1 ? "it is" : "they are"} grouped as ${UNASSIGNED_TAG}.`);
  for (const column of inferredTags?.blankColumns ?? []) warnings.push(`The column ${column} is blank on every row, so it is not read as a tag.`);
  return { portfolio: spec, warnings };
}
