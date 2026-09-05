/**
 * Filters.
 *
 * The workhorse is a topology-preserving-transform state variable filter
 * (Zavalishin). It stays stable under per-sample cutoff modulation, which a
 * direct-form biquad does not, and gives lowpass, highpass, bandpass and notch
 * from the same state. Biquads are used only where coefficients are static.
 */

import { cosTurns, dpow, dsqrt, sinTurns, tanTurns } from "./dmath.ts";

export class Svf {
  private sr: number;
  private g = 0;
  private k = 1;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private ic1 = 0;
  private ic2 = 0;
  private lastCut = -1;
  private lastQ = -1;

  lp = 0;
  bp = 0;
  hp = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  /** Coefficients are recomputed only on an actual change. */
  set(cutoffHz: number, q: number): void {
    if (cutoffHz === this.lastCut && q === this.lastQ) return;
    this.lastCut = cutoffHz;
    this.lastQ = q;
    let fc = cutoffHz;
    const nyq = this.sr * 0.49;
    if (fc > nyq) fc = nyq;
    if (fc < 5) fc = 5;
    this.g = tanTurns(fc / (2 * this.sr));
    this.k = 1 / (q < 0.05 ? 0.05 : q);
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
    this.lp = 0;
    this.bp = 0;
    this.hp = 0;
  }

  /** Advances state and fills lp/bp/hp. */
  process(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.bp = v1;
    this.lp = v2;
    this.hp = x - this.k * v1 - v2;
  }

  lowpass(x: number): number {
    this.process(x);
    return this.lp;
  }

  highpass(x: number): number {
    this.process(x);
    return this.hp;
  }

  bandpass(x: number): number {
    this.process(x);
    return this.bp;
  }
}

/** One-pole lowpass. Damping, envelope smoothing, feedback-path tone. */
export class OnePole {
  private a = 0;
  private y = 0;

  constructor(private_sr?: number) {}

  setCoef(a: number): void {
    this.a = a;
  }

  reset(v = 0): void {
    this.y = v;
  }

  process(x: number): number {
    this.y = x + this.a * (this.y - x);
    return this.y;
  }
}

/** Removes DC and subsonic rumble. Essential before any clipper. */
export class DcBlocker {
  private x1 = 0;
  private y1 = 0;
  private r: number;

  constructor(sampleRate: number, cutoffHz = 12) {
    this.r = 1 - (6.283185307179586 * cutoffHz) / sampleRate;
  }

  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.y1 = 0;
  }
}

export type BiquadKind = "lowpass" | "highpass" | "peaking" | "lowshelf" | "highshelf" | "bandpass";

/** RBJ cookbook biquad. Static coefficients only. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  set(kind: BiquadKind, sampleRate: number, freq: number, q: number, gainDb = 0): void {
    const turns = freq / sampleRate;
    const w0s = sinTurns(turns);
    const w0c = cosTurns(turns);
    const alpha = w0s / (2 * q);
    const A = gainDb === 0 ? 1 : dpow(10, gainDb / 40);
    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    let a0 = 1;
    let a1 = 0;
    let a2 = 0;

    switch (kind) {
      case "lowpass":
        b0 = (1 - w0c) / 2;
        b1 = 1 - w0c;
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * w0c;
        a2 = 1 - alpha;
        break;
      case "highpass":
        b0 = (1 + w0c) / 2;
        b1 = -(1 + w0c);
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * w0c;
        a2 = 1 - alpha;
        break;
      case "bandpass":
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * w0c;
        a2 = 1 - alpha;
        break;
      case "peaking":
        b0 = 1 + alpha * A;
        b1 = -2 * w0c;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * w0c;
        a2 = 1 - alpha / A;
        break;
      case "lowshelf": {
        const s = 2 * dsqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * w0c + s);
        b1 = 2 * A * (A - 1 - (A + 1) * w0c);
        b2 = A * (A + 1 - (A - 1) * w0c - s);
        a0 = A + 1 + (A - 1) * w0c + s;
        a1 = -2 * (A - 1 + (A + 1) * w0c);
        a2 = A + 1 + (A - 1) * w0c - s;
        break;
      }
      case "highshelf": {
        const s = 2 * dsqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * w0c + s);
        b1 = -2 * A * (A - 1 + (A + 1) * w0c);
        b2 = A * (A + 1 + (A - 1) * w0c - s);
        a0 = A + 1 - (A - 1) * w0c + s;
        a1 = 2 * (A - 1 - (A + 1) * w0c);
        a2 = A + 1 - (A - 1) * w0c - s;
        break;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  /** Transposed direct form II. */
  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}
