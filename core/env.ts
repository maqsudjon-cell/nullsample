/**
 * Envelopes. Sample-accurate, no zipper noise: every segment is a one-pole
 * approaching a target, so the output is continuous even when a stage is
 * retriggered mid-flight.
 */

import { timeCoef } from "./dmath.ts";

// A const object rather than an enum: Node runs these files with type
// stripping only, which cannot synthesise an enum's runtime object.
export const Stage = {
  Idle: 0,
  Attack: 1,
  Decay: 2,
  Sustain: 3,
  Release: 4,
} as const;

export class Adsr {
  private sr: number;
  private ka = 0;
  private kd = 0;
  private kr = 0;
  private sustain = 0.7;
  private stage: number = Stage.Idle;
  private y = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  /**
   * Times mean what they say. The attack aims past unity at 1.15 and the
   * coefficient is scaled so the envelope crosses 1.0 exactly at `attack`;
   * decay and release are scaled so each covers 60 dB in its stated time.
   */
  set(attack: number, decay: number, sustain: number, release: number): void {
    this.ka = timeCoef(attack / 2.036882, this.sr); // ln(1.15/0.15)
    this.kd = timeCoef(decay / 6.907755278982137, this.sr);
    this.kr = timeCoef(release / 6.907755278982137, this.sr);
    this.sustain = sustain;
  }

  trigger(): void {
    this.stage = Stage.Attack;
  }

  release(): void {
    if (this.stage !== Stage.Idle) this.stage = Stage.Release;
  }

  reset(): void {
    this.stage = Stage.Idle;
    this.y = 0;
  }

  get active(): boolean {
    return this.stage !== Stage.Idle;
  }

  next(): number {
    switch (this.stage) {
      case Stage.Attack:
        // aim past 1 so the approach through 1 is fast and near-linear
        this.y = 1.15 + (this.y - 1.15) * this.ka;
        if (this.y >= 1) {
          this.y = 1;
          this.stage = Stage.Decay;
        }
        break;
      case Stage.Decay:
        this.y = this.sustain + (this.y - this.sustain) * this.kd;
        if (this.y - this.sustain < 1e-4) this.stage = Stage.Sustain;
        break;
      case Stage.Sustain:
        this.y = this.sustain;
        break;
      case Stage.Release:
        this.y = this.y * this.kr;
        if (this.y < 1e-5) {
          this.y = 0;
          this.stage = Stage.Idle;
        }
        break;
      default:
        return 0;
    }
    return this.y;
  }
}

/** Percussive exponential decay with an optional hold, for drum bodies. */
export class ExpDecay {
  private k = 0;
  private y = 0;
  private hold = 0;
  private sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  /** decay is the time to fall 60 dB. */
  set(decaySeconds: number, holdSeconds = 0): void {
    this.k = timeCoef(decaySeconds / 6.907755278982137, this.sr); // 60 dB
    this.hold = Math.floor(holdSeconds * this.sr);
  }

  trigger(level = 1): void {
    this.y = level;
  }

  next(): number {
    if (this.hold > 0) {
      this.hold--;
      return this.y;
    }
    const v = this.y;
    this.y *= this.k;
    return v;
  }

  get value(): number {
    return this.y;
  }
}

export interface Segment {
  /** target value at the end of this segment */
  to: number;
  /** length in seconds */
  time: number;
  /** 0 = linear, >0 bends toward the start value, <0 toward the target */
  curve?: number;
}

/**
 * Renders an automation curve into a Float32Array. Used for arrangement-level
 * filter sweeps and gain rides.
 */
export function renderSegments(
  out: Float32Array,
  from: number,
  segments: readonly Segment[],
  sampleRate: number,
  offset = 0,
): number {
  let i = offset;
  let value = from;
  for (const seg of segments) {
    const n = Math.floor(seg.time * sampleRate);
    const curve = seg.curve ?? 0;
    for (let k = 0; k < n && i < out.length; k++, i++) {
      const t = n === 1 ? 1 : k / (n - 1);
      let shaped = t;
      if (curve > 0) {
        for (let c = 0; c < curve; c++) shaped = shaped * t;
      } else if (curve < 0) {
        const inv = 1 - t;
        let s = inv;
        for (let c = 0; c < -curve; c++) s = s * inv;
        shaped = 1 - s;
      }
      out[i] = value + (seg.to - value) * shaped;
    }
    value = seg.to;
  }
  for (; i < out.length; i++) out[i] = value;
  return i;
}
