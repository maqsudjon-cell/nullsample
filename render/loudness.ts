/**
 * Loudness measurement.
 *
 * Integrated RMS across a whole track is the wrong number to tune against. It
 * averages the quiet intro and the breakdown in with the drops, so any
 * arrangement with real dynamics reads low — and chasing that average with
 * makeup gain would flatten the track and destroy exactly the transients the
 * loudness target exists to protect.
 *
 * So the target applies to the loudest sustained stretch of the loud sections.
 * Integrated RMS is still reported, as information, with no target attached.
 *
 * This lives in /render rather than /core because it needs to know what a
 * section is, and /core knows nothing about arrangement.
 */

import { dsqrt, gain2db } from "../core/dmath.ts";
import { kaiserLowpass } from "../core/shape.ts";
import type { Stereo } from "../core/buffer.ts";
import type { SectionMark } from "./plan.ts";

/** Short-term window, in seconds. */
export const SHORT_TERM_SECONDS = 3;
/** Energy is accumulated in blocks this long, then summed across the window. */
const BLOCK_SECONDS = 0.1;
/** A section counts as loud at or above this intensity. */
const LOUD_INTENSITY = 0.9;
/** Below this crest factor the master is over-compressed whatever RMS says. */
export const CREST_FLOOR_DB = 6;

export interface LoudnessReport {
  /** Maximum short-term RMS inside the loud sections, dBFS. This is the one with a target. */
  dropRmsDb: number;
  /** Whole-file integrated RMS, dBFS. Information only — no target. */
  integratedRmsDb: number;
  /** Sample peak, dBFS. */
  peakDb: number;
  /** Inter-sample peak, dBTP. */
  truePeakDb: number;
  /** truePeakDb - dropRmsDb. Under CREST_FLOOR_DB means over-compressed. */
  crestDb: number;
  /** Where the loudest window sat, in seconds. */
  loudestAtSeconds: number;
  /** Names of the sections that were measured. */
  loudSections: string[];
  /** True when the crest factor has collapsed. */
  overCompressed: boolean;
}

/**
 * 4x interpolating true-peak detector. Same approach as the limiter's, but
 * one-shot over a finished buffer: 32 taps lands within 0.25 dB of the real
 * inter-sample maximum, where 16 underestimates by 1.8 dB at half Nyquist.
 */
function truePeak(buf: Stereo): number {
  const proto = kaiserLowpass(32, 0.125, 6);
  const up = new Float64Array(32);
  for (let ph = 0; ph < 4; ph++) {
    for (let k = 0; k < 8; k++) up[ph * 8 + k] = proto[k * 4 + ph] * 4;
  }
  let peak = 0;
  for (const ch of [buf.L, buf.R]) {
    const hist = new Float64Array(16);
    let pos = 0;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      hist[pos] = x;
      hist[pos + 8] = x;
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
      for (let ph = 0; ph < 4; ph++) {
        const b = ph * 8;
        let s = 0;
        for (let k = 0; k < 8; k++) s += up[b + k] * hist[pos + k];
        const m = s < 0 ? -s : s;
        if (m > peak) peak = m;
      }
      pos = pos === 0 ? 7 : pos - 1;
    }
  }
  return peak;
}

export function analyseLoudness(buf: Stereo, sections: readonly SectionMark[]): LoudnessReport {
  const sr = buf.sampleRate;
  const blockSamples = Math.max(1, Math.round(BLOCK_SECONDS * sr));
  const blocksPerWindow = Math.max(1, Math.round(SHORT_TERM_SECONDS / BLOCK_SECONDS));
  const blockCount = Math.floor(buf.length / blockSamples);

  // mean square per block
  const energy = new Float64Array(blockCount);
  let total = 0;
  for (let b = 0; b < blockCount; b++) {
    let sum = 0;
    const from = b * blockSamples;
    const to = from + blockSamples;
    for (let i = from; i < to; i++) sum += buf.L[i] * buf.L[i] + buf.R[i] * buf.R[i];
    energy[b] = sum / (blockSamples * 2);
    total += sum;
  }
  const integratedRmsDb = gain2db(dsqrt(total / (buf.length * 2)));

  const loud = sections.filter((s) => s.intensity >= LOUD_INTENSITY);
  const measured = loud.length > 0 ? loud : sections.slice();

  // Sliding short-term RMS, but only over windows that sit entirely inside a
  // loud section. A window straddling the edge of a drop would average the
  // break in with it and read low for the same reason integrated RMS does.
  let best = 0;
  let bestBlock = 0;
  for (const s of measured) {
    const firstBlock = Math.ceil(s.startSample / blockSamples);
    const lastBlock = Math.floor(s.endSample / blockSamples) - blocksPerWindow;
    for (let b = firstBlock; b <= lastBlock && b + blocksPerWindow <= blockCount; b++) {
      if (b < 0) continue;
      let sum = 0;
      for (let k = 0; k < blocksPerWindow; k++) sum += energy[b + k];
      const meanSquare = sum / blocksPerWindow;
      if (meanSquare > best) {
        best = meanSquare;
        bestBlock = b;
      }
    }
  }
  // a section shorter than the window still deserves a reading
  if (best === 0) {
    for (const s of measured) {
      const firstBlock = Math.ceil(s.startSample / blockSamples);
      const lastBlock = Math.min(blockCount - 1, Math.floor(s.endSample / blockSamples) - 1);
      let sum = 0;
      let n = 0;
      for (let b = firstBlock; b <= lastBlock; b++) {
        sum += energy[b];
        n++;
      }
      if (n > 0 && sum / n > best) {
        best = sum / n;
        bestBlock = firstBlock;
      }
    }
  }

  const dropRmsDb = gain2db(dsqrt(best));
  let samplePeak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = buf.L[i] < 0 ? -buf.L[i] : buf.L[i];
    const b = buf.R[i] < 0 ? -buf.R[i] : buf.R[i];
    if (a > samplePeak) samplePeak = a;
    if (b > samplePeak) samplePeak = b;
  }
  const truePeakDb = gain2db(truePeak(buf));
  const crestDb = truePeakDb - dropRmsDb;

  return {
    dropRmsDb,
    integratedRmsDb,
    peakDb: gain2db(samplePeak),
    truePeakDb,
    crestDb,
    loudestAtSeconds: (bestBlock * blockSamples) / sr,
    loudSections: measured.map((s) => s.name),
    overCompressed: crestDb < CREST_FLOOR_DB,
  };
}
