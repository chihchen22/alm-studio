/**
 * Legacy gate: under linear-zero with par-rate rows on a kernel convention,
 * buildCurveFromSetup returns the kernel's own bootstrap, so t, z and
 * convention equal bootstrapZeroCurve exactly.
 *
 * Both packs run through monthExactSnapshot for BOTH sides (review
 * ruling): the setup contract carries whole months, and both packs store the
 * 1M quote as 0.083333 years (the constructed pack also holds a 1D quote), so
 * the stored t[0] cannot be a setup row. On the month-exact copy the arrays are
 * equal byte for byte. A softer check pins the public pack AS STORED: z agrees
 * with the kernel to 1e-12 at every node (the BEY bill zero does not depend on
 * t, so only the stored t[0] label differs).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootstrapZeroCurve, parseMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { buildCurveFromSetup } from "../buildCurve";
import { monthExactSnapshot, setupFromSnapshot } from "./helpers";

const load = (url: URL): MarketSnapshot => parseMarketSnapshot(JSON.parse(readFileSync(url, "utf8")));

const PUBLIC = new URL("../../../../kernel/public/market_public.json", import.meta.url);
const CONSTRUCTED = new URL(
  "../../../../kernel/src/math/rates/__tests__/fixtures/market_constructed.json",
  import.meta.url,
);
const packs = [PUBLIC, CONSTRUCTED];

describe("legacy method equals the kernel bootstrap exactly (month-exact copy)", () => {
  for (const url of packs) {
    it(`pack ${url.pathname.split("/").pop()}`, () => {
      const snap = monthExactSnapshot(load(url)).snapshot;
      const kernel = bootstrapZeroCurve(snap);
      const built = buildCurveFromSetup(setupFromSnapshot(snap, "linear-zero"));
      expect(built.curve.t).toEqual(kernel.t);
      expect(built.curve.z).toEqual(kernel.z);
      expect(built.curve.convention).toBe(kernel.convention);
      expect(built.quoteTenors).toEqual(kernel.t);
      expect(built.warnings).toEqual([]);
    });
  }
});

describe("legacy method on the public pack as stored", () => {
  it("every z equals the kernel's z to 1e-12", () => {
    const snap = load(PUBLIC);
    const kernel = bootstrapZeroCurve(snap);
    const built = buildCurveFromSetup(setupFromSnapshot(snap, "linear-zero"));
    expect(built.curve.z).toHaveLength(kernel.z.length);
    built.curve.z.forEach((zi, i) => expect(Math.abs(zi - kernel.z[i])).toBeLessThan(1e-12));
    expect(built.curve.convention).toBe("semiannual_bond");
    // Only the stored 1M label differs: 0.083333 against the contract's 1/12.
    expect(built.curve.t[0]).toBe(1 / 12);
    expect(kernel.t[0]).toBe(0.083333);
    expect(built.curve.t.slice(1)).toEqual(kernel.t.slice(1));
  });
});
