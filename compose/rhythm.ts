/**
 * Rhythm. Sixteen steps per bar, per-step velocity, plus rolls and bursts.
 *
 * Patterns come from banks declared in the preset rather than being generated
 * freely. A freely generated drum pattern at 155 BPM is almost never a pattern
 * this genre would use; the interesting variation is in which pattern, how it
 * is accented, where the rolls land and what the fill does.
 */

import type { Rng } from "../core/rng.ts";

export const STEPS_PER_BAR = 16;

/**
 * Pattern notation, one character per 16th:
 *   X accent   x hit   o medium   - ghost   . rest
 */
const CHAR_VELOCITY: Record<string, number> = {
  X: 1,
  x: 0.82,
  o: 0.62,
  "-": 0.32,
  ".": 0,
};

export function parsePattern(src: string): Float32Array {
  const clean = src.replace(/[|\s]/g, "");
  const out = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i++) {
    const v = CHAR_VELOCITY[clean[i]];
    out[i] = v === undefined ? 0 : v;
  }
  return out;
}

export interface PatternBank {
  /** patterns ordered from sparse to dense */
  patterns: readonly string[];
}

/**
 * Picks a pattern, biased toward the dense end as intensity rises. The bias is
 * soft, so a low-intensity section can still surprise with a busy pattern.
 */
export function pickPattern(rng: Rng, bank: PatternBank, intensity: number): Float32Array {
  const n = bank.patterns.length;
  if (n === 1) return parsePattern(bank.patterns[0]);
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    const position = i / (n - 1);
    const distance = Math.abs(position - intensity);
    weights.push(0.12 + (1 - distance) * (1 - distance) * 2);
  }
  return parsePattern(rng.weighted([...bank.patterns], weights));
}

/** Small per-hit velocity variation. Never enough to change the pattern. */
export function humanise(rng: Rng, pattern: Float32Array, amount: number): Float32Array {
  const out = new Float32Array(pattern.length);
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] <= 0) {
      out[i] = 0;
      continue;
    }
    const v = pattern[i] * (1 + rng.range(-amount, amount));
    out[i] = v < 0.05 ? 0.05 : v > 1 ? 1 : v;
  }
  return out;
}

export interface RollEvent {
  /** fractional step position within the bar */
  step: number;
  velocity: number;
}

export interface RollSpec {
  /** probability a candidate step becomes a roll */
  chance: number;
  /** allowed subdivision counts, e.g. [3, 4, 6] */
  divisions: readonly number[];
  /** steps eligible to become rolls */
  candidates: readonly number[];
  /** 1 = flat, >1 crescendo, <1 decrescendo */
  ramp: number;
}

/**
 * Turns some hits into rolls. This is the single most characteristic gesture
 * in the genre, so it is a first-class part of the rhythm layer rather than a
 * post-processing trick.
 */
export function addRolls(rng: Rng, pattern: Float32Array, spec: RollSpec): RollEvent[] {
  const events: RollEvent[] = [];
  for (let s = 0; s < pattern.length; s++) {
    const isCandidate = spec.candidates.includes(s);
    if (!isCandidate || pattern[s] <= 0 || !rng.bool(spec.chance)) {
      if (pattern[s] > 0) events.push({ step: s, velocity: pattern[s] });
      continue;
    }
    const div = rng.pick(spec.divisions);
    for (let d = 0; d < div; d++) {
      const t = div === 1 ? 1 : d / (div - 1);
      const shape = spec.ramp >= 1 ? 0.45 + 0.55 * t * spec.ramp : 1 - t * (1 - spec.ramp);
      const v = pattern[s] * Math.min(1, Math.max(0.12, shape));
      events.push({ step: s + d / div, velocity: v });
    }
  }
  return events;
}

/** Plain conversion when no rolls apply. */
export function toEvents(pattern: Float32Array): RollEvent[] {
  const out: RollEvent[] = [];
  for (let s = 0; s < pattern.length; s++) if (pattern[s] > 0) out.push({ step: s, velocity: pattern[s] });
  return out;
}

/**
 * A one-bar fill. Builds a burst across the last `lengthSteps` of the bar,
 * used at section boundaries.
 */
export function buildFill(rng: Rng, lengthSteps: number, intensity: number): RollEvent[] {
  const events: RollEvent[] = [];
  const start = STEPS_PER_BAR - lengthSteps;
  const div = rng.pick([1, 2, 2, 4]);
  for (let s = start; s < STEPS_PER_BAR; s++) {
    const t = (s - start) / Math.max(1, lengthSteps - 1);
    for (let d = 0; d < div; d++) {
      events.push({
        step: s + d / div,
        velocity: Math.min(1, (0.5 + 0.5 * t) * (0.7 + 0.5 * intensity)),
      });
    }
  }
  return events;
}
