/**
 * Stem export.
 *
 *   npm run stems -- --seed 42 --out stems-42.zip
 *
 * Each bus is re-rendered in isolation. Because the engine is deterministic,
 * a stem is exactly the contribution that bus made to the mix, including the
 * reverb and delay it fed.
 */

import { writeFileSync } from "node:fs";
import { BUS_NAMES } from "../compose/arrange.ts";
import { getPreset } from "../presets/index.ts";
import { renderStem } from "../render/track.ts";
import { encodeWav } from "../render/wav.ts";
import { makeZip, type ZipEntry } from "../render/zip.ts";
import { num, parseArgs, str, words } from "./args.ts";

const args = parseArgs(process.argv.slice(2));
const presetName = str(args, "preset", "hyperpop");
const seed = str(args, "seed", "1");
const out = str(args, "out", `stems-${seed}.zip`);
const sampleRate = num(args, "rate", 44100);
const { preset, ranges } = getPreset(presetName);

const entries: ZipEntry[] = [];
for (const bus of BUS_NAMES) {
  process.stderr.write(`\r  rendering ${bus}...        `);
  const r = renderStem({ seed, preset, ranges, sampleRate, words: words(args) }, bus);
  entries.push({ name: `${seed}-${bus}.wav`, data: encodeWav(r.audio, 16) });
}
process.stderr.write("\r" + " ".repeat(40) + "\r");

const zip = makeZip(entries);
writeFileSync(out, zip);
console.log(`${out}  (${(zip.length / 1048576).toFixed(1)} MB)`);
for (const e of entries) console.log(`  ${e.name}  ${(e.data.length / 1048576).toFixed(1)} MB`);
