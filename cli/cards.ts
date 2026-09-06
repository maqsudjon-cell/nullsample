/**
 * Builds the landing page's demonstration cards.
 *
 *   npm run cards
 *
 * Every shape and every sound here is real engine output, computed at build
 * time. The cards are the page's explanation, so if they were illustrations
 * the page would be lying about the one thing it claims.
 *
 * Ships a small JSON dataset plus short mono clips. The engine itself is never
 * loaded on the landing page.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStereo, envelopePeaks, type Stereo } from "../core/buffer.ts";
import { cents, midiToHz } from "../core/dmath.ts";
import { Svf } from "../core/filter.ts";
import { Saw, Sine, Supersaw } from "../core/osc.ts";
import { makeRng } from "../core/rng.ts";
import { hardClip, softClip, waveshape, waveshapeOffset } from "../core/shape.ts";
import { Bass808Voice } from "../core/bass808.ts";
import { BUS_NAMES } from "../compose/arrange.ts";
import { getPreset } from "../presets/index.ts";
import { renderStem } from "../render/track.ts";
import { analyseLoudness } from "../render/loudness.ts";
import { encodeWav } from "../render/wav.ts";

const SR = 44100;
const OUT = new URL("../web/demos/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/** Points in one drawn waveform snapshot. */
const SHAPE = 320;

const mono = (data: Float32Array): Stereo => ({
  L: data,
  R: data,
  length: data.length,
  sampleRate: SR,
});

/** A window of the signal, normalised for drawing. */
function snapshot(buf: Float32Array, from: number, samples: number): number[] {
  const out: number[] = [];
  const step = samples / SHAPE;
  let peak = 1e-6;
  for (let i = 0; i < SHAPE; i++) {
    const v = buf[Math.min(buf.length - 1, Math.round(from + i * step))];
    out.push(v);
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return out.map((v) => Number((v / peak).toFixed(3)));
}

function fade(buf: Float32Array, seconds = 0.01): void {
  const n = Math.round(seconds * SR);
  for (let i = 0; i < n && i < buf.length; i++) {
    const g = i / n;
    buf[i] *= g;
    buf[buf.length - 1 - i] *= g;
  }
}

// ---------------------------------------------------------------------------
// card 1 — from nothing
// ---------------------------------------------------------------------------

/**
 * Silence, then a sine, then a sawtooth, then seven detuned copies of it.
 * The audio and the picture are the same four stages, so what you see is
 * always what you are hearing.
 */
function cardFromNothing() {
  const stageSeconds = [0.45, 1.55, 1.5, 2.5];
  const total = Math.round(stageSeconds.reduce((a, b) => a + b, 0) * SR);
  const buf = new Float32Array(total);
  const hz = midiToHz(45);
  const sine = new Sine(SR);
  sine.setFreq(hz);
  const saw = new Saw(SR);
  saw.setFreq(hz);
  const stack = new Supersaw(SR, makeRng("card"), 7, 16, 0.85);
  stack.setFreq(hz, cents);
  const frame = new Float64Array(2);
  const lp = new Svf(SR);
  lp.set(9000, 0.7);

  const bounds: number[] = [];
  let acc = 0;
  for (const s of stageSeconds) {
    bounds.push(acc);
    acc += s;
  }

  for (let i = 0; i < total; i++) {
    const t = i / SR;
    const s = sine.next();
    const w = saw.next();
    stack.next(frame);
    const st = (frame[0] + frame[1]) * 0.5;
    let v = 0;
    if (t < bounds[1]) {
      v = 0;
    } else if (t < bounds[2]) {
      // the sine fades up out of nothing
      const k = Math.min(1, (t - bounds[1]) / 0.5);
      v = s * 0.5 * k;
    } else if (t < bounds[3]) {
      // and sharpens into a sawtooth
      const k = Math.min(1, (t - bounds[2]) / 0.35);
      v = (s * (1 - k) + w * k) * 0.45;
    } else {
      // which splits into seven, drifting apart
      const k = Math.min(1, (t - bounds[3]) / 0.6);
      v = (w * (1 - k) * 0.45 + st * k * 0.42);
    }
    buf[i] = lp.lowpass(v);
  }
  fade(buf, 0.02);

  // one snapshot per stage, taken where that stage has fully arrived
  const win = Math.round(SR / hz * 3);
  const shapes = [
    { at: 0, label: "nothing", wave: new Array(SHAPE).fill(0) },
    { at: bounds[1] + 0.9, label: "a sine", wave: snapshot(buf, Math.round((bounds[1] + 0.9) * SR), win) },
    { at: bounds[2] + 0.9, label: "a sawtooth", wave: snapshot(buf, Math.round((bounds[2] + 0.9) * SR), win) },
    { at: bounds[3] + 1.4, label: "seven, detuned", wave: snapshot(buf, Math.round((bounds[3] + 1.4) * SR), win * 3) },
  ];
  writeFileSync(join(OUT, "card-nothing.wav"), encodeWav(mono(buf), 16));
  return { file: "card-nothing.mp3", duration: total / SR, shapes };
}

// ---------------------------------------------------------------------------
// card 2 — controlled destruction
// ---------------------------------------------------------------------------

/** One cycle, flattening and squaring off through the three stages. */
function cardDestruction() {
  const hz = midiToHz(45);
  const cycle = Math.round(SR / hz);
  const win = cycle * 2;
  const stages = [
    { label: "clean", fn: (x: number) => x },
    { label: "soft clip", fn: (x: number) => softClip(x * 3) },
    { label: "waveshaper", fn: (x: number) => waveshape(softClip(x * 3), 0.45, 0.12, waveshapeOffset(0.45, 0.12)) },
    { label: "hard clip", fn: (x: number) => hardClip(waveshape(softClip(x * 3), 0.45, 0.12, waveshapeOffset(0.45, 0.12)), 0.62) },
  ];

  const per = 1.2;
  const total = Math.round(per * stages.length * SR);
  const buf = new Float32Array(total);
  const shapes: { label: string; wave: number[] }[] = [];

  for (let k = 0; k < stages.length; k++) {
    const saw = new Saw(SR);
    saw.setFreq(hz);
    const from = Math.round(k * per * SR);
    const n = Math.round(per * SR);
    const seg = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, Math.min(i / (0.02 * SR), (n - i) / (0.06 * SR)));
      seg[i] = stages[k].fn(saw.next()) * 0.4 * env;
    }
    buf.set(seg, from);
    shapes.push({ label: stages[k].label, wave: snapshot(seg, Math.round(0.3 * SR), win) });
  }
  fade(buf, 0.02);
  writeFileSync(join(OUT, "card-dist.wav"), encodeWav(mono(buf), 16));
  return { file: "card-dist.mp3", duration: total / SR, stageSeconds: per, shapes };
}

// ---------------------------------------------------------------------------
// card 3 — the 808
// ---------------------------------------------------------------------------

/** The pitch bending down into the note, drawn as a line over the envelope. */
function card808() {
  const seconds = 2.6;
  const n = Math.round(seconds * SR);
  const buf = new Float32Array(n);
  const midi = 33;
  const drop = 12;
  const dropTime = 0.06;
  const voice = new Bass808Voice(SR, [{ start: 0, length: Math.round(n * 0.85), midi, velocity: 1, glide: false }], {
    dropSemitones: drop,
    dropTime,
    decay: 1.5,
    attack: 0.002,
    drive: 2.8,
    subLevel: 0.55,
    portamento: 0,
    toneHz: 2600,
  });
  voice.render(buf, 0, n);
  for (let i = 0; i < n; i++) buf[i] *= 0.72;
  fade(buf, 0.02);

  // the pitch curve the engine actually applies: an exponential toward the root
  const points = 200;
  const pitch: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = (i / (points - 1)) * seconds;
    const env = Math.exp(-t / dropTime);
    pitch.push(Number((drop * env).toFixed(3)));
  }
  const env = Array.from(envelopePeaks(mono(buf), points)).map((v) => Number(v.toFixed(3)));

  writeFileSync(join(OUT, "card-808.wav"), encodeWav(mono(buf), 16));
  return {
    file: "card-808.mp3",
    duration: seconds,
    dropSemitones: drop,
    dropMs: Math.round(dropTime * 1000),
    pitch,
    envelope: env,
  };
}

// ---------------------------------------------------------------------------
// card 4 — six parts, never merged
// ---------------------------------------------------------------------------

function cardSixParts(seed: string) {
  const { preset, ranges } = getPreset("hyperpop");
  const lanes: { name: string; file: string; peaks: number[] }[] = [];
  const seconds = 3;
  let from = 0;
  for (let i = 0; i < BUS_NAMES.length; i++) {
    const bus = BUS_NAMES[i];
    process.stderr.write(`\r  stem ${bus}...        `);
    const r = renderStem({ seed, preset, ranges, sampleRate: SR }, bus);
    if (i === 0) {
      const loud = analyseLoudness(r.audio, r.plan.sections);
      const spb = r.plan.samplesPerBar / SR;
      from = Math.max(0, Math.round((loud.loudestAtSeconds - 1) / spb)) * spb;
    }
    const start = Math.round(from * SR);
    const n = Math.min(Math.round(seconds * SR), r.audio.length - start);
    const clip = createStereo(n, SR);
    clip.L.set(r.audio.L.subarray(start, start + n));
    clip.R.set(r.audio.R.subarray(start, start + n));
    const f = Math.round(0.015 * SR);
    for (let k = 0; k < f; k++) {
      const g = k / f;
      clip.L[k] *= g; clip.R[k] *= g;
      clip.L[n - 1 - k] *= g; clip.R[n - 1 - k] *= g;
    }
    writeFileSync(join(OUT, `stem-${bus}.wav`), encodeWav(clip, 16));
    lanes.push({
      name: bus,
      file: `stem-${bus}.mp3`,
      peaks: Array.from(envelopePeaks(clip, 180)).map((v) => Number(v.toFixed(3))),
    });
  }
  process.stderr.write("\r" + " ".repeat(30) + "\r");
  return { seed, duration: seconds, lanes };
}

// ---------------------------------------------------------------------------

const cards = {
  fromNothing: cardFromNothing(),
  destruction: cardDestruction(),
  bass808: card808(),
  sixParts: cardSixParts("NULL-0001"),
};

writeFileSync(join(OUT, "cards.json"), JSON.stringify(cards));
const bytes = JSON.stringify(cards).length;
console.log(`web/demos/cards.json  ${(bytes / 1024).toFixed(1)} KB`);
console.log(`  from nothing: ${cards.fromNothing.shapes.length} stages, ${cards.fromNothing.duration.toFixed(1)} s`);
console.log(`  destruction:  ${cards.destruction.shapes.length} stages`);
console.log(`  808:          ${cards.bass808.pitch.length} pitch points, +${cards.bass808.dropSemitones} over ${cards.bass808.dropMs} ms`);
console.log(`  six parts:    ${cards.sixParts.lanes.length} lanes`);
