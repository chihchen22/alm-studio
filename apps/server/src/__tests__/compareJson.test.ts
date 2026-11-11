/**
 * GET /api/compare, the JSON twin of compare.csv. Both routes render
 * the one alignment (alignCompare), so the JSON must rebuild every CSV data
 * row cell for cell, and must refuse where compare.csv refuses.
 *
 * Two deterministic runs through the real platform path: A on slate "grid",
 * B on slate "grid-2" (the same scenarios minus the last), so B lacks a
 * scenario A has and the outer join carries an A-only row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, waitFor, type TestPlatform } from "./harness";

type CompareCell = string | number | boolean | null;
interface Provenance {
  runId: string;
  inputsHash: string;
  schemaVersion: string;
  engineVersion: string;
}
interface CompareReplyShape {
  table: string;
  columns: Array<{ name: string; role: "key" | "num" | "text" }>;
  rows: Array<{
    key: Record<string, CompareCell>;
    a: Record<string, CompareCell> | null;
    b: Record<string, CompareCell> | null;
    delta: Record<string, number | null>;
  }>;
  provenance: { a: Provenance; b: Provenance };
  note: string;
}

let tp: TestPlatform;
let runA: string;
let runB: string;

const submitBody = (scenarioSlateId: string): Record<string, unknown> => ({
  portfolioId: "vanilla-book-v1",
  marketId: "market-test",
  scenarioSlateId,
  assumptionSetIds: ["vanilla-empty-v1"],
});

const waitDone = async (runId: string): Promise<void> => {
  const done = await waitFor(
    async () => (await api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`)).body,
    (s) => s.state === "done" || s.state === "error",
    120_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
};

beforeAll(async () => {
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;
  const market = await loadTestMarket();
  const set = vanillaAssumptionSet();
  const scenarios = vanillaScenarios(set.id);
  const fewer = scenarios.slice(0, -1);

  const vanilla = buildVanillaPortfolio();
  store.putDocument("portfolios", vanilla.id, vanilla, {
    label: vanilla.label,
    asOf: vanilla.asOf,
    positionCount: vanilla.positions.length,
  });
  store.putDocument("market", "market-test", market, { label: "test market" });
  store.putDocument("assumption-sets", set.id, { ...set }, { label: set.label });
  store.putDocument(
    "scenario-slates",
    "grid",
    { id: "grid", label: "grid", scenarios },
    { label: "grid", scenarioCount: scenarios.length },
  );
  store.putDocument(
    "scenario-slates",
    "grid-2",
    { id: "grid-2", label: "grid-2", scenarios: fewer },
    { label: "grid-2", scenarioCount: fewer.length },
  );

  const a = await api<{ runId: string }>(tp.base, "POST", "/api/runs", submitBody("grid"));
  expect(a.status).toBe(202);
  runA = a.body.runId;
  const b = await api<{ runId: string }>(tp.base, "POST", "/api/runs", submitBody("grid-2"));
  expect(b.status).toBe(202);
  runB = b.body.runId;
  await waitDone(runA);
  await waitDone(runB);
}, 300_000);

afterAll(async () => {
  await tp.close();
});

describe("GET /api/compare", () => {
  it("serves the aligned table the CSV renders, cell for cell", async () => {
    for (const table of ["nii", "eve", "repricing-gap", "liquidity-gap", "attribution", "cashflows"]) {
      const j = await api<CompareReplyShape>(tp.base, "GET", `/api/compare?runs=${runA},${runB}&table=${table}`);
      expect(j.status).toBe(200);
      const csv = await fetch(`${tp.base}/api/compare.csv?runs=${runA},${runB}&table=${table}`).then((r) => r.text());
      const lines = csv.split("\r\n").filter((l) => l !== "" && !l.startsWith("#"));
      expect(lines.length - 1).toBe(j.body.rows.length);
      // Rebuild each CSV row from the JSON with the CSV's own encoding, restated here.
      const enc = (v: unknown) => (v === null || v === undefined ? "" : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const keys = j.body.columns.filter((c) => c.role === "key");
      const vals = j.body.columns.filter((c) => c.role !== "key");
      j.body.rows.forEach((r, i) => {
        const cells = [...keys.map((c) => enc(r.key[c.name])), ...vals.flatMap((c) => [enc(r.a?.[c.name]), enc(r.b?.[c.name]), ...(c.role === "num" ? [enc(r.delta[c.name])] : [])])];
        expect(cells.join(",")).toBe(lines[i + 1]);
      });
      expect(j.body.provenance.a.runId).toBe(runA);
      expect(j.body.note).toBe("derived columns are B - A, displayed beside both originals");
      // Every present side carries every value column, a missing cell as null, never omitted.
      const valNames = vals.map((c) => c.name).sort();
      for (const r of j.body.rows) {
        for (const side of [r.a, r.b]) if (side !== null) expect(Object.keys(side).sort()).toEqual(valNames);
      }
    }
  });

  it("writes a column the row never set as null (the nii TOTAL row)", async () => {
    const j = await api<CompareReplyShape>(tp.base, "GET", `/api/compare?runs=${runA},${runB}&table=nii`);
    const total = j.body.rows.find((r) => r.key.familyId === "TOTAL" && r.a !== null);
    expect(total).toBeDefined();
    expect(total!.a).toHaveProperty("interestIncome12", null);
    expect(typeof total!.a!.net12).toBe("number");
  });

  it("exercises a B-missing row (the scenario grid-2 drops)", async () => {
    const j = await api<CompareReplyShape>(tp.base, "GET", `/api/compare?runs=${runA},${runB}&table=nii`);
    expect(j.body.rows.some((r) => r.b === null && r.a !== null)).toBe(true);
  });

  it("refuses the way compare.csv refuses", async () => {
    expect((await api(tp.base, "GET", `/api/compare?runs=${runA}&table=nii`)).status).toBe(400);
    expect((await api(tp.base, "GET", `/api/compare?runs=${runA},${runB}&table=bogus`)).status).toBe(400);
    expect((await api(tp.base, "GET", `/api/compare?runs=${runA},nope&table=nii`)).status).toBe(404);
  });
});
