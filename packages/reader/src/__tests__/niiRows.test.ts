// packages/reader/src/__tests__/niiRows.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunResult } from "@alm/engine";
import { niiHorizonPath, niiHorizonRows, niiMonthlyNet } from "../niiRows";

const FIXTURE = fileURLToPath(new URL("../../../../apps/viewer/public/runResult.json", import.meta.url));
const BASE = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { runResult: RunResult }).runResult;
const fresh = (): RunResult => structuredClone(BASE);

describe("niiHorizonRows", () => {
  it("reads the pinned 12 and 24 month fields verbatim, one row per scenario", () => {
    const r = fresh();
    const t = niiHorizonRows(r);
    expect(t.horizons).toEqual(r.nii.horizonsMonths);
    expect(t.rows.map((x) => x.scenarioId)).toEqual(r.nii.byScenario.map((s) => s.scenarioId));
    const s0 = t.rows[0]!;
    expect(s0.cells[0]).toEqual({ horizonMonths: 12, envelopePath: "nii.byScenario[scenarioId=S0].totalNet12", read: { kind: "value", value: r.nii.byScenario[0]!.totalNet12 } });
    expect(s0.cells[1]!.read).toEqual({ kind: "value", value: r.nii.byScenario[0]!.totalNet24 });
  });

  it("reads another horizon from totalNetByHorizon, and says when it is not stored", () => {
    const r = fresh();
    r.nii.horizonsMonths = [12, 24, 36];
    expect(niiHorizonPath("S0", 36)).toBe("nii.byScenario[scenarioId=S0].totalNetByHorizon.36");
    expect(niiHorizonRows(r).rows[0]!.cells[2]!.read.kind).toBe("not-in-run");
    r.nii.byScenario[0]!.totalNetByHorizon = { ...r.nii.byScenario[0]!.totalNetByHorizon, 36: 123 };
    expect(niiHorizonRows(r).rows[0]!.cells[2]!.read).toEqual({ kind: "value", value: 123 });
  });

  it("a removed pinned field is not in this run, never a number", () => {
    const r = fresh();
    delete (r.nii.byScenario[1] as Partial<(typeof r.nii.byScenario)[number]>).totalNet24;
    const cell = niiHorizonRows(r).rows[1]!.cells[1]!;
    expect(cell.read.kind).toBe("not-in-run");
  });
});

describe("niiMonthlyNet", () => {
  it("hands back the stored scenario vector", () => {
    const r = fresh();
    const m = niiMonthlyNet(r, "S100");
    expect(m).toEqual({ kind: "series", values: r.nii.byScenario.find((s) => s.scenarioId === "S100")!.netMonthly });
  });

  it("says not in this run when the vector is absent", () => {
    const r = fresh();
    delete r.nii.byScenario[0]!.netMonthly;
    expect(niiMonthlyNet(r, "S0").kind).toBe("not-in-run");
  });
});

describe("scenario ids holding \".\" or \"]\"", () => {
  for (const id of ["Up 0.5", "S[x]"]) {
    it(`reads the horizon cells and the monthly vector for "${id}"`, () => {
      const r = fresh();
      r.nii.byScenario[1]!.scenarioId = id;
      const row = niiHorizonRows(r).rows[1]!;
      expect(row.scenarioId).toBe(id);
      expect(row.cells.map((c) => c.read)).toEqual([
        { kind: "value", value: r.nii.byScenario[1]!.totalNet12 },
        { kind: "value", value: r.nii.byScenario[1]!.totalNet24 },
      ]);
      expect(niiMonthlyNet(r, id)).toEqual({ kind: "series", values: r.nii.byScenario[1]!.netMonthly });
    });

    it(`is truly not in this run when "${id}" is absent`, () => {
      expect(niiMonthlyNet(fresh(), id)).toEqual({ kind: "not-in-run", reason: `nii.byScenario has no entry with scenarioId=${id}` });
    });
  }

  it("reads an id holding \"].\" and still fails loudly on an id no path can carry", () => {
    expect(niiHorizonPath("a].b", 12)).toBe("nii.byScenario[scenarioId=a].b].totalNet12");
    const r = fresh();
    r.nii.byScenario[1]!.scenarioId = "a].b";
    expect(niiMonthlyNet(r, "a].b")).toEqual({ kind: "series", values: r.nii.byScenario[1]!.netMonthly });
    expect(() => niiHorizonPath("", 12)).toThrow(/cannot be written/);
    expect(() => niiHorizonPath("a].b[k=c", 12)).toThrow(/cannot be written/);
  });
});
