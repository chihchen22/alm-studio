/**
 * Audit acceptance thresholds for the two least-squares calibrations, in
 * normal-vol basis points (model audit memo, Sec 7).
 *
 * These mirror the thresholds stated in the header of `hwCalibrate.ts` (5 bp
 * on the ATM short-rate column) and `bgmCalibrate.ts` (10 bp on the ATM
 * long-yield grid). They live here so the UI can state pass/breach against the
 * same numbers instead of hard-coding a verdict in prose: if a calibration
 * changes and the RMSE moves, the display follows it automatically.
 */

/** HW acceptance threshold, normal-vol bp on the ATM short-rate column. */
export const HW_RMSE_THRESHOLD_BP = 5;

/** BGM acceptance threshold, normal-vol bp on the ATM long-yield grid. */
export const BGM_RMSE_THRESHOLD_BP = 10;

export interface ThresholdVerdict {
  rmseBp: number;
  thresholdBp: number;
  breach: boolean;
  /** "RMSE 7.15 bp vs 5 bp target: BREACH" */
  label: string;
}

export function thresholdVerdict(rmseBp: number, thresholdBp: number): ThresholdVerdict {
  const breach = !(rmseBp <= thresholdBp);
  return {
    rmseBp,
    thresholdBp,
    breach,
    label: `RMSE ${rmseBp.toFixed(2)} bp vs ${thresholdBp} bp target: ${breach ? "BREACH" : "within target"}`,
  };
}
