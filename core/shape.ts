/**
 * Nonlinear stages, and the oversampling that keeps them musical.
 *
 * Every nonlinearity generates harmonics above the input's bandwidth. At the
 * base rate those fold straight back into the audible band as inharmonic
 * garbage. The chain therefore runs inside a 4x oversampled region: one
 * upsample before the first nonlinearity, one downsample after the last.
 * Oversampling the whole chain once rather than each stage separately is both
 * cheaper and equivalent — no nonlinearity ever sees the base rate.
 *
 * The hard clipper additionally uses first-order antiderivative antialiasing
 * (ADAA), which suppresses the residue the decimation filter cannot reach.
 */

import { dexp, dlog, dsqrt } from "./dmath.ts";
import { DcBlocker } from "./filter.ts";

// ---------------------------------------------------------------------------
// filter design
// ---------------------------------------------------------------------------

/** Modified Bessel function of the first kind, order 0. Series, exact ops. */
function besselI0(x: number): number {
  const half = x * 0.5;
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term = term * (half / k);
    sum += term * term;
  }
  return sum;
}

/**
 * Kaiser-windowed sinc lowpass, normalised cutoff in cycles/sample.
 * Deterministic: sinc uses the series sine, the window uses the series Bessel.
 */
export function kaiserLowpass(taps: number, cutoff: number, beta: number): Float64Array {
  const h = new Float64Array(taps);
  const m = (taps - 1) / 2;
  const i0b = besselI0(beta);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const t = n - m;
    // sinc(2*cutoff*t) via the deterministic sine, in turns
    let s: number;
    if (t === 0) {
      s = 2 * cutoff;
    } else {
      const arg = cutoff * t; // turns
      s = sinTurnsLocal(arg) / (3.141592653589793 * t);
    }
    const r = t / m;
    const w = besselI0(beta * dsqrt(1 - r * r < 0 ? 0 : 1 - r * r)) / i0b;
    h[n] = s * w;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

// local import to keep the hot module small
import { sinTurns as sinTurnsLocal } from "./dmath.ts";

// ---------------------------------------------------------------------------
// 4x oversampler
// ---------------------------------------------------------------------------

const FIR_CACHE = new Map<string, { up: Float64Array; down: Float64Array; perPhase: number }>();

function firFor(taps: number): { up: Float64Array; down: Float64Array; perPhase: number } {
  const key = String(taps);
  const hit = FIR_CACHE.get(key);
  if (hit) return hit;
  // Cutoff sits exactly on the base Nyquist (0.125 of the 4x rate), so the
  // passband is flat to 16 kHz and only -1.4 dB at 19 kHz, while 30 kHz -
  // which folds down to an audible 14.1 kHz on decimation - is 62 dB down.
  const proto = kaiserLowpass(taps, 0.125, 6.0);
  const up = new Float64Array(taps);
  // polyphase decomposition, phase-major, gain-compensated for zero stuffing
  const perPhase = taps / 4;
  for (let ph = 0; ph < 4; ph++) {
    for (let k = 0; k < perPhase; k++) {
      up[ph * perPhase + k] = proto[k * 4 + ph] * 4;
    }
  }
  const down = new Float64Array(proto);
  const entry = { up, down, perPhase };
  FIR_CACHE.set(key, entry);
  return entry;
}

export type OversampleQuality = 32 | 48 | 64;

/**
 * Oversampling quality is a FIXED engine constant, not a runtime option.
 * A "fast mode" that shortened the filter would make the same seed render
 * differently on a phone than on a laptop, which breaks non-negotiable #1.
 * Speed has to be found elsewhere.
 */
export const OVERSAMPLE_QUALITY: OversampleQuality = 48;

/**
 * 4x polyphase oversampler. Processes a block: upsample, hand the caller the
 * oversampled scratch to transform in place, downsample back.
 */
export class Oversampler4x {
  private up: Float64Array;
  private down: Float64Array;
  private perPhase: number;
  private taps: number;
  private upHist: Float64Array;
  private upPos = 0;
  private dnHist: Float64Array;
  private dnPos = 0;
  /** Oversampled scratch, 4 samples per input sample. */
  readonly scratch: Float64Array;

  constructor(blockSize: number, quality: OversampleQuality = OVERSAMPLE_QUALITY) {
    const f = firFor(quality);
    this.up = f.up;
    this.down = f.down;
    this.perPhase = f.perPhase;
    this.taps = quality;
    this.upHist = new Float64Array(this.perPhase * 2);
    this.dnHist = new Float64Array(this.taps * 2);
    this.scratch = new Float64Array(blockSize * 4);
  }

  reset(): void {
    this.upHist.fill(0);
    this.dnHist.fill(0);
    this.upPos = 0;
    this.dnPos = 0;
  }

  /** True when no energy remains anywhere in the filter state. */
  get idle(): boolean {
    for (let i = 0; i < this.upHist.length; i++) if (this.upHist[i] !== 0) return false;
    for (let i = 0; i < this.dnHist.length; i++) if (this.dnHist[i] !== 0) return false;
    return true;
  }

  /** Fills scratch[0 .. n*4) from src[start .. start+n). */
  upsample(src: Float32Array, start: number, n: number): void {
    const { up, upHist, perPhase, scratch } = this;
    let pos = this.upPos;
    for (let i = 0; i < n; i++) {
      const x = src[start + i];
      upHist[pos] = x;
      upHist[pos + perPhase] = x;
      const o = i * 4;
      for (let ph = 0; ph < 4; ph++) {
        const base = ph * perPhase;
        let s = 0;
        for (let k = 0; k < perPhase; k++) s += up[base + k] * upHist[pos + k];
        scratch[o + ph] = s;
      }
      pos = pos === 0 ? perPhase - 1 : pos - 1;
    }
    this.upPos = pos;
  }

  /** Filters and decimates scratch[0 .. n*4) into dst[start .. start+n). */
  downsample(dst: Float32Array, start: number, n: number): void {
    const { down, dnHist, taps, scratch } = this;
    let pos = this.dnPos;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      for (let ph = 0; ph < 4; ph++) {
        const v = scratch[o + ph];
        dnHist[pos] = v;
        dnHist[pos + taps] = v;
        pos = pos === 0 ? taps - 1 : pos - 1;
      }
      let s = 0;
      for (let k = 0; k < taps; k++) s += down[k] * dnHist[pos + k];
      dst[start + i] = s;
    }
    this.dnPos = pos;
  }
}

// ---------------------------------------------------------------------------
// nonlinearities
// ---------------------------------------------------------------------------

/** Smooth saturation. Odd symmetric, unity slope at zero. */
export function softClip(x: number): number {
  // rational tanh approximation, monotonic and exact-arithmetic only
  const x2 = x * x;
  if (x2 > 100) return x < 0 ? -1 : 1;
  const n = x * (27 + x2);
  const d = 27 + 9 * x2;
  const y = n / d;
  return y > 1 ? 1 : y < -1 ? -1 : y;
}

/**
 * Asymmetric waveshaper. `bias` adds even harmonics, `fold` bends the curve
 * back on itself at high drive for the metallic edge the preset wants.
 */
export function waveshape(x: number, fold: number, bias: number): number {
  const v = x + bias;
  const s = softClip(v);
  if (fold <= 0) return s - bias * 0.5;
  // partial wavefold: reflect the excess back down
  const a = v < 0 ? -v : v;
  if (a <= 1) return s - bias * 0.5;
  const excess = a - 1;
  const folded = 1 - excess * fold;
  const clamped = folded < -1 ? -1 : folded;
  const sgn = v < 0 ? -1 : 1;
  return sgn * clamped - bias * 0.5;
}

export function hardClip(x: number, ceiling: number): number {
  return x > ceiling ? ceiling : x < -ceiling ? -ceiling : x;
}

/** Antiderivative of hardClip. */
function hardClipAd(x: number, ceiling: number): number {
  const a = x < 0 ? -x : x;
  if (a <= ceiling) return (x * x) * 0.5;
  return ceiling * a - ceiling * ceiling * 0.5;
}

/**
 * Hard clip with first-order antiderivative antialiasing. Costs one divide
 * more than the plain clipper and removes most of the alias energy the
 * decimation filter leaves behind.
 */
export class AdaaClipper {
  private x1 = 0;
  private f1 = 0;
  ceiling = 1;

  reset(): void {
    this.x1 = 0;
    this.f1 = 0;
  }

  process(x: number): number {
    const c = this.ceiling;
    const d = x - this.x1;
    const f = hardClipAd(x, c);
    let y: number;
    if ((d < 0 ? -d : d) < 1e-6) {
      y = hardClip((x + this.x1) * 0.5, c);
    } else {
      y = (f - this.f1) / d;
    }
    this.x1 = x;
    this.f1 = f;
    return y;
  }
}

/** Bit depth and sample rate reduction, independently controllable. */
export class Bitcrush {
  bits = 16;
  /** Hold every Nth sample. 1 = no reduction. */
  hold = 1;
  private counter = 0;
  private held = 0;

  reset(): void {
    this.counter = 0;
    this.held = 0;
  }

  process(x: number): number {
    if (this.hold > 1) {
      if (this.counter <= 0) {
        this.held = x;
        this.counter = this.hold;
      }
      this.counter--;
      x = this.held;
    }
    if (this.bits < 24) {
      let levels = 1;
      for (let i = 0; i < this.bits - 1; i++) levels *= 2;
      const q = Math.round(x * levels) / levels;
      return q;
    }
    return x;
  }
}

/**
 * The full chain: soft clip -> waveshaper -> hard clip, run inside one 4x
 * oversampled region.
 */
export interface DistortionParams {
  /** input gain into the chain, linear */
  drive: number;
  /** waveshaper fold amount, 0..1 */
  fold: number;
  /** asymmetry, adds even harmonics */
  bias: number;
  /** hard clip ceiling */
  ceiling: number;
  /** output trim, linear */
  output: number;
}

export class DistortionChain {
  private os: Oversampler4x;
  private clipper = new AdaaClipper();
  private dc: DcBlocker;
  private blockSize: number;
  params: DistortionParams = { drive: 1, fold: 0, bias: 0, ceiling: 1, output: 1 };

  constructor(blockSize: number, quality: OversampleQuality = OVERSAMPLE_QUALITY) {
    this.os = new Oversampler4x(blockSize, quality);
    this.blockSize = blockSize;
    this.dc = new DcBlocker(44100, 14);
  }

  reset(): void {
    this.os.reset();
    this.clipper.reset();
    this.dc.reset();
  }

  /** Processes buf[start .. start+n) in place. n must not exceed blockSize. */
  process(buf: Float32Array, start: number, n: number): void {
    const { drive, fold, bias, ceiling, output } = this.params;
    this.clipper.ceiling = ceiling;
    this.os.upsample(buf, start, n);
    const s = this.os.scratch;
    const m = n * 4;
    const clipper = this.clipper;
    for (let i = 0; i < m; i++) {
      let v = s[i] * drive;
      v = softClip(v);
      v = waveshape(v, fold, bias);
      v = clipper.process(v);
      s[i] = v * output;
    }
    this.os.downsample(buf, start, n);
    // Asymmetric shaping always leaves DC behind, and DC is headroom the
    // master never gets back. Remove it before it reaches the bus.
    const dc = this.dc;
    for (let i = 0; i < n; i++) buf[start + i] = dc.process(buf[start + i]);
  }

  /**
   * True when the chain holds no energy, so an all-zero input block can be
   * skipped outright. The comparison is exact, so skipping never changes the
   * output.
   */
  get idle(): boolean {
    return this.os.idle;
  }

  get maxBlock(): number {
    return this.blockSize;
  }
}

/** Fast log(cosh) for tanh's antiderivative. Kept for shaping curves. */
export function logCosh(x: number): number {
  const a = x < 0 ? -x : x;
  return a + dlog(1 + dexp(-2 * a)) - 0.6931471805599453;
}
