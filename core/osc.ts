/**
 * Oscillators. Band-limited by PolyBLEP (discontinuous waveforms) and
 * PolyBLAMP (slope-discontinuous waveforms), so aliasing is a deliberate
 * choice made in a preset, never an accident of naive wave generation.
 *
 * Phase is kept in TURNS and wrapped every sample, so it never grows large
 * enough to lose mantissa bits.
 */

import { dsqrt, sinTurns } from "./dmath.ts";
import type { Rng } from "./rng.ts";

/** Step correction for a unit jump discontinuity. */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Ramp correction for a unit slope discontinuity. */
export function polyBlamp(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt - 1;
    return -0.3333333333333333 * x * x * x;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt + 1;
    return 0.3333333333333333 * x * x * x;
  }
  return 0;
}

export class Saw {
  phase = 0;
  inc = 0;
  private sr: number;

  constructor(sampleRate: number, phase = 0) {
    this.sr = sampleRate;
    this.phase = phase;
  }

  setFreq(hz: number): void {
    this.inc = hz / this.sr;
  }

  next(): number {
    const t = this.phase;
    const dt = this.inc;
    const v = 2 * t - 1 - polyBlep(t, dt);
    let p = t + dt;
    if (p >= 1) p -= 1;
    else if (p < 0) p += 1;
    this.phase = p;
    return v;
  }
}

export class Pulse {
  phase = 0;
  inc = 0;
  width = 0.5;
  private sr: number;

  constructor(sampleRate: number, phase = 0) {
    this.sr = sampleRate;
    this.phase = phase;
  }

  setFreq(hz: number): void {
    this.inc = hz / this.sr;
  }

  next(): number {
    const t = this.phase;
    const dt = this.inc;
    const w = this.width;
    let v = t < w ? 1 : -1;
    v += polyBlep(t, dt);
    let t2 = t + 1 - w;
    if (t2 >= 1) t2 -= 1;
    v -= polyBlep(t2, dt);
    let p = t + dt;
    if (p >= 1) p -= 1;
    this.phase = p;
    return v;
  }
}

export class Triangle {
  phase = 0;
  inc = 0;
  private sr: number;

  constructor(sampleRate: number, phase = 0) {
    this.sr = sampleRate;
    this.phase = phase;
  }

  setFreq(hz: number): void {
    this.inc = hz / this.sr;
  }

  next(): number {
    const t = this.phase;
    const dt = this.inc;
    let v = t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
    // slope steps by +8 at t=0 and -8 at t=0.5
    let t2 = t + 0.5;
    if (t2 >= 1) t2 -= 1;
    v += 8 * dt * (polyBlamp(t, dt) - polyBlamp(t2, dt));
    let p = t + dt;
    if (p >= 1) p -= 1;
    this.phase = p;
    return v;
  }
}

export class Sine {
  phase = 0;
  inc = 0;
  private sr: number;

  constructor(sampleRate: number, phase = 0) {
    this.sr = sampleRate;
    this.phase = phase;
  }

  setFreq(hz: number): void {
    this.inc = hz / this.sr;
  }

  next(): number {
    const v = sinTurns(this.phase);
    let p = this.phase + this.inc;
    if (p >= 1) p -= 1;
    else if (p < 0) p += 1;
    this.phase = p;
    return v;
  }
}

/** Uniform white noise in [-1,1). */
export class WhiteNoise {
  private rng: Rng;
  constructor(rng: Rng) {
    this.rng = rng;
  }
  next(): number {
    return this.rng.float() * 2 - 1;
  }
}

/** Pink noise, Paul Kellet's refined economy filter. -3 dB/octave. */
export class PinkNoise {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;
  private rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  next(): number {
    const w = this.rng.float() * 2 - 1;
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out * 0.11;
  }
}

/**
 * Supersaw: 7 to 9 detuned saws with randomised initial phase and stereo
 * spread. Detune follows the classic non-linear curve, so the outer voices sit
 * further out than a linear spread would put them.
 */
export class Supersaw {
  private voices: Saw[];
  private panL: Float64Array;
  private panR: Float64Array;
  private ratio: Float64Array;
  private normL: number;
  private normR: number;

  readonly count: number;

  constructor(
    sampleRate: number,
    rng: Rng,
    count: number,
    detuneCents: number,
    spread: number,
  ) {
    this.count = count;
    const n = count;
    this.voices = new Array(n);
    this.panL = new Float64Array(n);
    this.panR = new Float64Array(n);
    this.ratio = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.voices[i] = new Saw(sampleRate, rng.float());
      // -1..1 across the stack, centre voice at 0
      const u = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      const curved = u * u * u * 0.6 + u * 0.4; // outer voices pushed further
      const jitter = 1 + rng.range(-0.08, 0.08);
      const c = curved * detuneCents * jitter;
      this.ratio[i] = c;
      const pan = u * spread;
      // equal-power without a call into dmath per voice construction
      const a = (pan + 1) * 0.5;
      this.panL[i] = 1 - a;
      this.panR[i] = a;
    }
    // centre voice stays centred and dominant
    if (n % 2 === 1) {
      const c = (n - 1) / 2;
      this.panL[c] = 0.5;
      this.panR[c] = 0.5;
    }
    // Voice-count compensation.
    //
    // The voices are detuned, so they are mutually incoherent and their
    // energies add rather than their amplitudes: the sum grows as the square
    // root of the count, not linearly. Normalising by the root-sum-square of
    // the actual pan gains makes a nine-voice stack arrive at the same level
    // as a seven-voice one, which an ad-hoc divisor did not. Per channel,
    // because the pan spread is not symmetric for even voice counts.
    let sumL2 = 0;
    let sumR2 = 0;
    for (let i = 0; i < n; i++) {
      sumL2 += this.panL[i] * this.panL[i];
      sumR2 += this.panR[i] * this.panR[i];
    }
    this.normL = 1 / dsqrt(sumL2 > 1e-9 ? sumL2 : 1e-9);
    this.normR = 1 / dsqrt(sumR2 > 1e-9 ? sumR2 : 1e-9);
  }

  /** Precomputed cents-to-ratio table filled by the caller each note. */
  setFreq(hz: number, ratioTable: (cents: number) => number): void {
    for (let i = 0; i < this.voices.length; i++) {
      this.voices[i].setFreq(hz * ratioTable(this.ratio[i]));
    }
  }

  /** Writes one sample into out[0]=L, out[1]=R. */
  next(out: Float64Array): void {
    let l = 0;
    let r = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i].next();
      l += v * this.panL[i];
      r += v * this.panR[i];
    }
    out[0] = l * this.normL;
    out[1] = r * this.normR;
  }
}
