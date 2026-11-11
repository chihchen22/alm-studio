// apps/studio/src/results/shortfallRows.ts
/** The reinvestment shortfalls a run stored (ALM Studio P2), flattened in scenario order. Nothing is computed. */
import type { RunResult } from "@alm/engine";

export interface ShortfallRow {
  scenarioId: string;
  familyId: string;
  reinvest: string;
  targetBalanceEnd: number;
  achievedBalanceEnd: number;
  balanceGapEnd: number;
  firstBucket: number;
  clampedBuckets: number;
}

export function shortfallRows(result: RunResult): ShortfallRow[] {
  return (result.nii?.byScenario ?? []).flatMap((s) => (s.shortfalls ?? []).map((f) => ({
    scenarioId: s.scenarioId,
    familyId: f.familyId,
    reinvest: f.reinvest,
    targetBalanceEnd: f.targetBalanceEnd,
    achievedBalanceEnd: f.achievedBalanceEnd,
    balanceGapEnd: f.balanceGapEnd,
    firstBucket: f.firstBucket,
    clampedBuckets: f.clampedBuckets,
  })));
}
