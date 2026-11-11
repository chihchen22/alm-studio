/**
 * Intake module barrel (platform module M3).
 *
 * The inter-module contract:
 *
 *   parsePositions(input: { kind: "json", spec: unknown }
 *                       | { kind: "csv", text: string, coaId: string, ... })
 *     -> { portfolio: PortfolioSpec, warnings } | { errors: RowError[] }
 *
 * Two deliberate, additive deltas from the frozen sketch, recorded in the
 * W1-P2 module report as steps to W1-P1:
 *
 *   1. The CSV arm carries `portfolioId`, `label`, and `asOf` beside `coaId`:
 *      a CSV file cannot state them, the store id and the snapshot date must
 *      come from the request, and the platform never invents an as-of date.
 *   2. `parsePositions` takes a second `deps` argument with `resolveCoa`,
 *      because the intake module does not own or read the file store (M1
 *      does); the route resolves the stored COA and passes the lookup in.
 *   3. The CSV arm carries an OPTIONAL `taxonomyId` beside `coaId`,
 *      and `deps` a matching `resolveTaxonomy`. A CSV file cannot carry a
 *      taxonomy any more than it can carry a chart of accounts, so the tag
 *      columns target a stored one by id; a file with no tag column needs none.
 */
import type { ChartOfAccounts, DimensionTaxonomy } from "@alm/engine";
import { parsePositionsJson } from "./positionsJson";
import { parsePositionsCsv } from "./positionsCsv";
import { ID_PATTERN, type IntakeResult } from "./validationReport";

export type ParsePositionsInput =
  | { kind: "json"; spec: unknown }
  | {
      kind: "csv";
      text: string;
      /** Id of a stored chart of accounts the rows attach to. */
      coaId: string;
      /**
       * Id of a stored dimension taxonomy the `dim.<id>` columns are
       * authored against. Absent means the file carries no tag column, and a
       * `dim.` column in a file that named no taxonomy is a header refusal.
       */
      taxonomyId?: string;
      /** Store id for the new portfolio (ids double as filenames). */
      portfolioId: string;
      label: string;
      /** ISO snapshot date of the book of record. */
      asOf: string;
    };

export interface ParsePositionsDeps {
  /** Resolve a stored COA by id; supplied by the route (the store is M1's). */
  resolveCoa?: (coaId: string) => ChartOfAccounts | undefined;
  /** Resolve a stored taxonomy by id; supplied by the route, same reason. */
  resolveTaxonomy?: (taxonomyId: string) => DimensionTaxonomy | undefined;
}

/** Parse and fully validate a position import, JSON or CSV. */
export function parsePositions(
  input: ParsePositionsInput,
  deps: ParsePositionsDeps = {},
): IntakeResult {
  if (input.kind === "json") {
    return parsePositionsJson(input.spec);
  }
  if (!ID_PATTERN.test(input.coaId)) {
    return { errors: [{ column: "coaId", message: `coaId ${JSON.stringify(input.coaId)} must match ${ID_PATTERN}` }] };
  }
  const coa = deps.resolveCoa?.(input.coaId);
  if (!coa) {
    return {
      errors: [
        {
          column: "coaId",
          message: `no stored chart of accounts with id "${input.coaId}"; CSV import targets a stored COA (full custom books use the JSON path)`,
        },
      ],
    };
  }
  let taxonomy: DimensionTaxonomy | undefined;
  if (input.taxonomyId !== undefined) {
    if (!ID_PATTERN.test(input.taxonomyId)) {
      return {
        errors: [
          {
            column: "taxonomyId",
            message: `taxonomyId ${JSON.stringify(input.taxonomyId)} must match ${ID_PATTERN}`,
          },
        ],
      };
    }
    taxonomy = deps.resolveTaxonomy?.(input.taxonomyId);
    if (!taxonomy) {
      return {
        errors: [
          {
            column: "taxonomyId",
            message: `no stored dimension taxonomy with id "${input.taxonomyId}"; CSV tag columns target a stored taxonomy (full custom books use the JSON path)`,
          },
        ],
      };
    }
  }
  return parsePositionsCsv(
    input.text,
    coa,
    {
      portfolioId: input.portfolioId,
      label: input.label,
      asOf: input.asOf,
    },
    taxonomy,
  );
}

export { parsePositionsJson } from "./positionsJson";
export { parsePositionsCsv, type CsvPortfolioHeader } from "./positionsCsv";
export { parseMarketWorkbook, type MarketWorkbookResult } from "./marketWorkbook";
export {
  toValidationResponse,
  validatePortfolioSpec,
  ID_PATTERN,
  type RowError,
  type IntakeResult,
  type IntakeSuccess,
  type IntakeFailure,
} from "./validationReport";
export {
  getCsvColumnContract,
  renderColumnContractMarkdown,
  META_COLUMNS,
  type CsvColumnContract,
  type TermsContract,
  type ColumnSpec,
  type ParamBlockSpec,
} from "./columnContract";
