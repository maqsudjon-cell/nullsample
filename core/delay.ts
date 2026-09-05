/**
 * Delay lines. One fractional-delay primitive powers echo, ping-pong, chorus
 * and flanger, so there is one interpolation implementation to get right.
 */

import { sinTurns } from "./dmath.ts";

/** Fractional delay line with cubic Hermite interpolation. */
export class DelayLine {
  private buf: Float32Array;
  private mask: number;
  private w = 0;

  constructor(maxSamples: number) {
    let size = 4;
    while (size < maxSamples + 4) size *= 2;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }

  reset(): void {
    this.buf.fill(0);
    this.w = 0;
  }

  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }

  /** Reads `delay` samples back. Integer path when the delay is whole. */
  read(delay: number): number {
    const d = Math.floor(delay);
    const frac = delay - d;
    const base = (this.w - d - 1) & this.mask;
    if (frac === 0) return this.buf[base];
    const m = this.mask;
    const y0 = this.buf[(base + 1) & m];
    const y1 = this.buf[base];
    const y2 = this.buf[(base - 1) & m];
    const y3 = this.buf[(base - 2) & m];
    // Catmull-Rom
    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * frac + c2) * frac + c1) * frac + c0;
  }
}

/** Ping-pong capable stereo delay with a damped feedback path. */
export class StereoDelay {
  private dl: DelayLine;
  private dr: DelayLine;
  private lpL = 0;
  private lpR = 0;
  private sr: number;

  timeL = 0.25;
  timeR = 0.375;
  feedback = 0.4;
  /** 0 = fully damped, 1 = open */
  damping = 0.6;
  pingPong = true;

  constructor(sampleRate: number, maxSeconds = 2) {
    this.sr = sampleRate;
    this.dl = new DelayLine(Math.ceil(maxSeconds * sampleRate));
    this.dr = new DelayLine(Math.ceil(maxSeconds * sampleRate));
  }

  reset(): void {
    this.dl.reset();
    this.dr.reset();
    this.lpL = 0;
    this.lpR = 0;
  }

  /** Returns the wet signal only; the caller decides the mix. */
  process(inL: number, inR: number, out: Float64Array): void {
    const tl = this.timeL * this.sr;
    const tr = this.timeR * this.sr;
    const yl = this.dl.read(tl);
    const yr = this.dr.read(tr);
    const a = 1 - this.damping;
    this.lpL = yl + a * (this.lpL - yl);
    this.lpR = yr + a * (this.lpR - yr);
    if (this.pingPong) {
      this.dl.write(inL + this.lpR * this.feedback);
      this.dr.write(inR + this.lpL * this.feedback);
    } else {
      this.dl.write(inL + this.lpL * this.feedback);
      this.dr.write(inR + this.lpR * this.feedback);
    }
    out[0] = yl;
    out[1] = yr;
  }
}

/** Modulated short delay. depth and rate in seconds and hertz. */
export class Chorus {
  private d: DelayLine[];
  private phase: Float64Array;
  private sr: number;
  private n: number;

  baseDelay = 0.012;
  depth = 0.004;
  rate = 0.4;
  feedback = 0;

  constructor(sampleRate: number, voices = 3) {
    this.sr = sampleRate;
    this.n = voices;
    this.d = [];
    this.phase = new Float64Array(voices);
    for (let i = 0; i < voices; i++) {
      this.d.push(new DelayLine(Math.ceil(0.1 * sampleRate)));
      this.phase[i] = i / voices;
    }
  }

  reset(): void {
    for (const dl of this.d) dl.reset();
  }

  process(x: number, out: Float64Array): void {
    const inc = this.rate / this.sr;
    let l = 0;
    let r = 0;
    for (let i = 0; i < this.n; i++) {
      const lfo = sinTurns(this.phase[i]);
      let p = this.phase[i] + inc;
      if (p >= 1) p -= 1;
      this.phase[i] = p;
      const dsamp = (this.baseDelay + this.depth * lfo) * this.sr;
      const y = this.d[i].read(dsamp);
      this.d[i].write(x + y * this.feedback);
      // alternate voices to opposite sides
      if (i % 2 === 0) {
        l += y * 0.8;
        r += y * 0.4;
      } else {
        l += y * 0.4;
        r += y * 0.8;
      }
    }
    const g = 1 / this.n;
    out[0] = l * g;
    out[1] = r * g;
  }
}

/** Haas widener. Applied to mids and highs only; the caller keeps bass mono. */
export class Haas {
  private d: DelayLine;
  private sr: number;
  delaySeconds = 0.012;
  side: 1 | -1 = 1;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.d = new DelayLine(Math.ceil(0.05 * sampleRate));
  }

  reset(): void {
    this.d.reset();
  }

  process(x: number, out: Float64Array): void {
    this.d.write(x);
    const y = this.d.read(this.delaySeconds * this.sr);
    if (this.side === 1) {
      out[0] = x;
      out[1] = y;
    } else {
      out[0] = y;
      out[1] = x;
    }
  }
}
