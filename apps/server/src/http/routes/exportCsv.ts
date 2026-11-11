/**
 * CSV export routes (design Sections 3.3, 5.2).
 *
 *   GET /api/runs/:id/export/:table.csv   table in nii, eve, repricing-gap,
 *                                         liquidity-gap, attribution, cashflows,
 *                                         and repricing-gap-buckets,
 *                                         liquidity-gap-buckets,
 *                                         liquidity-gap-interest, ftp, and
 *                                         liquidity-stress, survival-path; a run
 *                                         that does not store one of those six is
 *                                         a 409 naming why
 *   GET /api/compare.csv?runs=a,b&table=  aligned two-run CSV with labeled
 *                                         derived deltas (B - A)
 *   GET /api/compare?runs=a,b&table=      the same alignment as JSON: columns,
 *                                         rows {key, a, b, delta}, provenance
 *
 * Every export reads the stored envelope verbatim; header comment rows carry
 * runId, inputsHash, the curve line (export/curveLine.ts: the
 * stamp, else the stored request's setup, else version 1), schemaVersion,
 * engineVersion, generation timestamp.
 */
import { rollUpRun, RollUpOptionsError, NiiMonthlyUnavailableError, type PortfolioSpec, type RollUpAlignment, type RunResult } from "@alm/engine";
import type { PlatformContext } from "../../context";
import { badRequest, conflict, notFound, unprocessable } from "../errors";
import type { Router } from "../router";
import type { RunStatus } from "../../jobs/types";
import {
  alignCompare,
  buildTable,
  EXPORT_TABLES,
  isExportTable,
  NOT_COMPARED,
  provenanceOf,
  renderCompareCsv,
  renderCsv,
  tableRefusal,
  type Cell,
  type CompareColumn,
  type ExportTable,
} from "../../export/csv";
import { storedRunCurveLine } from "../../export/curveLine";
import { isRollUpTable, ROLL_UP_TABLES, rollUpTable, type RollUpTable } from "../../export/rollUpCsv";

/** The `align` and `months` query of a roll-up read, checked the same way by the JSON route and the CSV. */
export function rollUpQuery(query: URLSearchParams): { alignment: RollUpAlignment; months?: number } {
  const align = query.get("align") ?? "cutoff";
  if (align !== "cutoff" && align !== "calendar") throw badRequest(`align must be "cutoff" (periods counted from the cut-off) or "calendar", got "${align}"`);
  const raw = query.get("months");
  if (raw === null) return { alignment: align };
  if (!/^\d+$/.test(raw)) throw badRequest(`months must be a whole number of months, got "${raw}"`);
  return { alignment: align, months: Number(raw) };
}

export function registerExportRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  /**
   * Deterministic-result gate for exports (closing the W3-A4b/W4-U1
   * disclosed 500 on the limitations page). A stochastic run's result.json
   * holds the SEPARATE distribution envelope, which carries none of
   * the deterministic table or provenance shape this module renders; without
   * this gate the export path dereferenced deterministic provenance and threw
   * a raw 500. Same posture as routes/runs.ts requireDeterministic: typed
   * refusal pointing at the honest read, never a crash. request.json files
   * predating the mode field are deterministic by construction.
   */
  const requireDeterministic = (runId: string, comparePointer = false): void => {
    if (!store.runFileExists(runId, "request.json")) return;
    const mode = store.readRunJson<{ mode?: string }>(runId, "request.json").mode ?? "deterministic";
    if (mode === "stochastic") {
      throw badRequest(
        `run "${runId}" is a stochastic run; its stored result is a distribution envelope ` +
          `, not a deterministic RunResult, and no CSV table shape of these export ` +
          `routes is defined for a distribution: rendering one as scenario rows would misread ` +
          `a Monte Carlo mean as an EVE. Read the envelope (N and SE lead every distribution) ` +
          `as JSON at /api/runs/${runId}/stochastic, and its statistics as CSV at ` +
          `/api/runs/${runId}/stochastic/summary.csv. Deterministic CSV exports do ` +
          `not exist for it.` +
          (comparePointer
            ? " Two stochastic runs compare at /api/compare/stochastic?runs=a,b, and as CSV " +
              "at /api/compare/stochastic.csv?runs=a,b."
            : ""),
      );
    }
  };

  const readDoneResult = (runId: string, what = "CSV export", comparePointer = false): RunResult => {
    if (!store.runFileExists(runId, "status.json")) throw notFound(`run "${runId}" not found`);
    requireDeterministic(runId, comparePointer);
    const status = store.readRunJson<RunStatus>(runId, "status.json");
    if (status.state !== "done") {
      throw conflict(`run "${runId}" is ${status.state}; ${what} requires state "done"`);
    }
    return store.readRunJson<RunResult>(runId, "result.json");
  };

  /** The header provenance of a done run: its result's fields and the curve line of its stored files. */
  const provOf = (runId: string, result: RunResult) => provenanceOf(result, storedRunCurveLine(store, runId, result)!);

  /** A done run that does not store the table (no buckets, no interest ladder, no FTP) is a 409 naming why. */
  const tableOf = (runId: string, result: RunResult, table: ExportTable) => {
    const why = tableRefusal(result, table);
    if (why !== null) throw conflict(`run "${runId}" cannot export ${table}.csv: ${why}`);
    return buildTable(result, table);
  };

  const parseTableParam = (raw: string): string => {
    if (!raw.endsWith(".csv")) {
      throw badRequest(`export path must end in .csv, got "${raw}"`);
    }
    return raw.slice(0, -".csv".length);
  };

  /** The quarterly or annual roll-up of a done run, read through the engine's one roll-up reader. */
  const rollUpCsv = (runId: string, table: RollUpTable, query: URLSearchParams) => {
    const result = readDoneResult(runId);
    const { alignment, months } = rollUpQuery(query);
    const stored = store.readRunJson<{ submission: { portfolioId: string } }>(runId, "request.json");
    const coa = store.getDocument<PortfolioSpec>("portfolios", stored.submission.portfolioId).doc.coa;
    let reply;
    try {
      reply = rollUpRun(result, coa, { period: ROLL_UP_TABLES[table], alignment, ...(months !== undefined ? { months } : {}) });
    } catch (err) {
      if (err instanceof RollUpOptionsError || err instanceof NiiMonthlyUnavailableError) throw unprocessable(err.message);
      throw err;
    }
    if (reply.kind === "absent") throw conflict(`run "${runId}" cannot export ${table}.csv: it stores no monthly net interest income to roll up`);
    return renderCsv(rollUpTable(reply), provOf(runId, result), new Date().toISOString());
  };

  router.add("GET", "/api/runs/:id/export/:file", (req) => {
    const table = parseTableParam(req.params.file);
    if (isRollUpTable(table)) {
      return {
        kind: "bytes",
        contentType: "text/csv; charset=utf-8",
        headers: { "content-disposition": `attachment; filename="${req.params.id}-${table}.csv"` },
        value: Buffer.from(rollUpCsv(req.params.id, table, req.query), "utf8"),
      };
    }
    if (!isExportTable(table)) {
      throw badRequest(
        `unknown export table "${table}"; tables: ${[...EXPORT_TABLES, ...Object.keys(ROLL_UP_TABLES)].join(", ")}`,
      );
    }
    const result = readDoneResult(req.params.id);
    const csv = renderCsv(tableOf(req.params.id, result, table), provOf(req.params.id, result), new Date().toISOString());
    return {
      kind: "bytes",
      contentType: "text/csv; charset=utf-8",
      headers: {
        "content-disposition": `attachment; filename="${req.params.id}-${table}.csv"`,
      },
      value: Buffer.from(csv, "utf8"),
    };
  });

  /** The runs/table query both compare routes take, validated the same way. */
  const parseCompareQuery = (
    req: { query: URLSearchParams },
    route = "compare.csv",
  ): { ids: string[]; table: ExportTable } => {
    const runsParam = req.query.get("runs");
    const tableParam = req.query.get("table");
    if (runsParam === null || tableParam === null) {
      throw badRequest(`${route} requires ?runs=a,b&table=<table>`);
    }
    const ids = runsParam.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (ids.length !== 2) throw badRequest(`runs must name exactly two run ids, got "${runsParam}"`);
    if (!isExportTable(tableParam)) {
      throw badRequest(
        `unknown export table "${tableParam}"; tables: ${EXPORT_TABLES.join(", ")}`,
      );
    }
    // The liquidity tables are exported per run; compare does not align them yet.
    const notCompared = NOT_COMPARED[tableParam];
    if (notCompared !== undefined) throw badRequest(`${route} cannot compare ${tableParam}: ${notCompared}`);
    return { ids, table: tableParam };
  };

  router.add("GET", "/api/compare.csv", (req) => {
    const { ids, table: tableParam } = parseCompareQuery(req);
    const [a, b] = ids.map((id) => readDoneResult(id, "CSV export", true));
    const csv = renderCompareCsv(
      { table: tableOf(ids[0]!, a!, tableParam), prov: provOf(ids[0]!, a) },
      { table: tableOf(ids[1]!, b!, tableParam), prov: provOf(ids[1]!, b) },
      new Date().toISOString(),
    );
    return {
      kind: "bytes",
      contentType: "text/csv; charset=utf-8",
      headers: {
        "content-disposition": `attachment; filename="compare-${ids[0]}-${ids[1]}-${tableParam}.csv"`,
      },
      value: Buffer.from(csv, "utf8"),
    };
  });

  router.add("GET", "/api/compare", (req) => {
    const { ids, table } = parseCompareQuery(req, "compare");
    const [a, b] = ids.map((id) => readDoneResult(id, "compare", true));
    const aligned = alignCompare(tableOf(ids[0]!, a!, table), tableOf(ids[1]!, b!, table));
    // Every side carries every column of its role, a cell the row never set
    // written as null (the nii TOTAL row sets only net12 and net24).
    const keyCols = aligned.columns.filter((c) => c.role === "key");
    const valCols = aligned.columns.filter((c) => c.role !== "key");
    const over = (cols: CompareColumn[], r: Record<string, Cell>) =>
      Object.fromEntries(cols.map((c) => [c.name, r[c.name] ?? null]));
    return {
      kind: "json",
      value: {
        table,
        columns: aligned.columns,
        rows: aligned.rows.map((r) => ({
          key: over(keyCols, r.key),
          a: r.a === null ? null : over(valCols, r.a),
          b: r.b === null ? null : over(valCols, r.b),
          delta: r.delta,
        })),
        provenance: { a: provOf(ids[0]!, a!), b: provOf(ids[1]!, b!) },
        note: "derived columns are B - A, displayed beside both originals",
      },
    };
  });
}
