/**
 * The view and cell contract: the shapes every other task
 * types against, and the plan schema bump that carries RunPlan.views.
 */
import { describe, expect, it } from "vitest";
import { PLAN_SCHEMA_VERSION, type RunPlan } from "../plan";
// The cell ROW types live in results.ts beside the family rows they sit next to
// (CellCashflows needs BucketedSeries); views.ts holds only the view and cell
// REFERENCE types. Importing CellEVE from "../views" is a TS2305 red.
import type {
  BucketedCashflowResult,
  CellEVE,
  GapLadder,
  ScenarioEVE,
  ScenarioNII,
} from "../results";
import type { RunRequest, RunResult } from "../run";
import type { CellRef, ViewDef, ViewResult } from "../views";

describe("view and cell contract", () => {
  it("types a view definition, a cell reference and a view result", () => {
    const view: ViewDef = { id: "by-segment", label: "By segment", groupBy: ["segment"] };
    const cell: CellRef = {
      id: 'DDA|{"segment":"rate-shopper"}',
      familyId: "DDA",
      tags: { segment: "rate-shopper" },
      positionCount: 2,
    };
    const out: ViewResult = {
      viewId: view.id,
      label: view.label,
      groupBy: view.groupBy,
      groups: [{ key: { segment: "rate-shopper" }, cellIds: [cell.id], positionCount: 2 }],
    };
    expect(out.groups[0]!.cellIds).toEqual([cell.id]);
    expect(cell.tags.segment).toBe("rate-shopper");
  });

  it("carries every cell arm as an OPTIONAL field, so a no-view envelope is unchanged", () => {
    const cf: BucketedCashflowResult = { grid: { horizonMonths: 1, asOf: "2026-01-01" }, byScenario: [] };
    const nii: Pick<ScenarioNII, "byCell"> = {};
    const eve: Pick<ScenarioEVE, "byCell"> = {};
    const gap: Pick<GapLadder, "byCell"> = {};
    const res: Pick<RunResult, "views"> = {};
    const req: Pick<RunRequest, "views"> = {};
    expect([cf.cells, nii.byCell, eve.byCell, gap.byCell, res.views, req.views].every((v) => v === undefined)).toBe(true);
  });

  it("types a cell EVE row and a plan that declares views at schema 1.4.0", () => {
    const pv: CellEVE = { cellId: "DDA|", pv: 1 };
    const plan: Pick<RunPlan, "schemaVersion" | "views"> = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      views: [{ id: "v", label: "V", groupBy: ["segment"] }],
    };
    expect(pv.pv).toBe(1);
    expect(plan.views![0]!.groupBy).toEqual(["segment"]);
  });

  it("is plan schema 1.4.0", () => {
    expect(PLAN_SCHEMA_VERSION).toBe("1.4.0");
  });
});
