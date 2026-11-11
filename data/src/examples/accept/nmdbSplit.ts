/**
 * Acceptance check: nmdb-beta-ladder-split (W1-H3 fix, live in the run
 * pipeline since the chunk.ts step).
 *
 * Anchor: the KERNEL'S OWN SPLIT.
 * `NMDBeta.initialBeta(path)` is the documented rate-locked-vs-repricing
 * decomposition; the acceptance oracle is that kernel value, not a number this
 * battery invents. For an interest-bearing NMD family the run-level repricing
 * ladder must show
 *
 *   band 0   = beta * (total runoff)  +  (1 - beta) * runoff[band 0]
 *   band b>0 =                           (1 - beta) * runoff[band b]
 *
 * where the runoff basis is the family's own liquidity ladder from the SAME
 * run. Conservation (bands re-sum to the family balance) and the non-IB
 * control (a plain `nmd` family stays pure runoff) complete the anchor.
 */
import { NMDBeta, NMD_B_TERMS_DEFAULTS, NMD_TERMS_DEFAULTS, type NMDBetaTerms, type NMDTerms } from "@alm/kernel";
import type { Position, RunResult } from "@alm/engine";
import { buildBaseCurve } from "@alm/engine/src/scenario";
import { buildScenarioRatePath } from "@alm/engine/src/projection/static";
import { baseScenario, emptySet, runSmallBook, smallBook } from "./handBooks";
import type { CapabilityCheck, CheckLine } from "./types";

const MMA_NOTIONAL = 2_000_000;
const DDA_NOTIONAL = 3_000_000;

function rows(result: RunResult, kind: "repricing" | "liquidity", nodeId: string) {
  const ladder = result.gap[kind].find((g) => g.scenarioId === "S0")!;
  return ladder.byCoaNode.find((n) => n.coaNodeId === nodeId)!.rows;
}

export const nmdbSplitCheck: CapabilityCheck = {
  capabilityId: "nmdb-beta-ladder-split",
  title: "D2: NMD-B beta x balance repricing slice via kernel initialBeta",
  run({ market }) {
    const lines: CheckLine[] = [];
    const set = emptySet();
    const mmaTerms: NMDBetaTerms = { ...NMD_B_TERMS_DEFAULTS, id: "mma-1", notional: MMA_NOTIONAL };
    const ddaTerms: NMDTerms = { ...NMD_TERMS_DEFAULTS, id: "dda-1", notional: DDA_NOTIONAL };
    const positions: Position[] = [
      { id: "mma-1", familyId: "MMA", coaNodeId: "coa-MMA", terms: mmaTerms },
      { id: "dda-1", familyId: "DDA", coaNodeId: "coa-DDA", terms: ddaTerms },
    ];
    const book = smallBook(
      "accept-nmdb",
      [
        { id: "MMA", side: "liability", instrumentType: "nmd-b" },
        { id: "DDA", side: "liability", instrumentType: "nmd" },
      ],
      positions,
    );
    const result = runSmallBook(book, market, [baseScenario(set.id)], [set], "accept-nmdb-1");

    // The kernel oracle: initialBeta at the base scenario's own t=0 rate path.
    const curve = buildBaseCurve(market);
    const path = buildScenarioRatePath(curve, baseScenario(set.id), 360);
    const beta = new NMDBeta(mmaTerms).initialBeta(path);
    const interior = beta > 0 && beta < 1;

    const repr = rows(result, "repricing", "coa-MMA").map((r) => r.liabilities);
    const liq = rows(result, "liquidity", "coa-MMA").map((r) => r.liabilities);
    const liqTotal = liq.reduce((a, b) => a + b, 0);

    // Band-wise independent expectation from the kernel beta + the run's own
    // liquidity (runoff) ladder.
    let worst = 0;
    for (let b = 0; b < repr.length; b++) {
      const want = b === 0 ? beta * liqTotal + (1 - beta) * liq[0] : (1 - beta) * liq[b];
      worst = Math.max(worst, Math.abs(repr[b] - want) / Math.max(1, liqTotal));
    }
    lines.push({
      id: "beta-split",
      status: interior && worst <= 1e-9 ? "pass" : "fail",
      detail:
        `NMD-B repricing bands reproduce beta*total-in-band-0 + (1-beta)*runoff with kernel ` +
        `initialBeta = ${beta.toFixed(6)} (strictly interior: ${interior}); worst band deviation ` +
        `${worst.toExponential(2)} <= 1e-9 relative (anchor: the kernel's own rate-locked vs ` +
        `repricing decomposition — the oracle is initialBeta(), not a battery-invented number)`,
    });

    const reprTotal = repr.reduce((a, b) => a + b, 0);
    const conserved = Math.abs(reprTotal - liqTotal) / Math.max(1, liqTotal);
    lines.push({
      id: "conservation",
      status: conserved <= 1e-9 ? "pass" : "fail",
      detail:
        `NMD-B repricing total $${reprTotal.toFixed(2)} equals liquidity total ` +
        `$${liqTotal.toFixed(2)} to ${conserved.toExponential(2)} relative ` +
        `(anchor: beta + (1-beta) = 1 per dollar — conservation by construction)`,
    });

    // Non-IB control: DDA repricing rows equal its liquidity rows exactly.
    const ddaRepr = rows(result, "repricing", "coa-DDA").map((r) => r.liabilities);
    const ddaLiq = rows(result, "liquidity", "coa-DDA").map((r) => r.liabilities);
    const same = ddaRepr.length === ddaLiq.length && ddaRepr.every((v, i) => v === ddaLiq[i]);
    lines.push({
      id: "non-ib-untouched",
      status: same ? "pass" : "fail",
      detail:
        `non-interest-bearing NMD repricing rows deep-equal its liquidity rows (bit): ${same} ` +
        `(anchor: a 0%-paying deposit has no beta slice; pure runoff is the correct treatment)`,
    });

    return { lines, observedNotImplemented: result.notImplemented.map((t) => t.layer) };
  },
};
