/** Stereo float buffers and measurement helpers. */

import { dsqrt, gain2db } from "./dmath.ts";

export interface Stereo {
  L: Float32Array;
  R: Float32Array;
  readonly length: number;
  readonly sampleRate: number;
}

export function createStereo(length: number, sampleRate: number): Stereo {
  return { L: new Float32Array(length), R: new Float32Array(length), length, sampleRate };
}

export function clearStereo(b: Stereo): void {
  b.L.fill(0);
  b.R.fill(0);
}

/** dst += src * gain */
export function mixInto(dst: Stereo, src: Stereo, gain: number): void {
  const n = dst.length < src.length ? dst.length : src.length;
  const { L: dl, R: dr } = dst;
  const { L: sl, R: sr } = src;
  for (let i = 0; i < n; i++) {
    dl[i] += sl[i] * gain;
    dr[i] += sr[i] * gain;
  }
}

/** dst += src * gainCurve[i] */
export function mixIntoCurve(dst: Stereo, src: Stereo, curve: Float32Array): void {
  const n = dst.length < src.length ? dst.length : src.length;
  const { L: dl, R: dr } = dst;
  const { L: sl, R: sr } = src;
  for (let i = 0; i < n; i++) {
    const g = curve[i];
    dl[i] += sl[i] * g;
    dr[i] += sr[i] * g;
  }
}

export function scaleStereo(b: Stereo, gain: number): void {
  const { L, R } = b;
  for (let i = 0; i < b.length; i++) {
    L[i] *= gain;
    R[i] *= gain;
  }
}

export function peak(b: Stereo): number {
  let p = 0;
  const { L, R } = b;
  for (let i = 0; i < b.length; i++) {
    const a = L[i] < 0 ? -L[i] : L[i];
    const c = R[i] < 0 ? -R[i] : R[i];
    if (a > p) p = a;
    if (c > p) p = c;
  }
  return p;
}

export function rms(b: Stereo): number {
  let s = 0;
  const { L, R } = b;
  for (let i = 0; i < b.length; i++) s += L[i] * L[i] + R[i] * R[i];
  return dsqrt(s / (b.length * 2));
}

export function peakDb(b: Stereo): number {
  return gain2db(peak(b));
}

export function rmsDb(b: Stereo): number {
  return gain2db(rms(b));
}

/** Mean sample value per channel. Should be within a hair of zero. */
export function dcOffset(b: Stereo): [number, number] {
  let l = 0;
  let r = 0;
  for (let i = 0; i < b.length; i++) {
    l += b.L[i];
    r += b.R[i];
  }
  return [l / b.length, r / b.length];
}

/** Longest run of exactly-silent frames, in samples. */
export function longestSilence(b: Stereo, threshold = 1e-5): number {
  let run = 0;
  let best = 0;
  for (let i = 0; i < b.length; i++) {
    const a = (b.L[i] < 0 ? -b.L[i] : b.L[i]) + (b.R[i] < 0 ? -b.R[i] : b.R[i]);
    if (a < threshold) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/** Short-window peak envelope, for drawing waveforms. */
export function envelopePeaks(b: Stereo, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const step = b.length / buckets;
  for (let k = 0; k < buckets; k++) {
    const start = Math.floor(k * step);
    const end = k === buckets - 1 ? b.length : Math.floor((k + 1) * step);
    let p = 0;
    for (let i = start; i < end; i++) {
      const a = (b.L[i] + b.R[i]) * 0.5;
      const m = a < 0 ? -a : a;
      if (m > p) p = m;
    }
    out[k] = p;
  }
  return out;
}
