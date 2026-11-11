/**
 * The numbers behind the 3D vol surface (ALM Studio Polish 10 T3): the projection, the
 * unit box of a grid, the faces (only four stored corners, far to near, their --seq-N step), the shading bounds, the
 * hit test, the view easing and the elevation clamp. Every expected value is worked by hand and restated here.
 */
import { describe, expect, it } from "vitest";
import type { VolGrid } from "@alm/reader";
import {
  axisShown, axisWeight, clampEl, easeView, evenTicks, faces, fitFrame, hitTest, keepLabels, layoutSurface, pickTicks, project, projectUnit, resolutionQuery,
  shadeOf, strikeTicks, surfaceDrag, surfaceFrame, traceRuns, vertices, VIEWS, type SurfaceLabelsIn, type Vertex, type View,
} from "../charts/surfaceProjection";

/** Three expiries by three columns, one quote missing: 10 to 40 bp. */
const GRID: VolGrid = { rows: [1, 4, 9], cols: [0, 1, 2], cells: [[10, 20, 30], [20, 30, 40], [30, 40, null]], atm: null, min: 10, max: 40 };
const vx = (X: number, Y: number, Z: number): Vertex => ({ i: 0, j: 0, X, Y, Z, v: 0 });

describe("project", () => {
  it("scales the unit box by the smaller of 64% of the width and 102% of the height, centred, the floor 60% down", () => {
    // 640 by 440: S = min(409.6, 448.8) = 409.6; the origin sits at x 320, y 264 + 0.08 S = 296.768.
    const o = project(0, 0, 0, { az: 0, el: 0 }, 640, 440);
    expect(o.x).toBeCloseTo(320, 9);
    expect(o.y).toBeCloseTo(296.768, 9);
    expect(project(0.5, 0, 0, { az: 0, el: 0 }, 640, 440).x).toBeCloseTo(524.8, 9);
    // Seen from straight above, a point half a box back sits 0.5 S higher on the canvas.
    expect(project(0, 0.5, 0, { az: 0, el: Math.PI / 2 }, 640, 440).y).toBeCloseTo(91.968, 9);
  });
  it("gives depth along the view: a turn of a quarter puts +x at the back, a point higher is nearer", () => {
    expect(project(0.5, 0, 0, { az: Math.PI / 2, el: 0 }, 640, 440).d).toBeCloseTo(0.5, 9);
    expect(project(0, 0, 0.5, { az: 0, el: Math.PI / 6 }, 640, 440).d).toBeCloseTo(-0.25, 9);
  });
  it("keeps the tilt between 3 and 86 degrees, and holds the four preset views", () => {
    expect(clampEl(0)).toBeCloseTo(0.0523599, 6);
    expect(clampEl(2)).toBeCloseTo(1.5009832, 6);
    expect(clampEl(0.5)).toBe(0.5);
    expect(VIEWS).toEqual({ iso: { az: -0.72, el: 0.52 }, front: { az: 0, el: 0.12 }, side: { az: -Math.PI / 2, el: 0.12 }, top: { az: 0, el: 1.5 } });
  });
});

describe("surfaceFrame and vertices", () => {
  it("sets columns linearly or on a square root, expiries on a square root, vols on a nice range 0.62 tall", () => {
    const grid: VolGrid = { rows: [1, 4], cols: [0.01, 0.03], cells: [[50, 60], [70, null]], atm: null, min: 50, max: 70 };
    const f = surfaceFrame(grid, "linear");
    expect([f.nx(0.01), f.nx(0.02), f.nx(0.03)].map((v) => Number(v.toFixed(9)))).toEqual([-0.5, 0, 0.5]);
    expect([f.ny(1), f.ny(2.25), f.ny(4)]).toEqual([-0.5, 0, 0.5]);
    expect(f.zt).toEqual({ lo: 50, hi: 70, step: 5, ticks: [50, 55, 60, 65, 70] });
    expect([f.nz(50), f.nz(60), f.nz(70)]).toEqual([0, 0.31, 0.62]);
    expect(surfaceFrame(GRID, "sqrt").nx(1)).toBeCloseTo(Math.sqrt(1 / 2) - 0.5, 9);
    // A missing quote is no vertex.
    expect(vertices(grid, f).map((q) => [q.i, q.j])).toEqual([[0, 0], [0, 1], [1, 0]]);
  });
});

describe("faces", () => {
  it("joins four stored quotes only, paints far to near, and fills each with the step of its mean vol", () => {
    const fs = faces(GRID, surfaceFrame(GRID, "linear"), { az: 0, el: 0.52 }, 640, 440);
    // The face at rows 1 to 2 and columns 1 to 2 has a missing corner. Mean depths: rows 1 to 2, 0.0116; rows 0 to 1
    // columns 0 to 1, -0.3196; columns 1 to 2, higher and so nearer, -0.4223.
    expect(fs.map((f) => [f.corners[0].i, f.corners[0].j])).toEqual([[1, 0], [0, 0], [0, 1]]);
    // Means 30, 20, 30 bp on seven equal bins from 10 to 40: steps 5, 3, 5.
    expect(fs.map((f) => f.step)).toEqual([5, 3, 5]);
    expect(fs[0]!.depth).toBeCloseTo(0.011578, 5);
  });
});

describe("shadeOf", () => {
  it("shades a level face 0.09 (the light is 0.82 up) and a face turned from the light the full 0.5", () => {
    expect(shadeOf(vx(0, 0, 0), vx(1, 0, 0), vx(1, 1, 0), vx(0, 1, 0))).toBeCloseTo(0.09, 9);
    expect(shadeOf(vx(0, 0, 0), vx(0, 1, 0), vx(0, 1, 1), vx(0, 0, 1))).toBe(0.5);
  });
  it("stays between 0 and 0.5 on every face", () => {
    for (const f of faces(GRID, surfaceFrame(GRID, "sqrt"), VIEWS.iso, 640, 440)) {
      expect(f.shade).toBeGreaterThanOrEqual(0);
      expect(f.shade).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("hitTest", () => {
  const pts = [{ i: 0, j: 0, x: 100, y: 100, d: 0.2 }, { i: 0, j: 1, x: 105, y: 100, d: -0.1 }, { i: 1, j: 0, x: 200, y: 200, d: 0 }];
  it("snaps to the nearest projected quote within 16 px, none beyond", () => {
    expect(hitTest(pts, 95, 100)).toEqual({ i: 0, j: 0 });
    expect(hitTest(pts, 205, 205)).toEqual({ i: 1, j: 0 });
    expect(hitTest(pts, 150, 150)).toBeNull();
    expect(hitTest(pts, 200, 217)).toBeNull();
  });
  it("prefers the nearer of two close hits, within 30 px squared of the nearest", () => {
    // 1 and 16 px squared away: the second is nearer the eye.
    expect(hitTest(pts, 101, 100)).toEqual({ i: 0, j: 1 });
  });
});

describe("easeView and pickTicks", () => {
  it("eases out on a cube and stops at the target", () => {
    expect(easeView({ az: 0, el: 0 }, { az: 1, el: 1 }, 0.5)).toEqual({ az: 0.875, el: 0.875 });
    expect(easeView({ az: 0, el: 0 }, { az: 1, el: 1 }, 2)).toEqual({ az: 1, el: 1 });
  });
  it("keeps at most n ticks spread evenly, the first and the last among them", () => {
    expect(pickTicks([1, 2, 3], 6)).toEqual([1, 2, 3]);
    expect(pickTicks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 6)).toEqual([1, 3, 5, 6, 8, 10]);
  });
});

describe("projectUnit and a fitted frame (Polish 10 Task 5, F1, F3, F5, F6)", () => {
  it("projects at unit scale about the origin, and a fit scales and places that", () => {
    const u = projectUnit(0.5, 0, 0, { az: 0, el: 0 });
    expect(u.x).toBeCloseTo(0.5, 12);
    expect(u.y).toBeCloseTo(0, 12);
    // From straight above, half a box back is half a unit up the canvas.
    expect(projectUnit(0, 0.5, 0, { az: 0, el: Math.PI / 2 }).y).toBeCloseTo(-0.5, 12);
    const p = project(0.5, 0, 0, { az: 0, el: 0 }, 640, 440, { S: 100, cx: 10, cy: 20 });
    expect(p.x).toBeCloseTo(60, 9);
    expect(p.y).toBeCloseTo(20, 9);
  });
  it("fits the widest scale whose items, anchors plus their px boxes, span the canvas less the margin, centred", () => {
    // A at -0.5 with a 30 px box to its left, B at +0.5 with a 20 px box to its right: S + 50 <= 200, so S = 150;
    // the extent runs -105 to 95 about the origin, centre -5, so cx = 100 + 5 = 105 (A's left edge 0, B's right 200).
    const A = { ux: -0.5, uy: 0, x0: -30, x1: 0, y0: -5, y1: 5 };
    const B = { ux: 0.5, uy: 0, x0: 0, x1: 20, y0: -5, y1: 5 };
    expect(fitFrame([A, B], 200, 100, 0, 1000)).toEqual({ S: 150, cx: 105, cy: 50 });
    // The cap binds first: S 100; extent -80 to 70, centre -5, cx 105.
    expect(fitFrame([A, B], 200, 100, 0, 100)).toEqual({ S: 100, cx: 105, cy: 50 });
    // A 10 px margin leaves 180: S = 130; extent -95 to 85, centre -5, cx 105.
    expect(fitFrame([A, B], 200, 100, 10, 1000)).toEqual({ S: 130, cx: 105, cy: 50 });
    // Height binds: C at uy -0.4 and D at +0.4 with a 12 px box under it: 0.8 S + 12 <= 100, so S = 110; y extent
    // -44 to 56, centre 6, cy = 50 - 6 = 44 (C's top at 0, D's bottom at 100).
    const C = { ux: 0, uy: -0.4, x0: 0, x1: 0, y0: 0, y1: 0 };
    const D = { ux: 0, uy: 0.4, x0: 0, x1: 0, y0: 0, y1: 12 };
    const f = fitFrame([A, B, C, D], 200, 100, 0, 1000);
    expect(f.S).toBeCloseTo(110, 9);
    expect(f.cx).toBeCloseTo(105, 9);
    expect(f.cy).toBeCloseTo(44, 9);
  });
});

describe("axisShown (F4)", () => {
  it("hides an axis the view shows under 0.3 of, edge-on", () => {
    // Front and Side (el 0.12): the depth edge shows sin 0.12 = 0.1197 of its length. Top (el 1.5): the vol axis shows
    // 0.62 cos 1.5 = 0.04386 of its 0.62. The 3D preset shows the expiry edge at sqrt(sin^2 0.72 + (cos 0.72 sin 0.52)^2) = 0.7579.
    expect(axisShown(0.1197, 1)).toBe(false);
    expect(axisShown(0.04386, 0.62)).toBe(false);
    expect(axisShown(0.7579, 1)).toBe(true);
    expect(axisShown(0.3, 1)).toBe(true);
    expect(axisShown(0.29, 1)).toBe(false);
  });
  it("gives a hidden axis's room back in the fit gradually: all of it at 0.3, none at 0.2 or less", () => {
    expect(axisWeight(0.5, 1)).toBe(1);
    expect(axisWeight(0.2, 1)).toBe(0);
    expect(axisWeight(0.1197, 1)).toBe(0);
    expect(axisWeight(0.25, 1)).toBeCloseTo(0.5, 12);
    // 0.155 of 0.62 is 0.25 of it.
    expect(axisWeight(0.155, 0.62)).toBeCloseTo(0.5, 12);
  });
});

describe("keepLabels (F3)", () => {
  it("keeps a label unless its box meets one already kept or leaves the canvas", () => {
    const r = (x0: number, x1: number, y0 = 0, y1 = 10) => ({ x0, x1, y0, y1 });
    // The second overlaps the first by 1 px and goes; the third is 1 px clear of the first and stays.
    expect(keepLabels([r(0, 10), r(9, 20), r(11, 20)], 100, 100)).toEqual([true, false, true]);
    // Past the right edge, past the left edge, below the bottom.
    expect(keepLabels([r(95, 101), r(-1, 5), r(40, 50, 95, 101)], 100, 100)).toEqual([false, false, false]);
  });
});

describe("evenTicks (F7)", () => {
  it("keeps the stored whole-unit values on the smallest 1, 2 or 5 step that gives at most n", () => {
    const strikes = [-0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07];
    expect(evenTicks(strikes, 0.01, 6)).toEqual([-0.02, 0, 0.02, 0.04, 0.06]);
    expect(evenTicks([0.03, 0.04], 0.01, 6)).toEqual([0.03, 0.04]);
    // 0 to 20 percent: 21 values; a 2 step still leaves 11, a 5 step 5.
    const wide = Array.from({ length: 21 }, (_, k) => k / 100);
    expect(evenTicks(wide, 0.01, 6)).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
  });
});

describe("layoutSurface (F1, F3, F4, F5, F6)", () => {
  // The Market cap surface's labels: strikes -2% to 6% on a -2% to 7% box, six expiries on a square root of 1y to 30y,
  // vols 50 to 130 bp by 10. Widths as the 11 px mono face prints them, about 6.6 px a character; titles 7 px.
  const w = (s: string) => s.length * 6.6;
  const ax = (at: number, text: string) => ({ at, text, w: w(text) });
  const X = (k: number) => (k + 2) / 9 - 0.5;
  const Y = (y: number) => (Math.sqrt(y) - 1) / (Math.sqrt(30) - 1) - 0.5;
  const CAP: SurfaceLabelsIn = {
    x: [-2, 0, 2, 4, 6].map((k) => ax(X(k), `${k}%`)),
    y: [1, 4, 7, 10, 20, 30].map((y) => ax(Y(y), `${y}y`)),
    z: [50, 60, 70, 80, 90, 100, 110, 120, 130].map((v, k) => ax((k / 8) * 0.62, `${v}`)),
    titles: { x: { text: "Strike", w: 42 }, y: { text: "Expiry", w: 42 }, z: { text: "bp", w: 14 } },
  };
  // A placed label's box, restated: the text is 8 px above its baseline and 3 below, centred or right aligned.
  const box = (l: { x: number; y: number; w: number; align: "center" | "right" }) => {
    const x0 = l.align === "center" ? l.x - l.w / 2 : l.x - l.w;
    return { x0, x1: x0 + l.w, y0: l.y - 8, y1: l.y + 3 };
  };
  const inside = (view: View, Wd: number) => {
    const L = layoutSurface(view, CAP, Wd, 440);
    for (const l of L.labels) {
      const b = box(l);
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(Wd);
      expect(b.y0).toBeGreaterThanOrEqual(0);
      expect(b.y1).toBeLessThanOrEqual(440);
    }
    // Every corner of the box, floor and top, inside the canvas less the 4 px margin.
    for (const [cx, cy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      for (const z of [0, 0.62]) {
        const p = project(cx!, cy!, z, view, Wd, 440, L.fit);
        expect(p.x).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(p.x).toBeLessThanOrEqual(Wd - 4 + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(p.y).toBeLessThanOrEqual(440 - 4 + 1e-9);
      }
    }
    // No two placed labels meet.
    const bs = L.labels.map(box);
    for (let a = 0; a < bs.length; a++) for (let b = a + 1; b < bs.length; b++) {
      const p = bs[a]!;
      const q = bs[b]!;
      expect(p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1).toBe(false);
    }
    return L;
  };
  const texts = (view: View, Wd: number) => layoutSurface(view, CAP, Wd, 440).labels.map((l) => l.text);

  it("keeps every label and every box corner on the canvas in all four views at 522, 616.7 and 658 px", () => {
    for (const view of [VIEWS.iso, VIEWS.front, VIEWS.side, VIEWS.top]) for (const Wd of [522, 616.7, 658]) inside(view, Wd);
  });
  it("never grows past today's scale, the smaller of 64% of the width and 102% of the height", () => {
    // 1440, 616.7 px: 394.688 at most.
    expect(layoutSurface(VIEWS.iso, CAP, 616.7, 440).fit.S).toBeLessThanOrEqual(394.688 + 1e-9);
  });
  it("prints every expiry tick and every strike but the floor corner's at the 3D preset", () => {
    // Restated in Polish 11: the vol ticks are placed first, so the -2% strike at the left floor corner, which meets the
    // floor vol tick 50, is the label that drops (it printed and 50 dropped before).
    for (const Wd of [522, 616.7, 658]) {
      const t = texts(VIEWS.iso, Wd);
      for (const s of ["0%", "2%", "4%", "6%", "1y", "4y", "7y", "10y", "20y", "30y", "Strike", "Expiry", "bp", "50", "130"]) expect(t).toContain(s);
      expect(t).not.toContain("-2%");
    }
  });
  it("hides the edge-on axis: expiries in Front, strikes in Side, the vol axis in Top", () => {
    const front = texts(VIEWS.front, 616.7);
    expect(front).not.toContain("Expiry");
    expect(front.filter((s) => s.endsWith("y"))).toEqual([]);
    expect(front).toContain("Strike");
    expect(front).toContain("130");
    const side = texts(VIEWS.side, 616.7);
    expect(side).not.toContain("Strike");
    expect(side.filter((s) => s.endsWith("%"))).toEqual([]);
    expect(side).toContain("Expiry");
    const top = texts(VIEWS.top, 616.7);
    expect(top).not.toContain("bp");
    expect(top).not.toContain("130");
    expect(top).toContain("Strike");
    expect(top).toContain("Expiry");
  });
  it("centres what is shown: a hidden axis keeps no room, so Front, Side and Top sit mid-canvas", () => {
    // The drawn extent (the box corners and the placed label boxes) leaves the same gap each side, give or take the
    // hidden axis's bare anchors 1.08 out: at most 0.04 S beyond the box.
    for (const view of [VIEWS.front, VIEWS.side, VIEWS.top]) {
      const L = layoutSurface(view, CAP, 616.7, 440);
      const xs: number[] = [];
      for (const [cx, cy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) for (const z of [0, 0.62]) xs.push(project(cx!, cy!, z, view, 616.7, 440, L.fit).x);
      for (const l of L.labels) { const b = box(l); xs.push(b.x0, b.x1); }
      const gapL = Math.min(...xs);
      const gapR = 616.7 - Math.max(...xs);
      expect(Math.abs(gapL - gapR)).toBeLessThanOrEqual(0.04 * L.fit.S + 1e-6);
    }
  });
  it("keeps the floor vol tick at 3D and Front: the vol ticks are placed before the floor labels (Polish 11, Minor 2)", () => {
    for (const view of [VIEWS.iso, VIEWS.front]) for (const Wd of [522, 616.7, 658]) {
      const L = inside(view, Wd);
      const t = L.labels.map((l) => l.text);
      for (const v of ["50", "60", "70", "80", "90", "100", "110", "120", "130"]) expect(t, `${v} at ${Wd}`).toContain(v);
    }
  });
  it("keeps the swaption's floor vol tick too: tenors on a square root, vols 70 to 150 bp", () => {
    const T = (y: number) => (Math.sqrt(y) - 1) / (Math.sqrt(30) - 1) - 0.5;
    const E = (y: number) => (Math.sqrt(y) - Math.sqrt(1 / 12)) / (Math.sqrt(30) - Math.sqrt(1 / 12)) - 0.5;
    const SWPN: SurfaceLabelsIn = {
      x: [[1, "1y"], [2, "2y"], [5, "5y"], [10, "10y"], [20, "20y"], [30, "30y"]].map(([y, s]) => ax(T(y as number), s as string)),
      y: [[1 / 12, "1M"], [0.5, "6M"], [2, "2y"], [5, "5y"], [10, "10y"], [30, "30y"]].map(([y, s]) => ax(E(y as number), s as string)),
      z: [70, 80, 90, 100, 110, 120, 130, 140, 150].map((v, k) => ax((k / 8) * 0.62, `${v}`)),
      titles: { x: { text: "Swap tenor", w: 70 }, y: { text: "Expiry", w: 42 }, z: { text: "bp", w: 14 } },
    };
    for (const view of [VIEWS.iso, VIEWS.front]) for (const Wd of [522, 616.7, 658]) {
      expect(layoutSurface(view, SWPN, Wd, 440).labels.map((l) => l.text), `${Wd}`).toContain("70");
    }
  });
  it("nudges the expiry ticks 6 px outward, away from the box", () => {
    // At the 3D preset the expiry edge is the box's right side (nearX +0.5, cos az > 0): the label sits 6 px right of
    // its anchor at X 0.54; the anchor x is cx + S (0.54 cos az - Y sin az).
    const L = layoutSurface(VIEWS.iso, CAP, 616.7, 440);
    const at = L.labels.find((l) => l.text === "30y")!;
    const ux = 0.54 * Math.cos(-0.72) - Y(30) * Math.sin(-0.72);
    expect(at.x).toBeCloseTo(L.fit.cx + L.fit.S * ux + 6, 6);
  });
});

describe("strikeTicks (Polish 11, Minor 4)", () => {
  it("ticks the whole-percent strikes on an even step when the grid stores some", () => {
    const live = [-0.02, -0.015, -0.01, 0, 0.01, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.07];
    expect(strikeTicks(live, 6)).toEqual({ ticks: [-0.02, 0, 0.02, 0.04, 0.06], whole: true });
  });
  it("falls back to six of the stored strikes when none is a whole percent, so the surface and the smile keep x ticks", () => {
    expect(strikeTicks([0.015, 0.025, 0.035], 6)).toEqual({ ticks: [0.015, 0.025, 0.035], whole: false });
    // Ten half-percent strikes: indices 0, 2, 4, 5, 7, 9 (k times 9 over 5, rounded).
    const half = [0.005, 0.015, 0.025, 0.035, 0.045, 0.055, 0.065, 0.075, 0.085, 0.095];
    expect(strikeTicks(half, 6)).toEqual({ ticks: [0.005, 0.025, 0.045, 0.055, 0.075, 0.095], whole: false });
  });
  it("falls back too when no even step keeps a whole strike: seven odd percents leave none on a 2% step", () => {
    // 1, 3, 7, 9, 11, 13, 17%: a 1% step keeps 7 (over 6), a 2% step keeps none. Indices 0, 1, 2, 4, 5, 6.
    const odd = [0.01, 0.03, 0.07, 0.09, 0.11, 0.13, 0.17];
    expect(evenTicks(odd, 0.01, 6)).toEqual([]);
    expect(strikeTicks(odd, 6)).toEqual({ ticks: [0.01, 0.03, 0.07, 0.11, 0.13, 0.17], whole: true });
  });
});

describe("traceRuns (Polish 11, T3 review Minor 1)", () => {
  // Three expiries by four columns with a hole mid-row 0, mid-column 3 and at a row end.
  const HOLES: VolGrid = { rows: [1, 4, 9], cols: [0, 1, 2, 3], cells: [[10, null, 30, 40], [20, 30, 40, null], [null, 40, 50, 60]], atm: null, min: 10, max: 60 };
  const verts = vertices(HOLES, surfaceFrame(HOLES, "linear"));
  const ij = (runs: Vertex[][]) => runs.map((r) => r.map((q) => [q.i, q.j]));
  it("breaks a selected row's trace at a missing quote instead of joining across it", () => {
    expect(ij(traceRuns(verts, "row", 0))).toEqual([[[0, 0]], [[0, 2], [0, 3]]]);
    expect(ij(traceRuns(verts, "row", 1))).toEqual([[[1, 0], [1, 1], [1, 2]]]);
  });
  it("breaks a selected column's trace the same way, down the expiries", () => {
    expect(ij(traceRuns(verts, "col", 3))).toEqual([[[0, 3]], [[2, 3]]]);
    expect(ij(traceRuns(verts, "col", 0))).toEqual([[[0, 0], [1, 0]]]);
    expect(ij(traceRuns(verts, "col", 1))).toEqual([[[1, 1], [2, 1]]]);
  });
});

describe("surfaceDrag (Polish 11, Minor 5 and T3 review Minors 2 to 4)", () => {
  const press = () => surfaceDrag(null, { type: "down", x: 100, y: 100, button: 0 });
  it("starts a drag on the primary button only; another button neither drags nor pins", () => {
    expect(press()).toEqual({ drag: { x: 100, y: 100, moved: false }, turn: null, pin: false });
    const right = surfaceDrag(null, { type: "down", x: 100, y: 100, button: 2 });
    expect(right).toEqual({ drag: null, turn: null, pin: false });
    expect(surfaceDrag(right.drag, { type: "up" })).toEqual({ drag: null, turn: null, pin: false });
  });
  it("leaves the view still until the drag passes 3 px, so a pin click with 2 px of jitter pins and does not turn", () => {
    const jitter = surfaceDrag(press().drag, { type: "move", x: 101, y: 101 });
    expect(jitter).toEqual({ drag: { x: 100, y: 100, moved: false }, turn: null, pin: false });
    // 3 px is still inside the threshold.
    const three = surfaceDrag(jitter.drag, { type: "move", x: 102, y: 101 });
    expect(three.turn).toBeNull();
    expect(surfaceDrag(three.drag, { type: "up" })).toEqual({ drag: null, turn: null, pin: true });
  });
  it("turns by the whole offset from the press once past 3 px, then move by move; a release after a turn does not pin", () => {
    const past = surfaceDrag(press().drag, { type: "move", x: 103, y: 101 });
    expect(past).toEqual({ drag: { x: 103, y: 101, moved: true }, turn: { dx: 3, dy: 1 }, pin: false });
    const next = surfaceDrag(past.drag, { type: "move", x: 110, y: 105 });
    expect(next).toEqual({ drag: { x: 110, y: 105, moved: true }, turn: { dx: 7, dy: 4 }, pin: false });
    expect(surfaceDrag(next.drag, { type: "up" })).toEqual({ drag: null, turn: null, pin: false });
  });
  it("ends the drag on a cancel or a lost capture with no pin; later moves and a release do nothing", () => {
    const cancelled = surfaceDrag(press().drag, { type: "cancel" });
    expect(cancelled).toEqual({ drag: null, turn: null, pin: false });
    expect(surfaceDrag(cancelled.drag, { type: "move", x: 140, y: 100 })).toEqual({ drag: null, turn: null, pin: false });
    expect(surfaceDrag(cancelled.drag, { type: "up" })).toEqual({ drag: null, turn: null, pin: false });
  });
});

describe("resolutionQuery (Polish 11, T3 review Minor 5)", () => {
  it("names the media query that changes when the device pixel ratio leaves its value", () => {
    expect(resolutionQuery(2)).toBe("(resolution: 2dppx)");
    expect(resolutionQuery(1.5)).toBe("(resolution: 1.5dppx)");
  });
});
