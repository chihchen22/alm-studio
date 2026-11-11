/**
 * Stable identifiers used across the engine contracts.
 *
 * Plain string aliases: they document intent without the ceremony of hard
 * brands, which a prototype does not need. Every id is caller-assigned and must
 * be stable across runs, because provenance hashes and result joins key on
 * them. Two runs that reuse an id are asserting the same object.
 */
export type CoaNodeId = string;
export type ProductFamilyId = string;
export type PositionId = string;
export type PortfolioId = string;
export type ScenarioId = string;
export type AssumptionSetId = string;
export type RunId = string;

/**
 * Balance-sheet side. "equity" is a plug node in the chart of accounts, never
 * an instrument: the engine derives it as assets minus liabilities at t=0.
 *
 * "derivative" is a swap family's side. A swap has no booked
 * balance, so every fold that sums "asset" or "liability" excludes it BY
 * DEFAULT, and the folds that must see it opt in through
 * ../swap/derivatives.ts. A missed fold therefore drops the hedge rather than
 * printing a wrong asset number.
 */
export type BalanceSheetSide = "asset" | "liability" | "equity" | "derivative";
