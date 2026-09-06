/**
 * Parameter audit.
 *
 *   npm run audit
 *   npm run audit -- --seed 42 --json audit.json
 *
 * lead.voices was inert from the day it was written: {min:7, max:9, step:2}
 * rounds every draw to 8, so a parameter identified as the likely largest
 * contributor to level spread had never varied at all. This finds the others.
 *
 * For every parameter it renders the same seed twice - once with that
 * parameter pinned to its minimum, once to its maximum, everything else held -
 * and measures what actually changed.
 *
 * It renders a WINDOW rather than whole tracks. 130 parameters at two full
 * renders each is over an hour; a seven-second window spanning the transition
 * into the first drop covers every bus, the transition effects and the master,
 * and brings the whole audit under ten minutes.
 */

import { writeFileSync } from "node:fs";
import { createStereo, type Stereo } from "../core/buffer.ts";
import { getPreset } from "../presets/index.ts";
import type { RangesFile } from "../presets/types.ts";
import { buildPlan } from "../render/plan.ts";
import { TrackRenderer } from "../render/track.ts";
import { analyse, maxBandDelta, BAND_NAMES, type Spectrum } from "./analysis.ts";
import { num, parseArgs, str } from "./args.ts";

const args = parseArgs(process.argv.slice(2));
const presetName = str(args, "preset", "hyperpop");
const SEED = str(args, "seed", "AUDIT-226");
const SR = num(args, "rate", 44100);
const jsonOut = str(args, "json", "");

/** Thresholds, in dB of band change. */
const INERT = 0.05;
const NEGLIGIBLE = 0.3;
const VIOLENT = 12;

/** Parameters that reshape the whole arrangement, so a fixed window is not comparable. */
const STRUCTURAL = new Set(["tempo", "barsPerChord"]);

/**
 * Which source a parameter controls, so the audit can tell "this parameter does
 * nothing" from "this parameter's source is not playing in the window I chose".
 *
 * Without this the tool reports an artefact as a bug: every `arp.*` parameter
 * measures zero in a drop that has no arp, which looks exactly like a dead
 * parameter and is not one. The default seed is chosen so that every bus and
 * every drum voice sounds inside the window; the check exists so that a
 * different seed cannot quietly reintroduce the artefact.
 */
function sourceOf(key: string): string {
  if (key.startsWith("drums.")) {
    const voice = key.split(".")[1];
    const voices = ["kick", "snare", "clap", "hat", "rim"];
    return voices.includes(voice) ? `drum:${voice}` : "bus:drums";
  }
  if (key.startsWith("bass.")) return "bus:bass808";
  if (key.startsWith("lead.")) {
    // Architecture-specific parameters only exist for the architecture that
    // drew them. Without this they read as dead on a seed that picked a
    // different lead - the same artefact the bus coverage check exists for.
    if (key === "lead.pulseWidthCentre" || key === "lead.pulseWidthDepth") return "arch:pulseStack";
    if (key === "lead.syncRatio") return "arch:syncSaw";
    if (key === "lead.fmRatio" || key === "lead.fmIndex") return "arch:fmPair";
    return "bus:lead";
  }
  if (key.startsWith("arp.")) return "bus:arp";
  if (key.startsWith("pads.")) return "bus:pads";
  if (key.startsWith("fx.")) return "bus:fx";
  return "global";
}

const { preset, ranges } = getPreset(presetName);

/**
 * Renders the window around the first drop. The renderer streams from zero, so
 * reaching bar 24 means rendering bars 0-24 anyway; that is the cost, and it
 * is still an order of magnitude cheaper than two full tracks per parameter.
 */
function windowOf(plan: ReturnType<typeof buildPlan>): { from: number; until: number } {
  const drop = plan.sections.find((s) => s.intensity >= 0.9) ?? plan.sections[0];
  // from two seconds before the drop, through five seconds of it
  return {
    from: Math.max(0, drop.startSample - 2 * SR),
    until: Math.min(plan.totalSamples, drop.startSample + 5 * SR),
  };
}

function renderWindow(overrides: Record<string, { min: number; max: number }>): Stereo {
  const r2: RangesFile = JSON.parse(JSON.stringify(ranges));
  for (const [k, v] of Object.entries(overrides)) {
    if (r2.params[k]) r2.params[k] = { ...r2.params[k], min: v.min, max: v.max };
  }
  const plan = buildPlan({ seed: SEED, preset, ranges: r2, sampleRate: SR });
  const { from, until } = windowOf(plan);

  const renderer = new TrackRenderer({ seed: SEED, preset, ranges: r2, sampleRate: SR });
  const chunk = renderer.chunkSize;
  const L = new Float32Array(chunk);
  const R = new Float32Array(chunk);
  const out = createStereo(until - from, SR);
  while (!renderer.done && renderer.position < until) {
    const start = renderer.position;
    const count = renderer.next(L, R);
    if (count === 0) break;
    for (let i = 0; i < count; i++) {
      const abs = start + i;
      if (abs >= from && abs < until) {
        out.L[abs - from] = L[i];
        out.R[abs - from] = R[i];
      }
    }
  }
  return out;
}

interface Row {
  key: string;
  min: number;
  max: number;
  structural: boolean;
  rmsDelta: number;
  crestDelta: number;
  corrDelta: number;
  /** largest single-sample difference between the two renders */
  sampleDelta: number;
  maxBand: number;
  worstBandName: string;
  klass: "dead" | "inert" | "negligible" | "normal" | "violent" | "unexercised";
  /** the bus or drum voice this parameter controls */
  source: string;
}

function compare(a: Spectrum, b: Spectrum): { maxBand: number; worst: string } {
  let m = 0;
  let idx = 0;
  for (let i = 0; i < a.bandsDb.length; i++) {
    const d = Math.abs(a.bandsDb[i] - b.bandsDb[i]);
    if (d > m) {
      m = d;
      idx = i;
    }
  }
  return { maxBand: m, worst: BAND_NAMES[idx] };
}

// --- coverage -----------------------------------------------------------
const coveragePlan = buildPlan({ seed: SEED, preset, ranges, sampleRate: SR });
const cov = windowOf(coveragePlan);
const inWindow = (at: number) => at >= cov.from && at < cov.until;
const sounding = new Set<string>(["global"]);
for (const e of coveragePlan.drumEvents) {
  if (inWindow(e.at)) {
    sounding.add("bus:drums");
    sounding.add(`drum:${e.voice.replace(/^hat.*/, "hat")}`);
  }
}
for (const n of coveragePlan.bassNotes) if (inWindow(n.start)) sounding.add("bus:bass808");
for (const n of coveragePlan.leadNotes) if (inWindow(n.start)) sounding.add("bus:lead");
for (const n of coveragePlan.arpNotes) if (inWindow(n.start)) sounding.add("bus:arp");
for (const c of coveragePlan.padChords) if (inWindow(c.start)) sounding.add("bus:pads");
for (const f of coveragePlan.fxEvents) if (f.start < cov.until && f.start + f.length > cov.from) sounding.add("bus:fx");
if (sounding.has("bus:lead")) sounding.add(`arch:${coveragePlan.lead.architecture}`);

const keys = Object.keys(ranges.params);
const rows: Row[] = [];
const started = Date.now();

for (let i = 0; i < keys.length; i++) {
  const key = keys[i];
  const spec = ranges.params[key];
  const source = sourceOf(key);
  if (spec.min === spec.max) {
    rows.push({
      key, min: spec.min, max: spec.max, structural: STRUCTURAL.has(key),
      rmsDelta: 0, crestDelta: 0, corrDelta: 0, sampleDelta: 0, maxBand: 0,
      worstBandName: "-", klass: "dead", source,
    });
    continue;
  }
  if (!sounding.has(source)) {
    // Its source does not play in this window, so a zero here means nothing.
    rows.push({
      key, min: spec.min, max: spec.max, structural: STRUCTURAL.has(key),
      rmsDelta: 0, crestDelta: 0, corrDelta: 0, sampleDelta: 0, maxBand: 0,
      worstBandName: "-", klass: "unexercised", source,
    });
    continue;
  }
  const loBuf = renderWindow({ [key]: { min: spec.min, max: spec.min } });
  const hiBuf = renderWindow({ [key]: { min: spec.max, max: spec.max } });
  // Sample-level difference decides "dead". A band delta can round to zero on
  // a source buried 40 dB under the mix while the waveform plainly differs;
  // only an identical waveform proves the parameter changed nothing.
  let sampleDelta = 0;
  for (let j = 0; j < loBuf.L.length; j++) {
    const dl = Math.abs(loBuf.L[j] - hiBuf.L[j]);
    if (dl > sampleDelta) sampleDelta = dl;
    const dr = Math.abs(loBuf.R[j] - hiBuf.R[j]);
    if (dr > sampleDelta) sampleDelta = dr;
  }
  const lo = analyse(loBuf);
  const hi = analyse(hiBuf);
  const { maxBand, worst } = compare(lo, hi);
  const rmsDelta = Math.abs(hi.rmsDb - lo.rmsDb);
  const crestDelta = Math.abs(hi.crestDb - lo.crestDb);
  const corrDelta = Math.abs(hi.stereoCorrelation - lo.stereoCorrelation);
  const worstOverall = Math.max(maxBand, rmsDelta);

  let klass: Row["klass"];
  // Bit-identical output is a different finding from "changes the audio by a
  // hundredth of a decibel". The first is a wiring bug; the second is a range
  // that is too narrow to matter. Reporting them together sends the reader
  // looking for bugs that are not there.
  if (sampleDelta === 0) klass = "dead";
  else if (worstOverall < INERT && corrDelta < 0.002) klass = "inert";
  else if (worstOverall < NEGLIGIBLE && corrDelta < 0.02) klass = "negligible";
  else if (worstOverall > VIOLENT) klass = "violent";
  else klass = "normal";

  rows.push({
    key, min: spec.min, max: spec.max, structural: STRUCTURAL.has(key),
    rmsDelta: Number(rmsDelta.toFixed(3)),
    crestDelta: Number(crestDelta.toFixed(3)),
    corrDelta: Number(corrDelta.toFixed(4)),
    sampleDelta,
    maxBand: Number(maxBand.toFixed(3)),
    worstBandName: worst,
    klass,
    source,
  });
  const done = i + 1;
  const eta = ((Date.now() - started) / done) * (keys.length - done) / 1000;
  process.stderr.write(`\r  ${done}/${keys.length}  ${key.padEnd(28)} eta ${eta.toFixed(0)}s      `);
}
process.stderr.write("\r" + " ".repeat(70) + "\r");

rows.sort((a, b) => Math.max(b.maxBand, b.rmsDelta) - Math.max(a.maxBand, a.rmsDelta));

const byClass = (k: Row["klass"]) => rows.filter((r) => r.klass === k);
const line = (r: Row) =>
  `  ${r.key.padEnd(28)} ${r.min.toString().padStart(8)} .. ${r.max.toString().padEnd(9)}` +
  `${r.maxBand.toFixed(2).padStart(7)} dB ${r.worstBandName.padStart(10)}` +
  `${r.rmsDelta.toFixed(2).padStart(8)} dB rms${r.corrDelta.toFixed(3).padStart(8)} corr` +
  (r.structural ? "   [structural]" : "");

console.log(`parameter audit - ${presetName}, seed ${SEED}, ${keys.length} parameters\n`);
console.log(`  ${"parameter".padEnd(28)} ${"range".padStart(8)}    ${"".padEnd(9)}${"max band".padStart(10)} ${"where".padStart(10)}${"rms".padStart(11)}${"stereo".padStart(13)}`);

for (const [title, klass, note] of [
  ["DEAD - min and max produce bit-identical audio. Each one is a bug.", "dead",
   "The value reaches the plan and changes nothing: it is never read, or a stage upstream makes it unreachable."],
  ["INERT - under 0.05 dB in every band. Real, but below anything a listener could use.", "inert",
   ""],
  ["VIOLENT - the range spans good and unusable audio. Narrow these first in M5.", "violent", ""],
  ["NEGLIGIBLE - real but under 0.3 dB in every band. Widen or delete; do not tune.", "negligible", ""],
  ["NOT EXERCISED - source silent in this window. Not a verdict; re-run on a seed that plays it.", "unexercised", ""],
] as const) {
  const set = byClass(klass);
  console.log(`\n${title}`);
  if (note) console.log(`  ${note}`);
  if (set.length === 0) console.log("  (none)");
  for (const r of set) console.log(line(r));
}

console.log(`\nNORMAL - ${byClass("normal").length} parameters, top 12 by effect:`);
for (const r of byClass("normal").slice(0, 12)) console.log(line(r));

console.log(`\nsummary: ${byClass("dead").length} dead, ${byClass("inert").length} inert, ${byClass("negligible").length} negligible, ` +
  `${byClass("normal").length} normal, ${byClass("violent").length} violent, ` +
  `${byClass("unexercised").length} not exercised`);
console.log(`window: ${(cov.from / SR).toFixed(1)}-${(cov.until / SR).toFixed(1)} s; sounding: ` +
  [...sounding].filter((x) => x !== "global").sort().join(" "));
console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(0)} s`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ preset: presetName, seed: SEED, rows }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
