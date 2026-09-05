/**
 * Formant tones.
 *
 * A band-passed saw with resonant peaks near 700, 1150 and 2400 Hz. This is a
 * synthetic vowel texture for pads and stabs - a shape a voice also happens to
 * make, not an imitation of one. It carries no pitch contour, vibrato or
 * consonants, and it is not intended to read as a singer.
 */

import { Svf } from "./filter.ts";
import { Saw } from "./osc.ts";
import type { Rng } from "./rng.ts";

export interface FormantSet {
  /** three formant centre frequencies in hertz */
  f: [number, number, number];
  /** three relative levels */
  a: [number, number, number];
  /** three bandwidth Q values */
  q: [number, number, number];
}

/** Neutral, between an "ah" and an "oo". Deliberately not a specific vowel. */
export const NEUTRAL_FORMANTS: FormantSet = {
  f: [700, 1150, 2400],
  a: [1, 0.5, 0.22],
  q: [7, 9, 11],
};

export class FormantVoice {
  private osc: Saw;
  private b0: Svf;
  private b1: Svf;
  private b2: Svf;
  private set: FormantSet;

  constructor(sampleRate: number, rng: Rng, set: FormantSet = NEUTRAL_FORMANTS) {
    this.osc = new Saw(sampleRate, rng.float());
    this.b0 = new Svf(sampleRate);
    this.b1 = new Svf(sampleRate);
    this.b2 = new Svf(sampleRate);
    this.set = set;
    this.apply(1);
  }

  /** `shift` scales the formant frequencies; 1 is neutral. */
  apply(shift: number): void {
    const s = this.set;
    this.b0.set(s.f[0] * shift, s.q[0]);
    this.b1.set(s.f[1] * shift, s.q[1]);
    this.b2.set(s.f[2] * shift, s.q[2]);
  }

  setFreq(hz: number): void {
    this.osc.setFreq(hz);
  }

  next(): number {
    const x = this.osc.next();
    const s = this.set;
    return (
      this.b0.bandpass(x) * s.a[0] +
      this.b1.bandpass(x) * s.a[1] +
      this.b2.bandpass(x) * s.a[2]
    );
  }
}
