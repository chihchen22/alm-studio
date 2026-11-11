/**
 * Spec P1 (ruling 2026-11-04): the per-position pass values a balance held at book (non-rate-sensitive) at
 * par, its opening balance, in every scenario, the value EVE gives the family, so the rows sum to EVE for every
 * family, that one included. The file's schema is 1.1.0.
 *
 * The expected values come from the book, never from the pass: a held-at-book row's pv must equal its position's
 * notional as the bank file states it, and the family sums are compared with the run's own EVE block.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import type { InstrumentEnvironment, InstrumentsFile, PortfolioSpec, RunRequest, RunResult } from "@alm/engine";
import { repoRoot } from "../config";
import { buildInstrumentsFile, INSTRUMENTS_FILE_SCHEMA_VERSION } from "../jobs/instrumentsPass";
import { loadTestMarket } from "./harness";

const bank = JSON.parse(readFileSync(join(repoRoot(), "examples", "mid-size-bank-v1.json"), "utf8")) as PortfolioSpec;
const heldAtBookFamilies = new Set(bank.coa.families.filter((f) => f.instrumentType === "non-rate-sensitive").map((f) => f.id));
const heldAtBook = bank.positions.filter((p) => heldAtBookFamilies.has(p.familyId));

let result: RunResult;
let file: InstrumentsFile;

beforeAll(async () => {
  const market = await loadTestMarket();
  const set = vanillaAssumptionSet();
  const request: RunRequest = {
    runId: "run-par-test",
    portfolioId: bank.id,
    marketSnapshot: market,
    scenarios: vanillaScenarios(set.id),
    assumptionSets: [set],
    grid: { horizonMonths: 360, asOf: bank.asOf },
    seed: "platform-0",
    timestamps: { startedAt: "2026-11-04T00:00:00.000Z", finishedAt: "2026-11-04T00:00:01.000Z" },
  };
  let environment: InstrumentEnvironment | undefined;
  result = buildRunResult(request, bank, {
    ...resolveDefaultContext(),
    durationMode: "base-only",
    onInstrumentEnvironment: (e) => {
      if (e instanceof Error) throw e;
      environment = e;
    },
  });
  const book = environment!.booksBySet.get(request.scenarios[0]!.assumptionSetId)!;
  file = buildInstrumentsFile(request, book, result, undefined, environment!);
}, 240_000);

describe("a balance held at book in the per-position results (Spec P1)", () => {
  it("the bank holds balances at book to test on", () => {
    // Stated by hand from the data note: cash and due 50, premises 50, other assets 150, all $ millions.
    expect(heldAtBook.map((p) => [p.id, (p.terms as { notional: number }).notional])).toEqual([
      ["mb-cash-due-1", 50_000_000],
      ["mb-premises-1", 50_000_000],
      ["mb-other-assets-1", 150_000_000],
    ]);
  });

  it("reads its position's notional as pv in every scenario, the par value", () => {
    const scenarios = result.eve.byScenario.map((s) => s.scenarioId);
    expect(scenarios.length).toBeGreaterThan(1);
    for (const p of heldAtBook) {
      const row = file.positions.find((r) => r.positionId === p.id)!;
      expect(row.byScenario.map((s) => s.scenarioId)).toEqual(scenarios);
      for (const s of row.byScenario) expect(s.pv, `${p.id} ${s.scenarioId}`).toBe((p.terms as { notional: number }).notional);
    }
  });

  it("the rows sum to the run's EVE for every family, the one held at book included, in every scenario", () => {
    let families = 0;
    for (const sc of result.eve.byScenario) {
      const sums = new Map<string, number>();
      for (const row of file.positions) sums.set(row.familyId, (sums.get(row.familyId) ?? 0) + row.byScenario.find((x) => x.scenarioId === sc.scenarioId)!.pv);
      for (const fam of sc.byFamily) {
        if (!sums.has(fam.familyId)) continue;
        families += 1;
        const got = sums.get(fam.familyId)!;
        expect(Math.abs(got - fam.pv) / Math.max(Math.abs(fam.pv), 1), `${sc.scenarioId} ${fam.familyId}`).toBeLessThanOrEqual(1e-9);
      }
      // The held-at-book family is compared, not skipped.
      for (const f of heldAtBookFamilies) expect(sums.has(f), `${sc.scenarioId} ${f}`).toBe(true);
    }
    expect(families).toBe(result.eve.byScenario.length * new Set(bank.positions.map((p) => p.familyId)).size);
  });

  it("is written in file schema 1.1.0", () => {
    expect(INSTRUMENTS_FILE_SCHEMA_VERSION).toBe("1.1.0");
    expect(file.schemaVersion as string).toBe("1.1.0");
  });
});
