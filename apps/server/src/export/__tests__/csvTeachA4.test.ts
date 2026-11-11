/**
 * The bucket, interest and FTP tables of the CSV export. Each one is the stored envelope
 * verbatim, so a learner can take the table on screen into a spreadsheet and tie it to the book. Expected bytes are
 * restated by hand. The six older tables keep their bytes: no note line, no new column.
 */
import { describe, expect, it } from "vitest";
import type { RunResult } from "@alm/engine";
import { buildTable, EXPORT_TABLES, renderCsv, tableRefusal } from "../csv";

const band = (label: string, startMonth: number, endMonth: number) => ({ label, startMonth, endMonth });
const row = (label: string, s: number, e: number, assets: number, liabilities: number, cum: number) => ({
  band: band(label, s, e), assets, liabilities, gap: assets - liabilities, cumulativeGap: cum,
});

function result(): RunResult {
  const std = [row("0-1M", 0, 1, 100.125, 40, 60.125), row("1-3M", 1, 3, 10, 20, 50.125)];
  const liq = {
    kind: "liquidity", scenarioId: "S0", rows: std, byCoaNode: [],
    userBuckets: { kind: "monthly", rows: [row("M1", 0, 1, 1.5, 0.25, 1.25)] },
    withInterest: {
      rows: [row("0-1M", 0, 1, 101, 41, 60), row("1-3M", 1, 3, 11, 21, 50)],
      userBuckets: { kind: "monthly", rows: [row("M1", 0, 1, 2, 1, 1)] },
      interest: {
        rows: [row("0-1M", 0, 1, 0.875, 1, -0.125), row("1-3M", 1, 3, 1, 1, -0.125)],
        userBuckets: { kind: "monthly", rows: [row("M1", 0, 1, 0.5, 0.75, -0.25)] },
      },
    },
  };
  const rep = {
    kind: "repricing", scenarioId: "S0", rows: std, byCoaNode: [],
    userBuckets: { kind: "custom", edgesMonths: [3], rows: [row("0-3M", 0, 3, 110.125, 60, 50.125)] },
  };
  const ftp = {
    scenarioId: "S0", irBasis: "risk-free", allInBasis: "risk-free-plus-tlp",
    byFamily: [
      { familyId: "loans", side: "asset", positionCount: 3, notional: 1000, couponRate: 0.0612345678, irFtpRate: 0.04, lpFtpRate: 0.005, allInFtpRate: 0.045, ftpMarginRate: 0.0162345678, couponInterest12: 61.2, ftpAccrual12: 45, margin12: 16.2, monthly: {} },
      { familyId: "empty", side: "liability", positionCount: 0, notional: 0, couponInterest12: 0, ftpAccrual12: 0, margin12: 0, monthly: {} },
    ],
    book: { bookNimRate: 0.0162345678, charges12: 45, credits12: 0, mismatchCenter12: 45 },
    nimBridge: { horizonMonths: 12, lendingMargin12: 16.2, fundingMargin12: 0, mismatchCenter12: 45, bridgeNet12: 61.2, niiNet12: 61.2 },
    shockedScenarios: { layer: "ftp-shocked", reason: "r" },
  };
  return { gap: { repricing: [rep], liquidity: [liq] }, ftp } as unknown as RunResult;
}

const prov = { runId: "r1", inputsHash: "h", curve: "c", schemaVersion: "s", engineVersion: "e" };
const NOTE = "# note,Every value is the stored engine figure at full precision; the screen rounds for display.";
const lines = (r: RunResult, t: Parameters<typeof buildTable>[1]) => renderCsv(buildTable(r, t), prov, "t").split("\r\n");

describe("the slice A4 export tables", () => {
  it("adds four tables after the six, in order (and S3d-1 two after those)", () => {
    expect(EXPORT_TABLES).toEqual(["nii", "eve", "repricing-gap", "liquidity-gap", "attribution", "cashflows", "repricing-gap-buckets", "liquidity-gap-buckets", "liquidity-gap-interest", "ftp", "liquidity-stress", "survival-path"]);
  });

  it("exports the run's own buckets with their kind, every figure as stored", () => {
    expect(lines(result(), "repricing-gap-buckets").slice(5)).toEqual([
      "# generatedAt,t", NOTE,
      "scenarioId,buckets,band,startMonth,endMonth,assets,liabilities,gap,cumulativeGap",
      "S0,custom,0-3M,0,3,110.125,60,50.125,50.125",
      "",
    ]);
    expect(lines(result(), "liquidity-gap-buckets")[8]).toBe("S0,monthly,M1,0,1,1.5,0.25,1.25,1.25");
  });

  it("exports the interest-inclusive ladder: standard bands then the run's buckets, total then interest on its own", () => {
    expect(lines(result(), "liquidity-gap-interest").slice(7)).toEqual([
      "scenarioId,buckets,band,startMonth,endMonth,assets,liabilities,gap,cumulativeGap,interestIncome,interestExpense,netInterest,cumulativeNetInterest",
      "S0,standard,0-1M,0,1,101,41,60,60,0.875,1,-0.125,-0.125",
      "S0,standard,1-3M,1,3,11,21,-10,50,1,1,0,-0.125",
      "S0,monthly,M1,0,1,2,1,1,1,0.5,0.75,-0.25,-0.25",
      "",
    ]);
  });

  it("leaves the interest columns blank when the stored ladder carries no interest rows", () => {
    const r = result();
    delete (r.gap.liquidity[0]!.withInterest as { interest?: unknown }).interest;
    expect(tableRefusal(r, "liquidity-gap-interest")).toBeNull();
    expect(lines(r, "liquidity-gap-interest")[8]).toBe("S0,standard,0-1M,0,1,101,41,60,60,,,,");
  });

  it("exports FTP by family, the book roll-up and the NIM bridge; an absent rate is a blank cell, never 0", () => {
    const l = lines(result(), "ftp").slice(7);
    expect(l[0]).toBe(
      "scenarioId,rowType,familyId,side,positionCount,notional,couponRate,irFtpRate,lpFtpRate,allInFtpRate,ftpMarginRate,couponInterest12,ftpAccrual12,margin12," +
        "irBasis,allInBasis,bookNimRate,charges12,credits12,mismatchCenter12,horizonMonths,lendingMargin12,fundingMargin12,derivativesNet12,bridgeNet12,newBusinessNet12,niiNet12",
    );
    expect(l[1]).toBe("S0,family,loans,asset,3,1000,0.0612345678,0.04,0.005,0.045,0.0162345678,61.2,45,16.2,,,,,,,,,,,,,");
    expect(l[2]).toBe("S0,family,empty,liability,0,0,,,,,,0,0,0,,,,,,,,,,,,,");
    expect(l[3]).toBe("S0,book,,,,,,,,,,,,,risk-free,risk-free-plus-tlp,0.0162345678,45,0,45,,,,,,,");
    expect(l[4]).toBe("S0,bridge,,,,,,,,,,,,,,,,,,45,12,16.2,0,,61.2,,61.2");
  });

  it("refuses a table the run does not store, by name, and passes one it does", () => {
    const r = result();
    for (const t of ["repricing-gap-buckets", "liquidity-gap-buckets", "liquidity-gap-interest", "ftp"] as const) expect(tableRefusal(r, t)).toBeNull();
    delete r.gap.repricing[0]!.userBuckets;
    delete r.gap.liquidity[0]!.userBuckets;
    delete r.gap.liquidity[0]!.withInterest;
    delete r.ftp;
    expect(tableRefusal(r, "repricing-gap-buckets")).toBe(
      "this run stores the repricing gap in the nine standard bands only (no gap.repricing userBuckets); export repricing-gap.csv instead",
    );
    expect(tableRefusal(r, "liquidity-gap-buckets")).toBe(
      "this run stores the liquidity gap in the nine standard bands only (no gap.liquidity userBuckets); export liquidity-gap.csv instead",
    );
    expect(tableRefusal(r, "liquidity-gap-interest")).toBe(
      'this run stores no interest-inclusive liquidity ladder (gap.liquidity withInterest is absent): the run did not ask for liquidity flows "principal-plus-interest"',
    );
    expect(tableRefusal(r, "ftp")).toBe("this run's result carries no ftp block (the run setup turned FTP off, or the envelope predates the block)");
    for (const t of ["nii", "eve", "repricing-gap", "liquidity-gap", "attribution", "cashflows"] as const) expect(tableRefusal(r, t)).toBeNull();
  });

  it("refuses an interest row on a different band from its total row rather than pairing by position", () => {
    const r = result();
    r.gap.liquidity[0]!.withInterest!.interest.rows[1]!.band.label = "3-6M";
    expect(tableRefusal(r, "liquidity-gap-interest")).toBe(
      "scenario S0: the standard interest rows do not line up with the standard total rows (band 3-6M against 1-3M)",
    );
  });

  it("writes no note line on the six older tables", () => {
    const r = { ...result(), nii: { byScenario: [] } } as unknown as RunResult;
    expect(renderCsv(buildTable(r, "nii"), prov, "t")).toBe(
      "# runId,r1\r\n# inputsHash,h\r\n# curve,c\r\n# schemaVersion,s\r\n# engineVersion,e\r\n# generatedAt,t\r\n" +
        "scenarioId,familyId,interestIncome12,interestExpense12,net12,interestIncome24,interestExpense24,net24\r\n",
    );
    expect(lines(result(), "repricing-gap")[6]).toBe("scenarioId,coaNodeId,band,startMonth,endMonth,assets,liabilities,gap,cumulativeGap");
  });
});

describe("CSV cells (S2b-3 fix round L3)", () => {
  it("prefixes a text cell a spreadsheet would read as a formula, and never a number", async () => {
    const { cell } = await import("../csv");
    expect(cell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(cell("+1")).toBe("'+1");
    expect(cell("-x")).toBe("'-x");
    expect(cell("@sum")).toBe("'@sum");
    expect(cell(-5)).toBe("-5");
    expect(cell("east")).toBe("east");
  });
});
