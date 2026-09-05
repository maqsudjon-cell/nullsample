/**
 * Feedback delay network reverb with a procedurally generated decay.
 *
 * No impulse responses ship with this product. A convolution reverb would mean
 * bundling a recorded IR, which is a sample by any honest definition and would
 * make the name a lie.
 *
 * Four allpass diffusers feed eight delay lines mixed by a Hadamard matrix.
 * Line lengths are mutually prime so the modal density never collapses into an
 * audible periodicity.
 */

import { dexp, dpow } from "./dmath.ts";
import { DelayLine } from "./delay.ts";

const PRIMES = [
  1123, 1229, 1361, 1487, 1609, 1741, 1867, 1997, 2131, 2273, 2411, 2549, 2683,
  2819, 2957, 3089, 3229, 3361, 3499, 3623,
];

export class Reverb {
  private lines: DelayLine[] = [];
  private lens: Float64Array;
  private gains: Float64Array;
  private damp: Float64Array;
  private diff: DelayLine[] = [];
  private diffLen: Float64Array;
  private state: Float64Array;
  private tmp: Float64Array;
  private sr: number;
  private preDelay: DelayLine;

  /** RT60 in seconds. */
  decay = 2.2;
  /** 0 = dark, 1 = bright. */
  brightness = 0.45;
  /** Room scale multiplier. */
  size = 1;
  preDelaySeconds = 0.02;

  constructor(sampleRate: number, seedOffset = 0) {
    this.sr = sampleRate;
    this.lens = new Float64Array(8);
    this.gains = new Float64Array(8);
    this.damp = new Float64Array(8);
    this.state = new Float64Array(8);
    this.tmp = new Float64Array(8);
    for (let i = 0; i < 8; i++) {
      const len = PRIMES[(i * 2 + seedOffset) % PRIMES.length];
      this.lens[i] = len;
      this.lines.push(new DelayLine(len * 4 + 8));
    }
    this.diffLen = new Float64Array([142, 379, 107, 277]);
    for (let i = 0; i < 4; i++) this.diff.push(new DelayLine(this.diffLen[i] * 2 + 8));
    this.preDelay = new DelayLine(Math.ceil(0.2 * sampleRate));
    this.update();
  }

  /** Recomputes feedback gains for the current decay and size. */
  update(): void {
    const scale = (this.size * this.sr) / 44100;
    for (let i = 0; i < 8; i++) {
      const len = this.lens[i] * scale;
      // per-line gain so every line reaches -60 dB at the same wall-clock time
      this.gains[i] = dpow(10, (-3 * len) / (this.decay * this.sr));
      this.damp[i] = dexp(-6.283185307179586 * (800 + 9000 * this.brightness) / this.sr);
    }
  }

  reset(): void {
    for (const l of this.lines) l.reset();
    for (const d of this.diff) d.reset();
    this.preDelay.reset();
    this.state.fill(0);
  }

  /** Mono in, stereo out. Wet only. */
  process(x: number, out: Float64Array): void {
    this.preDelay.write(x);
    let v = this.preDelay.read(this.preDelaySeconds * this.sr);

    // input diffusion: four allpasses
    for (let i = 0; i < 4; i++) {
      const d = this.diff[i];
      const del = d.read(this.diffLen[i]);
      const inp = v + del * 0.5;
      d.write(inp);
      v = del - inp * 0.5;
    }

    const scale = (this.size * this.sr) / 44100;
    const tmp = this.tmp;
    for (let i = 0; i < 8; i++) {
      const y = this.lines[i].read(this.lens[i] * scale);
      // one-pole damping inside the loop
      const a = this.damp[i];
      this.state[i] = y + a * (this.state[i] - y);
      tmp[i] = this.state[i] * this.gains[i];
    }

    // Hadamard 8x8 via three butterfly stages, then 1/sqrt(8) normalisation
    for (let s = 1; s < 8; s <<= 1) {
      for (let i = 0; i < 8; i += s << 1) {
        for (let j = i; j < i + s; j++) {
          const a = tmp[j];
          const b = tmp[j + s];
          tmp[j] = a + b;
          tmp[j + s] = a - b;
        }
      }
    }
    const norm = 0.35355339059327373; // 1/sqrt(8)
    for (let i = 0; i < 8; i++) this.lines[i].write(v + tmp[i] * norm);

    // decorrelated stereo taps
    out[0] = (tmp[0] + tmp[2] - tmp[5] + tmp[7]) * norm * 0.5;
    out[1] = (tmp[1] - tmp[3] + tmp[4] + tmp[6]) * norm * 0.5;
  }
}
