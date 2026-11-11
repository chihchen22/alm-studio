/**
 * CSV of the per-position results file: one row per position per
 * scenario, the position columns repeated on each of its rows. The first line is
 * the header, with no comment rows above it, so a spreadsheet opens it as a
 * table; the run id rides in the download's file name. Every cell is the
 * verbatim file value at full float precision (no rounding); an absent optional
 * field is an empty cell. The SEG columns repeat the position's base-scenario
 * constant-balance scalars on each scenario row, because they belong to the
 * position, not to the scenario. A file written before Spec P1 (schema 1.0.0) that holds a balance held at book ends
 * with one "# note" row saying its rows read 0 for those balances.
 */
import { instrumentsBeforeParNote, type InstrumentsFile } from "@alm/engine";
import { cell } from "./csv";

export const INSTRUMENTS_CSV_COLUMNS = [
  "positionId",
  "parentPositionId",
  "familyId",
  "coaNodeId",
  "side",
  "type",
  "notional",
  "discountSpreadBp",
  "walMonths",
  "firstRepricingMonth",
  "scenarioId",
  "pv",
  "nii12",
  "balance12",
  "principal12",
  "segNiiBase12",
  "segNiiUp12",
  "segNiiDown12",
  "segPeak",
] as const;

export function instrumentsCsv(file: InstrumentsFile): string {
  const lines: string[] = [INSTRUMENTS_CSV_COLUMNS.join(",")];
  for (const p of file.positions) {
    for (const s of p.byScenario) {
      lines.push(
        [
          p.positionId,
          p.parentPositionId,
          p.familyId,
          p.coaNodeId,
          p.side,
          p.type,
          p.notional,
          p.discountSpreadBp,
          p.walMonths,
          p.firstRepricingMonth,
          s.scenarioId,
          s.pv,
          s.nii12,
          s.balance12,
          s.principal12,
          p.seg?.niiBase12,
          p.seg?.niiUp12,
          p.seg?.niiDown12,
          p.seg?.segPeak,
        ]
          .map(cell)
          .join(","),
      );
    }
  }
  // Spec P1, slice K1: an older file's balances held at book read 0. The header stays the first line, so a spreadsheet
  // still opens the table; the one line follows the rows as a "# note" row, the comment form the other CSVs use.
  const older = instrumentsBeforeParNote(file);
  if (older !== null) lines.push(`# note,${cell(older)}`);
  return `${lines.join("\r\n")}\r\n`;
}
