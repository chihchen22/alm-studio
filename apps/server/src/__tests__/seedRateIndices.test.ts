// apps/server/src/__tests__/seedRateIndices.test.ts
/**
 * The seeded demonstration rate indices market
 * (rate-indices-demo-v1), the indexed book copy (synthetic-2500-indexed-v1) and
 * the plan that runs it (plan-synthetic-2500-indexed-v1), proven end to end on
 * a scratch store seeded by the real seedStore().
 *
 * Every expected number is restated here as a literal. The store hashes in
 * section A were measured on the unmodified code and are never re-pinned: the
 * three new documents are additions, and no existing seeded document changes.
 * The deltas in sections E2 and E3 were measured on the unmodified engine plus
 * the index formula before the seed existed (the design's measured vectors).
 * OSS slice S1 re-pinned the demo run-plan literals once: the demo routing policy's id is now
 * model-map-default-v1; with that id read back as the old one every re-pinned document hashes to its measured
 * literal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { Position, RunPlan, RunResult } from "@alm/engine";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
}, 300_000);
afterAll(() => t.close());

const PUBLIC = "market-public-2026-03-31";
const IDX_MARKET = "rate-indices-demo-v1";
const IDX_BOOK = "synthetic-2500-indexed-v1";
const BASE_PLAN = "plan-synthetic-2500-v1";
const IDX_PLAN = "plan-synthetic-2500-indexed-v1";

const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];
const SEED_LABEL = "Three rate indices on the public market pack (demonstration values)";

describe("A. no existing seeded document changed", () => {
  // Measured on the unmodified code; never re-pin.
  const PINS: Array<[Parameters<FileStore["getMeta"]>[0], string, string]> = [
    ["market", PUBLIC, "6d0501f30b0e59a93bb1294e68d5ed6041d473a264d5790e5da1dbdfa3a60731"],
    ["market", "tlp-shock-demo-v1", "abc80918c85cd6753cb9e499b47d4768b072b125cafffc56886d5a6253ad5d0a"],
    ["portfolios", "synthetic-2500-v1", "c93d9ba2e5c7a4e0e127de2bc697e42252434289cba8b1aac5efcdf69a61bc2c"],
    ["portfolios", "synthetic-2500-hedged-v1", "d9cb54a47a5a6c49f69bf89471aa72fbf44a0ebc893201caa26b966fcaf3f2db"],
    ["portfolios", "synthetic-lcr-liabilities-v1", "f9d13120fa6a92629ae01f55a1683389a79f3488d651d34b53f21653ed75aba4"],
    ["run-plans", "plan-synthetic-2500-v1", "5e2826755621ffc6d9123bc567fded1cbfa09d14d4870cf55a9443c99feafbee"],
    ["run-plans", "plan-synthetic-2500-hedged-v1", "7c652b11735b6880fe79edea963732e4f15a1ea79a21fa088a6eff3d953abab1"],
    ["run-plans", "plan-synthetic-lcr-liabilities-v1", "0519ff6678c5e795ff0384406d2d76059fa22a708c5bb3c25d80f5303333b4e5"],
    ["assumption-sets", "demo-behavioral-v1", "7b65f5629022b720de7a79819718a75545a56d06c5d966f963a2f61a058175a2"],
  ];
  for (const [collection, id, hash] of PINS) {
    it(`${collection}/${id} keeps its measured store hash`, () => {
      expect(store.getMeta(collection, id).contentHash).toBe(hash);
    });
  }
});

describe("B. the seeded market and book", () => {
  it("rate-indices-demo-v1 carries the three demonstration indices beside an untouched curve and TLP", async () => {
    const base = (await api<MarketSnapshot>(t.base, "GET", `/api/market/${PUBLIC}`)).body;
    const m = (await api<MarketSnapshot & { rateIndices?: unknown; derivedFrom?: Record<string, unknown> }>(t.base, "GET", `/api/market/${IDX_MARKET}`)).body;
    expect(m.rateIndices).toEqual([
      { id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basis: 0.03 },
      { id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basis: 0 },
      { id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basis: 0 },
    ]);
    expect(m.termFundingCurveQuotes).toHaveLength(11);
    expect(m.termFundingCurveQuotes).toEqual(base.termFundingCurveQuotes);
    expect(m.tlpNodes).toEqual(base.tlpNodes);
    expect(m.derivedFrom?.baseId).toBe(PUBLIC);
    expect(m.derivedFrom?.baseContentHash).toBe("900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651");
  });

  it("its stored bytes keep the hash first recorded when the seed was written", () => {
    // Recorded on the first green run of this suite; a later change to the seed or the derivation moves it.
    expect(store.getMeta("market", IDX_MARKET).contentHash).toBe("347674669bbc746208745bf97c683a81c5da643c5adad33d116a7d3238cc2e00");
    expect(store.getMeta("portfolios", IDX_BOOK).contentHash).toBe("befa1b78a5bd7ba1f6b1c7e9a0eed08e9f2829996cea871a0d2976b528a16306");
    expect(store.getMeta("run-plans", IDX_PLAN).contentHash).toBe("ef82c01f2c1660b14b8a2098bf2d21427b0d7fd9d2c046d20a5104475310acfc");
  });

  it("its store meta names the base, is seeded, and counts three ops", () => {
    const meta = store.getMeta("market", IDX_MARKET);
    expect(meta.derivedFromMarketId).toBe(PUBLIC);
    expect(meta.seeded).toBe(true);
    expect(meta.derivedOpCount).toBe(3);
    expect(meta.label).toBe(SEED_LABEL);
  });

  it("the indexed book names an index on three floaters and equals synthetic-2500-v1 everywhere else", async () => {
    const base = (await api<{ positions: Position[] }>(t.base, "GET", `/api/portfolios/synthetic-2500-v1`)).body;
    const idx = (await api<{ id: string; label: string; positions: Position[] }>(t.base, "GET", `/api/portfolios/${IDX_BOOK}`)).body;
    expect(idx.id).toBe(IDX_BOOK);
    expect(idx.label).toBe("Synthetic ALM Balance Sheet (2500 positions, seeded, three floaters naming demonstration rate indices)");
    expect(idx.positions).toHaveLength(base.positions.length);
    const named: Record<string, string> = { "floating-loans-0": "rfr-1m", "floating-loans-1": "rfr-3m", "floating-loans-2": "prime-demo" };
    let changed = 0;
    idx.positions.forEach((p, i) => {
      const b = base.positions[i]!;
      const want = named[b.id];
      if (want === undefined) {
        expect(p).toEqual(b);
      } else {
        changed += 1;
        expect(p).toEqual({ ...b, terms: { ...b.terms, rateIndexId: want } });
        expect(b.terms.type).toBe("floating-loan");
      }
    });
    expect(changed).toBe(3);
  });

  it("the plan is the behavioral chain on the indexed book and the indices market", async () => {
    const plan = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${IDX_PLAN}`)).body;
    const base = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${BASE_PLAN}`)).body;
    expect(plan.planId).toBe(IDX_PLAN);
    expect(plan.label).toBe("Synthetic book, three indexed floaters on the demonstration rate indices market (demonstration)");
    expect(plan.inputs).toEqual({ ...base.inputs, positionBook: IDX_BOOK, marketSnapshot: IDX_MARKET });
    expect(plan.stages).toEqual(base.stages);
    expect(plan.scenarios).toEqual(base.scenarios);
  });

  it("the catalog listing shows the market derived from the public pack (F)", async () => {
    const rows = (await api<Array<{ id: string; derivedFromMarketId?: string }>>(t.base, "GET", "/api/market")).body;
    expect(rows.find((r) => r.id === IDX_MARKET)?.derivedFromMarketId).toBe(PUBLIC);
  });
});

describe("C and D. the derive route and a re-seed agree with the seed", () => {
  it("POST /api/market/derive with the seed body is an identical re-save (200 unchanged)", async () => {
    const r = await api<{ status?: string }>(t.base, "POST", "/api/market/derive", {
      baseId: PUBLIC,
      ops: SEED_OPS,
      id: IDX_MARKET,
      label: SEED_LABEL,
    });
    expect(r.status, r.text).toBe(200);
  });

  it("a second seed pass writes nothing, reports nothing stale, and skips the three new ids", async () => {
    const report = await seedStore(store, repoRoot());
    expect(report.written).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.skipped).toContain(`market/${IDX_MARKET}`);
    expect(report.skipped).toContain(`portfolios/${IDX_BOOK}`);
    expect(report.skipped).toContain(`run-plans/${IDX_PLAN}`);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// E. the seeded end to end. Three scenarios keep the runs affordable: the base
// S0, S100 and S-100. Every run of a given plan id uses the same scenario
// subset, because the run route stores one slate per plan id.
// ---------------------------------------------------------------------------

const TERMINAL = ["done", "error", "cancelled", "interrupted"];
const KEEP = new Set(["regulatory-grid-v1#S0", "regulatory-grid-v1#S100", "regulatory-grid-v1#S-100"]);

async function runPlan(planId: string, marketId: string | null, label: string): Promise<RunResult> {
  const stored = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${planId}`)).body;
  const plan: RunPlan = {
    ...stored,
    inputs: marketId === null ? stored.inputs : { ...stored.inputs, marketSnapshot: marketId },
    scenarios: stored.scenarios.filter((sc) => "ref" in sc && KEEP.has(sc.ref)),
  };
  expect(plan.scenarios).toHaveLength(3);
  const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan, label });
  expect(r.status, r.text).toBe(202);
  const fin = await waitFor(
    () => api<{ state: string }>(t.base, "GET", `/api/runs/${r.body.runId}`).then((x) => x.body),
    (st) => TERMINAL.includes(st.state),
    900_000,
  );
  expect(fin.state).toBe("done");
  return (await api<RunResult>(t.base, "GET", `/api/runs/${r.body.runId}/result`)).body;
}

const nii = (r: RunResult, sc: string) => r.nii.byScenario.find((s) => s.scenarioId === sc)!;
const eve = (r: RunResult, sc: string) => r.eve.byScenario.find((s) => s.scenarioId === sc)!.eve;
const fam = (r: RunResult, sc: string, id: string) => r.cashflows.byScenario.find((s) => s.scenarioId === sc)!.byFamily.find((f) => f.familyId === id)!;
const nonFloating = <T extends { familyId: string }>(rows: T[]): T[] => rows.filter((x) => x.familyId !== "floating-loans");

let baseOnPublic: RunResult;
let baseOnIdx: RunResult;
let indexed: RunResult;
let indexedPlus25: RunResult;

describe("E. seeded end to end", () => {
  beforeAll(async () => {
    baseOnPublic = await runPlan(BASE_PLAN, null, "seed 7a: base plan on public");
    baseOnIdx = await runPlan(BASE_PLAN, IDX_MARKET, "seed 7a: base plan on the indices market");
    indexed = await runPlan(IDX_PLAN, null, "seed 7a: indexed plan");
    const derived = await api(t.base, "POST", "/api/market/derive", {
      baseId: PUBLIC,
      ops: [...SEED_OPS, { op: "add-index-basis", indexId: "prime-demo", value: 25 }],
      id: "idx-basis25-v1",
    });
    expect(derived.status, derived.text).toBe(201);
    indexedPlus25 = await runPlan(IDX_PLAN, "idx-basis25-v1", "seed 7a: indexed plan, prime +25 bp");
  }, 3_000_000);

  it("E1. an unindexed plan reads nothing from the indices block: public and indices market agree field by field", () => {
    expect(baseOnIdx.nii).toEqual(baseOnPublic.nii);
    expect(baseOnIdx.cashflows).toEqual(baseOnPublic.cashflows);
    expect(baseOnIdx.gap).toEqual(baseOnPublic.gap);
    expect(baseOnIdx.eve).toEqual(baseOnPublic.eve);
    expect(baseOnIdx.ftp).toEqual(baseOnPublic.ftp);
    // On curve default 2 (was 574278133.2521524); deltas Step 1
    expect(eve(baseOnPublic, "S0")).toBe(571500248.9115896);
    // On curve default 2 (was 574278133.2521524); deltas Step 1
    expect(eve(baseOnIdx, "S0")).toBe(571500248.9115896);
    // On curve default 2 (was 19970928.460970417); deltas Step 1
    expect(nii(baseOnPublic, "S0").totalNet12).toBe(20002005.278397486);
    // On curve default 2 (was 19970928.460970417); deltas Step 1
    expect(nii(baseOnIdx, "S0").totalNet12).toBe(20002005.278397486);
    expect(baseOnIdx.provenance.inputsHash).not.toBe(baseOnPublic.provenance.inputsHash);
    expect(baseOnIdx.schemaVersion).toBe("1.13.0");
    expect(baseOnPublic.schemaVersion).toBe("1.13.0");
  });

  it("E2. three indexed floaters move the floating-loans family and nothing else", () => {
    expect(indexed.schemaVersion).toBe("1.13.0");
    // Cash flows and NII: every other family is untouched.
    for (const sc of ["S0", "S100", "S-100"]) {
      const a = indexed.cashflows.byScenario.find((s) => s.scenarioId === sc)!.byFamily;
      const b = baseOnPublic.cashflows.byScenario.find((s) => s.scenarioId === sc)!.byFamily;
      expect(nonFloating(a)).toEqual(nonFloating(b));
      expect(nonFloating(nii(indexed, sc).byFamily)).toEqual(nonFloating(nii(baseOnPublic, sc).byFamily));
    }
    // Floating-loans interest: bucket 0 and the first twelve buckets.
    const fi = fam(indexed, "S0", "floating-loans").series.interest;
    const fb = fam(baseOnPublic, "S0", "floating-loans").series.interest;
    // On curve default 2 (was 3101.563487666286); deltas Step 1
    expect(fi[0]! - fb[0]!).toBeCloseTo(3101.563313596882, 6);
    let sum = 0;
    for (let k = 0; k < 12; k += 1) sum += fi[k]! - fb[k]!;
    // On curve default 2 (was 35631.54983967227); deltas Step 1
    expect(sum).toBeCloseTo(35803.835503031034, 4);
    // NII, floating loans are an asset family so the interest delta is the NII delta.
    // On curve default 2 (was 35631.54983967227); deltas Step 1
    expect(nii(indexed, "S0").totalNet12 - nii(baseOnPublic, "S0").totalNet12).toBeCloseTo(35803.83550301194, 3);
    // On curve default 2 (was 64737.99599839744); deltas Step 1
    expect(nii(indexed, "S0").totalNet24 - nii(baseOnPublic, "S0").totalNet24).toBeCloseTo(64770.80708986521, 3);
    // On curve default 2 (was 35924.21884072365); deltas Step 1
    expect(nii(indexed, "S100").totalNet12 - nii(baseOnPublic, "S100").totalNet12).toBeCloseTo(36097.661033689976, 3);
    // EVE moves through cash flows only (discounting is unchanged).
    // On curve default 2 (was 91998.17040917165); deltas Step 1
    expect(eve(indexed, "S0") - eve(baseOnPublic, "S0")).toBeCloseTo(92030.72400569916, 2);
    // On curve default 2 (was 91435.28249429706); deltas Step 1
    expect(eve(indexed, "S100") - eve(baseOnPublic, "S100")).toBeCloseTo(91468.06384658813, 2);
    // On curve default 2 (was 92635.01790130239); deltas Step 1
    expect(eve(indexed, "S-100") - eve(baseOnPublic, "S-100")).toBeCloseTo(92667.34337902069, 2);
    // Gap: the repricing ladder keys on the repricing schedule, so it is unchanged. The liquidity ladder moves with
    // amortization but conserves the principal it carries.
    expect(indexed.gap.repricing).toEqual(baseOnPublic.gap.repricing);
    const liqAssets = (r: RunResult) => r.gap.liquidity.find((l) => l.scenarioId === "S0")!.rows.reduce((s, row) => s + row.assets, 0);
    expect(liqAssets(indexed)).toBeCloseTo(liqAssets(baseOnPublic), 2);
    // FTP: non-floating rows equal, the floating family coupon is higher, counts and notional equal.
    const ftpI = indexed.ftp!.byFamily;
    const ftpB = baseOnPublic.ftp!.byFamily;
    expect(nonFloating(ftpI)).toEqual(nonFloating(ftpB));
    const fI = ftpI.find((x) => x.familyId === "floating-loans")!;
    const fB = ftpB.find((x) => x.familyId === "floating-loans")!;
    expect(fI.couponRate!).toBeGreaterThan(fB.couponRate!);
    expect(fI.positionCount).toBe(fB.positionCount);
    expect(fI.notional).toBe(fB.notional);
  });

  it("E3. a 25 bp basis shift on prime-demo moves only the one floater that names it", () => {
    expect(indexedPlus25.schemaVersion).toBe("1.13.0");
    expect(nii(indexedPlus25, "S0").totalNet12 - nii(indexed, "S0").totalNet12).toBeCloseTo(2956.626745908984, 3);
    const a = fam(indexedPlus25, "S0", "floating-loans").series.interest[0]!;
    const b = fam(indexed, "S0", "floating-loans").series.interest[0]!;
    expect(a - b).toBeCloseTo(263.645625, 6);
    const rows = (r: RunResult) => nonFloating(r.cashflows.byScenario.find((s) => s.scenarioId === "S0")!.byFamily);
    expect(rows(indexedPlus25)).toEqual(rows(indexed));
  });

  it("E4. the indexed plan on a market that carries no indices is refused before any number", async () => {
    const stored = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${IDX_PLAN}`)).body;
    const plan = { ...stored, inputs: { ...stored.inputs, marketSnapshot: PUBLIC } };
    const run = await api<{ error: { message: string } }>(t.base, "POST", "/api/plans/run", { plan });
    expect(run.status).toBe(422);
    expect(run.body.error.message).toContain('names rate index "rfr-1m"');
    expect(run.body.error.message).toContain('which market "market-public-2026-03-31" does not carry (it carries none)');
    expect(run.body.error.message).not.toContain("; and");
    const v = await api<{ compile: { passed: boolean } }>(t.base, "POST", "/api/plans/validate", { plan });
    expect(v.status).toBe(200);
    expect(v.body.compile.passed).toBe(false);
  });

  it("E5. the drill prices floating-loans-2 on prime-demo plus margin on the indices market, and refuses on the public pack", async () => {
    const body = (marketId: string) => ({
      instrument: { portfolioId: IDX_BOOK, positionId: "floating-loans-2" },
      marketId,
      scenarios: { parallelShockBp: 0 },
      horizonMonths: 12,
    });
    const ok = await api<{ byScenario: Array<{ rows: Array<{ month: number; couponRate: number; interest: number }> }> }>(
      t.base,
      "POST",
      "/api/instrument/project",
      body(IDX_MARKET),
    );
    expect(ok.status, ok.text).toBe(200);
    const row = ok.body.byScenario[0]!.rows[0]!;
    expect(row.month).toBe(1);
    // On curve default 2 (was 0.08981187754093536); deltas Step 1
    expect(row.couponRate).toBe(0.08981187832875318);
    // On curve default 2 (was 9471.403434681346); deltas Step 1
    expect(row.interest).toBe(9471.403517763234);
    const refused = await api(t.base, "POST", "/api/instrument/project", body(PUBLIC));
    expect(refused.status).toBe(422);
  });
});
