/**
 * Read side of the tool surface: queryResults (a JSON slice of a completed run)
 * and explain (a narration assembled ONLY from the run's attribution).
 *
 * Both are pure reads over a cached RunResult; neither recomputes a number.
 * queryResults narrows the cached result by metric and optional scenario/family
 * and returns the cached sub-object unchanged (so the slice equals the cache).
 * explain answers a headline movement from the AttributionResult the run already
 * computed, and declares supported=false with an honest reason where attribution
 * cannot support the question.
 */
import type { ExplainQuery, Explanation, ResultQuery, ResultSlice } from "../contracts/tools";
import type { DriverContribution, HeadlineAttribution } from "../contracts/results";
import type { RunResult } from "../contracts/run";
import { PEEL_ORDER } from "../attribution";

/** Slice a completed run by metric and optional scenario/family. Never recomputes. */
export function sliceResult(result: RunResult, query: ResultQuery): ResultSlice {
  const { metric, scenarioId, familyId } = query;
  let data: unknown;

  switch (metric) {
    case "nii": {
      if (scenarioId === undefined) {
        data = result.nii;
        break;
      }
      const scn = result.nii.byScenario.find((s) => s.scenarioId === scenarioId);
      if (!scn) throw new Error(`queryResults: nii has no scenario "${scenarioId}"`);
      if (familyId === undefined) {
        data = scn;
        break;
      }
      const fam = scn.byFamily.find((f) => f.familyId === familyId);
      if (!fam) throw new Error(`queryResults: nii scenario "${scenarioId}" has no family "${familyId}"`);
      data = fam;
      break;
    }
    case "eve": {
      if (scenarioId === undefined) {
        data = result.eve;
        break;
      }
      const scn = result.eve.byScenario.find((s) => s.scenarioId === scenarioId);
      if (!scn) throw new Error(`queryResults: eve has no scenario "${scenarioId}"`);
      if (familyId === undefined) {
        data = scn;
        break;
      }
      const fam = scn.byFamily.find((f) => f.familyId === familyId);
      if (!fam) throw new Error(`queryResults: eve scenario "${scenarioId}" has no family "${familyId}"`);
      data = fam;
      break;
    }
    case "repricing-gap":
    case "liquidity-gap": {
      const ladders = metric === "repricing-gap" ? result.gap.repricing : result.gap.liquidity;
      if (scenarioId === undefined) {
        data = ladders;
        break;
      }
      const ladder = ladders.find((l) => l.scenarioId === scenarioId);
      if (!ladder) throw new Error(`queryResults: ${metric} has no scenario "${scenarioId}"`);
      data = ladder;
      break;
    }
    case "cashflows": {
      if (scenarioId === undefined) {
        data = result.cashflows;
        break;
      }
      const scn = result.cashflows.byScenario.find((s) => s.scenarioId === scenarioId);
      if (!scn) throw new Error(`queryResults: cashflows has no scenario "${scenarioId}"`);
      if (familyId === undefined) {
        data = scn;
        break;
      }
      const fam = scn.byFamily.find((f) => f.familyId === familyId);
      if (!fam) {
        throw new Error(`queryResults: cashflows scenario "${scenarioId}" has no family "${familyId}"`);
      }
      data = fam;
      break;
    }
    default: {
      const bad = metric as string;
      throw new Error(`queryResults: unrecognized metric "${bad}"`);
    }
  }

  return { runId: query.runId, metric, data };
}

/** Fixed-precision text for a dollar amount in a narration string. */
function fmt(x: number): string {
  return x.toFixed(2);
}

/** Aggregate contributions to per-driver totals in PEEL_ORDER (deterministic). */
function driverTotals(headline: HeadlineAttribution): Array<{ driver: string; amount: number }> {
  const byDriver = new Map<string, number>();
  for (const c of headline.contributions) {
    byDriver.set(c.driver, (byDriver.get(c.driver) ?? 0) + c.amount);
  }
  return PEEL_ORDER.map((driver) => ({ driver, amount: byDriver.get(driver) ?? 0 }));
}

/**
 * Explain a headline movement from the run's attribution. Supported when a
 * matching headline exists and its residual is within the reconstruction
 * tolerance; otherwise supported=false with a reason.
 */
export function explainResult(result: RunResult, query: ExplainQuery): Explanation {
  const { metric, scenarioId } = query;
  const headline = result.attribution.headlines.find(
    (h) => h.metric === metric && h.scenarioId === scenarioId,
  );

  if (!headline) {
    return {
      supported: false,
      answer:
        `No attribution headline is available for ${metric} in scenario "${scenarioId}". ` +
        `Attribution is produced only for shocked scenarios whose sole difference from the base is the rate environment; ` +
        `the base scenario has no movement versus base to decompose.`,
      attribution: null,
      citations: [],
    };
  }

  const tol = 1e-6 * Math.max(1, Math.abs(headline.baseValue), Math.abs(headline.scenarioValue));

  if (Math.abs(headline.residual) > tol) {
    return {
      supported: false,
      answer:
        `The ${metric} movement in scenario "${scenarioId}" of ${fmt(headline.totalDelta)} versus base is not ` +
        `fully reconstructed by the enumerated drivers: the decomposition leaves a residual of ${fmt(headline.residual)}, ` +
        `above the reconstruction tolerance, so a driver-level explanation is not supported.`,
      attribution: headline,
      citations: [],
    };
  }

  // Cite the drivers that actually moved the metric, largest first.
  const citations: DriverContribution[] = headline.contributions
    .filter((c) => Math.abs(c.amount) > tol)
    .slice()
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const material = driverTotals(headline).filter((d) => Math.abs(d.amount) > tol);
  const drivers = material.map((d) => `${d.driver} ${fmt(d.amount)}`).join(", ");
  const answer =
    `In scenario "${scenarioId}", ${metric} moved ${fmt(headline.totalDelta)} versus base ` +
    `(${fmt(headline.baseValue)} to ${fmt(headline.scenarioValue)}). ` +
    (drivers.length > 0
      ? `The movement is attributed to: ${drivers}. `
      : `No single driver contributes a material amount. `) +
    `Residual ${fmt(headline.residual)}.`;

  return { supported: true, answer, attribution: headline, citations };
}
