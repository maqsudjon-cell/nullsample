/**
 * Render one seed to a WAV file.
 *
 *   npm run render -- --preset hyperpop --seed 42 --out track.wav
 *   npm run render -- --seed 42 --darker 0.5 --harder -0.3
 */

import { writeFileSync } from "node:fs";
import { getPreset } from "../presets/index.ts";
import { renderTrack } from "../render/track.ts";
import { encodeWav } from "../render/wav.ts";
import { bool, num, parseArgs, str, words } from "./args.ts";

const args = parseArgs(process.argv.slice(2));
const presetName = str(args, "preset", "hyperpop");
const seed = str(args, "seed", "1");
const out = str(args, "out", `track-${seed}.wav`);
const sampleRate = num(args, "rate", 44100);
const quiet = bool(args, "quiet");

const { preset, ranges } = getPreset(presetName);
const started = Date.now();
const result = renderTrack({
  seed,
  preset,
  ranges,
  sampleRate,
  words: words(args),
  onProgress: quiet
    ? undefined
    : (f, label) => process.stderr.write(`\r  ${(f * 100).toFixed(0).padStart(3)}%  ${label.padEnd(10)}`),
});
const elapsed = Date.now() - started;
if (!quiet) process.stderr.write("\r" + " ".repeat(30) + "\r");

writeFileSync(out, encodeWav(result.audio, 16));

const p = result.plan;
const noteName = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][p.harmony.tonicMidi % 12];
console.log(`${out}`);
console.log(`  seed ${p.seed}  preset ${p.presetName}`);
console.log(`  ${p.tempo.toFixed(1)} BPM  ${noteName} ${p.harmony.scaleName}  ${p.arrangement.templateName}  ${p.bars} bars  ${result.stats.durationSeconds.toFixed(1)} s`);
console.log(`  sections: ${p.arrangement.sections.map((s) => `${s.name}(${s.bars})`).join(" ")}`);
console.log(`  peak ${result.stats.peakDb.toFixed(2)} dBFS  rms ${result.stats.rmsDb.toFixed(2)} dBFS  crest ${(result.stats.peakDb - result.stats.rmsDb).toFixed(1)} dB`);
const peaks = Object.entries(result.stats.busPeaks)
  .map(([k, v]) => `${k} ${(20 * Math.log10(v + 1e-12)).toFixed(1)}`)
  .join("  ");
console.log(`  bus peaks (dBFS): ${peaks}`);
console.log(`  rendered in ${(elapsed / 1000).toFixed(2)} s  (${(result.stats.durationSeconds / (elapsed / 1000)).toFixed(1)}x realtime)`);
