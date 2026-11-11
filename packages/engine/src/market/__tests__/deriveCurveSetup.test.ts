/**
 * deriveMarketSnapshot set-curve-setup op (Task
 * 6). The base fixture, base hash and TLP-only byte-identity hash are copied
 * from deriveRateIndices.test.ts (measured there on the unmodified code); they are never re-pinned here.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { contentHash } from "../../runtime/contentHash";
import { deriveMarketSnapshot, derivedMarketId, MarketDerivationError } from "../deriveMarketSnapshot";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import { quoteTenorsOf } from "../../curveBuilder";
import type { CurveSetupBlock, MarketWithCurveSetup } from "../../contracts/curveSetup";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const BASE_ID = "market-public-2026-03-31";
const BASE_HASH = "900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651";
const TLP_ONLY_HASH = "b405d1983b39e2fc4941129b15175d4b17399403c8b67a359a62f8b49f8a0e5d";
const TLP_LABEL = "TLP +50 bp on every node of the public market pack (demonstration values)";

/** Rows sent out of tenor order on purpose: the derived block carries them sorted. */
const SETUP = {
  id: "sofr-demo",
  label: "SOFR demonstration setup",
  baseCurve: "SOFR",
  interpolation: "log-linear-df",
  dayCount: "ACT/360",
  compounding: "annual",
  inputs: [
    { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.039 },
    { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.043 },
    { instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.041 },
  ],
};
const SORTED: CurveSetupBlock = {
  id: "sofr-demo",
  label: "SOFR demonstration setup",
  baseCurve: "SOFR",
  interpolation: "log-linear-df",
  dayCount: "ACT/360",
  compounding: "annual",
  inputs: [
    { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.043 },
    { instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.041 },
    { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.039 },
  ],
};
const setupOp = (setup: unknown = SETUP) => ({ op: "set-curve-setup", setup: structuredClone(setup) });

let loaded: MarketSnapshot;
beforeAll(async () => {
  loaded = await loadMarketSnapshot(FIXTURE);
});
const load = (): MarketSnapshot => structuredClone(loaded);

function problemsOf(fn: () => unknown): Array<{ at: string; message: string }> {
  try {
    fn();
  } catch (e) {
    if (e instanceof MarketDerivationError) return e.problems;
    throw e;
  }
  throw new Error("expected a MarketDerivationError");
}

describe("set-curve-setup derive op", () => {
  it("leaves the key out and the hash unchanged when no setup op runs", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }], { baseId: BASE_ID, id: "tlp-shock-demo-v1", label: TLP_LABEL });
    expect(contentHash(r.snapshot)).toBe(TLP_ONLY_HASH);
    expect(Object.keys(r.snapshot)).not.toContain("curveSetup");
    expect(Object.keys(r.snapshot)).not.toContain("rateIndices");
    const byDefault = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }], { baseId: BASE_ID });
    expect(byDefault.id).toBe(derivedMarketId(BASE_ID, BASE_HASH, [{ op: "add", value: 50 }]));
    expect(byDefault.label).toBe("Funding spread shock on market-public-2026-03-31 (demonstration values)");
  });

  it("writes the block on the derived market, sorted, and records the normalized op", () => {
    const r = deriveMarketSnapshot(load(), [setupOp()], { baseId: BASE_ID });
    const snap = r.snapshot as MarketWithCurveSetup;
    expect(snap.curveSetup).toEqual(SORTED);
    expect(Object.keys(snap.curveSetup!)).toEqual(["id", "label", "baseCurve", "interpolation", "dayCount", "compounding", "inputs"]);
    expect(r.snapshot.derivedFrom).toEqual({ baseId: BASE_ID, baseContentHash: BASE_HASH, ops: [{ op: "set-curve-setup", setup: SORTED }] });
    expect(Object.keys(r.snapshot).pop()).toBe("derivedFrom");
    expect(r.id).toBe(derivedMarketId(BASE_ID, BASE_HASH, [{ op: "set-curve-setup", setup: SORTED }]));
    expect(r.label).toBe("Curve setup on market-public-2026-03-31 (demonstration values)");
    // Nothing else moves: the TLP, its quotes and the curve quotes are the base's.
    expect(r.snapshot.tlpNodes).toEqual(loaded.tlpNodes);
    expect(r.snapshot.termFundingCurveQuotes).toEqual(loaded.termFundingCurveQuotes);
    expect(r.snapshot.curveQuotes).toEqual(loaded.curveQuotes);
    expect(r.changes).toEqual([]);
    expect(r.indexChanges).toEqual([]);
    expect(r.termFundingQuotesDropped).toBe(0);
    expect("rateIndices" in r.snapshot).toBe(false);
    expect(contentHash(loaded)).toBe(BASE_HASH);
  });

  it("drives the run's base curve: dense nodes with the three quote tenors", () => {
    const r = deriveMarketSnapshot(load(), [setupOp()], { baseId: BASE_ID });
    const curve = buildBaseCurve(r.snapshot);
    expect(quoteTenorsOf(curve)).toEqual([3 / 12, 1, 2]);
    expect(curve.t).toHaveLength(24);
  });

  it("composes with a TLP op and names both in the default label", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }, setupOp()], { baseId: BASE_ID });
    expect((r.snapshot as MarketWithCurveSetup).curveSetup).toEqual(SORTED);
    expect(r.termFundingQuotesDropped).toBe(11);
    expect(r.label).toBe("Funding spread shock and curve setup on market-public-2026-03-31 (demonstration values)");
  });

  it("takes a setup on a base that carries no TLP nodes", () => {
    const base = { ...load(), tlpNodes: [] };
    const r = deriveMarketSnapshot(base, [setupOp()], { baseId: BASE_ID });
    expect((r.snapshot as MarketWithCurveSetup).curveSetup).toEqual(SORTED);
    expect(r.snapshot.tlpNodes).toEqual([]);
  });

  it("refuses an invalid setup in words (a par rate under continuous compounding)", () => {
    const p = problemsOf(() => deriveMarketSnapshot(load(), [setupOp({ ...SETUP, compounding: "continuous" })], { baseId: BASE_ID }));
    expect(p.length).toBe(3);
    for (const x of p) expect(x.at).toBe("ops[0]");
    expect(p.map((x) => x.message)).toContain(
      "ops[0]: row 1 is a par rate; continuous compounding has no coupon schedule. Use annual or semi-annual.",
    );
  });

  it("refuses a setup op whose setup is missing or which carries an unknown field", () => {
    const p = problemsOf(() => deriveMarketSnapshot(load(), [{ op: "set-curve-setup", setup: SETUP, extra: 1 }], { baseId: BASE_ID }));
    expect(p).toEqual([{ at: "ops[0]", message: 'ops[0]: unknown field "extra"; a set-curve-setup op carries op and setup' }]);
    const q = problemsOf(() => deriveMarketSnapshot(load(), [{ op: "set-curve-setup" }], { baseId: BASE_ID }));
    expect(q).toHaveLength(1);
    expect(q[0]!.at).toBe("ops[0]");
    expect(q[0]!.message).toMatch(/^ops\[0\]: curve setup must be an object/);
  });

  it("refuses two set-curve-setup ops in one derivation", () => {
    const other = { ...SETUP, id: "sofr-demo-2" };
    const p = problemsOf(() => deriveMarketSnapshot(load(), [setupOp(), { op: "add", value: 10 }, setupOp(other)], { baseId: BASE_ID }));
    expect(p).toEqual([
      { at: "ops[2]", message: "ops[2]: a derivation takes one set-curve-setup op; ops[0] already sets the curve setup" },
    ]);
  });

  it("deep-copies the block: mutating the input afterwards does not change the derived market", () => {
    const op = setupOp();
    const r = deriveMarketSnapshot(load(), [op], { baseId: BASE_ID });
    const before = contentHash(r.snapshot);
    (op.setup as { label: string }).label = "changed";
    (op.setup as { inputs: Array<{ value: number }> }).inputs[0]!.value = 0.5;
    expect(contentHash(r.snapshot)).toBe(before);
    expect((r.snapshot as MarketWithCurveSetup).curveSetup).toEqual(SORTED);
    // The stored block and the recorded op are separate objects too.
    expect((r.snapshot as MarketWithCurveSetup).curveSetup).not.toBe((r.snapshot.derivedFrom!.ops[0] as { setup: unknown }).setup);
  });

  it("the derived id changes when the setup changes, and not with the row order", () => {
    const a = deriveMarketSnapshot(load(), [setupOp()], { baseId: BASE_ID }).id;
    const b = deriveMarketSnapshot(load(), [setupOp({ ...SETUP, interpolation: "cubic-zero" })], { baseId: BASE_ID }).id;
    const c = deriveMarketSnapshot(load(), [setupOp(SORTED)], { baseId: BASE_ID }).id;
    expect(a).toMatch(/^derived-mk-[0-9a-f]{12}$/);
    expect(b).not.toBe(a);
    expect(c).toBe(a);
  });

  it("refuses a setup equal to the one the base already carries", () => {
    const first = deriveMarketSnapshot(load(), [setupOp()], { baseId: BASE_ID }).snapshot;
    const p = problemsOf(() => deriveMarketSnapshot(first, [setupOp(SORTED)], { baseId: "derived-once" }));
    expect(p).toEqual([
      {
        at: "ops",
        message:
          'the ops change no TLP node, no rate index, no short-rate volatility, no macro series and no curve setup; the derived market would carry what market "derived-once" carries',
      },
    ]);
    // A different setup on the same base replaces the block.
    const next = deriveMarketSnapshot(first, [setupOp({ ...SETUP, interpolation: "monotone-convex" })], { baseId: "derived-once" });
    expect((next.snapshot as MarketWithCurveSetup).curveSetup!.interpolation).toBe("monotone-convex");
  });

  it("refuses a base whose curveSetup block it cannot read", () => {
    const base = { ...load(), curveSetup: { id: "broken" } } as MarketSnapshot;
    const p = problemsOf(() => deriveMarketSnapshot(base, [setupOp()], { baseId: BASE_ID }));
    expect(p).toHaveLength(1);
    expect(p[0]!.at).toBe("base");
    expect(p[0]!.message).toMatch(/^market "market-public-2026-03-31" carries a curveSetup block the derivation cannot read: /);
  });
});
