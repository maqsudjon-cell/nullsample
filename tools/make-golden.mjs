#!/usr/bin/env node
/**
 * Regenerates the golden hashes.
 *
 * Run this ONLY when the engine has intentionally changed how it sounds, and
 * say so in the commit. A golden test that gets regenerated whenever it fails
 * is not a test.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { getPreset } from "../presets/index.ts";
import { renderTrack } from "../render/track.ts";
import { encodeWav } from "../render/wav.ts";

const SEEDS = ["12345", "hello", "7"];
const { preset, ranges } = getPreset("hyperpop");
const out = { preset: "hyperpop", rangesVersion: ranges.version, sampleRate: 44100, tracks: {} };

for (const seed of SEEDS) {
  const r = renderTrack({ seed, preset, ranges, sampleRate: 44100 });
  const bytes = encodeWav(r.audio, 16);
  const hash = createHash("sha256").update(bytes).digest("hex");
  out.tracks[seed] = {
    sha256: hash,
    bytes: bytes.length,
    bars: r.plan.bars,
    tempo: r.plan.tempo,
    peakDb: Number(r.stats.peakDb.toFixed(4)),
    rmsDb: Number(r.stats.rmsDb.toFixed(4)),
  };
  console.log(`${seed}  ${hash.slice(0, 16)}...  ${bytes.length} bytes  ${r.plan.tempo.toFixed(1)} BPM`);
}
const path = new URL("../test/golden/hashes.json", import.meta.url).pathname;
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${path}`);
