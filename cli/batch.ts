/**
 * Batch renderer.
 *
 *   npm run batch -- --preset hyperpop --count 50 --out ./batch
 *
 * Writes one WAV per seed plus a JSON record of every parameter value that was
 * sampled for it. The records are what `narrow` correlates against ratings;
 * a parameter that is not recorded cannot be tuned.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Encodes a buffer to MP3 with `lame`.
 *
 * A build-time tool, not a project dependency: the engine and the site never
 * touch it, and nothing about determinism depends on it - the WAV the engine
 * produces is the deterministic artefact, and this is a listening copy.
 */
function encodeMp3(buf: Stereo, outPath: string, bitrate: number): void {
  const wav = encodeWav(buf, 16);
  execFileSync("lame", ["-b", String(bitrate), "-h", "--quiet", "-", outPath], { input: wav });
}
import { getPreset } from "../presets/index.ts";
import { analyseLoudness } from "../render/loudness.ts";
import { renderTrack } from "../render/track.ts";
import { encodeWav } from "../render/wav.ts";
import { makeRng } from "../core/rng.ts";
import type { Stereo } from "../core/buffer.ts";
import type { RangesFile } from "../presets/types.ts";
import { analyse, BAND_EDGES } from "./analysis.ts";
import { bool, num, parseArgs, str } from "./args.ts";

export interface BatchRecord {
  seed: string;
  file: string;
  tempo: number;
  key: string;
  scale: string;
  arrangement: string;
  bars: number;
  durationSeconds: number;
  /** Maximum short-term RMS inside the drops. The number with a target. */
  dropRmsDb: number;
  /** Whole-file RMS. Information only — it averages the quiet sections in. */
  integratedRmsDb: number;
  truePeakDb: number;
  peakDb: number;
  crestDb: number;
  overCompressed: boolean;
  /**
   * Level change per band when summed to mono, measured over the loudest drop.
   * 0 is already mono, -3.01 dB is the floor for two fully decorrelated
   * channels, and below about -4 dB the channels are cancelling.
   */
  monoLossDb: number[];
  monoLossBroadbandDb: number;
  /** stereo correlation per band, same window */
  bandCorrelation: number[];
  /** bands losing more than 3 dB in mono */
  monoFlags: string[];
  params: Record<string, number>;
  choices: Record<string, string>;
}

/** One entry in the manifest the phone reads. */
export interface RateTrack {
  /** opaque id; the phone never sees the seed */
  id: string;
  seed: string;
  excerpt: string;
  full: string;
  /**
   * Set when this entry is a silent repeat of another. The rater cannot tell,
   * and disagreement between the two is what says whether a session is signal
   * or noise.
   */
  repeatOf?: string;
  /**
   * Drawn from the original uniform ranges rather than the learned weights.
   * Marked internally, never in the interface: these are the tracks that catch
   * the tuning loop being wrong.
   */
  explore: boolean;
}

export interface RateManifest {
  batchId: string;
  preset: string;
  rangesVersion: number;
  createdAt: string;
  /**
   * The exact ranges these tracks were rendered from.
   *
   * Carried here so the audio can be rebuilt byte-identically at any later
   * point, whatever the ranges file has moved on to. That is what lets the
   * MP3s stay out of git: a batch is ~137 MB at fifty tracks, replacing it
   * every cycle does not reclaim the history, and ten cycles would be a
   * gigabyte of audio that is fully regenerable from about 30 KB of JSON.
   */
  ranges: RangesFile;
  /** rating order is shuffled per session from a session seed, not here */
  tracks: RateTrack[];
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
const publish = bool(args, "publish");
const rebuild = bool(args, "rebuild");
/** Fraction of a batch drawn from the untouched uniform ranges. */
const EXPLORE_FRACTION = 0.2;
/** Silent repeats inserted per batch, to measure a session's self-agreement. */
const REPEATS = 3;
/** Seconds of excerpt: the approach to the drop plus its body. */
const EXCERPT_SECONDS = 45;
const EXCERPT_LEAD_IN = 8;

const { preset, ranges } = getPreset(presetName);

/**
 * The ranges with every learned weight curve stripped, for exploration draws.
 *
 * Reweighting steers the engine; it must never trap it. A fifth of each batch
 * ignores the weights entirely, so a region the loop has learned to avoid
 * still gets rendered and still gets rated, and a wrong verdict can be
 * corrected by evidence rather than only by hand.
 */
function uniformRanges(src: typeof ranges): typeof ranges {
  const out = JSON.parse(JSON.stringify(src));
  for (const k of Object.keys(out.params)) delete out.params[k].weights;
  return out;
}
const explorationRanges = uniformRanges(ranges);
mkdirSync(outDir, { recursive: true });

const records: BatchRecord[] = [];
const started = Date.now();

if (rebuild) {
  // Re-renders exactly the audio a manifest describes, from the ranges the
  // manifest carries. Used by the deploy workflow, so the site can serve a
  // batch that was never committed.
  const dir2 = join(ROOT, "web", "rate", "batch");
  const mPath = join(dir2, "manifest.json");
  if (!existsSync(mPath)) {
    console.error("no manifest at web/rate/batch/manifest.json - nothing to rebuild");
    process.exit(1);
  }
  const m: RateManifest = JSON.parse(readFileSync(mPath, "utf8"));
  if (!m.ranges || !m.ranges.params) {
    console.error(
      `manifest ${m.batchId} carries no ranges snapshot, so its audio cannot be\n` +
      `reproduced. Re-publish the batch: npm run batch -- --count N --publish`,
    );
    process.exit(1);
  }
  const uniform = uniformRanges(m.ranges as typeof ranges);
  const started2 = Date.now();
  let n = 0;
  for (const t of m.tracks) {
    if (t.repeatOf) continue; // a repeat points at another entry's files
    if (existsSync(join(dir2, t.excerpt)) && existsSync(join(dir2, t.full))) continue;
    const res = renderTrack({
      seed: t.seed, preset, ranges: (t.explore ? uniform : m.ranges) as typeof ranges, sampleRate,
    });
    const p2 = res.plan;
    const drop = p2.sections.find((x) => x.intensity >= 0.9) ?? p2.sections[0];
    const from = Math.max(0, drop.startSample - EXCERPT_LEAD_IN * sampleRate);
    const len = Math.min(res.audio.length - from, EXCERPT_SECONDS * sampleRate);
    const clip: Stereo = {
      L: res.audio.L.subarray(from, from + len),
      R: res.audio.R.subarray(from, from + len),
      sampleRate,
      length: len,
    };
    encodeMp3(clip, join(dir2, t.excerpt), 128);
    encodeMp3(res.audio, join(dir2, t.full), 112);
    n++;
    process.stderr.write(`\r  rebuilt ${n}  ${t.id}   `);
  }
  process.stderr.write("\r" + " ".repeat(40) + "\r");
  console.log(`rebuilt ${n} track(s) for ${m.batchId} in ${((Date.now() - started2) / 1000).toFixed(0)} s`);
  process.exit(0);
}

/** Deterministic: every nth track explores, so a batch id fixes which ones. */
const isExplore = (i: number) =>
  EXPLORE_FRACTION > 0 && Math.floor(i * EXPLORE_FRACTION) !== Math.floor((i - 1) * EXPLORE_FRACTION);

const rateTracks: RateTrack[] = [];
const pubDir = join(ROOT, "web", "rate", "batch");
if (publish) {
  rmSync(pubDir, { recursive: true, force: true });
  mkdirSync(pubDir, { recursive: true });
}

for (let i = 0; i < count; i++) {
  const seed = `${base}${String(i + 1).padStart(4, "0")}`;
  const explore = isExplore(i);
  const result = renderTrack({
    seed, preset, ranges: explore ? explorationRanges : ranges, sampleRate,
  });
  const file = `track-${String(i + 1).padStart(4, "0")}.wav`;
  writeFileSync(join(outDir, file), encodeWav(result.audio, 16));
  const p = result.plan;
  const loud = analyseLoudness(result.audio, p.sections);

  // Mono compatibility is measured over the loudest drop, because that is
  // where the supersaw is widest and where a cancellation would cost the most.
  const drop = p.sections.find((x) => x.intensity >= 0.9) ?? p.sections[0];
  const mono = analyse(result.audio, drop.startSample, Math.min(8 * sampleRate, result.audio.length - drop.startSample));
  const monoFlags: string[] = [];
  for (let b = 0; b < mono.monoLossDb.length; b++) {
    if (mono.monoLossDb[b] < -3) monoFlags.push(`${BAND_EDGES[b]}-${BAND_EDGES[b + 1]}`);
  }

  records.push({
    seed,
    file,
    tempo: p.tempo,
    key: NOTE_NAMES[p.harmony.tonicMidi % 12],
    scale: p.harmony.scaleName,
    arrangement: p.arrangement.templateName,
    bars: p.bars,
    durationSeconds: result.stats.durationSeconds,
    dropRmsDb: loud.dropRmsDb,
    integratedRmsDb: loud.integratedRmsDb,
    truePeakDb: loud.truePeakDb,
    peakDb: loud.peakDb,
    crestDb: loud.crestDb,
    overCompressed: loud.overCompressed,
    monoLossDb: mono.monoLossDb,
    monoLossBroadbandDb: mono.monoLossBroadbandDb,
    bandCorrelation: mono.bandCorrelation,
    monoFlags,
    params: p.params,
    choices: p.choices,
  });
  if (publish) {
    const drop = p.sections.find((x) => x.intensity >= 0.9) ?? p.sections[0];
    const from = Math.max(0, drop.startSample - EXCERPT_LEAD_IN * sampleRate);
    const len = Math.min(result.audio.length - from, EXCERPT_SECONDS * sampleRate);
    const clip: Stereo = {
      L: result.audio.L.subarray(from, from + len),
      R: result.audio.R.subarray(from, from + len),
      sampleRate,
      length: len,
    };
    const id = `t${String(i + 1).padStart(4, "0")}`;
    encodeMp3(clip, join(pubDir, `${id}-x.mp3`), 128);
    encodeMp3(result.audio, join(pubDir, `${id}-f.mp3`), 112);
    rateTracks.push({ id, seed, excerpt: `${id}-x.mp3`, full: `${id}-f.mp3`, explore });
  }

  const elapsed = (Date.now() - started) / 1000;
  const eta = (elapsed / (i + 1)) * (count - i - 1);
  process.stderr.write(
    `\r  ${i + 1}/${count}  ${seed}  ${p.tempo.toFixed(0)} BPM  drop ${loud.dropRmsDb.toFixed(1)} dB  crest ${loud.crestDb.toFixed(1)}${loud.overCompressed ? "!" : " "} mono ${mono.monoLossBroadbandDb.toFixed(1)}${monoFlags.length > 0 ? "!" : " "}  eta ${eta.toFixed(0)}s   `,
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

if (publish) {
  // Three silent repeats. They are ordinary entries with their own ids, so the
  // rater cannot tell; only the manifest knows which track each one is.
  const pick = makeRng(`repeats:${base}:${count}`).child("repeats");
  const chosen = pick.shuffle(rateTracks.map((_, i) => i)).slice(0, Math.min(REPEATS, rateTracks.length));
  for (let r = 0; r < chosen.length; r++) {
    const src = rateTracks[chosen[r]];
    rateTracks.push({
      id: `r${String(r + 1).padStart(2, "0")}`,
      seed: src.seed,
      excerpt: src.excerpt,
      full: src.full,
      repeatOf: src.id,
      explore: src.explore,
    });
  }

  const manifest: RateManifest = {
    batchId: `${base}-${ranges.version}-${count}`,
    preset: presetName,
    rangesVersion: ranges.version,
    createdAt: new Date().toISOString(),
    ranges,
    tracks: rateTracks,
  };
  writeFileSync(join(pubDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  let bytes = 0;
  for (const f of readdirSync(pubDir)) bytes += statSync(join(pubDir, f)).size;
  console.log(`\npublished ${rateTracks.length} entries (${count} tracks + ${chosen.length} repeats)`);
  console.log(`  ${pubDir}  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  batch ${manifest.batchId}, ${rateTracks.filter((t) => t.explore).length} exploration draws`);
}

console.log(`${count} tracks -> ${outDir}`);
console.log(`  index: ${join(outDir, "batch.json")}`);
console.log(`  total ${((Date.now() - started) / 1000).toFixed(1)} s`);

// --- mono compatibility summary ------------------------------------------
// Phone and laptop speakers are mono, and every technique that makes this
// genre wide - supersaw spread, chorus, Haas - works by phase difference.
const bandCount = BAND_EDGES.length - 1;
console.log(`\nmono compatibility, mean over ${count} tracks, measured across the loudest drop:`);
console.log(`  0 dB = already mono, -3.01 dB = fully decorrelated (width, not a fault), below -4 dB = cancelling`);
let flagged = 0;
for (let b = 0; b < bandCount; b++) {
  let loss = 0;
  let corr = 0;
  let worst = 0;
  for (const r of records) {
    loss += r.monoLossDb[b];
    corr += r.bandCorrelation[b];
    if (r.monoLossDb[b] < worst) worst = r.monoLossDb[b];
  }
  loss /= count;
  corr /= count;
  const note = loss < -4 ? "  CANCELLING" : loss < -3 ? "  wide" : "";
  if (loss < -3) flagged++;
  console.log(
    `  ${`${BAND_EDGES[b]}-${BAND_EDGES[b + 1]}`.padStart(11)} Hz ` +
    `${loss.toFixed(2).padStart(7)} dB   corr ${corr.toFixed(3).padStart(6)}   worst ${worst.toFixed(2).padStart(7)} dB${note}`,
  );
}
const flaggedTracks = records.filter((r) => r.monoFlags.length > 0);
console.log(
  `  mean: ${flagged === 0 ? "no band past the 3 dB gate" : `${flagged} band(s) past the 3 dB gate`}` +
  `   per track: ${flaggedTracks.length === 0 ? "none flagged" : `${flaggedTracks.length}/${count} flagged`}`,
);
for (const r of flaggedTracks) {
  console.log(`    ${r.seed}  ${r.monoFlags.join(", ")} Hz`);
}
console.log(`\nnext:  npm run sheet -- ${outDir}`);
