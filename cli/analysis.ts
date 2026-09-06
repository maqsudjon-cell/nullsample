/**
 * Spectral analysis for the tooling.
 *
 * Used by the parameter audit and by the reference-target extractor, so both
 * measure the same way and their numbers can be compared directly.
 *
 * This lives in /cli, not /core: it is measurement for humans, never part of a
 * render, and nothing here needs to be deterministic across hosts.
 */

import type { Stereo } from "../core/buffer.ts";

/** Band edges in hertz. Twelve bands, roughly logarithmic. */
export const BAND_EDGES = [
  0, 40, 80, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 8000, 22050,
];

export const BAND_NAMES = BAND_EDGES.slice(0, -1).map((lo, i) => {
  const hi = BAND_EDGES[i + 1];
  const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v));
  return `${fmt(lo)}-${fmt(hi)}`;
});

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * cr - im[i + k + half] * ci;
        const vi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface Spectrum {
  /** energy per band, in dB, normalised so the bands sum to 0 dB */
  bandsDb: number[];
  /** absolute band energy in dB, not normalised */
  bandsAbsDb: number[];
  rmsDb: number;
  peakDb: number;
  crestDb: number;
  /** -1 to 1; 1 is mono, 0 uncorrelated */
  stereoCorrelation: number;
  /** correlation per band */
  bandCorrelation: number[];
  /**
   * Level change per band when the mix is summed to mono, in dB.
   *
   * 0 means the band is already mono. -3.01 dB is the floor for two fully
   * decorrelated channels of equal level - that is width, not a fault. Below
   * about -4 dB the channels are actively cancelling, and the band will lose
   * material on a phone speaker.
   */
  monoLossDb: number[];
  /** the same measure across the whole spectrum */
  monoLossBroadbandDb: number;
  spectralCentroidHz: number;
  /** share of energy below 120 Hz, in dB relative to total */
  subShareDb: number;
}

const FFT_SIZE = 4096;

/**
 * Welch-averaged band analysis. Averaging overlapping blocks rather than
 * transforming the whole file keeps a single loud transient from dominating
 * the picture.
 */
export function analyse(buf: Stereo, fromSample = 0, sampleCount = 0): Spectrum {
  const n = sampleCount > 0 ? Math.min(sampleCount, buf.length - fromSample) : buf.length - fromSample;
  const hop = FFT_SIZE / 2;
  const blocks = Math.max(1, Math.floor((n - FFT_SIZE) / hop) + 1);
  const bandCount = BAND_EDGES.length - 1;

  const powL = new Float64Array(FFT_SIZE / 2);
  const powR = new Float64Array(FFT_SIZE / 2);
  const crossLR = new Float64Array(FFT_SIZE / 2);

  const win = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

  const reL = new Float64Array(FFT_SIZE);
  const imL = new Float64Array(FFT_SIZE);
  const reR = new Float64Array(FFT_SIZE);
  const imR = new Float64Array(FFT_SIZE);

  let counted = 0;
  for (let b = 0; b < blocks; b++) {
    const off = fromSample + b * hop;
    if (off + FFT_SIZE > buf.length) break;
    for (let i = 0; i < FFT_SIZE; i++) {
      reL[i] = buf.L[off + i] * win[i];
      reR[i] = buf.R[off + i] * win[i];
      imL[i] = 0;
      imR[i] = 0;
    }
    fft(reL, imL);
    fft(reR, imR);
    for (let k = 0; k < FFT_SIZE / 2; k++) {
      powL[k] += reL[k] * reL[k] + imL[k] * imL[k];
      powR[k] += reR[k] * reR[k] + imR[k] * imR[k];
      crossLR[k] += reL[k] * reR[k] + imL[k] * imR[k];
    }
    counted++;
  }

  const binHz = buf.sampleRate / FFT_SIZE;
  const bandEnergy = new Float64Array(bandCount);
  const bandCross = new Float64Array(bandCount);
  const bandPowL = new Float64Array(bandCount);
  const bandPowR = new Float64Array(bandCount);
  let centroidNum = 0;
  let centroidDen = 0;
  let subEnergy = 0;
  let totalEnergy = 0;

  for (let k = 1; k < FFT_SIZE / 2; k++) {
    const hz = k * binHz;
    const e = (powL[k] + powR[k]) / Math.max(1, counted);
    let band = 0;
    while (band < bandCount - 1 && hz >= BAND_EDGES[band + 1]) band++;
    bandEnergy[band] += e;
    bandCross[band] += crossLR[k] / Math.max(1, counted);
    bandPowL[band] += powL[k] / Math.max(1, counted);
    bandPowR[band] += powR[k] / Math.max(1, counted);
    centroidNum += hz * e;
    centroidDen += e;
    totalEnergy += e;
    if (hz < 120) subEnergy += e;
  }

  const bandsAbsDb: number[] = [];
  for (let i = 0; i < bandCount; i++) bandsAbsDb.push(10 * Math.log10(bandEnergy[i] + 1e-30));
  const mean = bandsAbsDb.reduce((s, v) => s + v, 0) / bandCount;
  const bandsDb = bandsAbsDb.map((v) => Number((v - mean).toFixed(3)));

  const bandCorrelation: number[] = [];
  const monoLossDb: number[] = [];
  let stereoPow = 0;
  let monoPow = 0;
  for (let i = 0; i < bandCount; i++) {
    const d = Math.sqrt(bandPowL[i] * bandPowR[i]);
    bandCorrelation.push(Number((d > 1e-20 ? bandCross[i] / d : 1).toFixed(3)));
    // mono is (L+R)/2, so its power is (PL + PR + 2C)/4; the stereo reference
    // is the per-channel average power, (PL + PR)/2
    const sp = bandPowL[i] + bandPowR[i];
    const mp = sp + 2 * bandCross[i];
    stereoPow += sp;
    monoPow += mp;
    monoLossDb.push(
      sp > 1e-20 ? Number((10 * Math.log10(Math.max(mp, 0) / (2 * sp) + 1e-12)).toFixed(2)) : 0,
    );
  }
  const monoLossBroadbandDb = stereoPow > 1e-20
    ? Number((10 * Math.log10(Math.max(monoPow, 0) / (2 * stereoPow) + 1e-12)).toFixed(2))
    : 0;

  let sum = 0;
  let peak = 0;
  for (let i = fromSample; i < fromSample + n; i++) {
    sum += buf.L[i] * buf.L[i] + buf.R[i] * buf.R[i];
    const a = Math.abs(buf.L[i]);
    const b2 = Math.abs(buf.R[i]);
    if (a > peak) peak = a;
    if (b2 > peak) peak = b2;
  }
  const rms = Math.sqrt(sum / (n * 2));
  const rmsDb = 20 * Math.log10(rms + 1e-30);
  const peakDb = 20 * Math.log10(peak + 1e-30);

  let cross = 0;
  let el = 0;
  let er = 0;
  for (let i = fromSample; i < fromSample + n; i++) {
    cross += buf.L[i] * buf.R[i];
    el += buf.L[i] * buf.L[i];
    er += buf.R[i] * buf.R[i];
  }
  const denom = Math.sqrt(el * er);

  return {
    bandsDb,
    bandsAbsDb: bandsAbsDb.map((v) => Number(v.toFixed(3))),
    rmsDb: Number(rmsDb.toFixed(3)),
    peakDb: Number(peakDb.toFixed(3)),
    crestDb: Number((peakDb - rmsDb).toFixed(3)),
    stereoCorrelation: Number((denom > 1e-20 ? cross / denom : 1).toFixed(4)),
    bandCorrelation,
    monoLossDb,
    monoLossBroadbandDb,
    spectralCentroidHz: Number((centroidDen > 0 ? centroidNum / centroidDen : 0).toFixed(1)),
    subShareDb: Number((10 * Math.log10((subEnergy + 1e-30) / (totalEnergy + 1e-30))).toFixed(3)),
  };
}

/** Largest absolute band difference between two spectra, in dB. */
export function maxBandDelta(a: Spectrum, b: Spectrum): number {
  let m = 0;
  for (let i = 0; i < a.bandsDb.length; i++) {
    const d = Math.abs(a.bandsDb[i] - b.bandsDb[i]);
    if (d > m) m = d;
  }
  return m;
}
