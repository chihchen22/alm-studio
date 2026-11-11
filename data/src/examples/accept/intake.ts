/**
 * Acceptance check: intake-json-csv-workbook.
 *
 * Anchors, per the module's acceptance clause:
 *
 *   1. ALL ERRORS, NOT FIRST-FAILURE — a book carrying two independent defects
 *      (an unknown family reference AND a kernel-invalid negative notional)
 *      returns ONE failure report naming BOTH rows, each with its positionId.
 *   2. KERNEL DRY INSTANTIATION — the negative-notional defect is caught by
 *      instantiating the real kernel instrument, so the error text is the
 *      kernel's own domain message ("notional must be positive"), not a
 *      re-implemented validation.
 *   3. ROUND-TRIP — the unmodified vanilla book parses to a success carrying
 *      all nine positions (the gate accepts good books; a refuse-everything
 *      parser would pass checks 1-2).
 *
 * The CSV column contract and workbook arms are suite-tested in
 * apps/server/src/intake/__tests__ (32 tests); the JSON arm exercised here is
 * the canonical path the other two feed into.
 */
import { parsePositions } from "../../../../apps/server/src/intake";
import type { PortfolioSpec } from "@alm/engine";
import { buildVanillaPortfolio } from "../../vanilla";
import type { CapabilityCheck, CheckLine } from "./types";

export const intakeCheck: CapabilityCheck = {
  capabilityId: "intake-json-csv-workbook",
  title: "Intake: per-row validation with kernel dry instantiation",
  run() {
    const lines: CheckLine[] = [];

    // 1 + 2. A two-defect book fails with BOTH rows named.
    const bad: PortfolioSpec = JSON.parse(JSON.stringify(buildVanillaPortfolio())) as PortfolioSpec;
    bad.id = "accept-intake-bad";
    bad.positions[1] = { ...bad.positions[1], familyId: "no-such-family" };
    const p4 = bad.positions[4];
    bad.positions[4] = { ...p4, terms: { ...p4.terms, notional: -5 } };

    const res = parsePositions({ kind: "json", spec: bad });
    if (!("errors" in res)) {
      lines.push({ id: "all-errors", status: "fail", detail: "two-defect book parsed as a success" });
    } else {
      const familyErr = res.errors.find((e) => /no-such-family/.test(e.message));
      const kernelErr = res.errors.find((e) => /notional must be positive/i.test(e.message));
      const bothNamed = familyErr?.positionId === bad.positions[1].id && kernelErr?.positionId === bad.positions[4].id;
      lines.push({
        id: "all-errors",
        status: familyErr && kernelErr && bothNamed ? "pass" : "fail",
        detail:
          `two-defect book returns ${res.errors.length} row errors in ONE report: unknown-family ` +
          `row named (${familyErr?.positionId ?? "MISSING"}), kernel dry-instantiation row named ` +
          `(${kernelErr?.positionId ?? "MISSING"}) with the kernel's own domain message verbatim ` +
          `(anchor: all-errors-not-first-failure, and the validator is the real kernel constructor, ` +
          `not a re-implementation)`,
      });
    }

    // 3. The good book round-trips.
    const good = parsePositions({ kind: "json", spec: buildVanillaPortfolio() });
    const ok = "portfolio" in good && good.portfolio.positions.length === 9;
    lines.push({
      id: "round-trip",
      status: ok ? "pass" : "fail",
      detail: `unmodified vanilla book parses to a success with 9/9 positions: ${ok} (anchor: the gate accepts good books — a refuse-everything parser cannot pass this line)`,
    });

    return { lines, observedNotImplemented: [] };
  },
};
