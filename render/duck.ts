/**
 * Streaming sidechain ducker.
 *
 * Driven by the explicit kick event list, never by analysing the kick bus.
 * Computed a sample at a time rather than as a full-length curve, because a
 * two-minute curve is 21 MB that a phone would rather spend on the output.
 *
 * Recovery is monotonic, so "the deepest of all overlapping events" and "the
 * most recent event" are the same thing - a new kick simply restarts the duck.
 */

import { timeCoef } from "../core/dmath.ts";

export class Ducker {
  private events: readonly number[];
  private cursor = 0;
  private lastEvent = -1;
  private attackSamples: number;
  private k: number;
  private depth: number;
  private value = 1;
  private phase = 0;

  constructor(
    events: readonly number[],
    sampleRate: number,
    depth: number,
    attack: number,
    release: number,
  ) {
    this.events = events;
    this.depth = depth;
    this.attackSamples = Math.max(1, Math.round(attack * sampleRate));
    this.k = timeCoef(release / 4.6, sampleRate);
  }

  /** Gain at absolute sample `abs`. Must be called with non-decreasing abs. */
  step(abs: number): number {
    while (this.cursor < this.events.length && this.events[this.cursor] <= abs) {
      this.lastEvent = this.events[this.cursor];
      this.phase = 0;
      this.cursor++;
    }
    if (this.lastEvent < 0 || this.depth <= 0) return 1;
    if (this.phase < this.attackSamples) {
      const t = this.phase / this.attackSamples;
      this.value = 1 - this.depth * t;
      this.phase++;
      return this.value;
    }
    const v = this.value;
    this.value = 1 + (this.value - 1) * this.k;
    return v;
  }
}
