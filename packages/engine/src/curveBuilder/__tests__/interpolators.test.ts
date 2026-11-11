import { describe, expect, it } from "vitest";
import { makeZeroInterpolator } from "../interpolators";

const t = [1 / 12, 0.25, 0.5, 1, 2, 5, 10, 30];
const z = [0.043, 0.0435, 0.044, 0.042, 0.0405, 0.041, 0.0425, 0.0435];
const methods = ["linear-zero", "log-linear-df", "cubic-zero", "monotone-convex"] as const;

describe("interpolators", () => {
  for (const m of methods) {
    it(`${m} reproduces every node and is flat at both ends`, () => {
      const f = makeZeroInterpolator(m, t, z);
      t.forEach((ti, i) => expect(f(ti)).toBeCloseTo(z[i], 12));
      expect(f(0.001)).toBeCloseTo(z[0], 12);
      expect(f(50)).toBeCloseTo(z[z.length - 1], 12);
    });
    it(`${m} degrades without NaN on one and two nodes`, () => {
      expect(makeZeroInterpolator(m, [1], [0.04])(0.5)).toBeCloseTo(0.04, 12);
      const two = makeZeroInterpolator(m, [1, 2], [0.04, 0.05]);
      expect(Number.isFinite(two(1.5))).toBe(true);
    });
  }
  it("log-linear-df is linear in -z*t between nodes", () => {
    const f = makeZeroInterpolator("log-linear-df", [1, 2], [0.04, 0.05]);
    const L = (x: number) => -f(x) * x;
    expect(L(1.5)).toBeCloseTo((L(1) + L(2)) / 2, 12);
  });
  it("monotone-convex keeps forwards non-negative for non-negative input forwards", () => {
    const f = makeZeroInterpolator("monotone-convex", t, z);
    const fwd = (a: number, b: number) => (f(b) * b - f(a) * a) / (b - a);
    for (let k = 1; k < 359; k++) expect(fwd(k / 12, (k + 1) / 12)).toBeGreaterThan(0);
  });
  it("monotone-convex integral over each interval equals the node move", () => {
    const f = makeZeroInterpolator("monotone-convex", t, z);
    for (let i = 1; i < t.length; i++) {
      const lhs = f(t[i]) * t[i] - f(t[i - 1]) * t[i - 1];
      const rhs = z[i] * t[i] - z[i - 1] * t[i - 1];
      expect(lhs).toBeCloseTo(rhs, 12);
    }
  });
});

// Extra coverage for the monotone-convex method. Nodes sit at t = 1, 2, 3, 4 so
// each interval has unit width, the interior weights are 1/2, and the discrete
// forwards fd are simply the steps in z*t. Each case below picks fd so that the
// second interval (1, 2] lands in one Hagan-West zone; the expected forwards
// are worked by hand from the published zone formula.
const T4 = [1, 2, 3, 4];
const fromForwards = (fd: number[]): number[] => {
  let acc = 0;
  return fd.map((f, i) => {
    acc += f;
    return acc / T4[i];
  });
};
/** Instantaneous forward d(z*s)/ds by central difference. */
const instFwd = (f: (s: number) => number, s: number): number => {
  const h = 1e-6;
  return (f(s + h) * (s + h) - f(s - h) * (s - h)) / (2 * h);
};

describe("monotone-convex zones", () => {
  it("zone 1: g0 = 0.002, g1 = -0.002 gives a quadratic (here linear) forward", () => {
    // f1 = 0.042, f2 = 0.038, fd2 = 0.040: forward = 0.040 + 0.002*(1 - 2x).
    const f = makeZeroInterpolator("monotone-convex", T4, fromForwards([0.044, 0.04, 0.036, 0.034]));
    expect(instFwd(f, 1.25)).toBeCloseTo(0.041, 8);
    expect(instFwd(f, 1.5)).toBeCloseTo(0.04, 8);
    expect(instFwd(f, 1.75)).toBeCloseTo(0.039, 8);
  });

  it("zone 2: g0 = 0.0005, g1 = -0.003 holds the forward flat up to eta = 4/7", () => {
    const f = makeZeroInterpolator("monotone-convex", T4, fromForwards([0.041, 0.04, 0.034, 0.034]));
    expect(instFwd(f, 1.2)).toBeCloseTo(0.0405, 8);
    expect(instFwd(f, 1.5)).toBeCloseTo(0.0405, 8);
    const eta = 4 / 7;
    const x = 0.8;
    const expected = 0.04 + 0.0005 + (-0.003 - 0.0005) * ((x - eta) / (1 - eta)) ** 2;
    expect(instFwd(f, 1 + x)).toBeCloseTo(expected, 8);
  });

  it("zone 3: g0 = 0.002, g1 = -0.0005 holds the forward flat from eta = 0.6", () => {
    const f = makeZeroInterpolator("monotone-convex", T4, fromForwards([0.044, 0.04, 0.039, 0.039]));
    expect(instFwd(f, 1.3)).toBeCloseTo(0.040125, 8);
    expect(instFwd(f, 1.7)).toBeCloseTo(0.0395, 8);
    expect(instFwd(f, 1.9)).toBeCloseTo(0.0395, 8);
  });

  it("zone 4: g0 = 0.002, g1 = 0.001 dips to fd + A at eta = 1/3", () => {
    const f = makeZeroInterpolator("monotone-convex", T4, fromForwards([0.044, 0.04, 0.042, 0.042]));
    const A = -(0.002 * 0.001) / (0.002 + 0.001);
    expect(instFwd(f, 1 + 1 / 3)).toBeCloseTo(0.04 + A, 8);
    expect(instFwd(f, 1 + 2 / 3)).toBeCloseTo(0.03975, 8);
    expect(instFwd(f, 1.1)).toBeGreaterThan(0.04 + A);
    expect(instFwd(f, 1.6)).toBeGreaterThan(0.04 + A);
  });

  it("every zone case reproduces its nodes and the interval node moves", () => {
    const cases = [
      [0.044, 0.04, 0.036, 0.034],
      [0.041, 0.04, 0.034, 0.034],
      [0.044, 0.04, 0.039, 0.039],
      [0.044, 0.04, 0.042, 0.042],
    ];
    for (const fd of cases) {
      const zs = fromForwards(fd);
      const f = makeZeroInterpolator("monotone-convex", T4, zs);
      T4.forEach((ti, i) => expect(f(ti)).toBeCloseTo(zs[i], 12));
      for (let s = 0.05; s < 5; s += 0.05) expect(Number.isFinite(f(s))).toBe(true);
    }
  });

  it("handles a negative zero rate node and negative forwards without NaN", () => {
    const tn = [0.5, 1, 2, 3, 5];
    const zn = [-0.005, -0.004, -0.002, 0.001, 0.003];
    const f = makeZeroInterpolator("monotone-convex", tn, zn);
    tn.forEach((ti, i) => expect(f(ti)).toBeCloseTo(zn[i], 12));
    expect(f(0.1)).toBeCloseTo(-0.005, 12);
    expect(f(10)).toBeCloseTo(0.003, 12);
    for (let s = 0.05; s < 6; s += 0.05) expect(Number.isFinite(f(s))).toBe(true);

    // All discrete forwards negative: no positivity clamp, forwards stay negative.
    const neg = makeZeroInterpolator("monotone-convex", [1, 2, 3], [-0.005, -0.006, -0.007]);
    expect(neg(2)).toBeCloseTo(-0.006, 12);
    for (let k = 12; k < 36; k++) {
      const a = k / 12;
      const b = (k + 1) / 12;
      const fw = (neg(b) * b - neg(a) * a) / (b - a);
      expect(Number.isFinite(fw)).toBe(true);
      expect(fw).toBeLessThan(0);
    }
  });

  it("reading t <= 0 returns the first zero rate for every method", () => {
    for (const m of methods) {
      const f = makeZeroInterpolator(m, t, z);
      expect(f(0)).toBe(z[0]);
      expect(f(-1)).toBe(z[0]);
    }
  });
});

describe("cubic-zero", () => {
  it("is linear on two nodes and matches a natural spline on three", () => {
    const two = makeZeroInterpolator("cubic-zero", [1, 2], [0.04, 0.05]);
    expect(two(1.25)).toBeCloseTo(0.0425, 12);
    // Natural spline through (0,0), (1,1), (2,0) shifted to t = 1, 2, 3: the
    // middle second derivative is -3, so at x = 0.5 the value is 0.6875.
    const three = makeZeroInterpolator("cubic-zero", [1, 2, 3], [0, 1, 0]);
    expect(three(1.5)).toBeCloseTo(0.6875, 12);
    expect(three(2.5)).toBeCloseTo(0.6875, 12);
  });
});

// B1 follow-up: the mirrored (g0 < 0) branch of each Hagan-West zone. Each case negates g0 and g1 of
// the matching case above, so the forward on (1, 2] is the reflection of that case about fd = 0.040.
describe("monotone-convex zones, mirrored (g0 < 0)", () => {
  it("zone 1: g0 = -0.002, g1 = 0.002 gives the reflected linear forward", () => {
    // f1 = 0.038, f2 = 0.042, fd2 = 0.040: forward = 0.040 - 0.002*(1 - 2x).
    const f = makeZeroInterpolator("monotone-convex", T4, fromForwards([0.036, 0.04, 0.044, 0.046]));
    expect(instFwd(f, 1.25)).toBeCloseTo(0.039, 8);
    expect(instFwd(f, 1.5)).toBeCloseTo(0.04, 8);
    expect(instFwd(f, 1.75)).toBeCloseTo(0.041, 8);
  });

  it("zone 2: g0 = -0.0005, g1 = 0.003 holds the forward flat up to eta = 4/7", () => {
    const f = makeZeroInterpolator("monotone-convex", T4, fromForwards([0.039, 0.04, 0.046, 0.046]));
    expect(instFwd(f, 1.2)).toBeCloseTo(0.0395, 8);
    expect(instFwd(f, 1.5)).toBeCloseTo(0.0395, 8);
    const eta = 4 / 7;
    const x = 0.8;
    const expected = 0.04 - 0.0005 + (0.003 + 0.0005) * ((x - eta) / (1 - eta)) ** 2;
    expect(instFwd(f, 1 + x)).toBeCloseTo(expected, 8);
  });

  it("zone 3: g0 = -0.002, g1 = 0.0005 holds the forward flat from eta = 0.6", () => {
    const f = makeZeroInterpolator("monotone-convex", T4, fromForwards([0.036, 0.04, 0.041, 0.041]));
    // x = 0.3: g = g1 + (g0 - g1) (eta - x)^2 / eta^2 = 0.0005 - 0.0025/4 = -0.000125.
    expect(instFwd(f, 1.3)).toBeCloseTo(0.039875, 8);
    expect(instFwd(f, 1.7)).toBeCloseTo(0.0405, 8);
    expect(instFwd(f, 1.9)).toBeCloseTo(0.0405, 8);
  });

  it("zone 4: g0 = -0.002, g1 = -0.001 peaks at fd + A at eta = 1/3", () => {
    const f = makeZeroInterpolator("monotone-convex", T4, fromForwards([0.036, 0.04, 0.038, 0.038]));
    const A = -(-0.002 * -0.001) / (-0.002 + -0.001);
    expect(A).toBeGreaterThan(0);
    expect(instFwd(f, 1 + 1 / 3)).toBeCloseTo(0.04 + A, 8);
    // x = 2/3: A + (g1 - A) ((x - eta)/(1 - eta))^2 = A + (g1 - A)/4 = 0.00025.
    expect(instFwd(f, 1 + 2 / 3)).toBeCloseTo(0.04025, 8);
    expect(instFwd(f, 1.1)).toBeLessThan(0.04 + A);
    expect(instFwd(f, 1.6)).toBeLessThan(0.04 + A);
  });

  it("every mirrored case reproduces its nodes and the interval node moves", () => {
    for (const fd of [
      [0.036, 0.04, 0.044, 0.046],
      [0.039, 0.04, 0.046, 0.046],
      [0.036, 0.04, 0.041, 0.041],
      [0.036, 0.04, 0.038, 0.038],
    ]) {
      const zs = fromForwards(fd);
      const f = makeZeroInterpolator("monotone-convex", T4, zs);
      T4.forEach((ti, i) => expect(f(ti)).toBeCloseTo(zs[i], 12));
    }
  });
});

// B1 follow-up: the left limit at a node and continuity at eta.
describe("interpolators, left limits and continuity at eta", () => {
  for (const m of methods) {
    it(`${m}: the left limit at every interior and last node is the node's zero rate`, () => {
      const f = makeZeroInterpolator(m, t, z);
      for (let i = 1; i < t.length; i++) {
        expect(f(t[i] * (1 - 1e-12)), `node ${i}`).toBeCloseTo(z[i], 10);
      }
    });
  }

  /** Zone 2, 3 and 4 cases on (1, 2], each orientation, with the eta of its zone formula. */
  const etaCases: Array<{ name: string; fd: number[]; eta: number }> = [
    { name: "zone 2", fd: [0.041, 0.04, 0.034, 0.034], eta: 4 / 7 },
    { name: "zone 2 mirrored", fd: [0.039, 0.04, 0.046, 0.046], eta: 4 / 7 },
    { name: "zone 3", fd: [0.044, 0.04, 0.039, 0.039], eta: 0.6 },
    { name: "zone 3 mirrored", fd: [0.036, 0.04, 0.041, 0.041], eta: 0.6 },
    { name: "zone 4", fd: [0.044, 0.04, 0.042, 0.042], eta: 1 / 3 },
    { name: "zone 4 mirrored", fd: [0.036, 0.04, 0.038, 0.038], eta: 1 / 3 },
  ];
  for (const c of etaCases) {
    it(`monotone-convex ${c.name}: zero rate and forward are continuous either side of eta`, () => {
      const f = makeZeroInterpolator("monotone-convex", T4, fromForwards(c.fd));
      const s = 1 + c.eta;
      expect(f(s * (1 - 1e-12))).toBeCloseTo(f(s * (1 + 1e-12)), 12);
      expect(f(s * (1 - 1e-12))).toBeCloseTo(f(s), 12);
      const d = 1e-4;
      expect(instFwd(f, s - d)).toBeCloseTo(instFwd(f, s + d), 6);
    });
  }
});
