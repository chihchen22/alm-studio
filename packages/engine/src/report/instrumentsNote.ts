/**
 * The one line an older per-position results file needs (Spec P1, carried over in slice K1). Since file schema 1.1.0
 * a balance held at book (non-rate-sensitive) is valued at par, its opening balance, as EVE values it. A 1.0.0 file,
 * written before, reads 0 for it; the store is append-only, so the file is never rewritten, and every surface that
 * shows its rows (the Instruments screen, Reports' present value by position, the CSV) says so in this one line.
 */
import { INSTRUMENTS_PAR_SINCE, type InstrumentsFile } from "../contracts/instruments";

/** The line, or null: only a file older than INSTRUMENTS_PAR_SINCE that holds a balance held at book needs it. */
export function instrumentsBeforeParNote(file: Pick<InstrumentsFile, "schemaVersion" | "positions">): string | null {
  if (file.schemaVersion === INSTRUMENTS_PAR_SINCE) return null;
  if (!file.positions.some((p) => p.type === "non-rate-sensitive")) return null;
  return "This results file was made before balances held at book were valued at par, so their rows read 0. Run the setup again to value them at par, as Value (EVE) does.";
}
