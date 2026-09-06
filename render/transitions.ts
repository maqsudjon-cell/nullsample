/**
 * Transition effects that act on the finished mix.
 *
 * These three want the whole mix rather than one bus: a tape stop that only
 * slowed the lead would sound broken, and a stutter that only repeated the
 * drums is a delay. They sit on the pre-master sum, after the auto-gain and
 * before the master chain, so the level they see is the level the master
 * expects.
 *
 * All three are streaming and position-driven. Each holds its own small buffer,
 * nothing here looks ahead of the playhead, and a chunk boundary falling inside
 * an effect window changes nothing - which is what keeps progressive playback
 * and the downloaded file bit-identical.
 */

import { Bitcrush } from "../core/shape.ts";
import { dexp } from "../core/dmath.ts";

export type MixEffectKind = "tapeStop" | "stutter" | "bitcrush";

export interface MixEffect {
  kind: MixEffectKind;
  /** absolute sample position of the first affected sample */
  at: number;
  /** length in samples */
  length: number;
  /** stutter only: length of the captured slice in samples */
  slice: number;
  /** the section this leads into, for the effect inventory */
  section: string;
}

/**
 * Tape stop: the mix decelerates to a standstill over the window.
 *
 * A ring buffer holds what has been written; the read pointer advances at a
 * falling rate, so it drifts behind the write pointer and the pitch falls with
 * it. The rate curve is cubic rather than linear because a linear slowdown
 * sounds like a pitch bend and a tape machine's flywheel does not.
 */
class TapeStop {
  private buf: Float32Array;
  private bufR: Float32Array;
  private size: number;
  private write = 0;
  private read = 0;
  private armed = false;

  constructor(maxLength: number) {
    this.size = maxLength + 4;
    this.buf = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
  }

  reset(): void {
    this.buf.fill(0);
    this.bufR.fill(0);
    this.write = 0;
    this.read = 0;
    this.armed = false;
  }

  /** One sample. `t` is 0..1 through the window. */
  step(l: number, r: number, t: number, out: Float64Array): void {
    if (!this.armed) {
      this.write = 0;
      this.read = 0;
      this.buf.fill(0);
      this.bufR.fill(0);
      this.armed = true;
    }
    this.buf[this.write] = l;
    this.bufR[this.write] = r;
    this.write = this.write + 1 === this.size ? 0 : this.write + 1;

    const i0 = Math.floor(this.read);
    const frac = this.read - i0;
    const a = i0 % this.size;
    const b = (i0 + 1) % this.size;
    out[0] = this.buf[a] + (this.buf[b] - this.buf[a]) * frac;
    out[1] = this.bufR[a] + (this.bufR[b] - this.bufR[a]) * frac;

    // rate 1 -> 0, cubic, and a short fade over the tail so the freeze does
    // not end on a click
    const u = 1 - t;
    const rate = u * u * u;
    const fade = t > 0.82 ? (1 - t) / 0.18 : 1;
    out[0] *= fade;
    out[1] *= fade;
    this.read += rate;
    if (this.read >= this.size) this.read -= this.size;
  }

  disarm(): void {
    this.armed = false;
  }
}

/**
 * Stutter: capture the first slice of the window, then repeat it.
 *
 * The slice halves twice as the window runs, which is the accelerating
 * retrigger the genre uses on the last beat before a drop. Nothing is
 * generated: it is the mix's own audio, repeated.
 */
class Stutter {
  private buf: Float32Array;
  private bufR: Float32Array;
  private cap = 0;
  private armed = false;

  constructor(maxSlice: number) {
    this.buf = new Float32Array(maxSlice + 2);
    this.bufR = new Float32Array(maxSlice + 2);
  }

  reset(): void {
    this.cap = 0;
    this.armed = false;
  }

  /** `p` is the sample offset into the window. */
  step(l: number, r: number, p: number, slice: number, length: number, out: Float64Array): void {
    if (!this.armed) {
      this.cap = 0;
      this.armed = true;
    }
    if (p < slice) {
      // still capturing: the audio passes through untouched
      this.buf[p] = l;
      this.bufR[p] = r;
      this.cap = p + 1;
      out[0] = l;
      out[1] = r;
      return;
    }
    const t = p / length;
    // halve the slice twice, floored so it never becomes a buzz
    let s = slice;
    if (t > 0.5) s = Math.max(64, s >> 1);
    if (t > 0.78) s = Math.max(64, s >> 1);
    const idx = (p - slice) % s;
    out[0] = this.buf[idx];
    out[1] = this.bufR[idx];
  }

  disarm(): void {
    this.armed = false;
  }
}

/**
 * Applies the mix effects for a track. One instance per render; it advances
 * with the playhead and holds no state between effects.
 */
export class MixTransitions {
  private effects: MixEffect[];
  private idx = 0;
  private tape: TapeStop;
  private stutter: Stutter;
  private crush = new Bitcrush();
  private frame = new Float64Array(2);

  constructor(effects: readonly MixEffect[], sampleRate: number) {
    this.effects = effects.slice().sort((a, b) => a.at - b.at);
    let maxTape = 1;
    let maxSlice = 1;
    for (const e of this.effects) {
      if (e.kind === "tapeStop" && e.length > maxTape) maxTape = e.length;
      if (e.kind === "stutter" && e.slice > maxSlice) maxSlice = e.slice;
    }
    this.tape = new TapeStop(maxTape);
    this.stutter = new Stutter(maxSlice);
    // sampleRate is not used by the effects themselves - every window is
    // already expressed in samples by the planner - but keeping it in the
    // signature means a future rate-dependent effect does not change callers.
    void sampleRate;
  }

  get isEmpty(): boolean {
    return this.effects.length === 0;
  }

  /** Processes a chunk in place. `start` is the absolute position of L[0]. */
  process(L: Float32Array, R: Float32Array, start: number, count: number): void {
    if (this.effects.length === 0) return;
    const end = start + count;
    // skip past anything already finished
    while (this.idx < this.effects.length && this.effects[this.idx].at + this.effects[this.idx].length <= start) {
      this.idx++;
      this.tape.disarm();
      this.stutter.disarm();
      this.crush.reset();
    }
    for (let k = this.idx; k < this.effects.length; k++) {
      const e = this.effects[k];
      if (e.at >= end) break;
      const from = Math.max(e.at, start);
      const to = Math.min(e.at + e.length, end);
      const frame = this.frame;
      for (let i = from; i < to; i++) {
        const j = i - start;
        const p = i - e.at;
        const t = p / e.length;
        if (e.kind === "tapeStop") {
          this.tape.step(L[j], R[j], t, frame);
          L[j] = frame[0];
          R[j] = frame[1];
        } else if (e.kind === "stutter") {
          this.stutter.step(L[j], R[j], p, e.slice, e.length, frame);
          L[j] = frame[0];
          R[j] = frame[1];
        } else {
          // bits 16 -> 4 and a rising sample-hold, so the transition audibly
          // falls apart rather than switching to a fixed crushed timbre
          this.crush.bits = Math.max(4, Math.round(16 - 12 * t));
          this.crush.hold = 1 + Math.round(7 * t * t);
          const g = 1 / (1 + 0.35 * t);
          L[j] = this.crush.process(L[j]) * g;
          R[j] = this.crush.process(R[j]) * g;
        }
      }
    }
  }
}

/**
 * Envelope for a dub delay throw: the send opens for one note and shuts, so a
 * single hit is thrown into the delay and nothing after it is.
 *
 * Returns a multiplier for the bus's delay send at absolute sample `at`.
 */
export function delayThrowGain(throws: readonly MixThrow[], at: number): number {
  for (const t of throws) {
    if (at < t.at || at >= t.at + t.length) continue;
    const p = (at - t.at) / t.length;
    // open fast, hold, then close before the next hit so only one note is sent
    if (p < 0.04) return t.amount * (p / 0.04);
    if (p > 0.30) return t.amount * dexp(-(p - 0.30) * 14);
    return t.amount;
  }
  return 0;
}

export interface MixThrow {
  at: number;
  length: number;
  /** extra send, added on top of the bus's own */
  amount: number;
  section: string;
}
