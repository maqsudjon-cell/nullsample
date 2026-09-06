/**
 * Kick and 808 masking.
 *
 *   npm run masking -- --seeds 20
 *
 * Task F settled the level question: sub-band share does not correlate with
 * gain reduction. Masking is a different question. When the kick and the 808
 * land together, do their fundamentals occupy the same place? If they do, the
 * kick loses definition and the sub loses weight, and gain staging cannot fix
 * it.
 *
 * Method: render the drums and 808 stems separately, find the moments where a
 * kick and an 808 note start within a 16th of each other, and over a short
 * window after each one take the 30-120 Hz spectrum of both stems. Each is
 * normalised to unit energy, so what is compared is spectral SHAPE rather than
 * level, and the two are compared with the Bhattacharyya coefficient: 1 means
 * the two occupy exactly the same frequencies, 0 means they are disjoint.
 */

import { renderStem } from "../render/track.ts";
import { buildPlan } from "../render/plan.ts";
import { getPreset } from "../presets/index.ts";
import { midiToHz } from "../core/dmath.ts";
import { num, parseArgs, str } from "./args.ts";

const args = parseArgs(process.argv.slice(2));
const presetName = str(args, "preset", "hyperpop");
const seedCount = Math.max(1, Math.round(num(args, "seeds", 20)));
const base = str(args, "base", "m");
const SR = num(args, "rate", 44100);
const { preset, ranges } = getPreset(presetName);

const FFT_SIZE = 4096;
const LOW_HZ = 30;
const HIGH_HZ = 120;
const WINDOW = 4096;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const win = new Float64Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

const binHz = SR / FFT_SIZE;
const loBin = Math.max(1, Math.floor(LOW_HZ / binHz));
const hiBin = Math.ceil(HIGH_HZ / binHz);

/** Unit-energy 30-120 Hz magnitude shape of a mono window. */
function shape(L: Float32Array, R: Float32Array, from: number): Float64Array | undefined {
  if (from + FFT_SIZE > L.length) return undefined;
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) re[i] = (L[from + i] + R[from + i]) * 0.5 * win[i];
  fft(re, im);
  const out = new Float64Array(hiBin - loBin + 1);
  let total = 0;
  for (let k = loBin; k <= hiBin; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    out[k - loBin] = p;
    total += p;
  }
  if (total < 1e-18) return undefined;
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Bhattacharyya coefficient of two unit-energy distributions. */
function overlap(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]);
  return s;
}

/** Energy-weighted centroid of a shape, in Hz. */
function centroid(a: Float64Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += (loBin + i) * binHz * a[i];
  return n;
}

interface Row { seed: string; hits: number; overlap: number; kickHz: number; bassHz: number; note: number }
const rows: Row[] = [];
const byNote = new Map<number, { n: number; sum: number }>();
const started = Date.now();

for (let i = 0; i < seedCount; i++) {
  const seed = `${base}${String(i + 1).padStart(4, "0")}`;
  const plan = buildPlan({ seed, preset, ranges, sampleRate: SR });
  const drums = renderStem({ seed, preset, ranges, sampleRate: SR }, "drums").audio;
  const bass = renderStem({ seed, preset, ranges, sampleRate: SR }, "bass808").audio;

  const tol = Math.round(plan.samplesPerStep);
  let hits = 0;
  let sumOverlap = 0;
  let sumKick = 0;
  let sumBass = 0;
  let noteSum = 0;

  for (const k of plan.kickPositions) {
    const note = plan.bassNotes.find((n) => Math.abs(n.start - k) <= tol);
    if (!note) continue;
    const at = Math.max(k, note.start);
    const ks = shape(drums.L, drums.R, at);
    const bs = shape(bass.L, bass.R, at);
    if (!ks || !bs) continue;
    hits++;
    const o = overlap(ks, bs);
    sumOverlap += o;
    sumKick += centroid(ks);
    sumBass += centroid(bs);
    noteSum += note.midi;
    const e = byNote.get(note.midi) ?? { n: 0, sum: 0 };
    e.n++;
    e.sum += o;
    byNote.set(note.midi, e);
  }
  if (hits === 0) continue;
  rows.push({
    seed, hits,
    overlap: sumOverlap / hits,
    kickHz: sumKick / hits,
    bassHz: sumBass / hits,
    note: noteSum / hits,
  });
  process.stderr.write(`\r  ${i + 1}/${seedCount}  ${seed}   `);
}
process.stderr.write("\r" + " ".repeat(40) + "\r");

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

console.log(`\nKICK / 808 MASKING — ${presetName}, ${rows.length} seeds, ${LOW_HZ}-${HIGH_HZ} Hz\n`);
console.log(pad("seed", 9) + padL("hits", 6) + padL("overlap", 9) + padL("kick Hz", 10) + padL("808 Hz", 9) + padL("mean midi", 11));
console.log("-".repeat(56));
let total = 0;
let totalHits = 0;
for (const r of rows) {
  console.log(
    pad(r.seed, 9) + padL(String(r.hits), 6) + padL(r.overlap.toFixed(3), 9) +
    padL(r.kickHz.toFixed(1), 10) + padL(r.bassHz.toFixed(1), 9) + padL(r.note.toFixed(1), 11),
  );
  total += r.overlap * r.hits;
  totalHits += r.hits;
}
const mean = totalHits > 0 ? total / totalHits : 0;
console.log("-".repeat(56));
console.log(`mean overlap ${mean.toFixed(3)} over ${totalHits} simultaneous hits`);
console.log(
  `\n1.0 = kick and 808 occupy exactly the same frequencies in ${LOW_HZ}-${HIGH_HZ} Hz.\n` +
  `Below about 0.5 they are separated enough that each keeps its own identity.`,
);

console.log(`\noverlap by 808 note:`);
const notes = [...byNote].sort((a, b) => a[0] - b[0]);
for (const [midi, e] of notes) {
  if (e.n < 5) continue;
  console.log(`  midi ${String(midi).padStart(3)}  ${midiToHz(midi).toFixed(1).padStart(6)} Hz   ` +
    `${e.n.toString().padStart(4)} hits   overlap ${(e.sum / e.n).toFixed(3)}`);
}
console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(0)} s`);
