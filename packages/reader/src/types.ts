/**
 * Types for the fixture bundle the viewer reads. The run payload is the frozen
 * @alm/engine RunResult (type-only import, erased at build: no engine runtime
 * enters the browser bundle). The generatedFrom / derived / showBeforeRun wrappers
 * are produced by scripts/generateFixture.mts; their shapes are declared here.
 */
import type {
  AssumptionDiff,
  AssumptionSet,
  AttributionDriver,
  BalanceSheetSide,
  RateSpec,
  RunResult,
} from "@alm/engine";

export interface BalanceSheetTotals {
  assets: number;
  liabilities: number;
  equity: number;
  equityNodeId: string;
}

export interface GeneratedFrom {
  note: string;
  portfolioId: string;
  positionCount: number;
  asOf: string;
  seed: string;
  balanceSheet: BalanceSheetTotals;
  families: Array<{ id: string; label: string; side: BalanceSheetSide }>;
  scenarios: Array<{ id: string; label: string; rateSpec: RateSpec }>;
}

/** One step in a headline's waterfall: a driver total summed across families. */
export interface WaterfallStep {
  driver: AttributionDriver;
  amount: number;
}

/** Per-headline waterfall, aggregated in the build step from engine attribution. */
export interface Waterfall {
  metric: "nii-12m" | "nii-24m" | "eve";
  scenarioId: string;
  baseValue: number;
  scenarioValue: number;
  totalDelta: number;
  residual: number;
  steps: WaterfallStep[];
}

export interface Derived {
  note: string;
  waterfalls: Waterfall[];
}

export interface ShowBeforeRun {
  baseSet: AssumptionSet;
  candidateSet: AssumptionSet;
  diff: AssumptionDiff;
  rationale: string;
}

export interface Bundle {
  generatedFrom: GeneratedFrom;
  runResult: RunResult;
  derived: Derived;
  showBeforeRun: ShowBeforeRun;
}
