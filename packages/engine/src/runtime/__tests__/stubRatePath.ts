/**
 * Minimal constant-rate RatePath for exercising instrument cashflow generation
 * without pulling in the bootstrap / curve machinery. Every step and every
 * tenor returns the same flat rate, which is all the factory round-trip test
 * needs: it asserts the generator runs and produces cashflows, not that the
 * numbers match a calibrated curve.
 */
import type { RatePath } from "@alm/kernel";

export class ConstantRatePath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;
  private readonly rate: number;

  constructor(rate: number, nSteps: number, dtYears: number = 1 / 12) {
    this.rate = rate;
    this.nSteps = nSteps;
    const times = new Array<number>(nSteps + 1);
    for (let k = 0; k <= nSteps; k++) times[k] = k * dtYears;
    this.times = times;
  }

  rateAt(_step: number): number {
    return this.rate;
  }

  forwardRateAt(_step: number, _tenorYears: number): number {
    return this.rate;
  }
}
