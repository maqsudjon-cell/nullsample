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
 * Streaming 808 voice.
 *
 * Written as a class rather than a one-shot so the renderer never has to hold
 * a full-length buffer for it. That matters twice over: it is two minutes of
 * mono float that a phone would rather spend on the output, and pre-rendering
 * it would add half a second before the first note could be heard.
 */
export class Bass808Voice {
  private sr: number;
  private notes: readonly Note808[];
  private p: Bass808Params;
  private dc: DcBlocker;
  private tone: Svf;
  private subLp: Svf;
  private dropK: number;
  private portK: number;
  private attackK: number;

  private phase = 0;
  private currentHz: number;
  private targetHz: number;
  private dropEnv = 0;
  private dropRange = 0;
  private amp = 0;
  private ampTarget = 0;
  private decayK = 1;
  private noteIdx = 0;
  private noteEnd = -1;
  peak = 0;

  constructor(sampleRate: number, notes: readonly Note808[], p: Bass808Params) {
    this.sr = sampleRate;
    this.notes = notes;
    this.p = p;
    this.dc = new DcBlocker(sampleRate, 16);
    this.tone = new Svf(sampleRate);
    this.tone.set(p.toneHz, 0.6);
    this.subLp = new Svf(sampleRate);
    this.subLp.set(120, 0.7);
    this.dropK = dexp(-1 / (p.dropTime * sampleRate));
    this.portK = p.portamento > 0 ? dexp(-1 / (p.portamento * sampleRate)) : 0;
    this.attackK = dexp(-1 / (Math.max(0.0005, p.attack) * sampleRate));
    const first = notes.length > 0 ? midiToHz(notes[0].midi) : 55;
    this.currentHz = first;
    this.targetHz = first;
  }

  /** Fills out[0 .. count) with the part from absolute sample `start`. */
  render(out: Float32Array, start: number, count: number): void {
    const p = this.p;
    const sr = this.sr;
    const notes = this.notes;
    if (notes.length === 0) {
      out.fill(0, 0, count);
      return;
    }

    for (let i = 0; i < count; i++) {
      const abs = start + i;

      while (this.noteIdx < notes.length && notes[this.noteIdx].start === abs) {
        const note = notes[this.noteIdx];
        this.targetHz = midiToHz(note.midi);
        if (note.glide) {
          // keep the current pitch and slide; no new drop
          this.dropRange = 0;
          this.dropEnv = 0;
        } else {
          this.currentHz = this.targetHz;
          this.dropRange = midiToHz(note.midi + p.dropSemitones) - this.targetHz;
          this.dropEnv = 1;
        }
        this.ampTarget = note.velocity;
        this.amp = note.glide ? this.amp : Math.max(this.amp, 1e-4);
        this.decayK = dexp(-6.907755278982137 / (p.decay * sr));
        this.noteEnd = note.start + note.length;
        this.noteIdx++;
      }

      if (this.portK > 0) {
        this.currentHz = this.targetHz + (this.currentHz - this.targetHz) * this.portK;
      } else {
        this.currentHz = this.targetHz;
      }

      const f = this.currentHz + this.dropRange * this.dropEnv;
      this.phase += f / sr;
      if (this.phase >= 1) this.phase -= 1;
      this.dropEnv *= this.dropK;

      if (abs < this.noteEnd) {
        this.amp = this.ampTarget + (this.amp - this.ampTarget) * this.attackK;
        this.ampTarget *= this.decayK;
      } else {
        this.amp *= 0.9994; // gentle release past the written length
      }

      const s = sinTurns(this.phase) * this.amp;
      let sat = softClip(s * p.drive);
      sat = this.tone.lowpass(sat);
      // clean parallel sub, mono, never driven
      const sub = this.subLp.lowpass(s) * p.subLevel;
      const v = this.dc.process(sat * 0.8 + sub);
      out[i] = v;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
    }
  }
}

/**
 * Renders the whole 808 part into `out` (mono). Returns the peak seen.
 * A thin wrapper over the streaming voice, kept for tests and offline use.
 */
export function render808(
  out: Float32Array,
  sampleRate: number,
  notes: readonly Note808[],
  p: Bass808Params,
): number {
  out.fill(0);
  if (notes.length === 0) return 0;
  const voice = new Bass808Voice(sampleRate, notes, p);
  voice.render(out, 0, out.length);
  return voice.peak;
}
