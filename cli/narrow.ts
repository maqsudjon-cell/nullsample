/**
 * Range narrowing.
 *
 *   npm run narrow -- ./batch
 *
 * Reads the batch records and the ratings, correlates every sampled parameter
 * against the ratings, and proposes a tightened ranges file plus a readable
 * diff. It never overwrites the ranges file: the proposal is a suggestion for
 * a human to accept, reject or edit.
 *
 * The statistics are deliberately conservative. With 50 ratings, most apparent
 * correlations are noise, so a parameter is only narrowed when the effect is
 * large enough to survive a permutation test, and never by more than a third
 * of its width in one pass.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPreset } from "../presets/index.ts";
import { num, parseArgs } from "./args.ts";
import type { BatchIndex } from "./batch.ts";

interface RatingsFile {
  preset: string;
  rangesVersion: number;
  ratings: Record<string, number>;
}

const args = parseArgs(process.argv.slice(2));
const dir = args.positional[0] ?? "./batch";
/** how far a range may shrink in one pass, as a fraction of its width */
const MAX_SHRINK = num(args, "shrink", 0.34);
/** minimum |r| before a parameter is considered at all */
const MIN_ABS_R = num(args, "minr", 0.18);
/** permutation-test threshold */
const MAX_P = num(args, "p", 0.1);

const indexPath = join(dir, "batch.json");
const ratingsPath = join(dir, "ratings.json");
if (!existsSync(indexPath)) throw new Error(`no batch.json in ${dir} - run npm run batch first`);
if (!existsSync(ratingsPath)) {
  console.error(`No ratings.json in ${dir}.`);
  console.error(`Open ${join(dir, "sheet.html")}, rate the tracks, press "Save ratings.json",`);
  console.error(`and move the downloaded file into ${dir}.`);
  process.exit(1);
}

const index: BatchIndex = JSON.parse(readFileSync(indexPath, "utf8"));
const ratingsFile: RatingsFile = JSON.parse(readFileSync(ratingsPath, "utf8"));
const { ranges } = getPreset(index.preset);

if (ratingsFile.rangesVersion !== index.rangesVersion) {
  console.error(
    `warning: ratings were made against ranges v${ratingsFile.rangesVersion} but this batch is v${index.rangesVersion}`,
  );
}

const rated = index.records
  .map((r) => ({ record: r, rating: ratingsFile.ratings[r.seed] }))
  .filter((x): x is { record: (typeof index.records)[0]; rating: number } => typeof x.rating === "number");

if (rated.length < 8) {
  console.error(`only ${rated.length} tracks rated - rate at least 8 before narrowing`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Permutation test. Shuffles the ratings many times and counts how often
 * chance produces a correlation at least this strong. Deterministic: the
 * shuffle uses a fixed seed, so re-running narrow on the same data gives the
 * same proposal.
 */
function permutationP(xs: number[], ys: number[], observed: number): number {
  let state = 0x2f6e2b1 >>> 0;
  const rnd = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  const shuffled = [...ys];
  const target = Math.abs(observed);
  let hits = 0;
  const trials = 2000;
  for (let t = 0; t < trials; t++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    if (Math.abs(pearson(xs, shuffled)) >= target) hits++;
  }
  return hits / trials;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------------------------------------------------------------------------

interface Finding {
  key: string;
  r: number;
  p: number;
  oldMin: number;
  oldMax: number;
  newMin: number;
  newMax: number;
  goodMean: number;
  badMean: number;
  n: number;
}

const paramKeys = Object.keys(ranges.params);
const ys = rated.map((x) => x.rating);
const findings: Finding[] = [];
const skipped: string[] = [];

for (const key of paramKeys) {
  const spec = ranges.params[key];
  const xs = rated.map((x) => x.record.params[key]);
  if (xs.some((v) => typeof v !== "number")) {
    skipped.push(key);
    continue;
  }
  const spread = Math.max(...xs) - Math.min(...xs);
  if (spread <= 0) {
    skipped.push(key);
    continue;
  }

  const r = pearson(xs, ys);
  if (Math.abs(r) < MIN_ABS_R) continue;
  const p = permutationP(xs, ys, r);
  if (p > MAX_P) continue;

  // where the well-rated renders actually sat
  const good = rated
    .filter((x) => x.rating >= 4)
    .map((x) => x.record.params[key])
    .sort((a, b) => a - b);
  const bad = rated.filter((x) => x.rating <= 2).map((x) => x.record.params[key]);
  if (good.length < 3) continue;

  const gLo = quantile(good, 0.1);
  const gHi = quantile(good, 0.9);
  const width = spec.max - spec.min;
  const minWidth = width * (1 - MAX_SHRINK);

  let newMin = gLo;
  let newMax = gHi;
  if (newMax - newMin < minWidth) {
    const centre = (newMin + newMax) / 2;
    newMin = centre - minWidth / 2;
    newMax = centre + minWidth / 2;
  }
  // never step outside the original bracket
  newMin = Math.max(spec.min, newMin);
  newMax = Math.min(spec.max, newMax);
  if (newMax <= newMin) continue;

  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  findings.push({
    key, r, p,
    oldMin: spec.min, oldMax: spec.max,
    newMin, newMax,
    goodMean: mean(good), badMean: mean(bad),
    n: rated.length,
  });
}

findings.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

// --- categorical choices ----------------------------------------------------
const choiceReport: string[] = [];
const choiceKeys = new Set<string>();
for (const x of rated) for (const k of Object.keys(x.record.choices)) choiceKeys.add(k);
for (const key of [...choiceKeys].sort()) {
  const byOption = new Map<string, number[]>();
  for (const x of rated) {
    const v = x.record.choices[key];
    if (v === undefined) continue;
    if (!byOption.has(v)) byOption.set(v, []);
    byOption.get(v)!.push(x.rating);
  }
  const rows = [...byOption.entries()]
    .map(([opt, rs]) => ({ opt, n: rs.length, mean: rs.reduce((s, v) => s + v, 0) / rs.length }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.mean - a.mean);
  if (rows.length < 2) continue;
  choiceReport.push(
    `  ${key}\n` +
      rows.map((x) => `    ${x.mean.toFixed(2)}  n=${String(x.n).padStart(2)}  ${x.opt}`).join("\n"),
  );
}

// --- write the proposal -----------------------------------------------------
const proposal = JSON.parse(JSON.stringify(ranges));
proposal.version = ranges.version + 1;
proposal.note =
  `Proposed by narrow from ${rated.length} ratings over ${index.count} renders ` +
  `(ranges v${ranges.version}). Review the diff before adopting. Not applied automatically.`;
for (const f of findings) {
  proposal.params[f.key].min = Number(f.newMin.toFixed(6));
  proposal.params[f.key].max = Number(f.newMax.toFixed(6));
}

const proposalPath = join(dir, `${index.preset}.ranges.proposal.json`);
writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));

// --- readable report --------------------------------------------------------
const dist = [0, 0, 0, 0, 0];
for (const y of ys) dist[y - 1]++;
const meanRating = ys.reduce((s, v) => s + v, 0) / ys.length;
const poorRate = (dist[0] + dist[1]) / ys.length;

const lines: string[] = [];
lines.push(`nullsample narrow - ${index.preset}, ranges v${ranges.version} -> v${proposal.version}`);
lines.push("");
lines.push(`  ${rated.length} of ${index.count} rated   mean ${meanRating.toFixed(2)}`);
lines.push(`  distribution  1:${dist[0]}  2:${dist[1]}  3:${dist[2]}  4:${dist[3]}  5:${dist[4]}`);
lines.push(`  rated poor (1-2): ${(poorRate * 100).toFixed(0)}%   ${poorRate < 0.05 ? "AT TARGET - the preset is done" : "target is under 5%"}`);
lines.push("");
if (findings.length === 0) {
  lines.push("  No parameter cleared the significance threshold.");
  lines.push("  That is a real result, not a failure: with this many ratings, nothing");
  lines.push("  in the parameter space is reliably driving the score. Either the ranges");
  lines.push("  are already reasonable, or the problem is somewhere the ranges cannot");
  lines.push("  reach - arrangement, note choice, or a bug.");
} else {
  lines.push(`  ${findings.length} parameter${findings.length === 1 ? "" : "s"} proposed for narrowing:`);
  lines.push("");
  lines.push(`  ${"parameter".padEnd(26)} ${"r".padStart(6)} ${"p".padStart(5)}   ${"from".padStart(19)}  ->  ${"to".padStart(19)}`);
  for (const f of findings) {
    const from = `[${f.oldMin.toFixed(3)}, ${f.oldMax.toFixed(3)}]`;
    const to = `[${f.newMin.toFixed(3)}, ${f.newMax.toFixed(3)}]`;
    const dir2 = f.r > 0 ? "higher rates better" : "lower rates better";
    lines.push(`  ${f.key.padEnd(26)} ${f.r.toFixed(2).padStart(6)} ${f.p.toFixed(3).padStart(5)}   ${from.padStart(19)}  ->  ${to.padStart(19)}   ${dir2}`);
  }
}
if (choiceReport.length > 0) {
  lines.push("");
  lines.push("  categorical choices, mean rating by option:");
  lines.push(...choiceReport);
}
lines.push("");
lines.push(`  proposal written to ${proposalPath}`);
lines.push(`  to adopt:  cp ${proposalPath} presets/${index.preset}.ranges.json`);
lines.push("");

const report = lines.join("\n");
writeFileSync(join(dir, "narrow-report.txt"), report + "\n");
console.log(report);
