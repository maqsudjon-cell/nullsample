/**
 * Harmony. A chord loop built from a scale and a degree pattern supplied by
 * the preset.
 *
 * The preset chooses the degrees. This file only knows how to turn a degree
 * into notes, which voicings exist, and how to keep a loop inside a register.
 */

import type { Rng } from "../core/rng.ts";

export const SCALES: Record<string, readonly number[]> = {
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  minorPentatonic: [0, 3, 5, 7, 10],
  aeolianSharp4: [0, 2, 3, 6, 7, 8, 10],
};

/** Voicings the preset may allow. Deliberately narrow: this genre is not jazz. */
export const VOICINGS: Record<string, readonly number[]> = {
  power: [0, 7],
  powerOct: [0, 7, 12],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  minor: [0, 3, 7],
  major: [0, 4, 7],
  minAdd9: [0, 3, 7, 14],
  majAdd9: [0, 4, 7, 14],
  minor7: [0, 3, 7, 10],
};

export interface Chord {
  /** absolute MIDI note of the chord root */
  rootMidi: number;
  /** index into the scale array */
  degreeIndex: number;
  /** semitone offsets from rootMidi */
  intervals: readonly number[];
  voicing: string;
  /** length in bars */
  bars: number;
}

export interface Harmony {
  /** MIDI note of the tonic */
  tonicMidi: number;
  scaleName: string;
  scale: readonly number[];
  chords: Chord[];
  barsPerLoop: number;
}

export interface HarmonySpec {
  tonicMidi: number;
  scaleName: string;
  /** scale degree indices, e.g. [0, 5, 3, 4] */
  degrees: readonly number[];
  /** which voicings may be chosen */
  voicings: readonly string[];
  barsPerChord: number;
}

/** Semitone offset of a scale degree, wrapping octaves for indices past the end. */
export function degreeSemitone(scale: readonly number[], degree: number): number {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  const idx = degree - oct * n;
  return scale[idx] + oct * 12;
}

/** True when the triad on this degree is minor within the scale. */
function isMinorTriad(scale: readonly number[], degree: number): boolean {
  const root = degreeSemitone(scale, degree);
  const third = degreeSemitone(scale, degree + 2) - root;
  return third <= 3;
}

export function buildHarmony(rng: Rng, spec: HarmonySpec): Harmony {
  const scale = SCALES[spec.scaleName] ?? SCALES.naturalMinor;
  const chords: Chord[] = [];
  for (const degree of spec.degrees) {
    const rootMidi = spec.tonicMidi + degreeSemitone(scale, degree);
    const minor = isMinorTriad(scale, degree);
    // filter the allowed voicings down to ones that fit the chord's quality
    const usable = spec.voicings.filter((v) => {
      if (v === "minor" || v === "minAdd9" || v === "minor7") return minor;
      if (v === "major" || v === "majAdd9") return !minor;
      return true; // power and sus voicings work either way
    });
    const voicing = usable.length > 0 ? rng.pick(usable) : "power";
    chords.push({
      rootMidi,
      degreeIndex: degree,
      intervals: VOICINGS[voicing] ?? VOICINGS.power,
      voicing,
      bars: spec.barsPerChord,
    });
  }
  return {
    tonicMidi: spec.tonicMidi,
    scaleName: spec.scaleName,
    scale,
    chords,
    barsPerLoop: chords.length * spec.barsPerChord,
  };
}

/** The chord sounding at a given bar. */
export function chordAtBar(h: Harmony, bar: number): Chord {
  const within = ((bar % h.barsPerLoop) + h.barsPerLoop) % h.barsPerLoop;
  let acc = 0;
  for (const c of h.chords) {
    acc += c.bars;
    if (within < acc) return c;
  }
  return h.chords[h.chords.length - 1];
}

/**
 * Voices a chord into absolute MIDI notes inside a register, keeping the
 * spacing the voicing describes rather than blindly folding into an octave.
 */
export function voiceChord(chord: Chord, lowMidi: number, highMidi: number): number[] {
  const notes: number[] = [];
  let root = chord.rootMidi;
  while (root < lowMidi) root += 12;
  while (root > lowMidi + 11) root -= 12;
  for (const iv of chord.intervals) {
    const n = root + iv;
    if (n <= highMidi) notes.push(n);
  }
  return notes.length > 0 ? notes : [root];
}
