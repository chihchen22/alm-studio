/**
 * @alm/kernel — public surface of the vendored ALM math kernel.
 *
 * Re-exports the instrument, rate-path, behavioral, and analytics modules
 * copied from the kernel source, with the comment and string changes that
 * DIVERGENCE.md lists. See PROVENANCE.md.
 *
 * Note: TypeScript `export *` silently omits any member exported under the
 * same name by two modules; import such members from their specific module.
 */

// --- Instrument types and concrete instruments ---
export * from "./math/instruments/types";
export * from "./math/instruments/fixedLoan";
export * from "./math/instruments/floatingLoan";
export * from "./math/instruments/mortgage";
export * from "./math/instruments/nmd";
export * from "./math/instruments/nmdBeta";

// --- Rate path machinery ---
export * from "./math/rates/bootstrap";
export * from "./math/rates/marketData";
export * from "./math/rates/ratePath";
export * from "./math/rates/rootFind";
export * from "./math/rates/random";
export * from "./math/rates/tlpCurve";
export * from "./math/rates/rateHistory";
export * from "./math/rates/importWorkbook";
export * from "./math/rates/hwCalibrate";
export * from "./math/rates/hwPricing";
export * from "./math/rates/simulateHw";
export * from "./math/rates/bgmCalibrate";
export * from "./math/rates/bgmPricing";
export * from "./math/rates/simulateBgm";
export * from "./math/rates/sabr";
export * from "./math/rates/sabrHeuristic";

// --- Behavioral models ---
export * from "./math/behavioral/nmdModel";
export * from "./math/behavioral/mbsModel";
export * from "./math/behavioral/prepay";
export * from "./math/behavioral/cdBook";
export * from "./math/behavioral/ddaChampion";
export * from "./math/behavioral/ddaChampionPaths";
export * from "./math/behavioral/championFan";
export * from "./math/behavioral/mmaTwoSleeve";
export * from "./math/behavioral/mmaGranularPaths";
export * from "./math/behavioral/repricingSurface";
export * from "./math/behavioral/prudentialSurface";

// Names exported identically by two modules: explicit re-export picks the
// canonical source and resolves TS2308. Import from the specific module if
// you need the sibling copy.
export { discountFactor } from "./math/behavioral/cdBook";
export { walYears } from "./math/behavioral/ddaChampion";
export type { StochasticEngine } from "./math/analytics/ftpLoans";

// --- Analytics ---
export * from "./math/analytics/duration";
export * from "./math/analytics/ftp";
export * from "./math/analytics/ftpLoans";
export * from "./math/analytics/ftpNmd";
export * from "./math/analytics/ftpStochastic";
export * from "./math/analytics/seg";
export * from "./math/analytics/nmdStock";
export * from "./math/analytics/nmdFrontier";
export * from "./math/analytics/tractor";
export { flatCarry, assembleClientRate } from "./math/behavioral/clientRateModel";
