import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseMarketSnapshot, type CurveQuote, type MarketSnapshot } from "@alm/kernel";
import type { NMDParams } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunRequest } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import { contentHash } from "../../runtime";
import { assembleProvenance, type ProvenanceContext } from "../assembleProvenance";
import { setupFromSnapshot } from "../../curveBuilder/__tests__/helpers";

// --- Fixtures ----------------------------------------------------------------
// Minimal but structurally complete inputs. The market snapshot is cast: the
// assembler only serializes it, so its exact kernel shape is irrelevant here.

const coa: ChartOfAccounts = {
  schemaVersion: "1",
  nodes: [
    { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
    { id: "mtg", label: "Mortgages", parentId: "assets", side: "asset", isLeaf: true, familyId: "MTG", order: 1 },
  ],
  families: [
    { id: "MTG", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "mtg" },
  ],
};

const portfolio: PortfolioSpec = {
  id: "port-1",
  label: "Test book",
  asOf: "2026-03-31",
  coa,
  positions: [
    {
      id: "MTG-0",
      familyId: "MTG",
      coaNodeId: "mtg",
      terms: {
        type: "mortgage",
        notional: 100000,
        annualRate: 0.06,
        termMonths: 360,
        wac: 0.065,
      } as unknown as PortfolioSpec["positions"][number]["terms"],
    },
  ],
};

const marketSnapshot = {
  calibrationDate: "2026-03-31",
  currency: "USD",
  curve: [{ tenor: "1Y", rate: 0.045 }],
} as unknown as MarketSnapshot;

const assumptionSets: AssumptionSet[] = [
  {
    schemaVersion: "1",
    id: "as-base",
    label: "Base",
    bindings: [
      {
        familyId: "MTG",
        overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.06 },
        modelVersion: "mbs-v1.0",
      },
      {
        familyId: "DDA",
        overlay: { kind: "nmd-decay", params: { horizonMonths: 360 } as unknown as NMDParams },
        modelVersion: "dda-v2.1",
      },
    ],
  },
];

const scenarios: Scenario[] = [
  {
    id: "base",
    label: "Base",
    rateSpec: { kind: "base" },
    assumptionSetId: "as-base",
    newBusiness: { mode: "static", rules: [] },
  },
  {
    id: "up200",
    label: "+200",
    rateSpec: { kind: "parallel", shockBp: 200 },
    assumptionSetId: "as-base",
    newBusiness: { mode: "static", rules: [] },
  },
];

const timestamps = { startedAt: "2026-07-16T10:00:00Z", finishedAt: "2026-07-16T10:00:03Z" };

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "run-1",
    portfolioId: "port-1",
    marketSnapshot,
    scenarios,
    assumptionSets,
    grid: { horizonMonths: 360, asOf: "2026-03-31" },
    seed: "12345678901234567890",
    timestamps,
    ...overrides,
  };
}

const context: ProvenanceContext = {
  engineVersion: "0.1.0",
  kernel: {
    sourceCommit: "c".repeat(40),
    provenanceFileHash: "a".repeat(64),
  },
};

describe("assembleProvenance — inputsHash determinism", () => {
  it("produces an identical inputsHash for two runs with identical inputs and seed", () => {
    const a = assembleProvenance(makeRequest({ runId: "run-a" }), portfolio, context);
    const b = assembleProvenance(makeRequest({ runId: "run-b" }), portfolio, context);
    expect(a.inputsHash).toBe(b.inputsHash);
  });

  it("changes the inputsHash when the seed changes", () => {
    const a = assembleProvenance(makeRequest(), portfolio, context);
    const b = assembleProvenance(makeRequest({ seed: "99999999999999999999" }), portfolio, context);
    expect(a.inputsHash).not.toBe(b.inputsHash);
  });

  it("changes the inputsHash when the grid changes", () => {
    const a = assembleProvenance(makeRequest(), portfolio, context);
    const b = assembleProvenance(
      makeRequest({ grid: { horizonMonths: 120, asOf: "2026-03-31" } }),
      portfolio,
      context,
    );
    expect(a.inputsHash).not.toBe(b.inputsHash);
  });

  it("changes the inputsHash when a scenario changes", () => {
    const a = assembleProvenance(makeRequest(), portfolio, context);
    const shocked = scenarios.map((s) =>
      s.id === "up200" ? { ...s, rateSpec: { kind: "parallel", shockBp: 100 } as const } : s,
    );
    const b = assembleProvenance(makeRequest({ scenarios: shocked }), portfolio, context);
    expect(a.inputsHash).not.toBe(b.inputsHash);
  });

  it("changes the inputsHash when an assumption set changes", () => {
    const a = assembleProvenance(makeRequest(), portfolio, context);
    const bumped: AssumptionSet[] = [
      {
        ...assumptionSets[0],
        bindings: [
          {
            familyId: "MTG",
            overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.09 },
            modelVersion: "mbs-v1.0",
          },
          assumptionSets[0].bindings[1],
        ],
      },
    ];
    const b = assembleProvenance(makeRequest({ assumptionSets: bumped }), portfolio, context);
    expect(a.inputsHash).not.toBe(b.inputsHash);
  });

  it("changes the inputsHash when the market snapshot changes", () => {
    const a = assembleProvenance(makeRequest(), portfolio, context);
    const other = { ...(marketSnapshot as object), currency: "EUR" } as unknown as MarketSnapshot;
    const b = assembleProvenance(makeRequest({ marketSnapshot: other }), portfolio, context);
    expect(a.inputsHash).not.toBe(b.inputsHash);
  });

  it("changes the inputsHash when the portfolio changes", () => {
    const a = assembleProvenance(makeRequest(), portfolio, context);
    const other: PortfolioSpec = {
      ...portfolio,
      positions: [
        {
          ...portfolio.positions[0],
          terms: { ...portfolio.positions[0].terms, notional: 200000 } as unknown as PortfolioSpec["positions"][number]["terms"],
        },
      ],
    };
    const b = assembleProvenance(makeRequest(), other, context);
    expect(a.inputsHash).not.toBe(b.inputsHash);
  });

  it("does NOT change the inputsHash when only the timestamps change", () => {
    const a = assembleProvenance(makeRequest(), portfolio, context);
    const b = assembleProvenance(
      makeRequest({ timestamps: { startedAt: "2030-01-01T00:00:00Z", finishedAt: "2030-01-01T00:00:09Z" } }),
      portfolio,
      context,
    );
    expect(a.inputsHash).toBe(b.inputsHash);
  });

  it("does NOT change the inputsHash when only the runId changes", () => {
    const a = assembleProvenance(makeRequest({ runId: "x" }), portfolio, context);
    const b = assembleProvenance(makeRequest({ runId: "y" }), portfolio, context);
    expect(a.inputsHash).toBe(b.inputsHash);
  });

  it("returns a 64-char lowercase hex sha-256 digest", () => {
    const rec = assembleProvenance(makeRequest(), portfolio, context);
    expect(rec.inputsHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("assembleProvenance — modelVersions", () => {
  it("collects one entry per (family, overlay-kind) from the bindings", () => {
    const rec = assembleProvenance(makeRequest(), portfolio, context);
    expect(rec.modelVersions).toEqual({
      "DDA::nmd-decay": "dda-v2.1",
      "MTG::prepay": "mbs-v1.0",
    });
  });

  it("serializes its keys in sorted order regardless of binding order", () => {
    const reversed: AssumptionSet[] = [
      { ...assumptionSets[0], bindings: [...assumptionSets[0].bindings].reverse() },
    ];
    const rec = assembleProvenance(makeRequest({ assumptionSets: reversed }), portfolio, context);
    const keys = Object.keys(rec.modelVersions);
    expect(keys).toEqual([...keys].sort());
    expect(JSON.stringify(rec.modelVersions)).toBe(
      JSON.stringify(rec.modelVersions, Object.keys(rec.modelVersions).sort()),
    );
  });

  it("throws when the same (family, overlay-kind) carries conflicting versions across sets", () => {
    const conflicting: AssumptionSet[] = [
      assumptionSets[0],
      {
        schemaVersion: "1",
        id: "as-stress",
        label: "Stress",
        bindings: [
          {
            familyId: "MTG",
            overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.12 },
            modelVersion: "mbs-v9.9",
          },
        ],
      },
    ];
    expect(() => assembleProvenance(makeRequest({ assumptionSets: conflicting }), portfolio, context)).toThrow(
      /conflicting model version/i,
    );
  });

  it("does not throw when the same key repeats with an identical version", () => {
    const repeated: AssumptionSet[] = [
      assumptionSets[0],
      {
        schemaVersion: "1",
        id: "as-stress",
        label: "Stress",
        bindings: [
          {
            familyId: "MTG",
            overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.12 },
            modelVersion: "mbs-v1.0",
          },
        ],
      },
    ];
    expect(() => assembleProvenance(makeRequest({ assumptionSets: repeated }), portfolio, context)).not.toThrow();
  });

  /**
   * Finding 5. The key rule is "does this binding narrow the family", and the
   * answer is the canonical predicate, not the presence of the field. An empty
   * selector narrows nothing and keys as the whole family, the same answer the
   * assumption diff key gives. bindAssumptions refuses an empty selector at
   * intake, so this is the two rules agreeing by construction rather than a
   * shape a caller can post.
   */
  it("keys a selector that narrows nothing as the whole family", () => {
    const empty: AssumptionSet[] = [
      {
        ...assumptionSets[0],
        bindings: assumptionSets[0].bindings.map((b) => ({ ...b, selector: {} })),
      },
    ];
    const rec = assembleProvenance(makeRequest({ assumptionSets: empty }), portfolio, context);
    expect(Object.keys(rec.modelVersions)).toEqual(["DDA::nmd-decay", "MTG::prepay"]);
  });
});

describe("assembleProvenance — record wiring", () => {
  it("carries every scalar field from request and context", () => {
    const rec = assembleProvenance(makeRequest(), portfolio, context);
    expect(rec.runId).toBe("run-1");
    expect(rec.engineVersion).toBe("0.1.0");
    expect(rec.kernel).toEqual(context.kernel);
    expect(rec.portfolioId).toBe("port-1");
    expect(rec.seed).toBe("12345678901234567890");
    expect(rec.timestamps).toEqual(timestamps);
  });

  it("lists scenarioIds in scenario order", () => {
    const rec = assembleProvenance(makeRequest(), portfolio, context);
    expect(rec.scenarioIds).toEqual(["base", "up200"]);
  });

  it("hashes each assumption set over its bindings", () => {
    const rec = assembleProvenance(makeRequest(), portfolio, context);
    expect(rec.assumptionSets).toEqual([
      { id: "as-base", hash: contentHash(assumptionSets[0].bindings) },
    ]);
  });

  it("throws when the resolved portfolio does not match the request portfolioId", () => {
    expect(() => assembleProvenance(makeRequest({ portfolioId: "other" }), portfolio, context)).toThrow(
      /portfolio id/i,
    );
  });
});

describe("index histories in the inputs hash (Piece B, step B3b, R1)", () => {
  const E = { id: "ih-0123456789abcdef", history: { label: "x", firstMonth: "2026-01", values: [0.04], source: { fileName: "x.csv", fileSha256: "a".repeat(64), format: "csv" as const, frequency: "monthly" as const, rows: 1, unit: "decimal" as const } } };
  // The stub market carries the curveDefault 1 marker here, so the curve default stamp is not
  // folded and these two tests keep isolating the index-history fold alone.
  const markedStub = { ...(marketSnapshot as object), curveDefault: 1 } as unknown as MarketSnapshot;
  it("a request without histories hashes exactly as before", () => {
    const a = assembleProvenance(makeRequest({ marketSnapshot: markedStub }), portfolio, context);
    expect(a.inputsHash).toBe(contentHash({ portfolio, scenarios, assumptionSets, grid: { horizonMonths: 360, asOf: "2026-03-31" }, seed: "12345678901234567890", marketSnapshot: markedStub }));
  });
  it("histories given to the run move the hash, and the hash covers them", () => {
    const b = assembleProvenance(makeRequest({ marketSnapshot: markedStub, indexHistories: [E] }), portfolio, context);
    expect(b.inputsHash).toBe(contentHash({ portfolio, scenarios, assumptionSets, grid: { horizonMonths: 360, asOf: "2026-03-31" }, seed: "12345678901234567890", marketSnapshot: markedStub, indexHistories: [E] }));
    expect(b.inputsHash).not.toBe(assembleProvenance(makeRequest({ marketSnapshot: markedStub }), portfolio, context).inputsHash);
  });
});

/**
 * Every record carries the curve default stamp, and the stamp
 * enters inputsHash only for a run with no curveSetup block and no curveDefault 1 marker. On that path
 * the market bytes alone no longer say which default built the curve (version 2, or version 1 on a
 * fallback with its reason); a marker or a block is already in the hashed market bytes, so those runs
 * hash exactly as before. Every expected stamp and every expected hash input is restated by hand.
 */
describe("the curve default stamp in the record and the inputs hash (B4 Task 6)", () => {
  const PUBLIC = parseMarketSnapshot(
    JSON.parse(readFileSync(new URL("../../../../kernel/public/market_public.json", import.meta.url), "utf8")),
  );
  const marked = { ...PUBLIC, curveDefault: 1 } as MarketSnapshot;
  const setup = { ...setupFromSnapshot(PUBLIC, "cubic-zero"), id: "cs-mine" };
  const onSetup = { ...PUBLIC, curveSetup: setup } as MarketSnapshot;
  const onSetupAndMarker = { ...PUBLIC, curveDefault: 1, curveSetup: setup } as MarketSnapshot;
  // 61 month-exact usable quotes: one over the default's limit of 60, so the default falls back to version 1.
  const tenors = [...Array.from({ length: 11 }, (_, i) => i + 1), ...Array.from({ length: 50 }, (_, i) => 12 + 6 * i)];
  const sixtyOne: MarketSnapshot = {
    ...PUBLIC,
    curveQuotes: tenors.map(
      (m) => ({ term: `${m}M`, tYears: m / 12, instrumentType: m < 12 ? "BILL_BEY" : "CMT_PAR", rate: 0.04 }) as CurveQuote,
    ),
  };
  const FALLBACK_REASON = "the snapshot holds 61 curve quotes of one month or longer; the default curve takes at most 60";
  const GRID = { horizonMonths: 360, asOf: "2026-03-31" };
  const SEED = "12345678901234567890";

  /** The pre-B4 inputs hash of a request on `market`, written out field by field. */
  const before = (market: MarketSnapshot): string =>
    contentHash({ portfolio, scenarios, assumptionSets, grid: GRID, seed: SEED, marketSnapshot: market });
  /** The same, with the stamp folded in beside the market. */
  const folded = (market: MarketSnapshot, curveDefault: unknown): string =>
    contentHash({ portfolio, scenarios, assumptionSets, grid: GRID, seed: SEED, marketSnapshot: market, curveDefault });
  const run = (market: MarketSnapshot) => assembleProvenance(makeRequest({ marketSnapshot: market }), portfolio, context);

  it("an unmarked market with no setup stamps version 2, and the stamp moves the hash", () => {
    const rec = run(PUBLIC);
    expect(rec.curveDefault).toEqual({ kind: "default", version: 2 });
    expect(rec.inputsHash).toBe(folded(PUBLIC, { kind: "default", version: 2 }));
    expect(rec.inputsHash).not.toBe(before(PUBLIC));
  });

  it("a marked market stamps version 1 with no reason and hashes exactly as before", () => {
    const rec = run(marked);
    expect(rec.curveDefault).toEqual({ kind: "default", version: 1 });
    expect(Object.prototype.hasOwnProperty.call(rec.curveDefault, "reason")).toBe(false);
    expect(rec.inputsHash).toBe(before(marked));
  });

  it("the same market with and without the marker: only the unmarked run's hash leaves the pre-B4 formula", () => {
    // The marker is a market field, so the two markets differ in bytes; what this pins is the fold:
    // the marked run is the pre-B4 hash of its market, the unmarked run is not the pre-B4 hash of its own.
    expect(run(marked).inputsHash).toBe(before(marked));
    expect(run(PUBLIC).inputsHash).not.toBe(before(PUBLIC));
    expect(run(marked).inputsHash).not.toBe(run(PUBLIC).inputsHash);
  });

  it("a run on a setup stamps {kind: setup, id} and hashes exactly as before, with or without the marker", () => {
    for (const m of [onSetup, onSetupAndMarker]) {
      const rec = run(m);
      expect(rec.curveDefault).toEqual({ kind: "setup", id: "cs-mine" });
      expect(rec.inputsHash).toBe(before(m));
    }
  });

  it("a fallback stamps version 1 with its reason, and the stamp with the reason is folded into the hash", () => {
    const rec = run(sixtyOne);
    expect(rec.curveDefault).toEqual({ kind: "default", version: 1, reason: FALLBACK_REASON });
    expect(rec.inputsHash).toBe(folded(sixtyOne, { kind: "default", version: 1, reason: FALLBACK_REASON }));
    expect(rec.inputsHash).not.toBe(before(sixtyOne));
    // The reason is part of what is hashed: the same fold without it is a different digest.
    expect(rec.inputsHash).not.toBe(folded(sixtyOne, { kind: "default", version: 1 }));
  });

  it("index histories and the stamp fold side by side on an unmarked market", () => {
    const E = { id: "ih-0123456789abcdef", history: { label: "x", firstMonth: "2026-01", values: [0.04], source: { fileName: "x.csv", fileSha256: "a".repeat(64), format: "csv" as const, frequency: "monthly" as const, rows: 1, unit: "decimal" as const } } };
    const rec = assembleProvenance(makeRequest({ marketSnapshot: PUBLIC, indexHistories: [E] }), portfolio, context);
    expect(rec.inputsHash).toBe(
      contentHash({ portfolio, scenarios, assumptionSets, grid: GRID, seed: SEED, marketSnapshot: PUBLIC, indexHistories: [E], curveDefault: { kind: "default", version: 2 } }),
    );
  });

  it("the stamp is written on every record, never left out", () => {
    for (const m of [PUBLIC, marked, onSetup, sixtyOne, marketSnapshot]) {
      expect(Object.prototype.hasOwnProperty.call(run(m), "curveDefault")).toBe(true);
    }
  });
});
