/**
 * Publishes a batch of drum loops to /rate for M5.
 *
 *   npm run drumbatch -- --count 50 --base d --publish
 *
 * M5 stalled because rating a two-minute track takes two minutes. An eight-bar
 * loop is judged in fifteen seconds, and the drums bus is shared - so tuning
 * drums through this loop improves the full tracks too, because both surfaces
 * build the kit with the same `sampleDrumKit`.
 *
 * Writes the same two artefacts as the track batch: `batch.json` with every
 * sampled parameter (what narrow and tune correlate against) and a /rate
 * manifest. The audio is not committed; the manifest carries the ranges it was
 * rendered from so the deploy can rebuild it byte-identically.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPreset } from "../presets/index.ts";
import { makeRng } from "../core/rng.ts";
import { renderDrumLoop } from "../render/drumloop.ts";
import { encodeWav } from "../render/wav.ts";
import type { Stereo } from "../core/buffer.ts";
import type { RangesFile } from "../presets/types.ts";
import { bool, num, parseArgs, str } from "./args.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const args = parseArgs(process.argv.slice(2));
const count = Math.max(1, Math.round(num(args, "count", 50)));
const base = str(args, "base", "d");
const outDir = str(args, "out", "./batch-drums");
const publish = bool(args, "publish");
const rebuild = bool(args, "rebuild");
const BARS = 8 as const;
const REPEATS = 3;

const { preset, ranges } = getPreset("hyperpop");
const pubDir = join(ROOT, "web", "rate", "batch");

function mp3(buf: Stereo, path: string): void {
  execFileSync("lame", ["-b", "160", "-h", "--quiet", "-", path], { input: encodeWav(buf, 16) });
}

/** A loop's tempo is drawn from the preset's own tempo range, per seed. */
function tempoFor(seed: string, r: RangesFile): number {
  const t = r.params["tempo"] ?? { min: 140, max: 170 };
  const lo = Math.max(80, t.min);
  const hi = Math.min(180, t.max);
  return Math.round(lo + (hi - lo) * makeRng(seed).child("drumbatch").child("bpm").float());
}

if (rebuild) {
  const m = JSON.parse(readFileSync(join(pubDir, "manifest.json"), "utf8"));
  if (m.kind !== "drums") {
    console.error("manifest is not a drum batch");
    process.exit(1);
  }
  for (const t of m.tracks) {
    if (t.repeatOf || existsSync(join(pubDir, t.excerpt))) continue;
    const loop = renderDrumLoop({ seed: t.seed, preset, ranges: m.ranges, bpm: t.bpm, bars: BARS });
    mp3(loop.audio, join(pubDir, t.excerpt));
  }
  console.log(`rebuilt ${m.batchId}`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
if (publish) {
  rmSync(pubDir, { recursive: true, force: true });
  mkdirSync(pubDir, { recursive: true });
}

const records = [];
const tracks: { id: string; seed: string; excerpt: string; full: string; explore: boolean; bpm: number; repeatOf?: string }[] = [];
const started = Date.now();
for (let i = 0; i < count; i++) {
  const seed = `${base}${String(i + 1).padStart(4, "0")}`;
  const bpm = tempoFor(seed, ranges);
  const loop = renderDrumLoop({ seed, preset, ranges, bpm, bars: BARS });
  records.push({
    seed, file: "", tempo: bpm, key: "-", scale: "-", arrangement: "drum loop", bars: BARS,
    durationSeconds: loop.audio.length / loop.audio.sampleRate,
    dropRmsDb: 0, integratedRmsDb: 0, truePeakDb: -1, peakDb: -1, crestDb: 0, overCompressed: false,
    monoLossDb: [], monoLossBroadbandDb: 0, bandCorrelation: [], monoFlags: [],
    params: loop.params, choices: {},
  });
  if (publish) {
    const id = `d${String(i + 1).padStart(4, "0")}`;
    mp3(loop.audio, join(pubDir, `${id}.mp3`));
    tracks.push({ id, seed, excerpt: `${id}.mp3`, full: `${id}.mp3`, explore: false, bpm });
  }
  process.stderr.write(`\r  ${i + 1}/${count}  ${seed}  ${bpm} BPM   `);
}
process.stderr.write("\r" + " ".repeat(40) + "\r");

writeFileSync(join(outDir, "batch.json"), JSON.stringify({
  preset: "hyperpop", rangesVersion: ranges.version, count, createdBySeedBase: base, records,
}, null, 2));

if (publish) {
  const pick = makeRng(`repeats:${base}:${count}`).child("repeats");
  const chosen = pick.shuffle(tracks.map((_, i) => i)).slice(0, Math.min(REPEATS, tracks.length));
  for (let r = 0; r < chosen.length; r++) {
    const src = tracks[chosen[r]];
    tracks.push({ ...src, id: `r${String(r + 1).padStart(2, "0")}`, repeatOf: src.id });
  }
  const manifest = {
    batchId: `${base}-drums-${ranges.version}-${count}`,
    kind: "drums",
    preset: "hyperpop",
    rangesVersion: ranges.version,
    createdAt: new Date().toISOString(),
    ranges,
    tracks,
  };
  writeFileSync(join(pubDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  let bytes = 0;
  for (const f of readdirSync(pubDir)) bytes += statSync(join(pubDir, f)).size;
  console.log(`published ${tracks.length} entries (${count} loops + ${chosen.length} repeats), ${(bytes / 1048576).toFixed(1)} MB`);
  console.log(`  batch ${manifest.batchId}`);
}
console.log(`${count} loops in ${((Date.now() - started) / 1000).toFixed(0)} s -> ${outDir}/batch.json`);
