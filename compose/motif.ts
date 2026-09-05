/**
 * Motif generation.
 *
 * A random walk over scale degrees produces melodies that are technically
 * different and perceptually identical - a listener hears "some notes" every
 * time. So generation is constrained instead:
 *
 *   1. a rhythm is chosen from weighted step positions, not uniformly
 *   2. a contour shape is chosen first and the degrees are fitted to it
 *   3. interval jumps are bounded, and the figure resolves to a stable degree
 *   4. the figure is then repeated with a varied tail, because repetition is
 *      what makes a hook a hook
 *
 * The result is a short figure with a recognisable shape, which is what this
 * genre actually uses.
 */

import type { Rng } from "../core/rng.ts";

export type Contour = "arch" | "descend" | "ascend" | "zigzag" | "drop" | "plateau";

export const CONTOURS: readonly Contour[] = ["arch", "descend", "ascend", "zigzag", "drop", "plateau"];

export interface MotifNote {
  /** 16th-note step within the figure */
  step: number;
  /** length in steps */
  length: number;
  /** scale degree index; may exceed the scale length to mean a higher octave */
  degree: number;
  velocity: number;
}

export interface MotifSpec {
  /** length of the figure in 16th steps */
  steps: number;
  minNotes: number;
  maxNotes: number;
  /** scale degrees the melody may use, as indices */
  allowedDegrees: readonly number[];
  /** largest jump between consecutive notes, in allowed-degree positions */
  maxJump: number;
  contour: Contour;
  /** 0..1, biases toward more onsets */
  density: number;
  /** degrees considered resolved endings, as indices into allowedDegrees */
  stableDegrees: readonly number[];
  /** chance a note is held rather than restruck */
  legato: number;
}

/** Step weights: downbeats first, then offbeat 8ths, then the 16ths between. */
function stepWeight(step: number, steps: number): number {
  const inBar = step % 16;
  if (inBar % 16 === 0) return 10;
  if (inBar % 8 === 0) return 6;
  if (inBar % 4 === 0) return 4.5;
  if (inBar % 2 === 0) return 2.2;
  return 1.4;
}

/** Normalised contour value in [0,1] at position t in [0,1]. */
function contourAt(shape: Contour, t: number): number {
  switch (shape) {
    case "arch":
      return 1 - (2 * t - 1) * (2 * t - 1);
    case "descend":
      return 1 - t;
    case "ascend":
      return t;
    case "zigzag":
      return (Math.floor(t * 4) % 2 === 0 ? t * 4 - Math.floor(t * 4) : 1 - (t * 4 - Math.floor(t * 4)));
    case "drop":
      return t < 0.6 ? 0.85 : 0.85 - (t - 0.6) * 2.1;
    case "plateau":
      return t < 0.25 ? t * 3.2 : 0.8;
    default:
      return t;
  }
}

export function generateMotif(rng: Rng, spec: MotifSpec): MotifNote[] {
  const steps = spec.steps;
  const target = Math.round(
    spec.minNotes + (spec.maxNotes - spec.minNotes) * (0.35 + 0.65 * spec.density),
  );
  const count = Math.max(2, Math.min(spec.maxNotes, target));

  // --- rhythm: weighted selection without replacement, step 0 always taken --
  const candidates: number[] = [];
  const weights: number[] = [];
  for (let s = 1; s < steps; s++) {
    candidates.push(s);
    weights.push(stepWeight(s, steps));
  }
  const onsets = [0];
  for (let k = 1; k < count && candidates.length > 0; k++) {
    let total = 0;
    for (const w of weights) total += w;
    let r = rng.float() * total;
    let idx = 0;
    for (; idx < weights.length; idx++) {
      r -= weights[idx];
      if (r < 0) break;
    }
    if (idx >= candidates.length) idx = candidates.length - 1;
    onsets.push(candidates[idx]);
    candidates.splice(idx, 1);
    weights.splice(idx, 1);
  }
  onsets.sort((a, b) => a - b);

  // --- pitches: fit the contour, bounded jumps, resolve at the end ---------
  const pool = spec.allowedDegrees;
  const n = onsets.length;
  const notes: MotifNote[] = [];
  let prevIdx = -1;

  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const shape = contourAt(spec.contour, t);
    // where the contour wants us, in pool positions
    let wantIdx = Math.round(shape * (pool.length - 1));
    if (prevIdx >= 0) {
      const lo = prevIdx - spec.maxJump;
      const hi = prevIdx + spec.maxJump;
      if (wantIdx < lo) wantIdx = lo;
      if (wantIdx > hi) wantIdx = hi;
    }
    // a little colour, still inside the jump bound
    if (rng.bool(0.34)) wantIdx += rng.int(-1, 1);
    if (wantIdx < 0) wantIdx = 0;
    if (wantIdx >= pool.length) wantIdx = pool.length - 1;

    const isLast = i === n - 1;
    if (isLast && spec.stableDegrees.length > 0) {
      // resolve: nearest stable position to where the contour left us
      let best = spec.stableDegrees[0];
      let bestDist = Infinity;
      for (const sd of spec.stableDegrees) {
        const d = Math.abs(sd - wantIdx);
        if (d < bestDist) {
          bestDist = d;
          best = sd;
        }
      }
      wantIdx = best;
    }

    const nextOnset = i + 1 < n ? onsets[i + 1] : steps;
    const gap = nextOnset - onsets[i];
    const length = rng.bool(spec.legato) ? gap : Math.min(gap, Math.max(1, Math.round(gap * 0.6)));
    notes.push({
      step: onsets[i],
      length: Math.max(1, length),
      degree: pool[wantIdx],
      velocity: 0.72 + 0.28 * (onsets[i] % 4 === 0 ? 1 : rng.float()),
    });
    prevIdx = wantIdx;
  }
  return notes;
}

/**
 * Repeats a figure across `repeats` slots, varying the tail of the last one.
 * Literal repetition is the point; the variation stops it from becoming a
 * loop the ear switches off from.
 */
export function repeatWithVariation(
  rng: Rng,
  motif: readonly MotifNote[],
  spec: MotifSpec,
  repeats: number,
  variationChance: number,
): MotifNote[] {
  const out: MotifNote[] = [];
  for (let r = 0; r < repeats; r++) {
    const offset = r * spec.steps;
    const vary = r > 0 && rng.bool(variationChance);
    for (let i = 0; i < motif.length; i++) {
      const note = motif[i];
      let degree = note.degree;
      // vary only the last third, so the head of the hook stays identical
      if (vary && i >= Math.floor(motif.length * 0.66)) {
        const pool = spec.allowedDegrees;
        const idx = pool.indexOf(degree);
        if (idx >= 0) {
          const shift = rng.int(-1, 1);
          const ni = Math.max(0, Math.min(pool.length - 1, idx + shift));
          degree = pool[ni];
        }
      }
      out.push({ step: note.step + offset, length: note.length, degree, velocity: note.velocity });
    }
  }
  return out;
}
