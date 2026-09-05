/**
 * Seeded PRNG. xoshiro128** with xmur3 seed expansion.
 *
 * The important property is not randomness quality (xoshiro128** is fine) but
 * that child streams are DERIVED BY NAME rather than drawn from a shared
 * stream. `rng.child("drums")` depends only on the root seed and the string
 * "drums", never on how much anyone else has consumed. That is what makes
 * lock-and-reroll work: rerolling the lead cannot disturb the drums, because
 * the drums never shared a stream with it in the first place.
 */

import { cosTurns, dlog, dsqrt } from "./dmath.ts";

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h = h ^ (h >>> 16);
    return h >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export class Rng {
  readonly seed: string;
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: string) {
    this.seed = seed;
    const h = xmur3(seed);
    this.s0 = h();
    this.s1 = h();
    this.s2 = h();
    this.s3 = h();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    // discard the first few outputs so short seeds decorrelate
    for (let i = 0; i < 16; i++) this.u32();
  }

  /** A named, independent child stream. Order-free by construction. */
  child(name: string): Rng {
    return new Rng(this.seed + ":" + name);
  }

  u32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform in [0,1). */
  float(): number {
    return this.u32() * 2.3283064365386963e-10; // 2^-32
  }

  /** Uniform in [lo,hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  /** Uniform integer in [lo,hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  /** True with probability p. */
  bool(p = 0.5): boolean {
    return this.float() < p;
  }

  /** +1 or -1. */
  sign(): number {
    return this.u32() & 1 ? 1 : -1;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  /** Weighted pick. Weights need not be normalised. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this.float() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Standard normal, Box-Muller. Deterministic through dmath. */
  gauss(): number {
    let u = this.float();
    if (u < 1e-12) u = 1e-12;
    return dsqrt(-2 * dlog(u)) * cosTurns(this.float());
  }

  /** Normal, clamped to +/-3 sigma so a preset range is never escaped. */
  gaussIn(lo: number, hi: number): number {
    const mid = (lo + hi) * 0.5;
    const half = (hi - lo) * 0.5;
    let g = this.gauss() / 3;
    if (g < -1) g = -1;
    if (g > 1) g = 1;
    return mid + half * g;
  }

  /** In-place Fisher-Yates. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}

/** Normalise any user-supplied seed to the canonical string form. */
export function normaliseSeed(seed: string | number): string {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) return "0";
    return String(Math.trunc(seed));
  }
  const trimmed = seed.trim();
  return trimmed.length === 0 ? "0" : trimmed;
}

export function makeRng(seed: string | number): Rng {
  return new Rng(normaliseSeed(seed));
}
