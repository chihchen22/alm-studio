// packages/reader/src/__tests__/instruments.test.ts
// The reader client of the per-position results file. The paths are
// restated by hand from apps/server/src/http/routes/runs.ts; none is read back from the code under test.
// The file is data, returned verbatim; a run without one answers a 404 that surfaces as ApiError.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  getInstruments,
  instrumentsCsvUrl,
  type InstrumentRow,
  type InstrumentsFile,
} from "../api/client";

const calls: Array<{ url: string; init?: RequestInit }> = [];
function mock(status = 200, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

const FILE: InstrumentsFile = {
  schemaVersion: "1.0.0",
  runId: "run-20261014-010101-0010abc",
  asOf: "2026-03-31",
  horizonMonths: 360,
  discountBasis: "spread-consistent",
  scenarios: ["S0", "S200"],
  positions: [
    {
      positionId: "loan-1",
      familyId: "fixed-loans",
      coaNodeId: "coa-fixed-loans",
      side: "asset",
      type: "fixed-loan",
      notional: 100_000_000,
      dimensions: { segment: "retail" },
      discountSpreadBp: 120,
      walMonths: 19.5,
      firstRepricingMonth: 1,
      byScenario: [
        { scenarioId: "S0", pv: 99_000_000, nii12: 5_900_000, balance12: 70_000_000, principal12: 30_000_000 },
        { scenarioId: "S200", pv: 97_000_000, nii12: 5_900_000, balance12: 70_000_000, principal12: 30_000_000 },
      ],
      seg: { niiBase12: 5_900_000, niiUp12: 5_900_000, niiDown12: 5_900_000, segPeak: 100_000_000 },
    },
  ],
};

describe("reader instruments api", () => {
  it("getInstruments reads GET /api/runs/:id/instruments and returns the file verbatim", async () => {
    mock(200, FILE);
    const got = await getInstruments("run 1/x");
    expect([calls[0]!.url, calls[0]!.init?.method]).toEqual(["/api/runs/run%201%2Fx/instruments", undefined]);
    expect(got).toEqual(FILE);
    const row: InstrumentRow = got.positions[0]!;
    expect([row.positionId, row.byScenario[1]!.pv, row.seg?.segPeak]).toEqual(["loan-1", 97_000_000, 100_000_000]);
    expect("parentPositionId" in row).toBe(false);
  });

  it("getInstruments surfaces the 404 of a run without the file as an ApiError carrying the sentence", async () => {
    mock(404, { error: { code: "not_found", message: 'run "r1" has no per-position results file' } });
    const err = await getInstruments("r1").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toContain("no per-position results file");
  });

  it("instrumentsCsvUrl is the download link of GET /api/runs/:id/instruments.csv", () => {
    expect(instrumentsCsvUrl("run-1")).toBe("/api/runs/run-1/instruments.csv");
    expect(instrumentsCsvUrl("a b")).toBe("/api/runs/a%20b/instruments.csv");
  });
});
