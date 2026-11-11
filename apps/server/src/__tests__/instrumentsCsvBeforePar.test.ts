/**
 * Spec P1, carried over in slice K1: the CSV of an older per-position results file says in one line that its balances
 * held at book read 0. The header stays the first line; the note is a trailing "# note" row, only on a 1.0.0 file that
 * holds such a balance.
 */
import { describe, expect, it } from "vitest";
import type { InstrumentsFile } from "@alm/engine";
import { instrumentsCsv, INSTRUMENTS_CSV_COLUMNS } from "../export/instrumentsCsv";

function file(version: "1.0.0" | "1.1.0", heldAtBook: boolean): InstrumentsFile {
  const row = (id: string, type: string) => ({
    positionId: id, familyId: "f", coaNodeId: "n", side: "asset" as const, type, notional: 100, dimensions: {},
    firstRepricingMonth: null, byScenario: [{ scenarioId: "S0", pv: type === "non-rate-sensitive" ? 0 : 99, nii12: 1, balance12: 90, principal12: 10 }],
  });
  return {
    schemaVersion: version, runId: "r", asOf: "2026-03-31", horizonMonths: 360, discountBasis: "all-in", scenarios: ["S0"],
    positions: heldAtBook ? [row("loan", "fixed-loan"), row("cash", "non-rate-sensitive")] : [row("loan", "fixed-loan")],
  };
}

describe("instruments CSV: the note an older file carries", () => {
  it("a 1.0.0 file with a balance held at book ends with one # note row; the header is still first", () => {
    const lines = instrumentsCsv(file("1.0.0", true)).trimEnd().split("\r\n");
    expect(lines[0]).toBe(INSTRUMENTS_CSV_COLUMNS.join(","));
    expect(lines.length).toBe(4);
    expect(lines[3]).toMatch(/^# note,"?This results file was made before balances held at book were valued at par/);
  });

  it("a 1.1.0 file, or a 1.0.0 file with no such balance, carries no note", () => {
    expect(instrumentsCsv(file("1.1.0", true))).not.toContain("# note");
    expect(instrumentsCsv(file("1.0.0", false))).not.toContain("# note");
  });
});
