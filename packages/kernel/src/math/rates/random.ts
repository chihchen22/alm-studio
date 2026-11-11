/**
 * Seedable random number generator: PCG32 (O'Neill 2014) with Box-Muller normal.
 *
 * PCG family is the modern recommendation for Monte Carlo work — high quality,
 * fast, and bit-reproducible across platforms with a fixed seed. This is a
 * 32-bit variant for simplicity (sufficient for path counts up to ~10^9).
 *
 * Bit-identical Python <-> TS path parity IS a goal, and it holds. The
 * Python reference engine's RNG is an exact port of THIS PCG32
 * stream, not NumPy's PCG64; parity is measured bit-exact (uint32 draws,
 * Box-Muller normals, and the downstream HW/BGM paths) and gated in the Python
 * test suite against a frozen copy of this port's output. Do not change the
 * PCG32 constants, the stream increment, or the Box-Muller draw order without
 * re-running that parity gate: an edit here silently breaks a downstream tier
 * that depends on the exact stream.
 *
 * Reference: O'Neill, "PCG: A Family of Simple Fast Space-Efficient
 * Statistically Good Algorithms for Random Number Generation", 2014.
 */

const TWO_PI = 2 * Math.PI;

// 64-bit arithmetic emulated with BigInt.
const PCG32_MULT = 6364136223846793005n;
const MASK_64 = (1n << 64n) - 1n;
const MASK_32 = (1n << 32n) - 1n;

export class PCG32 {
  private state: bigint;
  private inc: bigint;
  // Cached normal sample for Box-Muller (returns two normals per pair).
  private normalCache: number | null = null;

  constructor(seed: bigint | number, stream: bigint | number = 0n) {
    this.inc = (((typeof stream === "number" ? BigInt(stream) : stream) << 1n) | 1n) & MASK_64;
    this.state = 0n;
    this.advance();
    this.state = (this.state + (typeof seed === "number" ? BigInt(seed) : seed)) & MASK_64;
    this.advance();
  }

  /** Advance the internal state by one step and emit a 32-bit unsigned integer. */
  nextUint32(): number {
    const oldState = this.state;
    this.state = (oldState * PCG32_MULT + this.inc) & MASK_64;
    const xorshifted = ((oldState >> 18n) ^ oldState) >> 27n;
    const rot = oldState >> 59n;
    const x = xorshifted & MASK_32;
    const r = Number(rot);
    const result = ((Number(x) >>> r) | (Number(x) << ((-r) & 31))) >>> 0;
    return result;
  }

  /** Uniform double in [0, 1) with 32 bits of resolution. */
  nextUniform(): number {
    return this.nextUint32() / 4294967296.0;
  }

  /** Standard normal sample via Box-Muller (cached pair). */
  nextNormal(): number {
    if (this.normalCache !== null) {
      const cached = this.normalCache;
      this.normalCache = null;
      return cached;
    }
    let u1 = this.nextUniform();
    while (u1 === 0) u1 = this.nextUniform();
    const u2 = this.nextUniform();
    const r = Math.sqrt(-2.0 * Math.log(u1));
    const t = TWO_PI * u2;
    this.normalCache = r * Math.sin(t);
    return r * Math.cos(t);
  }

  /** Generate `n` standard normal samples. */
  nextNormals(n: number): Float64Array {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.nextNormal();
    return out;
  }

  private advance(): void {
    this.state = (this.state * PCG32_MULT + this.inc) & MASK_64;
  }
}
