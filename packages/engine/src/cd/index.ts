/**
 * CD competing-risk adapter module. Standalone this wave: nothing
 * outside packages/engine/src/cd imports from here yet. W3-A2b wires the
 * factory arm, the PositionTerms union, and the seeded book, and re-exports
 * this surface through the engine barrel (the barrel is not A2-owned).
 */
export {
  CdAdapterError,
  cdCurveMonths,
  cdMaturityMonths,
  validateCdTerms,
  type CdCohortSpec,
  type CdTerms,
  type CdWalkMark,
} from "./terms";
export { cdCurveFromPath, cdWalkMarkOf, markCdBook, markCdTerms, stripCdMarks, CD_TLP_SAMPLE_MONTHS } from "./corrections";
export { resolveCdParams, zeroHazardParams, type CdParamOverrides } from "./params";
export {
  CdBookInstrument,
  type CdAdapterOptions,
  type CdWalkDetail,
} from "./cdInstrument";
