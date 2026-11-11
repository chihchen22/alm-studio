/**
 * The rate document's error classes, in a leaf module that imports nothing from
 * rates/. `rateDocument.ts` and `clientRate.ts` both need them, and
 * `clientRate.ts` must not import `rateDocument.ts` (which imports it): a class
 * that extends a binding not yet initialised throws a ReferenceError at ESM
 * load. `rateDocument.ts` re-exports both classes, so every existing importer
 * and `instanceof` check sees the same class objects.
 */

/** Thrown for an input the builder refuses rather than guesses on. */
export class RateDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateDocumentError";
  }
}

/**
 * A client-rate row whose 10-year benchmark is not finite at some month. The row
 * is never written: no carry-forward, interpolation or zero fill, because any
 * fill would impose an unstated benchmark and break the unit-beta identity.
 */
export class ClientRateBenchmarkError extends RateDocumentError {
  readonly familyId: string;
  readonly scenarioId: string;
  /** 1-based month: index k is month k + 1. */
  readonly month: number;
  constructor(familyId: string, scenarioId: string, month: number) {
    super(
      `rate document: client-rate benchmark is not finite for family ${familyId} scenario ${scenarioId} month ${month}`,
    );
    this.name = "ClientRateBenchmarkError";
    this.familyId = familyId;
    this.scenarioId = scenarioId;
    this.month = month;
  }
}
