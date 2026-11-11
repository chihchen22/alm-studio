/**
 * Acceptance check: seasoning-reanchor (W2-A3 semantics + W3-A7 run-gate lift).
 *
 * Anchor, per the report Section 3.4 (the lift's independent anchor):
 * DEGENERACY. A seasoned 24-month bullet at originationOffsetMonths -6 IS an
 * 18-month bullet. The check runs both books through the FULL pipeline
 * (base + regulatory grid) and asserts the nii / eve / gap / cashflows blocks
 * are deep-equal — the fresh twin never exercises the re-anchor code path, so
 * the oracle is independent of the lifted arithmetic.
 *
 * The one abstaining consumer, asserted rather than implied: the seasoned run
 * OMITS the ftp block and carries exactly one typed `ftp.seasoned-book`
 * register tag naming the position (the FTP par-match is not yet
 * offset-aware); the twin carries ftp and an empty register. Malformed offsets
 * still refuse typed (SeasoningError).
 */
import { FIXED_LOAN_DEFAULTS, type FixedLoanTerms } from "@alm/kernel";
import type { Position, RunResult } from "@alm/engine";
import { emptySet, gridScenarios, runSmallBook, smallBook } from "./handBooks";
import type { CapabilityCheck, CheckLine } from "./types";

function bulletBook(id: string, maturityMonths: number, originationOffsetMonths: number) {
  const terms: FixedLoanTerms = {
    ...FIXED_LOAN_DEFAULTS,
    id: `${id}-p`,
    notional: 800_000,
    maturityMonths,
    originationOffsetMonths,
    amortType: "bullet",
  };
  const positions: Position[] = [{ id: `${id}-p`, familyId: "FIXED", coaNodeId: "coa-FIXED", terms }];
  return smallBook(id, [{ id: "FIXED", side: "asset", instrumentType: "fixed-loan" }], positions);
}

function comparable(r: RunResult) {
  return JSON.stringify({ nii: r.nii, eve: r.eve, gap: r.gap, cashflows: r.cashflows });
}

export const seasoningCheck: CapabilityCheck = {
  capabilityId: "seasoning-reanchor",
  title: "D3a: seasoning re-anchored end to end for fixed-rate terms",
  run({ market }) {
    const lines: CheckLine[] = [];
    const set = emptySet();
    const seasoned = runSmallBook(bulletBook("accept-seasoned", 24, -6), market, gridScenarios(set.id), [set], "accept-seasoned-1");
    const twin = runSmallBook(bulletBook("accept-seasoned-twin", 18, 0), market, gridScenarios(set.id), [set], "accept-seasoned-twin-1");
    const observed = [
      ...seasoned.notImplemented.map((t) => t.layer),
      ...twin.notImplemented.map((t) => t.layer),
    ];

    const equal = comparable(seasoned) === comparable(twin);
    lines.push({
      id: "degeneracy",
      status: equal ? "pass" : "fail",
      detail:
        `seasoned 24M bullet at offset -6 vs fresh 18M comparator, full grid: nii/eve/gap/cashflows ` +
        `blocks deep-equal = ${equal} (anchor: a seasoned bullet IS its remaining-term comparator; ` +
        `the comparator never runs the re-anchor code, so the oracle is independent)`,
    });

    const tags = seasoned.notImplemented.filter((t) => t.layer === "ftp.seasoned-book");
    const namesPosition = tags.length === 1 && /accept-seasoned-p/.test(tags[0].reason);
    const ftpAbstains = !("ftp" in seasoned) || seasoned.ftp === undefined;
    const twinHasFtp = twin.ftp !== undefined && twin.notImplemented.length === 0;
    lines.push({
      id: "ftp-abstains-typed",
      status: tags.length === 1 && namesPosition && ftpAbstains && twinHasFtp ? "pass" : "fail",
      detail:
        `seasoned run: ftp block absent = ${ftpAbstains}, exactly one typed ftp.seasoned-book tag ` +
        `naming the position = ${namesPosition}; fresh comparator: ftp present with empty register = ` +
        `${twinHasFtp} (anchor: the FTP par-match is not offset-aware — it refuses in-register ` +
        `rather than publishing mis-timed accruals)`,
    });

    let refused = "no error";
    try {
      runSmallBook(bulletBook("accept-seasoned-bad", 24, 3), market, gridScenarios(set.id), [set], "accept-seasoned-bad-1");
    } catch (err) {
      refused = (err as Error).name;
    }
    lines.push({
      id: "malformed-offset-refuses",
      status: refused === "SeasoningError" ? "pass" : "fail",
      detail:
        `positive (forward-start) offset refuses typed: ${refused} (anchor: dynamic new business ` +
        `owns future originations; the validator's support matrix is enforced, not advisory)`,
    });

    return { lines, observedNotImplemented: observed };
  },
};
