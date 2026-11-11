import { describe, expect, it } from "vitest";
import { squarify } from "../charts/treemap";
describe("squarify", () => {
  it("tiles four leaves to the full area with no overlap and omits non-positive values", () => {
    const { rects, omitted } = squarify([{ key: "a", value: 6 }, { key: "b", value: 6 }, { key: "c", value: 4 }, { key: "d", value: 4 }, { key: "z", value: 0 }], 100, 50);
    expect(omitted.map((o) => o.key)).toEqual(["z"]);
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(5000, 6);
    for (const r of rects) { expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0); expect(r.x + r.w).toBeLessThanOrEqual(100 + 1e-9); expect(r.y + r.h).toBeLessThanOrEqual(50 + 1e-9); }
    // area proportional to value
    const byKey = Object.fromEntries(rects.map((r) => [r.key, r.w * r.h]));
    expect(byKey.a / byKey.c).toBeCloseTo(1.5, 6);
    // Hand computed (scale 250 per unit, short side 50): a alone is a 30 by 50 strip (adding b worsens the aspect from 1.67 to 2.4),
    // b alone the next 30 by 50 strip, then c and d fill the remaining 40 by 50 as 40 by 25 each.
    expect(rects.find((r) => r.key === "a")).toMatchObject({ x: 0, y: 0, w: 30, h: 50 });
    expect(rects.find((r) => r.key === "d")).toMatchObject({ x: 60, y: 25, w: 40, h: 25 });
  });
});
