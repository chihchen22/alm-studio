/**
 * Acceptance battery check: key-rate durations + EVE channel decomposition.
 * Registered by W3-V2 in ./registry.ts (registry and the
 * declared-deferred status flip are V2-owned per the collision ledger; this
 * file ships with W3-A5 so the check exists in the same window as the
 * capability). Anchors, each line
 * printing the MEASURED value:
 *
 *   1. vanilla reconciliation — the nine-position vanilla book's KRD sum
 *      lands on the pinned 5.37 base equity duration within the convergence
 *      tolerance (the book is fully fixed-rate, so the only gap is bump-size
 *      convexity: 25bp KRD machinery vs the pinned ±100bp measurement).
 *   2. additivity-plus-convergence gate — the residual versus the
 *      same-machinery parallel reference falls roughly four-fold when the
 *      bump halves (the alm-eve gate; a small residual that does not converge
 *      is a construction error, and the gate says so).
 *   3. channel degeneracy — on the path-independent vanilla book every
 *      shocked scenario's projection channel and interaction remainder are
 *      EXACTLY zero and the total equals the discounting channel (bit
 *      identity, not tolerance).
 *
 * Both capabilities are OFF by default on the run pipeline (cost-labeled
 * opt-ins); this check opts in through the exported RunPipelineContext flags.
 */
import {
  buildRunResult,
  resolveDefaultContext,
  type RunPipelineContext,
  type RunRequest,
} from "@alm/engine";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "../../vanilla";
import type { CapabilityCheck, CapabilityCheckResult, CheckLine } from "./types";

/**
 * The pinned vanilla base equity duration, measured by the ±100bp duration
 * engine. It was re-pinned from 5.43 at the public-basis re-base of 2026-09-24.
 */
const PINNED_EQUITY_DURATION = 5.37;
/**
 * Reconciliation tolerance for the 25bp working-bump sum against the ±100bp
 * pin. Two disclosed components, both measured on the vanilla book: bump-width
 * convexity between a 25bp and a 100bp central difference (~6.5e-3y — a
 * smaller bump reads slightly less convexity premium) plus the 25bp
 * additivity residual (~3.2e-4y). NOT a loosened gate: the additivity anchor
 * itself is the same-bump residual line below, at its own tight tolerance.
 */
const PIN_TOLERANCE_25BP = 0.02;
/**
 * At the pin's own 100bp bump the width effect vanishes and only the
 * (second-order, 16x the 25bp) additivity residual separates the sum from the
 * pinned golden (measured ~5e-3y).
 */
const PIN_TOLERANCE_100BP = 0.01;
const TS = { startedAt: "2026-08-02T00:00:00.000Z", finishedAt: "2026-08-02T00:00:00.000Z" };

export const keyRateCheck: CapabilityCheck = {
  // Register id: the plan named this capability "krd-channel-decomposition"
  // in declared-deferred.json before the module existed; the check binds to the
  // plan's id rather than minting a second one (at registration).
  capabilityId: "krd-channel-decomposition",
  title: "Key-rate durations + EVE channel decomposition (opt-in)",
  run(ctx): CapabilityCheckResult {
    const lines: CheckLine[] = [];
    const portfolio = buildVanillaPortfolio();
    const set = vanillaAssumptionSet();
    const request: RunRequest = {
      runId: "accept-keyrate-1",
      portfolioId: portfolio.id,
      marketSnapshot: ctx.market,
      scenarios: vanillaScenarios(set.id),
      assumptionSets: [set],
      grid: { horizonMonths: 360, asOf: portfolio.asOf },
      seed: "accept-keyrate",
      timestamps: { ...TS },
    };
    const context: RunPipelineContext = {
      ...resolveDefaultContext(),
      keyRate: true,
      eveChannels: true,
    };
    const result = buildRunResult(request, portfolio, context);
    const observed = result.notImplemented.map((t) => t.layer);

    const kr = result.eve.keyRate;
    if (!kr) {
      lines.push({
        id: "keyrate-present",
        status: "fail",
        detail:
          "keyRate block absent on the vanilla opt-in run (no regime-amplified positions exist there; the block must land)",
      });
      return { lines, observedNotImplemented: observed };
    }

    // 1a. Vanilla reconciliation to the pinned golden at the working 25bp bump
    // (bump-width convexity disclosed in the tolerance constant's doc).
    const gap = Math.abs(kr.sum - PINNED_EQUITY_DURATION);
    lines.push({
      id: "vanilla-sum",
      status: gap <= PIN_TOLERANCE_25BP ? "pass" : "fail",
      detail:
        `KRD sum ${kr.sum.toFixed(6)}y over ${kr.nodes.length} curve nodes vs pinned base ` +
        `equity duration ${PINNED_EQUITY_DURATION.toFixed(2)} (±100bp engine) — |gap| ` +
        `${gap.toExponential(2)} <= ${PIN_TOLERANCE_25BP} (anchor: the hand-checkable vanilla ` +
        `golden; the gap is measured 25bp-vs-100bp width convexity; same-machinery parallel ` +
        `reference ${kr.parallelReference.toFixed(6)}y at ${kr.bumpBp}bp)`,
    });

    // 1b. At the pin's own 100bp bump the width effect vanishes: the sum must
    // sit on the pinned golden up to the (residual-only) tolerance.
    const result100 = buildRunResult(
      { ...request, runId: "accept-keyrate-100" },
      portfolio,
      { ...resolveDefaultContext(), keyRate: { bumpBp: 100 } },
    );
    const kr100 = result100.eve.keyRate;
    if (!kr100) {
      lines.push({ id: "vanilla-sum-100bp", status: "fail", detail: "keyRate block absent at bumpBp 100" });
    } else {
      const gap100 = Math.abs(kr100.sum - PINNED_EQUITY_DURATION);
      lines.push({
        id: "vanilla-sum-100bp",
        status: gap100 <= PIN_TOLERANCE_100BP ? "pass" : "fail",
        detail:
          `KRD sum ${kr100.sum.toFixed(6)}y at the pin's own 100bp bump vs pinned ` +
          `${PINNED_EQUITY_DURATION.toFixed(2)} — |gap| ${gap100.toExponential(2)} <= ` +
          `${PIN_TOLERANCE_100BP} (anchor: same-bump reconciliation, only the additivity ` +
          `residual ${kr100.convergence.residualYears.toExponential(3)}y separates them)`,
      });
      observed.push(...result100.notImplemented.map((t) => t.layer));
    }

    // 2. The additivity-plus-convergence gate, with the measured residuals.
    const c = kr.convergence;
    lines.push({
      id: "convergence-gate",
      status: c.converged ? "pass" : "fail",
      detail:
        `additivity residual ${c.residualYears.toExponential(3)}y at ${kr.bumpBp}bp -> ` +
        `${c.residualYearsAtHalvedBump.toExponential(3)}y at ${c.halvedBumpBp}bp, ratio ` +
        `${c.ratio === undefined ? "n/a (below floor)" : c.ratio.toFixed(3)} (anchor: second-order ` +
        `central-difference scaling — the residual must FALL roughly four-fold under bump halving, ` +
        `alm-eve convention; converged=${c.converged})`,
    });

    // 3. Channel degeneracy on the path-independent vanilla book.
    const ch = result.eve.channels;
    if (!ch || ch.byScenario.length === 0) {
      lines.push({
        id: "channels-degeneracy",
        status: "fail",
        detail: "channels block absent or empty on the vanilla opt-in run",
      });
    } else {
      let exact = true;
      for (const row of ch.byScenario) {
        if (row.projectionDelta !== 0 || row.interactionResidual !== 0) exact = false;
        if (row.totalDelta !== row.discountingDelta) exact = false;
      }
      const worst = Math.max(
        ...ch.byScenario.map((r) => Math.max(Math.abs(r.projectionDelta), Math.abs(r.interactionResidual))),
      );
      lines.push({
        id: "channels-degeneracy",
        status: exact ? "pass" : "fail",
        detail:
          `projection channel and interaction remainder EXACTLY 0 across ${ch.byScenario.length} ` +
          `shocked scenarios (max |value| ${worst}), total === discounting channel bit-exact ` +
          `(anchor: a fixed-rate book regenerates bit-identical cash flows under any path — ` +
          `the path-independence degeneracy)`,
      });
    }

    return { lines, observedNotImplemented: observed };
  },
};
