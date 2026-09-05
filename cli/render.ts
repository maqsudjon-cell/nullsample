/**
 * Render one seed to a WAV file.
 *
 *   npm run render -- --preset hyperpop --seed 42 --out track.wav
 *   npm run render -- --seed 42 --darker 0.5 --harder -0.3
 */

import { writeFileSync } from "node:fs";
import { getPreset } from "../presets/index.ts";
import { analyseLoudness, CREST_FLOOR_DB } from "../render/loudness.ts";
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
const loud = analyseLoudness(result.audio, p.sections);
console.log(`  drop rms ${loud.dropRmsDb.toFixed(2)} dBFS (target -7 to -8, loudest 3 s at ${loud.loudestAtSeconds.toFixed(1)} s)`);
console.log(`  true peak ${loud.truePeakDb.toFixed(2)} dBTP  crest ${loud.crestDb.toFixed(1)} dB${loud.overCompressed ? `  OVER-COMPRESSED (under ${CREST_FLOOR_DB} dB)` : ""}`);
console.log(`  integrated rms ${loud.integratedRmsDb.toFixed(2)} dBFS (information only, no target)`);
const peaks = Object.entries(result.stats.busPeaks)
  .map(([k, v]) => `${k} ${(20 * Math.log10(v + 1e-12)).toFixed(1)}`)
  .join("  ");
console.log(`  bus peaks (dBFS): ${peaks}`);
console.log(`  rendered in ${(elapsed / 1000).toFixed(2)} s  (${(result.stats.durationSeconds / (elapsed / 1000)).toFixed(1)}x realtime)`);
