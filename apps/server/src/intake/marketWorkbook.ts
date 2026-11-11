/**
 * Market snapshot workbook intake.
 *
 * A thin, honest wrapper over the kernel's existing `importMarketWorkbook`
 * (packages/kernel/src/math/rates/importWorkbook.ts): the 4-sheet market-data workbook layout
 * parser the kernel already ships and parity-tests against the Python
 * converter. This module adds nothing to the parsing; it maps the kernel's
 * thrown refusals into the intake error shape so the route can 422 with the
 * kernel's message verbatim, and it passes the kernel's ImportSummary through
 * for the caller to store beside the snapshot.
 *
 * Data constraint: any workbook a practitioner imports here stays a
 * local, internal artifact in the 127.0.0.1-bound store. This module ships no
 * market-data fixture; the unit tests build a synthetic in-memory workbook
 * with invented numbers.
 */
import {
  importMarketWorkbook,
  type ImportSummary,
  type MarketSnapshot,
} from "@alm/kernel";

export type MarketWorkbookResult =
  | { ok: true; snapshot: MarketSnapshot; summary: ImportSummary }
  | { ok: false; errors: { message: string }[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse market workbook bytes. `fallbackDate` is used as the calibration date
 * only when the filename carries no `_YYYYMMDD` suffix; it must be a stated
 * ISO date, never a platform-invented one.
 */
export function parseMarketWorkbook(
  bytes: ArrayBuffer | Uint8Array,
  fileName: string,
  fallbackDate: string,
): MarketWorkbookResult {
  if (!ISO_DATE.test(fallbackDate)) {
    return {
      ok: false,
      errors: [
        { message: `fallbackDate ${JSON.stringify(fallbackDate)} must be an ISO date (YYYY-MM-DD)` },
      ],
    };
  }
  try {
    const { snapshot, summary } = importMarketWorkbook(bytes, fileName, fallbackDate);
    return { ok: true, snapshot, summary };
  } catch (err) {
    return {
      ok: false,
      errors: [{ message: err instanceof Error ? err.message : String(err) }],
    };
  }
}

export type { ImportSummary, MarketSnapshot };
