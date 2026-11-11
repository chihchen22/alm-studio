/**
 * The numbers behind LinePlot (ALM Studio Polish 10 T1): nice ticks, the y range and its zero floor, the square-root scale and its
 * inverse, x tick thinning, the nearest stored x, path segments over nulls, the gap in bp, the zoom band, the
 * tooltip's place and the month ticks. Every expected value is worked by hand and restated here.
 */
import { describe, expect, it } from "vitest";
import {
  deltaBp, leftMargin, monthTicks, nearestX, niceTicks, pathD, segments, signedBp, steadyLeftMargin, stepDecimals, storedXs, thinTicks, tipLeft, tipPlace, tipRows, tipTop, toggleHidden, xClipPad, xScale,
  yDomain, zoomDrag, zoomTo,
} from "../charts/plotScale";
import { moneyTick } from "../format/figures";

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 times a power of ten and covers the range with whole ticks", () => {
    // raw step 1.3 / 6 = 0.2167: mantissa 2.167 rounds to 2, so 0.2 from 3.6 to 5.0.
    expect(niceTicks(3.64, 4.94, 6)).toEqual({ lo: 3.6, hi: 5, step: 0.2, ticks: [3.6, 3.8, 4, 4.2, 4.4, 4.6, 4.8, 5] });
    expect(niceTicks(0, 1, 4)).toEqual({ lo: 0, hi: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] });
    // raw 1.24: mantissa under 1.5 rounds to 1.
    expect(niceTicks(-0.35, 7.1, 6).ticks).toEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // raw 0.37: mantissa 3.7 rounds to 5, so 0.5.
    expect(niceTicks(0.9, 3.1, 6).step).toBe(0.5);
  });
  it("opens a flat range by 1% of its value each side", () => {
    expect(niceTicks(5, 5, 4)).toEqual({ lo: 4.94, hi: 5.06, step: 0.02, ticks: [4.94, 4.96, 4.98, 5, 5.02, 5.04, 5.06] });
  });
});

describe("yDomain", () => {
  it("pads 5% each side and puts about one tick per 45 px, four at least", () => {
    // The benchmark curve's stored range, 3.68% to 4.88%, on a 242 px plot: five ticks wanted, 0.2% apart.
    expect(yDomain([0.0368, 0.0488, 0.0392], 242)).toEqual({ lo: 0.036, hi: 0.05, step: 0.002, ticks: [0.036, 0.038, 0.04, 0.042, 0.044, 0.046, 0.048, 0.05] });
    expect(yDomain([-0.3, 7], 262).ticks).toEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("floors a set at or above zero at zero rather than padding below it", () => {
    expect(yDomain([0.01, 1], 262)).toEqual({ lo: 0, hi: 1.2, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2] });
  });
  it("gives zero to one when there is nothing to plot", () => {
    expect(yDomain([], 262).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
  it("with zero, floors an all-positive set at zero however far from zero it sits (Polish 13)", () => {
    // Without it, 900 to 1000 pads 5 each side to 895 and 1005: raw step 110 / 6 = 18.3, mantissa 1.83 rounds to 2, so
    // 20 apart from 880 to 1020.
    expect(yDomain([900, 1000], 262)).toEqual({ lo: 880, hi: 1020, step: 20, ticks: [880, 900, 920, 940, 960, 980, 1000, 1020] });
    // With it, the range is 0 to 1000, padded 50 above to 1050: raw 175, mantissa 1.75 rounds to 2, so 200 apart from 0
    // to 1200.
    expect(yDomain([900, 1000], 262, true)).toEqual({ lo: 0, hi: 1200, step: 200, ticks: [0, 200, 400, 600, 800, 1000, 1200] });
  });
  it("with zero, leaves a set that crosses zero as it was, and tops an all-negative set at zero (Polish 13)", () => {
    expect(yDomain([-0.3, 7], 262, true)).toEqual(yDomain([-0.3, 7], 262));
    expect(yDomain([-0.3, 7], 262, true).ticks).toEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // -1000 to 0, padded 50 below to -1050 and not above: raw 175, so 200 apart from -1200 to 0.
    expect(yDomain([-1000, -900], 262, true)).toEqual({ lo: -1200, hi: 0, step: 200, ticks: [-1200, -1000, -800, -600, -400, -200, 0] });
  });
});

describe("xScale", () => {
  it("places tenors to scale on a square-root axis and inverts it", () => {
    const s = xScale("sqrt", 0, 30, 50, 624);
    expect(s.toPx(0)).toBe(50);
    expect(s.toPx(30)).toBe(624);
    // sqrt(7.5) is half of sqrt(30).
    expect(s.toPx(7.5)).toBeCloseTo(337, 9);
    expect(s.fromPx(337)).toBeCloseTo(7.5, 9);
  });
  it("maps linearly and inverts", () => {
    const s = xScale("linear", 0, 359, 50, 624);
    expect(s.toPx(179.5)).toBe(337);
    expect(s.fromPx(624)).toBe(359);
  });
});

describe("leftMargin (Polish 13 fix round 1)", () => {
  it("keeps 50 px while the widest y label fits it, and grows to the widest label's width plus 8 px gap and 4 px room", () => {
    // Four characters: ceil(4 * 6.6 = 26.4) + 12 = 39, under 50. Six characters: ceil(39.6) + 12 = 52.
    expect(leftMargin(["3.5%", "4.0%", "6.5%"])).toBe(50);
    expect(leftMargin([])).toBe(50);
    // "$3,500M" is seven characters: ceil(7 * 6.6 = 46.2) = 47, plus 8 and 4 is 59.
    expect(leftMargin(["$0M", "$500M", "$3,500M"])).toBe(59);
    // Eight, with the true minus: ceil(52.8) = 53, so 65.
    expect(leftMargin(["−$1,200M", "$0M"])).toBe(65);
    expect(leftMargin(["123456"])).toBe(52);
  });
});

describe("thinTicks", () => {
  it("drops a tick whose label box would meet the last one kept: 6.6 px a character at 11 px, 10 px apart", () => {
    const s = xScale("sqrt", 0, 30, 50, 624);
    // Two-character labels are 13.2 px wide, so centres need 13.2 + 10 = 23.2 px. 1M at 80.3 px, 3M at 102.4 (22.1 px
    // on: dropped), 6M at 124.1 (43.8 on 1M: kept), 1Y at 154.8 (30.7 on 6M: kept).
    const ticks = [{ value: 0.083333, label: "1M" }, { value: 0.25, label: "3M" }, { value: 0.5, label: "6M" }, { value: 1, label: "1Y" }];
    expect(thinTicks(ticks, s.toPx).map((t) => t.label)).toEqual(["1M", "6M", "1Y"]);
  });
  it("spaces long labels by their width, not by a fixed 30 px (Polish 11, Minor 3)", () => {
    // Centres 40 px apart. "Scenario A" and "Scenario B" are 66 px wide each: 66 + 10 = 76 px needed, so B drops and C
    // (80 px on A) stays. Short labels 40 px apart all stay: 6.6 + 10 = 16.6 px needed.
    const at = (v: number) => v;
    const long = [{ value: 0, label: "Scenario A" }, { value: 40, label: "Scenario B" }, { value: 80, label: "Scenario C" }];
    expect(thinTicks(long, at).map((t) => t.label)).toEqual(["Scenario A", "Scenario C"]);
    const short = [{ value: 0, label: "1" }, { value: 40, label: "2" }, { value: 80, label: "3" }];
    expect(thinTicks(short, at).map((t) => t.label)).toEqual(["1", "2", "3"]);
    // Mixed widths: "M0" (13.2) then "Year 10" (46.2) 38 px on needs 6.6 + 23.1 + 10 = 39.7: dropped; 40 px on is kept.
    expect(thinTicks([{ value: 0, label: "M0" }, { value: 38, label: "Year 10" }], at).map((t) => t.label)).toEqual(["M0"]);
    expect(thinTicks([{ value: 0, label: "M0" }, { value: 40, label: "Year 10" }], at).map((t) => t.label)).toEqual(["M0", "Year 10"]);
  });
});

describe("steadyLeftMargin (Polish 14, Polish 13 Minor 4)", () => {
  it("takes the larger of the margin for the shown y labels and the one for the full unzoomed range's labels", () => {
    // A hidden wide series or a zoom leaves short labels shown; the full range's "$3,500M" (seven characters,
    // ceil(46.2) + 8 + 4 = 59) holds the margin, so the plot does not slide sideways.
    expect(steadyLeftMargin(["1.0", "2.0"], ["$0M", "$3,500M"])).toBe(59);
    // A wider shown label still widens it: "−$1,200M" is eight characters, ceil(52.8) + 12 = 65.
    expect(steadyLeftMargin(["−$1,200M", "$0M"], ["$0M", "$3,500M"])).toBe(65);
    // Both short: the 50 px floor.
    expect(steadyLeftMargin(["3.5%"], ["4.0%"])).toBe(50);
    expect(steadyLeftMargin([], [])).toBe(50);
  });
});

describe("xClipPad (Polish 14, Polish 12 Minor 1)", () => {
  const S = { points: [[1, 1], [2, 2], [3, null]] as Array<[number, number | null]> };
  it("pads the clip 6 px in x only when every stored x drawn lies inside the window", () => {
    // Series x 1 and 2 (3 is null, so not drawn) and a context line at 1 to 3, all inside 0..3.
    expect(xClipPad([S, { points: [[1, 5], [3, 5]] }], 0, 3)).toBe(6);
    // A context line stored at x 4 runs past a window ending at 3 (the slice's end cell null): no pad.
    expect(xClipPad([S, { points: [[1, 5], [4, 5]] }], 0, 3)).toBe(0);
    // A zoomed window 1.5..2.5 inside the data: the lines run past both edges, so no pad.
    expect(xClipPad([S], 1.5, 2.5)).toBe(0);
    // An x a hair past the edge is on it (the 1e-9 tolerance inX uses).
    expect(xClipPad([S], 1 + 1e-10, 2 - 1e-10)).toBe(6);
  });
});

describe("storedXs and nearestX", () => {
  it("lists the distinct stored x with a value inside the range, ascending", () => {
    expect(storedXs([{ points: [[3, 1], [1, 2], [2, null]] }, { points: [[2, 5], [9, 1]] }], 0, 5)).toEqual([1, 2, 3]);
  });
  it("snaps to the stored x nearest the pointer, the lower one on a tie, none on an empty set", () => {
    const px = (x: number) => x * 10;
    expect(nearestX([1, 2, 3], px, 14)).toBe(1);
    expect(nearestX([1, 2, 3], px, 16)).toBe(2);
    expect(nearestX([1, 2, 3], px, 15)).toBe(1);
    expect(nearestX([], px, 15)).toBeNull();
  });
});

describe("pathD", () => {
  it("lifts the pen at a null, so a missing value breaks the line", () => {
    expect(pathD([[0, 1], [1, null], [2, 3], [3, 4]], (x) => x * 10, (y) => y)).toBe("M0.00,1.00M20.00,3.00L30.00,4.00");
    expect(pathD([[0, null]], (x) => x, (y) => y)).toBe("");
  });
});

describe("segments (Polish 11, T1 review Minor 3)", () => {
  it("splits the stored points at every null into the runs the line draws, in order", () => {
    expect(segments([[0, 1], [1, null], [2, 3], [3, 4]])).toEqual([[[0, 1]], [[2, 3], [3, 4]]]);
    expect(segments([[0, null], [1, 2], [2, 5], [3, null], [4, null], [5, 1]])).toEqual([[[1, 2], [2, 5]], [[5, 1]]]);
    expect(segments([[0, null]])).toEqual([]);
    expect(segments([[0, 1], [1, 2]])).toEqual([[[0, 1], [1, 2]]]);
  });
});

describe("the gap to the base in bp", () => {
  it("is (y - base) times 100 on percent-unit values, whole bp, never a negative zero", () => {
    expect(deltaBp(4.705, 3.705)).toBe(100);
    expect(deltaBp(3.226, 3.705)).toBe(-48);
    expect(Object.is(deltaBp(3.70499, 3.705), 0)).toBe(true);
  });
  it("rounds an exact half bp away from zero on both sides, whatever the float noise (Polish 11, Minor 6)", () => {
    // 3.705 - 3.7 is 0.4999999999999893 bp in floating point, 3.7 - 3.695 is 0.5000000000000115: both are half a bp.
    expect(deltaBp(3.705, 3.7)).toBe(1);
    expect(deltaBp(3.7, 3.695)).toBe(1);
    expect(deltaBp(3.695, 3.7)).toBe(-1);
    expect(deltaBp(3.7, 3.705)).toBe(-1);
    // Off the half, plain rounding: 0.49 bp is 0, -1.51 bp is -2.
    expect(Object.is(deltaBp(3.7049, 3.7), 0)).toBe(true);
    expect(deltaBp(3.6849, 3.7)).toBe(-2);
  });
  it("prints signed", () => {
    expect([signedBp(100), signedBp(-48), signedBp(0)]).toEqual(["+100", "-48", "0"]);
  });
});

describe("stepDecimals", () => {
  it("gives the decimals a tick label needs at its step", () => {
    expect([0.2, 0.05, 1, 20, 0.002].map(stepDecimals)).toEqual([1, 2, 0, 0, 3]);
  });
});

describe("moneyTick (Polish 13)", () => {
  it("prints a y tick in USD millions at every step, at the decimals the step needs, a true minus, no signed zero", () => {
    const M = "\u2212";
    // Millions at every step (fix round 1): a whole-million step prints no decimals, a sub-$1M step the ones it needs.
    expect([0, 500e6, 3_500e6].map((v) => moneyTick(v, 500e6))).toEqual(["$0M", "$500M", "$3,500M"]);
    expect(moneyTick(800e6, 100e6)).toBe("$800M");
    expect(moneyTick(1_000e6, 200e6)).toBe("$1,000M");
    expect(moneyTick(-300e6, 100e6)).toBe(`${M}$300M`);
    expect(moneyTick(2_500_000, 500_000)).toBe("$2.5M");
    expect(moneyTick(0, 500_000)).toBe("$0.0M");
    expect(moneyTick(50_000, 50_000)).toBe("$0.05M");
    expect(moneyTick(-2_000_000, 1_000_000)).toBe(`${M}$2M`);
    expect(moneyTick(-0.4, 1_000_000)).toBe("$0M");
  });
});

describe("zoomTo", () => {
  it("turns a drag of more than 8 px into the domain under it, clamped to the plot", () => {
    const s = xScale("linear", 0, 574, 50, 624);
    expect(zoomTo(100, 105, s, 50, 624)).toBeNull();
    expect(zoomTo(400, 200, s, 50, 624)).toEqual([150, 350]);
    expect(zoomTo(10, 700, s, 50, 624)).toEqual([0, 574]);
  });
  it("ignores a drag that stays in the y-axis gutter or the right margin", () => {
    const s = xScale("linear", 0, 574, 50, 624);
    // 30 to 45 px lies wholly left of the plot's 50 px edge; 630 to 640 px wholly right of its 624 px edge.
    expect(zoomTo(30, 45, s, 50, 624)).toBeNull();
    expect(zoomTo(630, 640, s, 50, 624)).toBeNull();
  });
  it("clamps a drag that crosses into the plot before it checks the width, ascending", () => {
    const s = xScale("linear", 0, 574, 50, 624);
    // 20 to 60 px clamps to 50 to 60 px: 10 px, so domain 0 to 10.
    expect(zoomTo(20, 60, s, 50, 624)).toEqual([0, 10]);
    // 700 to 610 px clamps to 610 to 624 px: 14 px, so domain 560 to 574.
    expect(zoomTo(700, 610, s, 50, 624)).toEqual([560, 574]);
    // 40 to 55 px clamps to 50 to 55 px: 5 px, too short to zoom.
    expect(zoomTo(40, 55, s, 50, 624)).toBeNull();
  });
});

describe("zoomDrag (Polish 11, Minor 5)", () => {
  it("starts a band on the press, follows the pointer, and hands the band over on the release", () => {
    const down = zoomDrag(null, { type: "down", px: 100, button: 0 });
    expect(down).toEqual({ drag: { from: 100, to: 100 }, release: null });
    const moved = zoomDrag(down.drag, { type: "move", px: 180 });
    expect(moved).toEqual({ drag: { from: 100, to: 180 }, release: null });
    expect(zoomDrag(moved.drag, { type: "up", px: 190 })).toEqual({ drag: null, release: [100, 190] });
  });
  it("starts only on the primary button: a right-button press starts no drag and its release zooms nothing (fix round 1)", () => {
    const right = zoomDrag(null, { type: "down", px: 100, button: 2 });
    expect(right).toEqual({ drag: null, release: null });
    expect(zoomDrag(right.drag, { type: "move", px: 180 })).toEqual({ drag: null, release: null });
    expect(zoomDrag(right.drag, { type: "up", px: 190 })).toEqual({ drag: null, release: null });
    // A second button pressed during a primary drag leaves that drag as it was.
    expect(zoomDrag({ from: 100, to: 150 }, { type: "down", px: 160, button: 2 })).toEqual({ drag: { from: 100, to: 150 }, release: null });
  });
  it("ends the drag on a cancel or a lost capture: the band clears and nothing zooms", () => {
    expect(zoomDrag({ from: 100, to: 180 }, { type: "cancel" })).toEqual({ drag: null, release: null });
    // A release after the cancel finds no drag, so it zooms nothing either.
    expect(zoomDrag(null, { type: "up", px: 190 })).toEqual({ drag: null, release: null });
    expect(zoomDrag(null, { type: "move", px: 190 })).toEqual({ drag: null, release: null });
  });
});

describe("toggleHidden (Polish 11, T1 review coverage note)", () => {
  it("hides a shown series and shows a hidden one, but never hides the last one shown", () => {
    const ids = ["a", "b", "c"];
    expect([...toggleHidden(new Set(), ids, "a")]).toEqual(["a"]);
    expect([...toggleHidden(new Set(["a"]), ids, "a")]).toEqual([]);
    expect([...toggleHidden(new Set(["a"]), ids, "b")].sort()).toEqual(["a", "b"]);
    // a and b hidden: c is the last one shown and stays.
    expect([...toggleHidden(new Set(["a", "b"]), ids, "c")].sort()).toEqual(["a", "b"]);
    expect([...toggleHidden(new Set(), ["only"], "only")]).toEqual([]);
  });
  it("returns a new set and leaves the one it was given as it was", () => {
    const before = new Set(["a"]);
    const after = toggleHidden(before, ["a", "b"], "b");
    expect(after).not.toBe(before);
    expect([...before]).toEqual(["a"]);
  });
});

describe("the tooltip's place", () => {
  it("sits 16 px right of the crosshair and flips left at the right edge", () => {
    expect(tipLeft(100, 150, 640)).toBe(116);
    expect(tipLeft(500, 150, 640)).toBe(334);
    expect(tipLeft(100, 200, 250)).toBe(0);
  });
  it("never covers the crosshair: the side with room, else the larger side with its width capped (Polish 11, F11)", () => {
    // 640 px wide, 16 px gap, 4 px right margin. At 100 the right side has 640 - 4 - 116 = 520 px: a 150 px tip fits.
    expect(tipPlace(100, 150, 640)).toEqual({ left: 116, maxWidth: null });
    // At 500 the right has 120 px, the left 484: it flips left, 500 - 16 - 150 = 334.
    expect(tipPlace(500, 150, 640)).toEqual({ left: 334, maxWidth: null });
    // The 1024 Rates case: a 440 px tip on a 658 px chart. At 300 the right has 654 - 316 = 338 px and the left 284:
    // neither fits, the right is larger, so it sits at 316 capped to 338 px.
    expect(tipPlace(300, 440, 658)).toEqual({ left: 316, maxWidth: 338 });
    // At 400 the right has 238 px and the left 384: the left is larger, so it is capped to 384 px and ends at 384.
    expect(tipPlace(400, 440, 658)).toEqual({ left: 0, maxWidth: 384 });
    // Where the old placement clamped to 0 over the crosshair (100 px on a 250 px chart), the right's 130 px is used.
    expect(tipPlace(100, 200, 250)).toEqual({ left: 116, maxWidth: 130 });
  });
  it("keeps a 440 px tip clear of the crosshair at every place on the 1024 chart", () => {
    for (let px = 50; px <= 642; px += 4) {
      const p = tipPlace(px, 440, 658);
      const w = p.maxWidth === null ? 440 : Math.min(440, p.maxWidth);
      const clear = p.left >= px + 16 || p.left + w <= px - 16;
      expect(clear, `crosshair at ${px}`).toBe(true);
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left + w).toBeLessThanOrEqual(654);
    }
  });
  it("centres on the pointer inside the plot's height, at the fallback with no pointer", () => {
    expect(tipTop(null, 80, 300, 16)).toBe(16);
    expect(tipTop(150, 80, 300, 16)).toBe(110);
    expect(tipTop(10, 80, 300, 16)).toBe(0);
    expect(tipTop(290, 80, 300, 16)).toBe(220);
  });
});

describe("tipRows (Polish 15 item 4)", () => {
  const S = (id: string) => ({ id });
  const at = (values: Record<string, number | null>) => (s: { id: string }) => values[s.id] ?? null;
  it("lists each shown series with a value, highest first, ties in the shown order", () => {
    const shown = [S("a"), S("b"), S("base"), S("s0")];
    expect(tipRows(shown, at({ a: 3, b: null, base: 2, s0: 2 })).map((r) => [r.s.id, r.v])).toEqual([["a", 3], ["base", 2], ["s0", 2]]);
  });
  it("leaves the base's twin out while the base has the same value there, so the base prints once", () => {
    const shown = [S("a"), S("s0"), S("base")];
    expect(tipRows(shown, at({ a: 3, s0: 2, base: 2 }), "base", "s0").map((r) => r.s.id)).toEqual(["a", "base"]);
    // A twin that differs from the base at this x is not the base there: both rows stay (2.5 above 2).
    expect(tipRows(shown, at({ a: 3, s0: 2.5, base: 2 }), "base", "s0").map((r) => r.s.id)).toEqual(["a", "s0", "base"]);
    // The base hidden (not shown) or with no value here: the twin's row returns.
    expect(tipRows([S("a"), S("s0")], at({ a: 3, s0: 2 }), "base", "s0").map((r) => r.s.id)).toEqual(["a", "s0"]);
    expect(tipRows(shown, at({ a: 3, s0: 2, base: null }), "base", "s0").map((r) => r.s.id)).toEqual(["a", "s0"]);
    // No twin named, or the twin is the base itself: nothing is left out.
    expect(tipRows(shown, at({ a: 3, s0: 2, base: 2 }), "base").map((r) => r.s.id)).toEqual(["a", "s0", "base"]);
    expect(tipRows(shown, at({ a: 3, s0: 2, base: 2 }), "base", "base").map((r) => r.s.id)).toEqual(["a", "s0", "base"]);
  });
});

describe("monthTicks", () => {
  // Whole years print with an uppercase Y, as every curve tenor does since Polish 15 (Polish 16).
  it("ticks a 30-year path every five years and a short span in months", () => {
    expect(monthTicks(0, 359)).toEqual([
      { value: 0, label: "M0" }, { value: 60, label: "5Y" }, { value: 120, label: "10Y" },
      { value: 180, label: "15Y" }, { value: 240, label: "20Y" }, { value: 300, label: "25Y" },
    ]);
    expect(monthTicks(100, 160).map((t) => t.label)).toEqual(["9Y", "10Y", "11Y", "12Y", "13Y"]);
    expect(monthTicks(0, 20).map((t) => t.label)).toEqual(["M0", "M6", "1Y", "M18"]);
  });
});
