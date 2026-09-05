/**
 * M1 acceptance demo: a saw through a resonant filter sweep and the full
 * distortion chain, written to WAV. Nothing musical, just proof the core
 * primitives behave.
 *
 *   node cli/demo-core.ts out.wav
 */

import { createStereo, peakDb, rmsDb, dcOffset } from "../core/buffer.ts";
import { cosTurns, midiToHz } from "../core/dmath.ts";
import { Svf } from "../core/filter.ts";
import { Saw, Supersaw } from "../core/osc.ts";
import { cents } from "../core/dmath.ts";
import { makeRng } from "../core/rng.ts";
import { DistortionChain } from "../core/shape.ts";
import { Reverb } from "../core/reverb.ts";
import { Limiter } from "../core/dynamics.ts";
import { encodeWav } from "../render/wav.ts";
import { writeFileSync } from "node:fs";

const SR = 44100;
const SECONDS = 6;
const BLOCK = 512;
const n = SR * SECONDS;

const rng = makeRng("m1-demo");
const out = createStereo(n, SR);
const mono = new Float32Array(n);

// --- source: a supersaw playing a slow rising note ------------------------
const saw = new Supersaw(SR, rng.child("saw"), 7, 18, 0.7);
const filt = new Svf(SR);
const frame = new Float64Array(2);
const wide = new Float32Array(n);

for (let i = 0; i < n; i++) {
  const t = i / SR;
  const midi = 36 + 12 * (t / SECONDS);
  saw.setFreq(midiToHz(midi), cents);
  // filter sweep 200 Hz -> 6 kHz and back, high resonance
  const sweep = 0.5 - 0.5 * cosTurns(t / SECONDS);
  filt.set(200 + 5800 * sweep, 6);
  saw.next(frame);
  const m = (frame[0] + frame[1]) * 0.5;
  mono[i] = filt.lowpass(m) * 0.5;
  wide[i] = (frame[0] - frame[1]) * 0.25;
}

// --- distortion chain, 4x oversampled -------------------------------------
const dist = new DistortionChain(BLOCK);
dist.params = { drive: 4.5, fold: 0.35, bias: 0.08, ceiling: 0.9, output: 0.55 };
for (let i = 0; i < n; i += BLOCK) {
  dist.process(mono, i, Math.min(BLOCK, n - i));
}

// --- reverb and output ----------------------------------------------------
const rev = new Reverb(SR, 3);
rev.decay = 1.8;
rev.brightness = 0.5;
rev.update();
const lim = new Limiter(SR, 0.0025, 0.05);
lim.ceiling = 0.89;

for (let i = 0; i < n; i++) {
  rev.process(mono[i] * 0.25, frame);
  const l = mono[i] * 0.8 + wide[i] + frame[0] * 0.5;
  const r = mono[i] * 0.8 - wide[i] + frame[1] * 0.5;
  lim.process(l, r, frame);
  out.L[i] = frame[0];
  out.R[i] = frame[1];
}

const path = process.argv[2] ?? "demo-core.wav";
writeFileSync(path, encodeWav(out, 16));
const [dl, dr] = dcOffset(out);
console.log(`wrote ${path}`);
console.log(`  ${SECONDS}s stereo  peak ${peakDb(out).toFixed(2)} dBFS  rms ${rmsDb(out).toFixed(2)} dBFS`);
console.log(`  dc offset L ${dl.toExponential(2)}  R ${dr.toExponential(2)}`);
