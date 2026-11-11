/**
 * Bounded Levenberg-Marquardt least squares, Marquardt-scaled, with a
 * trust-region accept/reject test.
 *
 * Why this exists rather than `ml-levenberg-marquardt` (used by the HW
 * calibrator, where two well-scaled parameters make it harmless): that package
 * (a) adds the damping term as `λ·I` to an unscaled `JᵀJ`, and (b) accepts
 * every trial step unconditionally, keeping only a best-so-far record. On the
 * six-parameter Rebonato fit the columns of `JᵀJ` span eight orders of
 * magnitude (the volScalar column is O(1e8), the `c` column can be exactly 0),
 * so `λ ∈ [1e-7, 1e7]` never damps anything: the iteration is undamped
 * Gauss-Newton on a near-singular normal matrix, produces parameter steps of
 * O(100) inside boxes of width 5, gets clamped, and random-walks. Whether it
 * ever dips below its starting error is luck, which is exactly the observed
 * behaviour (it never dipped on the public surface).
 *
 * This solver fixes both defects:
 *   - damping is `λ·diag(JᵀJ)` (Marquardt), so λ is scale-free;
 *   - a trial step is evaluated and *rejected* if it does not reduce the sum of
 *     squares, with λ raised on rejection and lowered on acceptance, which is
 *     what makes LM a descent method.
 * Box constraints are enforced by projection of the trial point; the
 * accept/reject test then guards against a clamp that would hurt the fit.
 */

export interface LMOptions {
  /** Lower bounds, one per parameter. */
  minValues: number[];
  /** Upper bounds, one per parameter. */
  maxValues: number[];
  /** Initial Marquardt damping factor (relative to diag(JᵀJ)). */
  damping?: number;
  /** Absolute finite-difference step per parameter (central differences). */
  gradientDifference: number[];
  /** Maximum accepted-or-rejected iterations. */
  maxIterations?: number;
  /** Stop when the relative SSE improvement of an accepted step falls below this. */
  tolerance?: number;
}

export interface LMResult {
  parameterValues: number[];
  /** Sum of squared residuals at the returned point. */
  sumSquaredResiduals: number;
  iterations: number;
  /** True if the loop stopped on the tolerance rather than on the iteration cap. */
  converged: boolean;
}

/** Solve A x = b for small dense A by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
    if (Math.abs(M[piv][k]) < 1e-300) return null;
    if (piv !== k) [M[k], M[piv]] = [M[piv], M[k]];
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      if (f === 0) continue;
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

/**
 * Minimise ‖residuals(p)‖² over the box [minValues, maxValues].
 *
 * `residuals` returns one entry per observation; scaling of the residuals is
 * the caller's business (the BGM fit works in bp).
 */
export function levenbergMarquardtLS(
  residuals: (params: number[]) => number[],
  initialValues: number[],
  options: LMOptions,
): LMResult {
  const { minValues, maxValues, gradientDifference } = options;
  const maxIterations = options.maxIterations ?? 400;
  const tolerance = options.tolerance ?? 1e-12;
  const n = initialValues.length;

  const clampAll = (p: number[]) =>
    p.map((v, k) => Math.min(Math.max(minValues[k], v), maxValues[k]));
  const sse = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

  let params = clampAll(initialValues);
  let r = residuals(params);
  let f = sse(r);
  if (!Number.isFinite(f)) {
    return { parameterValues: params, sumSquaredResiduals: f, iterations: 0, converged: false };
  }

  let lambda = options.damping ?? 1e-3;
  let iteration = 0;
  let converged = false;

  for (; iteration < maxIterations; iteration++) {
    // Central-difference Jacobian, respecting the box at the perturbed points.
    const m = r.length;
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    for (let k = 0; k < n; k++) {
      const h = gradientDifference[k];
      const pp = [...params];
      const pm = [...params];
      pp[k] = Math.min(maxValues[k], params[k] + h);
      pm[k] = Math.max(minValues[k], params[k] - h);
      const span = pp[k] - pm[k];
      if (span === 0) continue;
      const rp = residuals(pp);
      const rm = residuals(pm);
      for (let i = 0; i < m; i++) J[i][k] = (rp[i] - rm[i]) / span;
    }

    // Normal equations JᵀJ and gradient Jᵀr.
    const JtJ: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const Jtr = new Array<number>(n).fill(0);
    for (let i = 0; i < m; i++) {
      for (let a = 0; a < n; a++) {
        Jtr[a] += J[i][a] * r[i];
        for (let b2 = a; b2 < n; b2++) JtJ[a][b2] += J[i][a] * J[i][b2];
      }
    }
    for (let a = 0; a < n; a++) for (let b2 = 0; b2 < a; b2++) JtJ[a][b2] = JtJ[b2][a];

    // Marquardt scaling: damp by λ·diag(JᵀJ), with a floor so a structurally
    // flat column (diag == 0) still gets a finite, well-conditioned step.
    const diag = Array.from({ length: n }, (_, k) => JtJ[k][k]);
    const diagMax = Math.max(...diag, 0);
    const floor = diagMax > 0 ? diagMax * 1e-10 : 1;
    const scale = diag.map((v) => (v > floor ? v : floor));

    let accepted = false;
    // Inner loop: raise λ until a trial step actually reduces the SSE. This
    // accept/reject test is what makes the iteration a descent method; the
    // asymmetric schedule (÷3 on acceptance, ×10 on rejection) measured best
    // across the swaption surfaces it was tried on, beating Nielsen's
    // gain-ratio update by ~0.05 bp of final RMSE on both.
    for (let inner = 0; inner < 40; inner++) {
      const A = JtJ.map((row, a) => row.map((v, b2) => (a === b2 ? v + lambda * scale[a] : v)));
      const step = solve(A, Jtr.map((v) => -v));
      if (step === null) {
        lambda *= 10;
        continue;
      }
      const trial = clampAll(params.map((v, k) => v + step[k]));
      const rTrial = residuals(trial);
      const fTrial = sse(rTrial);
      if (Number.isFinite(fTrial) && fTrial < f) {
        const rel = (f - fTrial) / Math.max(f, Number.MIN_VALUE);
        params = trial;
        r = rTrial;
        f = fTrial;
        lambda = Math.max(lambda / 3, 1e-12);
        accepted = true;
        if (rel < tolerance) converged = true;
        break;
      }
      lambda *= 10;
      if (lambda > 1e14) break;
    }

    if (!accepted || converged) {
      converged = converged || !accepted; // no admissible descent step: local min
      break;
    }
  }

  return { parameterValues: params, sumSquaredResiduals: f, iterations: iteration, converged };
}
