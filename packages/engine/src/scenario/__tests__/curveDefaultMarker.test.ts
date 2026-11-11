/**
 * The curve default version 1 marker. A market carrying
 * `curveDefault: 1` and no curveSetup block builds the kernel bootstrap, byte for byte. A curveSetup
 * block wins over the marker. Only the value 1 is valid; any other value is refused in plain words.
 * The marker rides a derived market (the derive clones its base) and moves the market content hash.
 * Since Task 5 a market with no marker builds curve default version 2 (curveDefaultFlip.test.ts).
 * The refusal sentence is restated by hand, never imported.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bootstrapZeroCurve, parseMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { buildBaseCurve, curveDefaultOf } from "../rateEnvironment";
import { buildCurveFromSetup, validateCurveSetup } from "../../curveBuilder";
import { setupFromSnapshot } from "../../curveBuilder/__tests__/helpers";
import { deriveMarketSnapshot } from "../../market";
import { contentHash } from "../../runtime/contentHash";
import type { MarketWithCurveSetup } from "../../contracts/curveSetup";

const url = new URL("../../../../kernel/public/market_public.json", import.meta.url);
const snap = parseMarketSnapshot(JSON.parse(readFileSync(url, "utf8")));

const marked = (s: MarketSnapshot, value: unknown = 1): MarketSnapshot => ({ ...s, curveDefault: value }) as MarketSnapshot;

/** The refusal of a marker value other than 1, restated by hand. */
const refusal = (shown: string) =>
  `The market's curveDefault is ${shown}; the only value it takes is 1, which selects curve default version 1 (the kernel bootstrap). Remove the field to build on the platform default.`;

describe("the curve default version 1 marker", () => {
  it("a marked market with no curveSetup builds the kernel bootstrap, byte for byte", () => {
    const mine = buildBaseCurve(marked(snap));
    const kernel = bootstrapZeroCurve(snap);
    expect(mine.t).toEqual(kernel.t);
    expect(mine.z).toEqual(kernel.z);
    expect(mine.convention).toBe(kernel.convention);
    for (const t of [0.25, 1, 2.5, 7, 10, 20, 30]) expect(mine.discountFactor(t)).toBe(kernel.discountFactor(t));
  });

  it("a market with no marker no longer builds the kernel bytes: the marker is what selects them", () => {
    const absent = buildBaseCurve(snap);
    const v1 = buildBaseCurve(marked(snap));
    expect(absent.t).not.toEqual(v1.t);
    expect(absent.z).not.toEqual(v1.z);
  });

  it("curveDefaultOf reads 1 for a marked market and 2 for an unmarked one", () => {
    expect(curveDefaultOf(marked(snap))).toBe(1);
    expect(curveDefaultOf(snap)).toBe(2);
  });

  it("a curveSetup block wins over the marker", () => {
    const setup = setupFromSnapshot(snap, "log-linear-df");
    const both = { ...snap, curveDefault: 1, curveSetup: setup } as MarketWithCurveSetup;
    const built = buildBaseCurve(both);
    const checked = validateCurveSetup(setup);
    if (!checked.ok) throw new Error(checked.refusals.join("; "));
    const direct = buildCurveFromSetup(checked.block).curve;
    expect(built.t).toEqual(direct.t);
    expect(built.z).toEqual(direct.z);
    expect(built.t).not.toEqual(bootstrapZeroCurve(snap).t);
  });

  it("refuses any marker value other than 1, in plain words, with or without a curveSetup block", () => {
    const cases: Array<[unknown, string]> = [
      [2, "2"],
      [0, "0"],
      [1.5, "1.5"],
      ["1", '"1"'],
      [null, "null"],
      [true, "true"],
      [{ version: 1 }, "an object"],
    ];
    const setup = setupFromSnapshot(snap, "log-linear-df");
    for (const [value, shown] of cases) {
      expect(() => buildBaseCurve(marked(snap, value)), String(shown)).toThrow(refusal(shown));
      expect(() => curveDefaultOf(marked(snap, value)), String(shown)).toThrow(refusal(shown));
      expect(() => buildBaseCurve({ ...marked(snap, value), curveSetup: setup } as MarketSnapshot), String(shown)).toThrow(refusal(shown));
    }
  });

  it("the marker survives a derive and moves the market content hash", () => {
    const base = marked(snap);
    const r = deriveMarketSnapshot(base, [{ op: "add", value: 50 }], { baseId: "market-marked" });
    expect((r.snapshot as MarketWithCurveSetup).curveDefault).toBe(1);
    expect(curveDefaultOf(r.snapshot)).toBe(1);
    const setup = setupFromSnapshot(snap, "log-linear-df");
    const withSetup = deriveMarketSnapshot(base, [{ op: "set-curve-setup", setup }], { baseId: "market-marked" });
    expect((withSetup.snapshot as MarketWithCurveSetup).curveDefault).toBe(1);
    expect(contentHash(base)).not.toBe(contentHash(snap));
    expect(r.snapshot.derivedFrom!.baseContentHash).toBe(contentHash(base));
  });
});
