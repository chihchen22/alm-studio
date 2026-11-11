/**
 * The results label for index history. One Informational note after the
 * B3a formula note: each history the run's lagged indices read, whether it covers every month a lag reads (else
 * "history ends YYYY-MM; N months filled flat"), and the history's value at the as-of month beside the curve's month 0
 * and the gap, which the run never re-levels. Readiness prints the same clause (historyReadingText). Undefined when no
 * history is read, so a run without history carries the notes it carried before B3b.
 */
import type { NotImplemented } from "../contracts/errors";
import type { IndexHistoryReading } from "../contracts/indexHistory";
import { makeNotImplemented } from "../runtime/notImplemented";
import { bpText, percentText } from "./describe";

export const HISTORY_NOTE_LAYER = "plan.rate-index.history";
const months = (n: number): string => (n === 1 ? "1 month" : `${n} months`);

export function historyReadingText(r: IndexHistoryReading): string {
  const cover: string[] = [];
  // A history that starts at or after the cut-off serves no month a lag reads (no look-ahead): every such month is
  // flat, and naming its last month, which is after the cut-off, would mislead.
  if (r.firstMonth >= r.asOfMonth) {
    if (r.flatAfter > 0) cover.push(`history starts ${r.firstMonth}, at or after the cut-off; ${months(r.flatAfter)} filled flat`);
  } else {
    if (r.flatAfter > 0) cover.push(`history ends ${r.lastMonth}; ${months(r.flatAfter)} filled flat`);
    if (r.flatBefore > 0) cover.push(`history starts ${r.firstMonth}; ${months(r.flatBefore)} before it read its first value`);
  }
  if (cover.length === 0) cover.push("history covers every month a lag reads");
  const junction = r.asOfValue !== null
    ? `at ${r.asOfMonth} the history is ${percentText(r.asOfValue)} and the curve's month 0 is ${percentText(r.curveMonth0)}, a gap of ${bpText(r.curveMonth0 - r.asOfValue)}`
    : `the history has no value at ${r.asOfMonth}; the curve's month 0 is ${percentText(r.curveMonth0)}`;
  return `${r.indexId} (history ${r.historyId}, read by ${r.readBy.join(", ")}): ${cover.join("; ")}; ${junction}`;
}

export function rateIndexHistoryNote(readings: readonly IndexHistoryReading[]): NotImplemented | undefined {
  if (readings.length === 0) return undefined;
  return makeNotImplemented(
    HISTORY_NOTE_LAYER,
    `the run's lagged indices read these index histories before the cut-off: ${readings.map(historyReadingText).join("; ")}. ` +
      "A history is not shocked: every scenario and every path reads the same values. The parent's own months read the curve; " +
      "a lagged level index reads the history from its month 0, a beta index from month 1.",
  );
}
