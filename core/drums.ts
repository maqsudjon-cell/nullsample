/**
 * Drum synthesis. Every voice is built from oscillators, noise and envelopes.
 *
 * Each renderer returns a freshly synthesised mono hit. The sequencer caches a
 * small number of variants per voice and mixes them at velocity, which is what
 * keeps a sixty-bar arrangement inside the time budget without making every
 * hit literally identical.
 */

import { dexp, midiToHz } from "./dmath.ts";
import { DcBlocker, Svf } from "./filter.ts";
import { Pulse, Sine } from "./osc.ts";
import type { Rng } from "./rng.ts";
import { softClip, waveshape } from "./shape.ts";

export interface KickParams {
  startHz: number;
  endHz: number;
  pitchDecay: number;
  ampDecay: number;
  clickLevel: number;
  clickDecay: number;
  drive: number;
  bodyLevel: number;
}

export function renderKick(sr: number, p: KickParams, rng: Rng): Float32Array {
  const n = Math.ceil((p.ampDecay * 1.6 + 0.02) * sr);
  const out = new Float32Array(n);
  const pk = dexp(-1 / (p.pitchDecay * sr));
  const ak = dexp(-6.907755278982137 / (p.ampDecay * sr));
  const ck = dexp(-6.907755278982137 / (p.clickDecay * sr));
  const dc = new DcBlocker(sr, 18);
  const clickFilter = new Svf(sr);
  clickFilter.set(2600, 0.8);

  let pitchEnv = 1;
  let amp = 1;
  let clickAmp = 1;
  let phase = 0;
  const range = p.startHz - p.endHz;

  for (let i = 0; i < n; i++) {
    const f = p.endHz + range * pitchEnv;
    phase += f / sr;
    if (phase >= 1) phase -= 1;
    // body: sine, slightly saturated so it holds up in a dense mix
    const body = sinFast(phase);
    let v = body * amp * p.bodyLevel;
    // click: short noise burst through a resonant band, gives the transient
    if (clickAmp > 1e-4) {
      const noise = rng.float() * 2 - 1;
      v += clickFilter.bandpass(noise) * clickAmp * p.clickLevel;
    }
    v = softClip(v * p.drive) * (1 / (1 + (p.drive - 1) * 0.55));
    out[i] = dc.process(v);
    pitchEnv *= pk;
    amp *= ak;
    clickAmp *= ck;
  }
  fadeTail(out, Math.floor(0.004 * sr));
  return out;
}

export interface SnareParams {
  toneHz: number;
  toneDecay: number;
  noiseDecay: number;
  noiseLowHz: number;
  noiseHighHz: number;
  noiseLevel: number;
  toneLevel: number;
  drive: number;
}

export function renderSnare(sr: number, p: SnareParams, rng: Rng): Float32Array {
  const n = Math.ceil((Math.max(p.toneDecay, p.noiseDecay) * 1.6 + 0.01) * sr);
  const out = new Float32Array(n);
  const tk = dexp(-6.907755278982137 / (p.toneDecay * sr));
  const nk = dexp(-6.907755278982137 / (p.noiseDecay * sr));
  const hp = new Svf(sr);
  hp.set(p.noiseLowHz, 0.7);
  const lp = new Svf(sr);
  lp.set(p.noiseHighHz, 0.7);
  const dc = new DcBlocker(sr, 30);
  // two detuned bodies, a fifth apart, is the classic tuned-shell trick
  let ph1 = 0;
  let ph2 = 0;
  const f1 = p.toneHz / sr;
  const f2 = (p.toneHz * 1.48) / sr;
  let tAmp = 1;
  let nAmp = 1;

  for (let i = 0; i < n; i++) {
    ph1 += f1;
    if (ph1 >= 1) ph1 -= 1;
    ph2 += f2;
    if (ph2 >= 1) ph2 -= 1;
    const tone = (sinFast(ph1) * 0.65 + sinFast(ph2) * 0.35) * tAmp * p.toneLevel;
    const white = rng.float() * 2 - 1;
    const noise = lp.lowpass(hp.highpass(white)) * nAmp * p.noiseLevel;
    let v = tone + noise;
    v = softClip(v * p.drive) * (1 / (1 + (p.drive - 1) * 0.5));
    out[i] = dc.process(v);
    tAmp *= tk;
    nAmp *= nk;
  }
  fadeTail(out, Math.floor(0.003 * sr));
  return out;
}

export interface ClapParams {
  bursts: number;
  spacing: number;
  spread: number;
  bandLowHz: number;
  bandHighHz: number;
  burstDecay: number;
  tailDecay: number;
  tailLevel: number;
}

export function renderClap(sr: number, p: ClapParams, rng: Rng): Float32Array {
  const total = p.spacing * p.bursts + p.tailDecay * 1.5;
  const n = Math.ceil(total * sr);
  const out = new Float32Array(n);
  const hp = new Svf(sr);
  hp.set(p.bandLowHz, 0.9);
  const lp = new Svf(sr);
  lp.set(p.bandHighHz, 0.8);
  const bk = dexp(-6.907755278982137 / (p.burstDecay * sr));
  const tk = dexp(-6.907755278982137 / (p.tailDecay * sr));

  // burst onsets, slightly uneven - a perfectly even clap sounds like a
  // flanged click rather than several hands
  const onsets: number[] = [];
  for (let b = 0; b < p.bursts; b++) {
    const jitter = 1 + rng.range(-p.spread, p.spread);
    onsets.push(Math.floor(b * p.spacing * jitter * sr));
  }
  const levels: number[] = [];
  for (let b = 0; b < p.bursts; b++) levels.push(0.7 + 0.3 * rng.float());

  let burstAmp = 0;
  let tailAmp = 0;
  let next = 0;
  const tailStart = onsets[onsets.length - 1];

  for (let i = 0; i < n; i++) {
    while (next < onsets.length && i === onsets[next]) {
      burstAmp = levels[next];
      next++;
    }
    if (i === tailStart) tailAmp = p.tailLevel;
    const white = rng.float() * 2 - 1;
    const band = lp.lowpass(hp.highpass(white));
    out[i] = band * (burstAmp + tailAmp);
    burstAmp *= bk;
    tailAmp *= tk;
  }
  fadeTail(out, Math.floor(0.004 * sr));
  return out;
}

export interface HatParams {
  decay: number;
  baseHz: number;
  highpassHz: number;
  bandHz: number;
  bandQ: number;
  noiseMix: number;
}

/** Six inharmonic pulses through a highpass - the 808 metallic recipe. */
const HAT_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

export function renderHat(sr: number, p: HatParams, rng: Rng): Float32Array {
  const n = Math.ceil((p.decay * 1.5 + 0.005) * sr);
  const out = new Float32Array(n);
  const oscs: Pulse[] = [];
  for (let i = 0; i < HAT_RATIOS.length; i++) {
    const o = new Pulse(sr, rng.float());
    o.setFreq(p.baseHz * HAT_RATIOS[i]);
    o.width = 0.5;
    oscs.push(o);
  }
  const hp = new Svf(sr);
  hp.set(p.highpassHz, 0.7);
  const band = new Svf(sr);
  band.set(p.bandHz, p.bandQ);
  const k = dexp(-6.907755278982137 / (p.decay * sr));
  let amp = 1;

  for (let i = 0; i < n; i++) {
    let metal = 0;
    for (let j = 0; j < oscs.length; j++) metal += oscs[j].next();
    metal *= 0.1666666666666667;
    const white = rng.float() * 2 - 1;
    const src = metal * (1 - p.noiseMix) + white * p.noiseMix;
    const v = hp.highpass(src) * 0.7 + band.bandpass(src) * 0.5;
    out[i] = v * amp;
    amp *= k;
  }
  fadeTail(out, Math.floor(0.002 * sr));
  return out;
}

export interface RimParams {
  hz: number;
  q: number;
  decay: number;
  clickLevel: number;
}

export function renderRim(sr: number, p: RimParams, rng: Rng): Float32Array {
  const n = Math.ceil((p.decay * 1.6 + 0.004) * sr);
  const out = new Float32Array(n);
  const band = new Svf(sr);
  band.set(p.hz, p.q);
  const band2 = new Svf(sr);
  band2.set(p.hz * 2.7, p.q * 0.6);
  const k = dexp(-6.907755278982137 / (p.decay * sr));
  let amp = 1;
  for (let i = 0; i < n; i++) {
    const impulse = i < 2 ? 1 : 0;
    const white = (rng.float() * 2 - 1) * (i < 12 ? p.clickLevel : 0);
    const src = impulse + white;
    out[i] = (band.bandpass(src) + band2.bandpass(src) * 0.4) * amp;
    amp *= k;
  }
  fadeTail(out, Math.floor(0.002 * sr));
  return out;
}

export interface TomParams {
  startHz: number;
  endHz: number;
  pitchDecay: number;
  decay: number;
  noiseLevel: number;
}

export function renderTom(sr: number, p: TomParams, rng: Rng): Float32Array {
  const n = Math.ceil((p.decay * 1.6 + 0.01) * sr);
  const out = new Float32Array(n);
  const pk = dexp(-1 / (p.pitchDecay * sr));
  const ak = dexp(-6.907755278982137 / (p.decay * sr));
  const dc = new DcBlocker(sr, 25);
  const nf = new Svf(sr);
  nf.set(1800, 0.8);
  let pitchEnv = 1;
  let amp = 1;
  let phase = 0;
  const range = p.startHz - p.endHz;
  for (let i = 0; i < n; i++) {
    const f = p.endHz + range * pitchEnv;
    phase += f / sr;
    if (phase >= 1) phase -= 1;
    const white = rng.float() * 2 - 1;
    const v = sinFast(phase) * amp + nf.bandpass(white) * amp * p.noiseLevel;
    out[i] = dc.process(softClip(v * 1.4) * 0.8);
    pitchEnv *= pk;
    amp *= ak;
  }
  fadeTail(out, Math.floor(0.004 * sr));
  return out;
}

// ---------------------------------------------------------------------------

/** Local sine so drum loops do not pay a cross-module call per sample. */
function sinFast(turns: number): number {
  return sinTurnsRef(turns);
}
import { sinTurns as sinTurnsRef } from "./dmath.ts";

/** Fades the last `len` samples to zero so a truncated tail never clicks. */
function fadeTail(buf: Float32Array, len: number): void {
  const n = buf.length;
  const l = Math.min(len, n);
  for (let i = 0; i < l; i++) {
    const g = i / l;
    buf[n - 1 - i] *= g;
  }
}

export { midiToHz, waveshape };
