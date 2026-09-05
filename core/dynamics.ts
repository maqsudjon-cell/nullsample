/**
 * Dynamics. Envelope follower, compressor, lookahead limiter, and a sidechain
 * ducker driven by an explicit event list.
 *
 * The ducker does NOT analyse the kick bus. It is handed the exact sample
 * positions the sequencer placed kicks at. That keeps the pump locked to the
 * grid whatever the kick's level ends up being, and it means locking the drums
 * and rerolling everything else cannot change how the pads pump.
 */

import { db2gain, dexp, dpow, gain2db, timeCoef } from "./dmath.ts";
import { kaiserLowpass } from "./shape.ts";

export class EnvelopeFollower {
  private y = 0;
  private ka = 0;
  private kr = 0;

  constructor(sampleRate: number, attackSec = 0.001, releaseSec = 0.1) {
    this.set(sampleRate, attackSec, releaseSec);
  }

  set(sampleRate: number, attackSec: number, releaseSec: number): void {
    this.ka = timeCoef(attackSec, sampleRate);
    this.kr = timeCoef(releaseSec, sampleRate);
  }

  reset(): void {
    this.y = 0;
  }

  process(x: number): number {
    const a = x < 0 ? -x : x;
    const k = a > this.y ? this.ka : this.kr;
    this.y = a + k * (this.y - a);
    return this.y;
  }
}

/**
 * Soft-knee feedforward compressor.
 *
 * Gain is computed at a fixed control rate of 8 samples and interpolated
 * between control points. The transcendentals in the gain law are the
 * expensive part and glue compression does not need them per sample; the
 * block size is fixed, so the result is still bit-identical everywhere.
 */
const CONTROL_RATE = 8;

export class Compressor {
  private env: EnvelopeFollower;
  private sr: number;
  private gain = 1;
  private targetGain = 1;
  private counter = 0;
  private step = 0;

  thresholdDb = -18;
  ratio = 4;
  kneeDb = 6;
  makeupDb = 0;

  constructor(sampleRate: number, attackSec = 0.005, releaseSec = 0.12) {
    this.sr = sampleRate;
    this.env = new EnvelopeFollower(sampleRate, attackSec, releaseSec);
  }

  setTimes(attackSec: number, releaseSec: number): void {
    this.env.set(this.sr, attackSec, releaseSec);
  }

  reset(): void {
    this.env.reset();
    this.gain = 1;
    this.targetGain = 1;
    this.counter = 0;
    this.step = 0;
  }

  /** Current gain reduction in dB, negative. */
  get reductionDb(): number {
    return gain2db(this.gain) - this.makeupDb;
  }

  process(x: number, detector: number): number {
    const e = this.env.process(detector);
    if (this.counter <= 0) {
      const eDb = gain2db(e);
      const over = eDb - this.thresholdDb;
      let outDb: number;
      const halfKnee = this.kneeDb * 0.5;
      if (over <= -halfKnee) {
        outDb = 0;
      } else if (over >= halfKnee) {
        outDb = over * (1 / this.ratio - 1);
      } else {
        const t = over + halfKnee;
        outDb = ((1 / this.ratio - 1) * t * t) / (2 * this.kneeDb);
      }
      this.targetGain = db2gain(outDb + this.makeupDb);
      this.step = (this.targetGain - this.gain) / CONTROL_RATE;
      this.counter = CONTROL_RATE;
    }
    this.counter--;
    this.gain += this.step;
    return x * this.gain;
  }
}

/**
 * Lookahead peak limiter. A true sliding maximum over the lookahead window
 * (monotonic deque) rather than a decaying peak hold, so nothing sneaks past
 * between two loud transients.
 */
export class Limiter {
  private delayL: Float32Array;
  private delayR: Float32Array;
  private look: number;
  /** window length; covers the sample being output through the newest input */
  private win: number;
  private peaks: Float32Array;
  private deque: Int32Array;
  private head = 0;
  private tail = 0;
  private idx = 0;
  private gain = 1;
  private kr: number;

  ceiling = 0.98;

  constructor(sampleRate: number, lookaheadSec = 0.0025, releaseSec = 0.05) {
    this.look = Math.max(8, Math.floor(lookaheadSec * sampleRate));
    this.win = this.look + 1;
    this.delayL = new Float32Array(this.win);
    this.delayR = new Float32Array(this.win);
    this.peaks = new Float32Array(this.win);
    this.deque = new Int32Array(this.win + 1);
    this.kr = timeCoef(releaseSec, sampleRate);
  }

  reset(): void {
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.peaks.fill(0);
    this.head = 0;
    this.tail = 0;
    this.idx = 0;
    this.gain = 1;
  }

  setRelease(sampleRate: number, releaseSec: number): void {
    this.kr = timeCoef(releaseSec, sampleRate);
  }

  /**
   * Writes the limited frame into out[0], out[1].
   *
   * The sliding maximum is a monotonic deque over absolute sample indices, so
   * the window provably contains the peak of the sample currently leaving the
   * delay line. A decaying peak-hold would let a second transient slip through
   * in the shadow of the first.
   */
  process(l: number, r: number, out: Float64Array): void {
    const w = this.win;
    const dq = this.deque;
    const cap = dq.length;
    const al = l < 0 ? -l : l;
    const ar = r < 0 ? -r : r;
    const p = al > ar ? al : ar;
    const i = this.idx;
    const slot = i % w;

    this.peaks[slot] = p;
    while (this.tail !== this.head) {
      const back = (this.tail - 1 + cap) % cap;
      if (this.peaks[dq[back] % w] <= p) this.tail = back;
      else break;
    }
    dq[this.tail] = i;
    this.tail = (this.tail + 1) % cap;
    while (dq[this.head] <= i - w) this.head = (this.head + 1) % cap;
    const windowMax = this.peaks[dq[this.head] % w];

    // the frame leaving the line is i - look, whose slot is (i + 1) % w
    const outSlot = (i + 1) % w;
    const outL = this.delayL[outSlot];
    const outR = this.delayR[outSlot];
    this.delayL[slot] = l;
    this.delayR[slot] = r;
    this.idx = i + 1;

    const need = windowMax > this.ceiling ? this.ceiling / windowMax : 1;
    this.gain = need < this.gain ? need : need + this.kr * (this.gain - need);

    out[0] = outL * this.gain;
    out[1] = outR * this.gain;
  }
}

/**
 * True-peak limiter.
 *
 * The final stage of a streaming master. Two things distinguish it from the
 * plain Limiter above:
 *
 * 1. It measures the INTER-SAMPLE peak. A signal whose samples all sit under
 *    0 dBFS can still reconstruct above it between samples, and a lossy
 *    encoder will clip it. Detection therefore runs on a 4x interpolated copy
 *    of each channel, which is what "true peak" means.
 *
 * 2. It sets the output ceiling on its own, with no look back over the whole
 *    track. That is what lets the master chain stream: the file the user
 *    downloads is produced by exactly the same code path, in the same order,
 *    as the audio they already heard.
 *
 * One gain is applied to both channels so the stereo image cannot shift.
 */
export class TruePeakLimiter {
  private look: number;
  private win: number;
  private delayL: Float32Array;
  private delayR: Float32Array;
  private peaks: Float32Array;
  private deque: Int32Array;
  private head = 0;
  private tail = 0;
  private idx = 0;
  private gain = 1;
  private kr: number;
  // 4x interpolation, detection only: 4 phases of 8 taps
  private up: Float64Array;
  private histL: Float64Array;
  private histR: Float64Array;
  private hpos = 0;

  ceiling = 0.891; // -1 dBTP

  constructor(sampleRate: number, lookaheadSec = 0.003, releaseSec = 0.08) {
    this.look = Math.max(8, Math.floor(lookaheadSec * sampleRate));
    this.win = this.look + 1;
    this.delayL = new Float32Array(this.win);
    this.delayR = new Float32Array(this.win);
    this.peaks = new Float32Array(this.win);
    this.deque = new Int32Array(this.win + 1);
    this.kr = timeCoef(releaseSec, sampleRate);
    // Measured against sines whose samples deliberately miss the peak: 16
    // taps underestimates by 1.8 dB at half Nyquist, which would make this a
    // true-peak limiter in name only. 32 taps lands within 0.25 dB, and the
    // ceiling carries that as margin.
    const proto = kaiserLowpass(32, 0.125, 6);
    this.up = new Float64Array(32);
    for (let ph = 0; ph < 4; ph++) {
      for (let k = 0; k < 8; k++) this.up[ph * 8 + k] = proto[k * 4 + ph] * 4;
    }
    this.histL = new Float64Array(16);
    this.histR = new Float64Array(16);
  }

  reset(): void {
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.peaks.fill(0);
    this.histL.fill(0);
    this.histR.fill(0);
    this.head = 0;
    this.tail = 0;
    this.idx = 0;
    this.hpos = 0;
    this.gain = 1;
  }

  /** Highest interpolated magnitude across both channels for this frame. */
  private truePeak(l: number, r: number): number {
    const { up, histL, histR } = this;
    const pos = this.hpos;
    histL[pos] = l;
    histL[pos + 8] = l;
    histR[pos] = r;
    histR[pos + 8] = r;
    let mx = l < 0 ? -l : l;
    const ar = r < 0 ? -r : r;
    if (ar > mx) mx = ar;
    for (let ph = 0; ph < 4; ph++) {
      const b = ph * 8;
      let sl = 0;
      let sr = 0;
      for (let k = 0; k < 8; k++) {
        sl += up[b + k] * histL[pos + k];
        sr += up[b + k] * histR[pos + k];
      }
      const al = sl < 0 ? -sl : sl;
      const arr = sr < 0 ? -sr : sr;
      if (al > mx) mx = al;
      if (arr > mx) mx = arr;
    }
    this.hpos = pos === 0 ? 7 : pos - 1;
    return mx;
  }

  process(l: number, r: number, out: Float64Array): void {
    const w = this.win;
    const dq = this.deque;
    const cap = dq.length;
    const p = this.truePeak(l, r);
    const i = this.idx;
    const slot = i % w;

    this.peaks[slot] = p;
    while (this.tail !== this.head) {
      const back = (this.tail - 1 + cap) % cap;
      if (this.peaks[dq[back] % w] <= p) this.tail = back;
      else break;
    }
    dq[this.tail] = i;
    this.tail = (this.tail + 1) % cap;
    while (dq[this.head] <= i - w) this.head = (this.head + 1) % cap;
    const windowMax = this.peaks[dq[this.head] % w];

    const outSlot = (i + 1) % w;
    const outL = this.delayL[outSlot];
    const outR = this.delayR[outSlot];
    this.delayL[slot] = l;
    this.delayR[slot] = r;
    this.idx = i + 1;

    const need = windowMax > this.ceiling ? this.ceiling / windowMax : 1;
    this.gain = need < this.gain ? need : need + this.kr * (this.gain - need);

    out[0] = outL * this.gain;
    out[1] = outR * this.gain;
  }

  /** Latency in samples. */
  get latency(): number {
    return this.look;
  }
}

export interface DuckSpec {
  /** sample positions of the trigger events */
  events: readonly number[];
  /** 0..1, how far the gain is pulled down */
  depth: number;
  /** seconds to reach full duck */
  attack: number;
  /** seconds to recover */
  release: number;
}

/**
 * Builds a gain curve from an explicit trigger list. Overlapping events take
 * the deeper of the two, so a doubled kick does not stack into silence.
 */
export function buildDuckCurve(length: number, sampleRate: number, spec: DuckSpec): Float32Array {
  const g = new Float32Array(length);
  g.fill(1);
  const depth = spec.depth;
  if (depth <= 0 || spec.events.length === 0) return g;
  const attack = Math.max(1, Math.floor(spec.attack * sampleRate));
  const release = Math.max(1, Math.floor(spec.release * sampleRate));
  const floorGain = 1 - depth;
  // exponential recovery reaching within 1 % of unity at `release`
  const k = timeCoef(spec.release / 4.6, sampleRate);

  for (const ev of spec.events) {
    let i = ev;
    if (i >= length) continue;
    // attack ramp
    for (let a = 0; a < attack && i < length; a++, i++) {
      const t = a / attack;
      const v = 1 - depth * t;
      if (v < g[i]) g[i] = v;
    }
    // exponential recovery
    let v = floorGain;
    for (let rIdx = 0; rIdx < release && i < length; rIdx++, i++) {
      if (v < g[i]) g[i] = v;
      v = 1 + (v - 1) * k;
    }
  }
  return g;
}

/** Peak of a mono signal, for gain staging assertions. */
export function peakMono(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i];
    if (a > p) p = a;
  }
  return p;
}

export { db2gain, gain2db, dexp, dpow };
