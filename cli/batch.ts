/**
 * Batch renderer.
 *
 *   npm run batch -- --preset hyperpop --count 50 --out ./batch
 *
 * Writes one WAV per seed plus a JSON record of every parameter value that was
 * sampled for it. The records are what `narrow` correlates against ratings;
 * a parameter that is not recorded cannot be tuned.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPreset } from "../presets/index.ts";
import { renderTrack } from "../render/track.ts";
import { encodeWav } from "../render/wav.ts";
import { num, parseArgs, str } from "./args.ts";

export interface BatchRecord {
  seed: string;
  file: string;
  tempo: number;
  key: string;
  scale: string;
  arrangement: string;
  bars: number;
  durationSeconds: number;
  peakDb: number;
  rmsDb: number;
  params: Record<string, number>;
  choices: Record<string, string>;
}

export interface BatchIndex {
  preset: string;
  rangesVersion: number;
  count: number;
  createdBySeedBase: string;
  records: BatchRecord[];
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const args = parseArgs(process.argv.slice(2));
const presetName = str(args, "preset", "hyperpop");
const count = Math.max(1, Math.round(num(args, "count", 50)));
const outDir = str(args, "out", "./batch");
const base = str(args, "base", "b");
const sampleRate = num(args, "rate", 44100);

const { preset, ranges } = getPreset(presetName);
mkdirSync(outDir, { recursive: true });

const records: BatchRecord[] = [];
const started = Date.now();

for (let i = 0; i < count; i++) {
  const seed = `${base}${String(i + 1).padStart(4, "0")}`;
  const result = renderTrack({ seed, preset, ranges, sampleRate });
  const file = `track-${String(i + 1).padStart(4, "0")}.wav`;
  writeFileSync(join(outDir, file), encodeWav(result.audio, 16));
  const p = result.plan;
  records.push({
    seed,
    file,
    tempo: p.tempo,
    key: NOTE_NAMES[p.harmony.tonicMidi % 12],
    scale: p.harmony.scaleName,
    arrangement: p.arrangement.templateName,
    bars: p.bars,
    durationSeconds: result.stats.durationSeconds,
    peakDb: result.stats.peakDb,
    rmsDb: result.stats.rmsDb,
    params: p.params,
    choices: p.choices,
  });
  const elapsed = (Date.now() - started) / 1000;
  const eta = (elapsed / (i + 1)) * (count - i - 1);
  process.stderr.write(
    `\r  ${i + 1}/${count}  ${seed}  ${p.tempo.toFixed(0)} BPM  eta ${eta.toFixed(0)}s   `,
  );
}
process.stderr.write("\r" + " ".repeat(60) + "\r");

const index: BatchIndex = {
  preset: presetName,
  rangesVersion: ranges.version,
  count,
  createdBySeedBase: base,
  records,
};
writeFileSync(join(outDir, "batch.json"), JSON.stringify(index, null, 2));

console.log(`${count} tracks -> ${outDir}`);
console.log(`  index: ${join(outDir, "batch.json")}`);
console.log(`  total ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`\nnext:  npm run sheet -- ${outDir}`);
