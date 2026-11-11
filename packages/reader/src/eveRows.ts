import type { EVEResult } from "@alm/engine";

/**
 * The EVE tab shows a PV derivatives column only when a scenario
 * carries `pvDerivatives`. The engine leaves the key out on a book with no
 * swaps, so an absent column is the true statement there, not a zero.
 */
export function eveHasDerivatives(eve: EVEResult): boolean {
  return eve.byScenario.some((s) => s.pvDerivatives !== undefined);
}
