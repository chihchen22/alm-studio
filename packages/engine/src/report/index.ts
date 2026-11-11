/**
 * Read-side report helpers (harness Plane 4, piece 2b; Plane 5).
 * Pure functions over a stored RunResult: nothing here computes a
 * balance-sheet number, it only re-groups or scores numbers the engine already
 * computed.
 */
export {
  pivot,
  PivotUnavailableError,
  PIVOT_METRICS,
  type PivotMetric,
  type PivotQuery,
  type PivotResult,
  type PivotRow,
} from "./pivot";
export { validateLens, type LensProblem } from "./lensValidate";
export {
  LENS_READERS,
  LENS_READER_IDS,
  type LensReader,
  type LensReaderId,
  type ReaderInput,
  type ReaderOutcome,
} from "./lensReaders";
export {
  readLens,
  LensUnavailableError,
  type ConstraintReading,
  type ConstraintStatus,
  type LensQuery,
  type LensReading,
  type ScenarioLensReading,
} from "./lens";
// The shipped demonstration custom metric. A read over the series the
// plan wires to it, which is why it sits with the readers.
export { computeBalanceSummary, BALANCE_SUMMARY_KEYS } from "./balanceSummary";
// The second built-in custom metric, asset and liability WAL. A read
// over the principal series the plan wires to it, so it sits with the readers.
export { computeWalGap, WAL_GAP_KEYS } from "./walGap";
// The third built-in custom metric, the survival horizon over each
// scenario's own projected flows. A read over the cash flows the
// plan wires to it.
export {
  computeSurvivalHorizon,
  SURVIVAL_HORIZON_KEYS,
  SURVIVAL_STRESS_DEMO,
  HQLA_DIMENSION,
  type SurvivalStressTable,
} from "./survivalHorizon";
// The shared HQLA buffer and the US Level 2 caps.
export {
  HQLA_HAIRCUT,
  bufferLevels,
  cappedHqla,
  classifyBufferFamilies,
  hasBufferFamily,
  type BufferClass,
  type BufferLevels,
} from "./hqlaBuffer";
// The LCR two ways, on scenario flows and on US rule run-off rates.
export {
  computeLcrRegulatory,
  computeLcrScenario,
  LCR_CATEGORY_DIMENSION,
  LCR_KEYS,
  US_LCR_RUNOFF_DEMO,
} from "./lcr";
// Stochastic Compare: aligns two stored stochastic envelopes; every
// B - A and the standard-error figure are derived here, never in a client.
export {
  compareStochastic,
  StochasticCompareError,
  type MeanDeltaBasis,
  type StochasticCompare,
  type StochasticCompareSide,
  type StochasticContextRow,
  type StochasticContextValue,
  type StochasticDistributionCompare,
  type StochasticStat,
  type StochasticStatRow,
} from "./stochasticCompare";
// Single-run stochastic summary: one stored stochastic envelope read
// as context and statistic rows; every value verbatim, none derived.
export {
  summarizeStochastic,
  StochasticSummaryError,
  type CalibrationGateState,
  type StochasticCalibrationGate,
  type StochasticRunSummary,
  type StochasticSummaryContextRow,
  type StochasticSummaryDistribution,
  type StochasticSummaryRow,
} from "./stochasticSummary";
// The one field helper a client renders, the parameters of a
// calibration arm as one text; the server's summary CSV writes it as `# calibration.parameters`.
export { calibrationParametersText } from "./stochasticFields";
// Studio A+E contract 7: income, expense and net per month per family, read off
// the stored cash flow block and the family side; net equals the stored
// netMonthly exactly, and an envelope without netMonthly returns a typed absent.
export {
  niiMonthly,
  niiMonthlyChart,
  NiiMonthlyUnavailableError,
  type NiiMonthlyChart,
  type NiiMonthlyFamilyRow,
  type NiiMonthlyReply,
  type NiiMonthlyScenario,
} from "./niiMonthly";
// Quarterly and annual roll-ups of stored monthly series, the one reader the route,
// the CSV and the Studio share. Flows sum, balances end-of-period with the average, rates a ratio of sums.
export {
  rollUpRun,
  rollUpWindows,
  rollFlow,
  rollBalance,
  rollRate,
  rollStockAtEnd,
  rollGapRows,
  isMonthlyLadder,
  RollUpOptionsError,
  ROLL_UP_RULES,
  ROLL_UP_PERIODS,
  ROLL_UP_ALIGNMENTS,
  PERIOD_MONTHS,
  type RollUpAlignment,
  type RollUpOptions,
  type RollUpPeriod,
  type RollUpReply,
  type RollUpWindow,
  type RolledFamily,
  type RolledGapRow,
  type RolledScenario,
  type SeriesIndexing,
} from "./rollUp";
// Spec P1, slice K1: the one line an older per-position results file needs.
export { instrumentsBeforeParNote } from "./instrumentsNote";
