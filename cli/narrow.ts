/**
 * Per-axis correlation and range proposals.
 *
 *   npm run narrow                       fetches the current batch from the Worker
 *   npm run narrow -- ./batch            uses a local ratings.json instead
 *
 * A single score per track is very little information: fifty tracks against
 * forty parameters, correlated with one blurred number, and the human has to
 * answer the hardest possible question fifty times. Four axes give four
 * independent signals, and each pulls on a different cluster — punch on the
 * drums and the master, space on reverb, width and distortion, hook on the
 * motif parameters.
 *
 * Every proposal says which axis it is optimising, so a change that would buy
 * punch by killing space can be rejected on sight. It never writes the ranges
 * file: `tune` does that, under the guard rails in Addendum 9.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPreset } from "../presets/index.ts";
import { num, parseArgs, str } from "./args.ts";
import type { BatchIndex, RateManifest } from "./batch.ts";
import {
  AXES, fdrKeep, fetchRatings, judgeSessions, loadLocalRatings, merge, pearson,
  permutationP, scoresByTrack, survivesSplit, type Axis, type Rating,
} from "./ratings.ts";

const args = parseArgs(process.argv.slice(2));
const dir = args.positional[0] ?? "./batch";
const workerUrl = str(args, "worker", "https://nullsample-rate.maqsudjon-polatov.workers.dev");
const key = str(args, "key", process.env.NULLSAMPLE_RATE_KEY ?? "");
const MIN_ABS_R = num(args, "minr", 0.18);
const MAX_P = num(args, "p", 0.1);
const FDR = num(args, "fdr", 0.1);
const MAX_SHRINK = num(args, "shrink", 0.34);

const indexPath = join(dir, "batch.json");
if (!existsSync(indexPath)) throw new Error(`no batch.json in ${dir} - run npm run batch first`);
const index: BatchIndex = JSON.parse(readFileSync(indexPath, "utf8"));
const { ranges } = getPreset(index.preset);

const manifestPath = join("web", "rate", "batch", "manifest.json");
const manifest: RateManifest | undefined = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : undefined;

// --- collect ratings --------------------------------------------------------

let ratings: Rating[] = loadLocalRatings(join(dir, "ratings.json"));
if (manifest && key) {
  try {
    const remote = await fetchRatings(workerUrl, manifest.batchId, key);
    ratings = merge(ratings, remote);
    console.log(`fetched ${remote.length} ratings from the worker`);
  } catch (e) {
    console.error(`could not reach the worker (${(e as Error).message}); using local ratings only`);
  }
} else if (!key) {
  console.error(`no sync key: set NULLSAMPLE_RATE_KEY or pass --key to pull from the worker`);
}

if (ratings.length === 0) {
  console.error(`no ratings found. Rate at nullsample.maqsudjon.com/rate first.`);
  process.exit(1);
}

// --- discard bad sessions, whole ------------------------------------------

const repeatOf = new Map<string, string>();
for (const t of manifest?.tracks ?? []) if (t.repeatOf) repeatOf.set(t.id, t.repeatOf);
const verdicts = judgeSessions(ratings, repeatOf);
const dropped = new Set(verdicts.filter((v) => !v.kept).map((v) => v.session));
if (dropped.size > 0) {
  console.log(`\ndiscarded ${dropped.size} session(s):`);
  for (const v of verdicts.filter((x) => !x.kept)) {
    console.log(`  ${v.session}  ${v.reason}`);
  }
}
const kept = ratings.filter((r) => !dropped.has(r.session));

// --- map ratings back onto rendered parameter values -----------------------

const seedOf = new Map<string, string>();
for (const t of manifest?.tracks ?? []) seedOf.set(t.id, t.seed);
const bySeed = new Map(index.records.map((r) => [r.seed, r]));
const trackScores = scoresByTrack(kept);

interface Row { seed: string; params: Record<string, number>; scores: Partial<Record<Axis, number>> }
const rows: Row[] = [];
for (const [trackId, scores] of trackScores) {
  const seed = seedOf.get(trackId) ?? trackId;
  const rec = bySeed.get(seed);
  if (!rec) continue;
  rows.push({ seed, params: rec.params, scores });
}

if (rows.length < 8) {
  console.error(`only ${rows.length} rated tracks matched this batch - rate at least 8`);
  process.exit(1);
}

// --- per-axis correlation ---------------------------------------------------

interface Finding {
  key: string; axis: Axis; r: number; p: number; n: number;
  goodMean: number; badMean: number; split: boolean;
  oldMin: number; oldMax: number; newMin: number; newMax: number;
}

const paramKeys = Object.keys(ranges.params);
const findings: Finding[] = [];

for (const axis of AXES) {
  const withAxis = rows.filter((r) => typeof r.scores[axis] === "number");
  if (withAxis.length < 8) continue;
  const ys = withAxis.map((r) => r.scores[axis] as number);
  const candidates: Finding[] = [];
  const ps: number[] = [];

  for (const k of paramKeys) {
    const xs = withAxis.map((r) => r.params[k]);
    if (xs.some((v) => typeof v !== "number")) continue;
    if (Math.max(...xs) - Math.min(...xs) <= 0) continue;
    const r = pearson(xs, ys);
    if (Math.abs(r) < MIN_ABS_R) continue;
    const p = permutationP(xs, ys, r);
    if (p > MAX_P) continue;

    const spec = ranges.params[k];
    const good = withAxis.filter((_, i) => ys[i] >= 4).map((x) => x.params[k]);
    const bad = withAxis.filter((_, i) => ys[i] <= 2).map((x) => x.params[k]);
    const gm = good.length > 0 ? good.reduce((s, v) => s + v, 0) / good.length : NaN;
    const bm = bad.length > 0 ? bad.reduce((s, v) => s + v, 0) / bad.length : NaN;

    // A proposal only, and never more than a third of the width in one pass.
    const width = spec.max - spec.min;
    const shift = Math.sign(r) * MAX_SHRINK * width * 0.5;
    const newMin = Math.max(spec.min, spec.min + Math.max(0, shift));
    const newMax = Math.min(spec.max, spec.max + Math.min(0, shift));

    candidates.push({
      key: k, axis, r, p, n: withAxis.length,
      goodMean: gm, badMean: bm,
      split: survivesSplit(xs, ys),
      oldMin: spec.min, oldMax: spec.max, newMin, newMax,
    });
    ps.push(p);
  }

  const keepIdx = fdrKeep(ps, FDR);
  candidates.forEach((c, i) => { if (keepIdx.has(i)) findings.push(c); });
}

// --- report ------------------------------------------------------------------

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

console.log(`\nPER-AXIS CORRELATION — ${index.preset}, ${rows.length} rated tracks, ranges v${index.rangesVersion}\n`);
const means: Record<string, string> = {};
for (const axis of AXES) {
  const vals = rows.map((r) => r.scores[axis]).filter((v): v is number => typeof v === "number");
  means[axis] = vals.length > 0 ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : "-";
}
console.log(`mean scores:  ${AXES.map((a) => `${a} ${means[a]}`).join("   ")}`);

for (const axis of AXES) {
  const set = findings.filter((f) => f.axis === axis).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  console.log(`\n${axis.toUpperCase()} — ${set.length === 0 ? "nothing cleared the bar" : `${set.length} parameter(s)`}`);
  if (set.length === 0) continue;
  console.log(`  ${pad("parameter", 26)}${padL("r", 7)}${padL("p", 7)}${padL("split", 7)}   proposal`);
  for (const f of set) {
    const dir = f.r > 0 ? "higher scores better" : "lower scores better";
    console.log(
      `  ${pad(f.key, 26)}${padL(f.r.toFixed(2), 7)}${padL(f.p.toFixed(3), 7)}` +
      `${padL(f.split ? "yes" : "no", 7)}   ${dir}: ${f.oldMin} .. ${f.oldMax} -> ` +
      `${f.newMin.toFixed(4)} .. ${f.newMax.toFixed(4)}`,
    );
  }
}

const conflicts = new Map<string, Finding[]>();
for (const f of findings) {
  const l = conflicts.get(f.key) ?? [];
  l.push(f);
  conflicts.set(f.key, l);
}
const opposed = [...conflicts].filter(([, fs]) => fs.length > 1 && new Set(fs.map((f) => Math.sign(f.r))).size > 1);
if (opposed.length > 0) {
  console.log(`\nTRADE-OFFS — these pull two axes in opposite directions:`);
  for (const [k, fs] of opposed) {
    console.log(`  ${pad(k, 26)}${fs.map((f) => `${f.axis} ${f.r > 0 ? "+" : "-"}${Math.abs(f.r).toFixed(2)}`).join("   ")}`);
  }
}

const outPath = join(dir, "proposal.json");
writeFileSync(outPath, JSON.stringify({ preset: index.preset, rangesVersion: index.rangesVersion, findings }, null, 2));
console.log(`\nwrote ${outPath} — a proposal, not a change. \`npm run tune\` applies weights under the Addendum 9 guard rails.`);
