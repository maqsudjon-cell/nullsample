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

// ---------------------------------------------------------------------------
// Alternative lead architectures
//
// Parameter variation inside one architecture produces variants of one sound.
// A listener hears those as the same instrument with the knobs moved. Different
// architectures produce different instruments, which is what registers as
// variety.
//
// All four leads present the same interface so the bus can hold any of them,
// and all four normalise by the root-sum-square of their pan gains for the same
// reason the supersaw does: detuned voices are mutually incoherent, so their
// energies add rather than their amplitudes, and a stack must not be louder
// than a single voice.
//
// `Supersaw` above is untouched. These are additive.
// ---------------------------------------------------------------------------

export interface LeadVoice {
  readonly count: number;
  setFreq(hz: number, ratioTable: (cents: number) => number): void;
  next(out: Float64Array): void;
}

/** Detune, pan and normalisation shared by every stacked lead. */
class VoiceStack {
  readonly panL: Float64Array;
  readonly panR: Float64Array;
  readonly ratio: Float64Array;
  readonly normL: number;
  readonly normR: number;

  constructor(rng: Rng, n: number, detuneCents: number, spread: number) {
    this.panL = new Float64Array(n);
    this.panR = new Float64Array(n);
    this.ratio = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const u = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      const curved = u * u * u * 0.6 + u * 0.4;
      const jitter = 1 + rng.range(-0.08, 0.08);
      this.ratio[i] = curved * detuneCents * jitter;
      const pan = u * spread;
      const a = (pan + 1) * 0.5;
      this.panL[i] = 1 - a;
      this.panR[i] = a;
    }
    if (n % 2 === 1) {
      const c = (n - 1) / 2;
      this.panL[c] = 0.5;
      this.panR[c] = 0.5;
    }
    let sumL2 = 0;
    let sumR2 = 0;
    for (let i = 0; i < n; i++) {
      sumL2 += this.panL[i] * this.panL[i];
      sumR2 += this.panR[i] * this.panR[i];
    }
    this.normL = 1 / dsqrt(sumL2 > 1e-9 ? sumL2 : 1e-9);
    this.normR = 1 / dsqrt(sumR2 > 1e-9 ? sumR2 : 1e-9);
  }
}

/**
 * Pulse stack with width modulation.
 *
 * Narrower and more nasal than a saw stack, and the slow width drift gives it
 * movement a static detune cannot. Each voice gets its own LFO phase so the
 * widths never sweep in lockstep, which would read as one voice.
 */
export class PulseStack implements LeadVoice {
  readonly count: number;
  private voices: Pulse[];
  private stack: VoiceStack;
  private lfoPhase: Float64Array;
  private lfoInc: Float64Array;
  private centre: number;
  private depth: number;

  constructor(
    sampleRate: number,
    rng: Rng,
    count: number,
    detuneCents: number,
    spread: number,
    widthCentre: number,
    widthDepth: number,
  ) {
    this.count = count;
    this.stack = new VoiceStack(rng, count, detuneCents, spread);
    this.voices = new Array(count);
    this.lfoPhase = new Float64Array(count);
    this.lfoInc = new Float64Array(count);
    this.centre = widthCentre;
    this.depth = widthDepth;
    for (let i = 0; i < count; i++) {
      this.voices[i] = new Pulse(sampleRate, rng.float());
      this.lfoPhase[i] = rng.float();
      // 0.09 to 0.4 Hz, distinct per voice
      this.lfoInc[i] = (0.09 + 0.31 * rng.float()) / sampleRate;
    }
  }

  setFreq(hz: number, ratioTable: (cents: number) => number): void {
    for (let i = 0; i < this.voices.length; i++) {
      this.voices[i].setFreq(hz * ratioTable(this.stack.ratio[i]));
    }
  }

  next(out: Float64Array): void {
    let l = 0;
    let r = 0;
    for (let i = 0; i < this.voices.length; i++) {
      let ph = this.lfoPhase[i] + this.lfoInc[i];
      if (ph >= 1) ph -= 1;
      this.lfoPhase[i] = ph;
      let w = this.centre + this.depth * sinTurns(ph);
      if (w < 0.06) w = 0.06;
      else if (w > 0.94) w = 0.94;
      this.voices[i].width = w;
      const v = this.voices[i].next();
      l += v * this.stack.panL[i];
      r += v * this.stack.panR[i];
    }
    out[0] = l * this.stack.normL;
    out[1] = r * this.stack.normR;
  }
}

/**
 * Hard-synced saw.
 *
 * A slave saw runs at `ratio` times the note and is reset every time the master
 * phasor wraps. The reset is a step discontinuity, so it is corrected with a
 * polyBLEP scaled to the height of that step - without it the sync buzz is
 * aliasing rather than harmonics, and it does not survive the oversampled
 * distortion stage cleanly.
 *
 * The sync ratio is the character: at 1 it is a plain saw, and it grows more
 * vocal and metallic as it rises.
 */
export class SyncSaw implements LeadVoice {
  readonly count: number;
  private stack: VoiceStack;
  private masterPhase: Float64Array;
  private masterInc: Float64Array;
  private slavePhase: Float64Array;
  private slaveInc: Float64Array;
  private ratio: number;

  constructor(
    sampleRate: number,
    rng: Rng,
    count: number,
    detuneCents: number,
    spread: number,
    syncRatio: number,
  ) {
    this.count = count;
    this.stack = new VoiceStack(rng, count, detuneCents, spread);
    this.masterPhase = new Float64Array(count);
    this.masterInc = new Float64Array(count);
    this.slavePhase = new Float64Array(count);
    this.slaveInc = new Float64Array(count);
    this.ratio = syncRatio;
    this.sr = sampleRate;
    for (let i = 0; i < count; i++) {
      this.masterPhase[i] = rng.float();
      this.slavePhase[i] = this.masterPhase[i] * syncRatio % 1;
    }
  }

  private sr: number;

  setFreq(hz: number, ratioTable: (cents: number) => number): void {
    for (let i = 0; i < this.count; i++) {
      const f = hz * ratioTable(this.stack.ratio[i]);
      this.masterInc[i] = f / this.sr;
      this.slaveInc[i] = (f * this.ratio) / this.sr;
    }
  }

  next(out: Float64Array): void {
    let l = 0;
    let r = 0;
    for (let i = 0; i < this.count; i++) {
      const dt = this.slaveInc[i];
      const t = this.slavePhase[i];
      let v = 2 * t - 1 - polyBlep(t, dt);

      let mp = this.masterPhase[i] + this.masterInc[i];
      let sp = t + dt;
      if (mp >= 1) {
        mp -= 1;
        // the master wrapped inside this sample: reset the slave, and correct
        // the step it just made
        const frac = this.masterInc[i] > 0 ? mp / this.masterInc[i] : 0;
        const before = 2 * sp - 1;
        const after = -1;
        v -= (before - after) * polyBlepAt(frac);
        sp = frac * dt;
      }
      if (sp >= 1) sp -= 1;
      this.masterPhase[i] = mp;
      this.slavePhase[i] = sp;

      l += v * this.stack.panL[i];
      r += v * this.stack.panR[i];
    }
    out[0] = l * this.stack.normL;
    out[1] = r * this.stack.normR;
  }
}

/**
 * Residual of a unit step at fractional position `frac` within the sample.
 *
 * The same correction polyBlep applies, expressed against a known step height
 * rather than inferred from the phase - the sync reset is not periodic in the
 * oscillator's own phase, so the usual form does not apply.
 */
function polyBlepAt(frac: number): number {
  const t = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return (t * t) * 0.5 - t + 0.5;
}

/**
 * Two-operator FM.
 *
 * One sine modulating another. At a low index it is a soft bell-like tone; the
 * index is kept modest because this genre wants a lead that survives heavy
 * distortion, and a high-index FM tone turns to mud the moment it is clipped.
 */
export class FmPair implements LeadVoice {
  readonly count: number;
  private stack: VoiceStack;
  private carrier: Float64Array;
  private modulator: Float64Array;
  private carrierInc: Float64Array;
  private modulatorInc: Float64Array;
  private index: number;
  private ratio: number;
  private sr: number;

  constructor(
    sampleRate: number,
    rng: Rng,
    count: number,
    detuneCents: number,
    spread: number,
    modRatio: number,
    modIndex: number,
  ) {
    this.count = count;
    this.sr = sampleRate;
    this.stack = new VoiceStack(rng, count, detuneCents, spread);
    this.carrier = new Float64Array(count);
    this.modulator = new Float64Array(count);
    this.carrierInc = new Float64Array(count);
    this.modulatorInc = new Float64Array(count);
    this.ratio = modRatio;
    this.index = modIndex;
    for (let i = 0; i < count; i++) {
      this.carrier[i] = rng.float();
      this.modulator[i] = rng.float();
    }
  }

  setFreq(hz: number, ratioTable: (cents: number) => number): void {
    for (let i = 0; i < this.count; i++) {
      const f = hz * ratioTable(this.stack.ratio[i]);
      this.carrierInc[i] = f / this.sr;
      this.modulatorInc[i] = (f * this.ratio) / this.sr;
    }
  }

  next(out: Float64Array): void {
    let l = 0;
    let r = 0;
    for (let i = 0; i < this.count; i++) {
      const m = sinTurns(this.modulator[i]);
      const v = sinTurns(this.carrier[i] + m * this.index);
      let cp = this.carrier[i] + this.carrierInc[i];
      if (cp >= 1) cp -= 1;
      let mp = this.modulator[i] + this.modulatorInc[i];
      if (mp >= 1) mp -= 1;
      this.carrier[i] = cp;
      this.modulator[i] = mp;
      l += v * this.stack.panL[i];
      r += v * this.stack.panR[i];
    }
    out[0] = l * this.stack.normL;
    out[1] = r * this.stack.normR;
  }
}
