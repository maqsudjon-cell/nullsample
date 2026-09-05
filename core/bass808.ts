/**
 * The 808.
 *
 * A sine sub with an exponential pitch glide into the target note, a long
 * decay, and saturation to grow the harmonics that let it survive on a phone
 * speaker. A clean parallel sub sits underneath, low-passed and never
 * saturated, so the fundamental stays solid however hard the top is driven.
 *
 * Portamento between notes is what separates an 808 line from a row of
 * detached bass notes.
 */

import { dexp, midiToHz, sinTurns } from "./dmath.ts";
import { DcBlocker, Svf } from "./filter.ts";
import { softClip } from "./shape.ts";

export interface Note808 {
  /** start position in samples */
  start: number;
  /** length in samples */
  length: number;
  midi: number;
  velocity: number;
  /** glide from the previous note's pitch instead of retriggering the drop */
  glide: boolean;
}

export interface Bass808Params {
  /** semitones above the target the pitch drop starts from */
  dropSemitones: number;
  /** seconds for the drop, 0.04 to 0.09 */
  dropTime: number;
  /** amplitude decay to -60 dB, seconds */
  decay: number;
  /** attack, seconds - a couple of ms stops the click */
  attack: number;
  /** saturation drive */
  drive: number;
  /** level of the clean parallel sub */
  subLevel: number;
  /** portamento time between glided notes, seconds */
  portamento: number;
  /** low-pass on the saturated path */
  toneHz: number;
}

/**
 * Renders the whole 808 part into `out` (mono). Returns the peak seen.
 */
export function render808(
  out: Float32Array,
  sampleRate: number,
  notes: readonly Note808[],
  p: Bass808Params,
): number {
  out.fill(0);
  if (notes.length === 0) return 0;

  const sr = sampleRate;
  const dc = new DcBlocker(sr, 16);
  const tone = new Svf(sr);
  tone.set(p.toneHz, 0.6);
  const subLp = new Svf(sr);
  subLp.set(120, 0.7);

  const dropK = dexp(-1 / (p.dropTime * sr));
  const portK = p.portamento > 0 ? dexp(-1 / (p.portamento * sr)) : 0;
  const attackK = dexp(-1 / (Math.max(0.0005, p.attack) * sr));

  let phase = 0;
  let currentHz = midiToHz(notes[0].midi);
  let targetHz = currentHz;
  let dropEnv = 0;
  let dropRange = 0;
  let amp = 0;
  let ampTarget = 0;
  let decayK = 1;
  let peak = 0;

  let noteIdx = 0;
  let noteEnd = -1;
  const n = out.length;

  for (let i = 0; i < n; i++) {
    // note starts
    while (noteIdx < notes.length && notes[noteIdx].start === i) {
      const note = notes[noteIdx];
      targetHz = midiToHz(note.midi);
      if (note.glide) {
        // keep the current pitch and slide; no new drop
        dropRange = 0;
        dropEnv = 0;
      } else {
        currentHz = targetHz;
        dropRange = midiToHz(note.midi + p.dropSemitones) - targetHz;
        dropEnv = 1;
      }
      ampTarget = note.velocity;
      amp = note.glide ? amp : Math.max(amp, 1e-4);
      decayK = dexp(-6.907755278982137 / (p.decay * sr));
      noteEnd = note.start + note.length;
      noteIdx++;
    }

    if (portK > 0) currentHz = targetHz + (currentHz - targetHz) * portK;
    else currentHz = targetHz;

    const f = currentHz + dropRange * dropEnv;
    phase += f / sr;
    if (phase >= 1) phase -= 1;
    dropEnv *= dropK;

    // amplitude: fast attack toward the note level, then exponential decay
    if (i < noteEnd) {
      amp = ampTarget + (amp - ampTarget) * attackK;
      ampTarget *= decayK;
    } else {
      amp *= 0.9994; // gentle release past the written length
    }

    const s = sinTurns(phase) * amp;
    // saturated path
    let sat = softClip(s * p.drive);
    sat = tone.lowpass(sat);
    // clean parallel sub, mono, never driven
    const sub = subLp.lowpass(s) * p.subLevel;
    const v = dc.process(sat * 0.8 + sub);
    out[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak;
}
