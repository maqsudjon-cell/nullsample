/**
 * Motif generation.
 *
 * A random walk over scale degrees produces melodies that are technically
 * different and perceptually identical - a listener hears "some notes" every
 * time. Constrained generation fixes that much: it stops wrong notes. It does
 * not produce memorable ones, and in this genre the hook is the whole track.
 *
 * So a hook is built from three separable parts:
 *
 *   1. a RHYTHM FIGURE - where the onsets are, independent of pitch. A hyperpop
 *      lead has a rhythmic identity you would recognise on one drum.
 *   2. a PITCH FIGURE - a shape, chosen from a small set of archetypes and then
 *      filled. Real hooks have a contour you can hum; free constrained
 *      generation produces melodies that obey every rule and have no shape.
 *   3. a FOUR-BAR STRUCTURE - bars 1 and 3 identical, bar 2 a small answer, bar
 *      4 the variation that resolves. Repetition is the point, but mechanical
 *      repetition and structured repetition sound completely different.
 *
 * The two figures have independent lengths. When the pitch figure is shorter
 * than the rhythm it cycles against it, so the same shape lands on different
 * beats each time round - which is most of what makes a four-bar phrase sound
 * composed rather than looped.
 */

import type { Rng } from "../core/rng.ts";

export type Contour =
  | "arch"
  | "valley"
  | "descend"
  | "ascend"
  | "zigzag"
  | "leapStep"
  | "drop"
  | "plateau";

export const CONTOURS: readonly Contour[] = [
  "arch", "valley", "descend", "ascend", "zigzag", "leapStep", "drop", "plateau",
];

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

/** Where the notes are. Carries no pitch information at all. */
export interface RhythmFigure {
  /** onset positions in 16th steps, ascending, always starting at 0 */
  onsets: number[];
  /** note length in steps, parallel to `onsets` */
  lengths: number[];
  /** 0..1 accent, parallel to `onsets` */
  accents: number[];
}

/** What the notes are. Carries no timing information at all. */
export interface PitchFigure {
  /** positions into MotifSpec.allowedDegrees */
  positions: number[];
  contour: Contour;
}

/** Step weights: downbeats first, then offbeat 8ths, then the 16ths between. */
function stepWeight(step: number): number {
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
    case "valley":
      return (2 * t - 1) * (2 * t - 1);
    case "descend":
      return 1 - t;
    case "ascend":
      return t;
    case "zigzag":
      return (Math.floor(t * 4) % 2 === 0 ? t * 4 - Math.floor(t * 4) : 1 - (t * 4 - Math.floor(t * 4)));
    case "leapStep":
      // the genre's most-used shape: one large jump up, then stepwise descent
      return t < 0.12 ? 0.06 : 1 - (t - 0.12) * 0.8;
    case "drop":
      return t < 0.6 ? 0.85 : 0.85 - (t - 0.6) * 2.1;
    case "plateau":
      return t < 0.25 ? t * 3.2 : 0.8;
    default:
      return t;
  }
}

/**
 * Generates the rhythm alone: weighted selection without replacement, step 0
 * always taken so the figure has a downbeat to be recognised by.
 */
export function generateRhythm(rng: Rng, spec: MotifSpec): RhythmFigure {
  const steps = spec.steps;
  const target = Math.round(
    spec.minNotes + (spec.maxNotes - spec.minNotes) * (0.35 + 0.65 * spec.density),
  );
  const count = Math.max(2, Math.min(spec.maxNotes, target));

  const candidates: number[] = [];
  const weights: number[] = [];
  for (let s = 1; s < steps; s++) {
    candidates.push(s);
    weights.push(stepWeight(s));
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

  const lengths: number[] = [];
  const accents: number[] = [];
  for (let i = 0; i < onsets.length; i++) {
    const nextOnset = i + 1 < onsets.length ? onsets[i + 1] : steps;
    const gap = nextOnset - onsets[i];
    const held = rng.bool(spec.legato) ? gap : Math.min(gap, Math.max(1, Math.round(gap * 0.6)));
    lengths.push(Math.max(1, held));
    accents.push(0.72 + 0.28 * (onsets[i] % 4 === 0 ? 1 : rng.float()));
  }
  return { onsets, lengths, accents };
}

/**
 * Generates the pitch shape alone, over `slots` positions. Its length is chosen
 * independently of the rhythm, so a five-note shape over a seven-onset rhythm
 * puts the shape's peak on a different beat each time round.
 */
export function generatePitchFigure(rng: Rng, spec: MotifSpec, slots: number): PitchFigure {
  const pool = spec.allowedDegrees;
  const positions: number[] = [];
  let prevIdx = -1;
  for (let i = 0; i < slots; i++) {
    const t = slots === 1 ? 0 : i / (slots - 1);
    let wantIdx = Math.round(contourAt(spec.contour, t) * (pool.length - 1));
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
    positions.push(wantIdx);
    prevIdx = wantIdx;
  }
  return { positions, contour: spec.contour };
}

/** Nearest stable position to `idx`. */
function resolveTo(spec: MotifSpec, idx: number): number {
  if (spec.stableDegrees.length === 0) return idx;
  let best = spec.stableDegrees[0];
  let bestDist = Infinity;
  for (const sd of spec.stableDegrees) {
    const d = Math.abs(sd - idx);
    if (d < bestDist) {
      bestDist = d;
      best = sd;
    }
  }
  return best;
}

/**
 * Lays a pitch figure over a rhythm figure. The pitch figure cycles if it is
 * shorter than the rhythm.
 */
export function combine(
  rhythm: RhythmFigure,
  pitch: PitchFigure,
  spec: MotifSpec,
  resolveLast: boolean,
): MotifNote[] {
  const pool = spec.allowedDegrees;
  const n = rhythm.onsets.length;
  const notes: MotifNote[] = [];
  for (let i = 0; i < n; i++) {
    let idx = pitch.positions[i % pitch.positions.length];
    if (resolveLast && i === n - 1) idx = resolveTo(spec, idx);
    notes.push({
      step: rhythm.onsets[i],
      length: rhythm.lengths[i],
      degree: pool[idx],
      velocity: rhythm.accents[i],
    });
  }
  return notes;
}

/**
 * Shifts the tail of a pitch figure by a few positions, leaving the head
 * identical. The head is what makes the hook recognisable; the tail is what
 * stops four identical bars from switching the ear off.
 */
function varyTail(rng: Rng, pitch: PitchFigure, spec: MotifSpec, from: number, spread: number): PitchFigure {
  const pool = spec.allowedDegrees;
  const positions = pitch.positions.slice();
  let moved = false;
  for (let i = from; i < positions.length; i++) {
    const shift = rng.int(-spread, spread);
    const next = Math.max(0, Math.min(pool.length - 1, positions[i] + shift));
    if (next !== positions[i]) moved = true;
    positions[i] = next;
  }
  // An answer that came out identical is not an answer. Force the last slot to
  // move rather than let a run of zero draws collapse the four-bar structure
  // back into four identical bars.
  if (!moved && positions.length > 0) {
    const last = positions.length - 1;
    const dir = positions[last] >= pool.length - 1 ? -1 : 1;
    positions[last] = Math.max(0, Math.min(pool.length - 1, positions[last] + dir * spread));
  }
  return { positions, contour: pitch.contour };
}

/**
 * The four-bar hook.
 *
 *   bar 1  A    the figure
 *   bar 2  A'   same rhythm, tail answered a step or two away
 *   bar 3  A    identical to bar 1 - the repetition that makes it a hook
 *   bar 4  B    tail varied further and resolved onto a stable degree
 *
 * Returns one four-bar unit, with steps running 0 .. 4*spec.steps.
 */
export function buildFourBarHook(rng: Rng, spec: MotifSpec): MotifNote[] {
  const rhythm = generateRhythm(rng.child("rhythm"), spec);
  // The pitch figure gets its own length, deliberately not the onset count.
  const slots = Math.max(3, Math.min(rhythm.onsets.length, rng.int(3, 6)));
  const pitch = generatePitchFigure(rng.child("pitch"), spec, slots);

  const answerFrom = Math.max(1, Math.floor(slots * 0.5));
  const answer = varyTail(rng.child("answer"), pitch, spec, answerFrom, 1);
  const variation = varyTail(rng.child("variation"), pitch, spec, Math.max(1, Math.floor(slots * 0.34)), 2);

  const bars = [
    combine(rhythm, pitch, spec, false),
    combine(rhythm, answer, spec, false),
    combine(rhythm, pitch, spec, false),
    combine(rhythm, variation, spec, true),
  ];

  const out: MotifNote[] = [];
  for (let b = 0; b < bars.length; b++) {
    const offset = b * spec.steps;
    for (const n of bars[b]) {
      out.push({ step: n.step + offset, length: n.length, degree: n.degree, velocity: n.velocity });
    }
  }
  return out;
}

/**
 * Repeats a four-bar hook across a section. Whole units only: a hook cut in
 * half on bar three is the one arrangement that sounds like a mistake.
 */
export function repeatHook(hook: readonly MotifNote[], unitSteps: number, bars: number, stepsPerBar: number): MotifNote[] {
  const units = Math.max(1, Math.floor(bars / (unitSteps / stepsPerBar)));
  const out: MotifNote[] = [];
  const limit = bars * stepsPerBar;
  for (let u = 0; u < units; u++) {
    const offset = u * unitSteps;
    for (const n of hook) {
      if (n.step + offset >= limit) continue;
      out.push({ step: n.step + offset, length: n.length, degree: n.degree, velocity: n.velocity });
    }
  }
  return out;
}
