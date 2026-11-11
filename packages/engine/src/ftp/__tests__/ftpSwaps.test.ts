/**
 * FTP keeps a swap family's row and writes it as zero (spec Section
 * 4). A swap needs no funding, so nothing is transfer-priced; the row stays
 * present with a zero notional and no rates, the commitment precedent.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildTLPCurve, DEFAULT_TLP_CURVE, type MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { buildScenarioRatePath } from "../../projection/static";
import { HORIZON, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { buildBaseCurve } from "../../scenario";
import { hedgedBook, swapPosition, SWAP_FAMILY_ID } from "../../swap/__tests__/fixtures";
import { computeFtpResult } from "../computeFtp";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function ftpFor(book: PortfolioSpec) {
  const curve = buildBaseCurve(market);
  const tlp = market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE;
  const scenario: Scenario = {
    id: "S0",
    label: "S0",
    rateSpec: { kind: "base" },
    assumptionSetId: "AS-BASE",
    newBusiness: { mode: "static", rules: [] },
  };
  return computeFtpResult({
    portfolio: book,
    scenarios: [scenario],
    baseScenarioId: "S0",
    curve,
    tlp,
    path: buildScenarioRatePath(curve, scenario, HORIZON),
    horizonMonths: HORIZON,
    niiBase: { scenarioId: "S0", totalNet12: 0 },
  });
}

describe("FTP and a swap family", () => {
  it("keeps the swap row, written as zero, with no rate keys", () => {
    const ftp = ftpFor(hedgedBook("PF-FTP-SWAP", [swapPosition("SW1")]));
    const row = ftp.byFamily.find((f) => f.familyId === SWAP_FAMILY_ID)!;
    const outcome =
      `positionCount=${row.positionCount} notional=${row.notional} margin12=${row.margin12} ` +
      `couponInterest12=${row.couponInterest12} rateKeys=${["couponRate", "irFtpRate", "allInFtpRate"].filter((k) => k in row).join(",")}`;
    expect(outcome).toBe("positionCount=0 notional=0 margin12=0 couponInterest12=0 rateKeys=");
    expect(row.side).toBe("derivative");
  });

  it("moves no book figure: charges, credits, mismatch, book NIM rate and both margins are bit-identical", () => {
    const a = ftpFor(twoSidedBook("PF-FTP-0"));
    const b = ftpFor(hedgedBook("PF-FTP-1", [swapPosition("SW1")]));
    expect(b.book).toEqual(a.book);
    expect(b.nimBridge.lendingMargin12).toBe(a.nimBridge.lendingMargin12);
    expect(b.nimBridge.fundingMargin12).toBe(a.nimBridge.fundingMargin12);
    for (const r of a.byFamily) expect(b.byFamily.find((f) => f.familyId === r.familyId)).toEqual(r);
  });
});
