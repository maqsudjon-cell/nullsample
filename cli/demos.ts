/**
 * Builds the landing page's audio: demo excerpts, and the code-beside-sound
 * clips.
 *
 *   npm run demos
 *
 * The code excerpts are pulled verbatim out of /core at build time rather than
 * transcribed, so the page cannot end up showing code that no longer matches
 * the engine. If an excerpt stops matching, this fails loudly.
 *
 * The clips demonstrate one idea each by A/B: the same note with and without
 * the one line that matters. That is the argument the landing page is making,
 * and it takes four seconds rather than a paragraph.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStereo, type Stereo } from "../core/buffer.ts";
import { cents, midiToHz } from "../core/dmath.ts";
import { Svf } from "../core/filter.ts";
import { Saw, polyBlep } from "../core/osc.ts";
import { makeRng } from "../core/rng.ts";
import { softClip } from "../core/shape.ts";
import { Bass808Voice } from "../core/bass808.ts";
import { getPreset } from "../presets/index.ts";
import { renderTrack } from "../render/track.ts";
import { analyseLoudness } from "../render/loudness.ts";
import { encodeWav } from "../render/wav.ts";

const SR = 44100;
const OUT = new URL("../web/demos/", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/** Seeds shown on the landing page. The first is the hero. */
const DEMO_SEEDS = ["NULL-0001", "RAGE-88KK", "VOID-7X2A", "GRID-LOCK4"];
const EXCERPT_SECONDS = 20;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// ---------------------------------------------------------------------------
// source extraction
// ---------------------------------------------------------------------------

/** Pulls a function body out of a source file, verbatim. */
function extract(file: string, startsWith: string, lines: number, mustContain: string[]): string {
  const src = readFileSync(join(ROOT, file), "utf8").split("\n");
  const at = src.findIndex((l) => l.trim().startsWith(startsWith));
  if (at < 0) throw new Error(`demos: could not find "${startsWith}" in ${file}`);
  const text = src.slice(at, at + lines).join("\n");
  for (const needle of mustContain) {
    if (!text.includes(needle)) {
      throw new Error(`demos: excerpt from ${file} no longer contains "${needle}"`);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// clip 1: the band-limited saw, with and without the correction
// ---------------------------------------------------------------------------

function sawClip(): Stereo {
  const seconds = 6;
  const n = SR * seconds;
  const out = createStereo(n, SR);
  const half = n / 2;
  const filt = new Svf(SR);
  filt.set(16000, 0.7);

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const local = i < half ? i / half : (i - half) / half;
    // Sweeps to 4.4 kHz. Measured: at that pitch the corrected version is
    // 28.6 dB cleaner, where at 1.7 kHz it is only 8.5 dB and both versions'
    // worst aliases sit near 21 kHz where nobody can hear them. The demo has
    // to go where the difference is actually audible or it is not a demo.
    const hz = 220 * (1 + 19 * local * local);
    const dt = hz / SR;
    const naive = 2 * phase - 1;
    // the second half adds the one line that is the whole difference
    const v = i < half ? naive : naive - polyBlep(phase, dt);
    phase += dt;
    if (phase >= 1) phase -= 1;
    const env = Math.min(1, Math.min(local * 12, (1 - local) * 12));
    const y = filt.lowpass(v) * 0.32 * env;
    out.L[i] = y;
    out.R[i] = y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// clip 2: the 808, one element at a time
// ---------------------------------------------------------------------------

function bass808Clip(): Stereo {
  const stages = 4;
  const stageSeconds = 1.6;
  const n = Math.round(SR * stageSeconds * stages);
  const out = createStereo(n, SR);
  const notes = [];
  for (let s = 0; s < stages; s++) {
    notes.push({
      start: Math.round(s * stageSeconds * SR),
      length: Math.round(stageSeconds * SR * 0.92),
      midi: 33,
      velocity: 1,
      glide: false,
    });
  }
  // Each stage turns one more part of the voice on, so the ear can attach a
  // sound to a line rather than to a paragraph about it.
  const params = [
    { dropSemitones: 0, drive: 1, subLevel: 0, toneHz: 6000 },
    { dropSemitones: 9, drive: 1, subLevel: 0, toneHz: 6000 },
    { dropSemitones: 9, drive: 3.4, subLevel: 0, toneHz: 2600 },
    { dropSemitones: 9, drive: 3.4, subLevel: 0.6, toneHz: 2600 },
  ];
  for (let s = 0; s < stages; s++) {
    const voice = new Bass808Voice(SR, [notes[s]], {
      dropSemitones: params[s].dropSemitones,
      dropTime: 0.06,
      decay: 1.1,
      attack: 0.003,
      drive: params[s].drive,
      subLevel: params[s].subLevel,
      portamento: 0,
      toneHz: params[s].toneHz,
    });
    const from = notes[s].start;
    const count = Math.min(Math.round(stageSeconds * SR), n - from);
    const buf = new Float32Array(count);
    voice.render(buf, from, count);
    for (let i = 0; i < count; i++) {
      const v = buf[i] * 0.62;
      out.L[from + i] = v;
      out.R[from + i] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Peak envelope, quantised to two decimals.
 *
 * Shipped in the manifest so the hero waveform draws on page load without
 * downloading or decoding any audio. A visitor who never presses play still
 * sees the shape of the thing, and the page still costs nothing.
 */
function peakEnvelope(buf: Stereo, buckets: number): number[] {
  const out: number[] = [];
  const step = buf.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * step);
    const to = b === buckets - 1 ? buf.length : Math.floor((b + 1) * step);
    let p = 0;
    for (let i = from; i < to; i++) {
      const a = (buf.L[i] + buf.R[i]) * 0.5;
      const m = a < 0 ? -a : a;
      if (m > p) p = m;
    }
    out.push(Number(p.toFixed(2)));
  }
  return out;
}

function excerpt(full: Stereo, fromSeconds: number, seconds: number): Stereo {
  const from = Math.round(fromSeconds * full.sampleRate);
  const n = Math.min(Math.round(seconds * full.sampleRate), full.length - from);
  const out = createStereo(n, full.sampleRate);
  out.L.set(full.L.subarray(from, from + n));
  out.R.set(full.R.subarray(from, from + n));
  // short fades so an excerpt cannot click
  const f = Math.round(0.02 * full.sampleRate);
  for (let i = 0; i < f; i++) {
    const g = i / f;
    out.L[i] *= g;
    out.R[i] *= g;
    out.L[n - 1 - i] *= g;
    out.R[n - 1 - i] *= g;
  }
  return out;
}

const { preset, ranges } = getPreset("hyperpop");
const tracks = [];

for (const seed of DEMO_SEEDS) {
  process.stderr.write(`\r  rendering ${seed}...      `);
  const r = renderTrack({ seed, preset, ranges, sampleRate: SR });
  const loud = analyseLoudness(r.audio, r.plan.sections);
  // take the excerpt from the loudest moment, backed off so it starts on a bar
  const spb = r.plan.samplesPerBar / SR;
  const startBar = Math.max(0, Math.round((loud.loudestAtSeconds - 2) / spb));
  const from = startBar * spb;
  const clip = excerpt(r.audio, from, EXCERPT_SECONDS);
  writeFileSync(join(OUT, `${seed}.wav`), encodeWav(clip, 16));
  const fromSample = Math.round(from * SR);
  const section = r.plan.sections.find(
    (sec) => fromSample >= sec.startSample && fromSample < sec.endSample,
  );
  tracks.push({
    seed,
    file: `${seed}.mp3`,
    peaks: tracks.length === 0 ? peakEnvelope(clip, 220) : [],
    fromSection: section ? section.name : "drop",
    tempo: Number(r.plan.tempo.toFixed(1)),
    key: `${NOTE_NAMES[r.plan.harmony.tonicMidi % 12]} ${r.plan.harmony.scaleName.replace(/([A-Z])/g, " $1").toLowerCase().trim()}`,
    form: r.plan.arrangement.templateName,
    bars: r.plan.bars,
    lengthSeconds: Number((r.plan.totalSamples / SR).toFixed(1)),
    dropRmsDb: Number(loud.dropRmsDb.toFixed(2)),
    crestDb: Number(loud.crestDb.toFixed(1)),
    excerptSeconds: EXCERPT_SECONDS,
  });
}
process.stderr.write("\r" + " ".repeat(40) + "\r");

writeFileSync(join(OUT, "saw.wav"), encodeWav(sawClip(), 16));
writeFileSync(join(OUT, "bass808.wav"), encodeWav(bass808Clip(), 16));

const manifest = {
  tracks,
  clips: [
    {
      id: "saw",
      file: "saw.mp3",
      title: "A sawtooth, and the one line that makes it usable",
      blurb:
        "A naive sawtooth is one subtraction, and it aliases: as the pitch sweeps up you hear a second tone sliding down through it. PolyBLEP corrects the waveform at the discontinuity. The same sweep twice — correction off for three seconds, then on. At the top of the sweep the corrected version measures 28.6 dB cleaner.",
      source: "core/osc.ts",
      code: extract("core/osc.ts", "next(): number {", 10, ["polyBlep", "this.phase"]),
      stages: [
        // the first stage highlights nothing on purpose: the point is that
        // the highlighted line is the entire difference
        { at: 0, until: 3, label: "the same code with polyBlep removed — listen for the tone sliding down", line: -1 },
        { at: 3, until: 6, label: "this one line is the whole difference", line: 3 },
      ],
    },
    {
      id: "bass808",
      file: "bass808.mp3",
      title: "An 808, one element at a time",
      blurb:
        "Four notes. Each one turns on one more part of the voice, so you can hear what each line is responsible for.",
      source: "core/bass808.ts",
      code: extract("core/bass808.ts", "const f = this.currentHz + this.dropRange * this.dropEnv;", 18, [
        "sinTurns",
        "softClip",
        "subLp",
      ]),
      stages: [
        { at: 0, until: 1.6, label: "a sine at the note", line: 12 },
        { at: 1.6, until: 3.2, label: "plus the pitch drop into it", line: 0 },
        { at: 3.2, until: 4.8, label: "plus saturation, for harmonics a phone can reproduce", line: 13 },
        { at: 4.8, until: 6.4, label: "plus a clean parallel sub, never driven", line: 16 },
      ],
    },
  ],
};
writeFileSync(join(OUT, "demos.json"), JSON.stringify(manifest, null, 2));

console.log(`web/demos/  ${tracks.length} track excerpts + ${manifest.clips.length} code clips (WAV)`);
console.log(`next: encode to mp3 with tools/encode-demos.sh`);
