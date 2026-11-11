/**
 * Zero-rate interpolators for the curve builder.
 *
 * makeZeroInterpolator turns node tenors t (years, strictly ascending,
 * positive, at least one) and continuously compounded zero rates z into a
 * function of tenor. Every method reproduces the nodes, returns the first zero
 * rate for any tenor at or before the first node (t <= 0 included) and the last
 * zero rate beyond the last node: flat ends (decision 17).
 *
 * Pure math: no kernel dependency.
 */
import type { CurveInterpolation } from "../contracts/curveSetup";

export type ZeroFn = (t: number) => number;

/** Index i with t[i] <= s <= t[i + 1]; caller guarantees t[0] < s < t[n - 1]. */
function bracket(t: readonly number[], s: number): number {
  let lo = 0;
  let hi = t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

function linearZero(t: readonly number[], z: readonly number[]): ZeroFn {
  return (s) => {
    const i = bracket(t, s);
    const w = (s - t[i]) / (t[i + 1] - t[i]);
    return z[i] * (1 - w) + z[i + 1] * w;
  };
}

function logLinearDf(t: readonly number[], z: readonly number[]): ZeroFn {
  const L = t.map((ti, i) => -z[i] * ti);
  return (s) => {
    const i = bracket(t, s);
    const w = (s - t[i]) / (t[i + 1] - t[i]);
    return -(L[i] + (L[i + 1] - L[i]) * w) / s;
  };
}

/** Natural cubic spline of z against t (second derivative zero at both ends). */
function cubicZero(t: readonly number[], z: readonly number[]): ZeroFn {
  const n = t.length;
  if (n === 2) return linearZero(t, z);
  const h: number[] = [];
  for (let i = 0; i < n - 1; i++) h.push(t[i + 1] - t[i]);
  // Second derivatives M; M[0] = M[n-1] = 0. Thomas algorithm on the interior.
  const M = new Array<number>(n).fill(0);
  const m = n - 2;
  const diag = new Array<number>(m);
  const rhs = new Array<number>(m);
  for (let k = 0; k < m; k++) {
    const i = k + 1;
    diag[k] = 2 * (h[i - 1] + h[i]);
    rhs[k] = 6 * ((z[i + 1] - z[i]) / h[i] - (z[i] - z[i - 1]) / h[i - 1]);
  }
  for (let k = 1; k < m; k++) {
    const sub = h[k]; // coefficient of M[k] in row k + 1, equals super of row k
    const factor = sub / diag[k - 1];
    diag[k] -= factor * h[k];
    rhs[k] -= factor * rhs[k - 1];
  }
  for (let k = m - 1; k >= 0; k--) {
    const next = k + 1 < m ? M[k + 2] : 0;
    M[k + 1] = (rhs[k] - h[k + 1] * next) / diag[k];
  }
  return (s) => {
    const i = bracket(t, s);
    const hi = h[i];
    const a = (t[i + 1] - s) / hi;
    const b = (s - t[i]) / hi;
    return (
      a * z[i] +
      b * z[i + 1] +
      ((a * a * a - a) * M[i] + (b * b * b - b) * M[i + 1]) * (hi * hi) / 6
    );
  };
}

/**
 * Antiderivative from 0 to x (0 <= x <= 1) of the Hagan and West (2006)
 * monotone-convex forward correction g, given g0 = g(0) and g1 = g(1).
 * The integral over [0, 1] is zero in every zone.
 */
function monotoneConvexG(g0: number, g1: number, x: number): number {
  if (g0 === 0 && g1 === 0) return 0;
  // Zone 1: quadratic.
  if (
    (g0 > 0 && -0.5 * g0 >= g1 && g1 >= -2 * g0) ||
    (g0 < 0 && -0.5 * g0 <= g1 && g1 <= -2 * g0)
  ) {
    return g0 * (x - 2 * x * x + x * x * x) + g1 * (-x * x + x * x * x);
  }
  // Zone 2: flat at g0 up to eta, then quadratic to g1.
  if ((g0 < 0 && g1 > -2 * g0) || (g0 > 0 && g1 < -2 * g0)) {
    const eta = (g1 + 2 * g0) / (g1 - g0);
    if (x <= eta) return g0 * x;
    const span = 1 - eta;
    const tail = span > 0 ? ((g1 - g0) * (x - eta) ** 3) / (3 * span * span) : 0;
    return g0 * x + tail;
  }
  // Zone 3: quadratic from g0 down to g1 at eta, then flat at g1.
  if ((g0 > 0 && 0 > g1 && g1 > -0.5 * g0) || (g0 < 0 && 0 < g1 && g1 < -0.5 * g0)) {
    const eta = (3 * g1) / (g1 - g0);
    if (eta <= 0) return g1 * x;
    if (x < eta) return g1 * x + ((g0 - g1) * (eta ** 3 - (eta - x) ** 3)) / (3 * eta * eta);
    return g1 * x + ((g0 - g1) * eta) / 3;
  }
  // Zone 4: g0 and g1 of the same sign (or one of them zero).
  const eta = g1 / (g1 + g0);
  const A = (-g0 * g1) / (g0 + g1);
  const head = (u: number): number =>
    eta > 0 ? ((g0 - A) * (eta ** 3 - (eta - u) ** 3)) / (3 * eta * eta) : 0;
  if (x < eta) return A * x + head(x);
  const span = 1 - eta;
  const tail = span > 0 ? ((g1 - A) * (x - eta) ** 3) / (3 * span * span) : 0;
  return A * x + head(eta) + tail;
}

function clampForward(f: number, lo: number, hi: number): number {
  return Math.min(Math.max(f, lo), hi);
}

function monotoneConvex(t: readonly number[], z: readonly number[]): ZeroFn {
  const N = t.length;
  // Prepend the node (0, L = 0). T[k], Lg[k] for k = 0..N.
  const T = [0, ...t];
  const Lg = [0, ...t.map((ti, i) => -z[i] * ti)];
  // Discrete forwards fd[i] for interval i = 1..N (fd[0] unused).
  const fd = new Array<number>(N + 1).fill(0);
  for (let i = 1; i <= N; i++) fd[i] = -(Lg[i] - Lg[i - 1]) / (T[i] - T[i - 1]);
  // Node forwards f[i] for i = 0..N.
  const f = new Array<number>(N + 1).fill(0);
  for (let i = 1; i < N; i++) {
    const w = (T[i] - T[i - 1]) / (T[i + 1] - T[i - 1]);
    let fi = w * fd[i + 1] + (1 - w) * fd[i];
    if (fd[i] >= 0 && fd[i + 1] >= 0) fi = clampForward(fi, 0, 2 * Math.min(fd[i], fd[i + 1]));
    f[i] = fi;
  }
  if (N === 1) {
    f[0] = fd[1];
    f[1] = fd[1];
  } else {
    f[0] = fd[1] - 0.5 * (f[1] - fd[1]);
    f[N] = fd[N] - 0.5 * (f[N - 1] - fd[N]);
  }
  if (fd[1] >= 0) f[0] = clampForward(f[0], 0, 2 * fd[1]);
  if (fd[N] >= 0) f[N] = clampForward(f[N], 0, 2 * fd[N]);

  return (s) => {
    // The caller has already handled s <= t[0] and s >= t[N - 1], so s lies in
    // interval i >= 2 and the first interval's g = 0 rule needs no branch here.
    let i = bracket(T, s) + 1;
    if (i < 2) i = 2;
    const h = T[i] - T[i - 1];
    const x = (s - T[i - 1]) / h;
    const g0 = f[i - 1] - fd[i];
    const g1 = f[i] - fd[i];
    const L = Lg[i - 1] - (fd[i] * (s - T[i - 1]) + h * monotoneConvexG(g0, g1, x));
    return -L / s;
  };
}

export function makeZeroInterpolator(
  method: CurveInterpolation,
  t: readonly number[],
  z: readonly number[],
): ZeroFn {
  const n = t.length;
  const first = z[0];
  const last = z[n - 1];
  if (n <= 1) return () => first;
  let inner: ZeroFn;
  switch (method) {
    case "linear-zero":
      inner = linearZero(t, z);
      break;
    case "log-linear-df":
      inner = logLinearDf(t, z);
      break;
    case "cubic-zero":
      inner = cubicZero(t, z);
      break;
    case "monotone-convex":
      inner = monotoneConvex(t, z);
      break;
    default: {
      const never: never = method;
      throw new Error(`unknown interpolation: ${String(never)}`);
    }
  }
  const t0 = t[0];
  const tn = t[n - 1];
  return (s) => {
    if (!(s > t0)) return first;
    if (s >= tn) return last;
    return inner(s);
  };
}
