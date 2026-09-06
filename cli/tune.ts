/**
 * The closed tuning loop.
 *
 *   npm run tune                  one cycle: read ratings, reweight, record
 *   npm run tune -- --dry         report what it would do and change nothing
 *
 * `narrow` proposes range changes for a human. This does not narrow ranges at
 * all, and that difference is the whole design.
 *
 * Tightening is irreversible in a closed loop: an excluded region is never
 * rendered, so it is never rated, so the exclusion can never be found to be
 * wrong. Twenty unrepresentative ratings early on would amputate part of the
 * parameter space permanently and the loop would converge, happily, on a local
 * optimum with no way back.
 *
 * So ranges never move. What moves is the probability of drawing from each part
 * of them, and no weight may ever reach zero. A region that scored badly on bad
 * evidence becomes rare, not impossible, and recovers when better evidence
 * arrives. That single property is what makes the loop safe to leave running.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPreset } from "../presets/index.ts";
import { ParamSampler } from "../presets/sampler.ts";
import { bool, num, parseArgs, str } from "./args.ts";
import type { BatchIndex, RateManifest } from "./batch.ts";
import {
  AXES, fdrKeep, fetchRatings, judgeSessions, loadLocalRatings, merge, pearson,
  permutationP, scoresByTrack, survivesSplit, type Axis, type Rating,
} from "./ratings.ts";

const args = parseArgs(process.argv.slice(2));
const dir = args.positional[0] ?? "./batch";
const dry = bool(args, "dry");
const workerUrl = str(args, "worker", "https://nullsample-rate.maqsudjon-polatov.workers.dev");
const key = str(args, "key", process.env.NULLSAMPLE_RATE_KEY ?? "");

// --- U2: the confidence bar ------------------------------------------------
/** Rated tracks needed before a parameter may move at all. */
const MIN_TRACKS = num(args, "minTracks", 24);
/** The parameter's own range must be covered, not just sampled in one corner. */
const MIN_COVERAGE = 0.55;
const MIN_ABS_R = 0.22;
const MAX_P = 0.05;
const FDR = 0.1;

/** How far a weight may move in one cycle, and the floor it can never pass. */
const MAX_WEIGHT_STEP = 0.35;
const WEIGHT_FLOOR = ParamSampler.WEIGHT_FLOOR;
const BUCKETS = 5;

// --- U8: stop conditions ----------------------------------------------------
const CYCLE_CAP = num(args, "cycles", 40);
const TARGET_MEAN = 4.0;
const FLAT_CYCLES = 4;
const FLAT_DELTA = 0.05;

interface Move {
  param: string; from: number[]; to: number[]; axis: string; r: number; n: number;
}
interface Cycle {
  cycle: number;
  at: string;
  batchId: string;
  rated: number;
  scores: Record<Axis, number>;
  moved: Move[];
  skipped: { param: string; reason: string }[];
  discardedSessions: { session: string; agreement: number; reason: string }[];
  selfAgreement: number;
  constraintFailures?: string[];
  stopped?: string;
}
interface Tuning { cycles: Cycle[]; paused: boolean; stopped?: string }

const TUNING_PATH = join("web", "rate", "tuning.json");
const tuning: Tuning = existsSync(TUNING_PATH)
  ? JSON.parse(readFileSync(TUNING_PATH, "utf8"))
  : { cycles: [], paused: false };

if (tuning.stopped) {
  console.log(`tuning already stopped: ${tuning.stopped}`);
  process.exit(0);
}
if (tuning.paused) {
  console.log(`tuning is paused from /rate/progress. Nothing to do.`);
  process.exit(0);
}

const indexPath = join(dir, "batch.json");
if (!existsSync(indexPath)) throw new Error(`no batch.json in ${dir}`);
const index: BatchIndex = JSON.parse(readFileSync(indexPath, "utf8"));
const { ranges } = getPreset(index.preset);
const rangesPath = join("presets", `${index.preset}.ranges.json`);

const manifestPath = join("web", "rate", "batch", "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`no published batch - run npm run batch -- --publish`);
const manifest: RateManifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// --- gather -----------------------------------------------------------------

let ratings: Rating[] = loadLocalRatings(join(dir, "ratings.json"));
if (key) {
  try {
    ratings = merge(ratings, await fetchRatings(workerUrl, manifest.batchId, key));
  } catch (e) {
    console.error(`worker unreachable (${(e as Error).message}); using local ratings`);
  }
}

// --- U5: reject bad sessions, whole ----------------------------------------

const repeatOf = new Map<string, string>();
for (const t of manifest.tracks) if (t.repeatOf) repeatOf.set(t.id, t.repeatOf);
const verdicts = judgeSessions(ratings, repeatOf);
const dropped = new Set(verdicts.filter((v) => !v.kept).map((v) => v.session));
const kept = ratings.filter((r) => !dropped.has(r.session));
const withRepeats = verdicts.filter((v) => v.repeats > 0);
const selfAgreement = withRepeats.length > 0
  ? withRepeats.reduce((s, v) => s + v.agreement, 0) / withRepeats.length
  : 1;

const seedOf = new Map(manifest.tracks.map((t) => [t.id, t.seed]));
const bySeed = new Map(index.records.map((r) => [r.seed, r]));
const trackScores = scoresByTrack(kept);

interface Row { params: Record<string, number>; scores: Partial<Record<Axis, number>> }
const rows: Row[] = [];
for (const [trackId, scores] of trackScores) {
  const rec = bySeed.get(seedOf.get(trackId) ?? trackId);
  if (rec) rows.push({ params: rec.params, scores });
}

const meanScores = {} as Record<Axis, number>;
for (const a of AXES) {
  const vals = rows.map((r) => r.scores[a]).filter((v): v is number => typeof v === "number");
  meanScores[a] = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
}

// --- U1 + U2: reweight what has cleared the bar ----------------------------

const moved: Move[] = [];
const skipped: { param: string; reason: string }[] = [];
const nextParams = JSON.parse(JSON.stringify(ranges.params)) as typeof ranges.params;

if (rows.length < MIN_TRACKS) {
  skipped.push({ param: "*", reason: `only ${rows.length} rated tracks, need ${MIN_TRACKS}` });
} else {
  for (const axis of AXES) {
    const withAxis = rows.filter((r) => typeof r.scores[axis] === "number");
    if (withAxis.length < MIN_TRACKS) continue;
    const ys = withAxis.map((r) => r.scores[axis] as number);

    const candidates: { key: string; r: number; xs: number[] }[] = [];
    const ps: number[] = [];
    for (const k of Object.keys(nextParams)) {
      const spec = nextParams[k];
      const xs = withAxis.map((r) => r.params[k]);
      if (xs.some((v) => typeof v !== "number")) continue;
      const width = spec.max - spec.min;
      if (width <= 0) continue;
      const coverage = (Math.max(...xs) - Math.min(...xs)) / width;
      if (coverage < MIN_COVERAGE) {
        skipped.push({ param: k, reason: `range only ${(coverage * 100).toFixed(0)}% covered` });
        continue;
      }
      const r = pearson(xs, ys);
      if (Math.abs(r) < MIN_ABS_R) continue;
      const p = permutationP(xs, ys, r);
      if (p > MAX_P) continue;
      if (!survivesSplit(xs, ys)) {
        skipped.push({ param: k, reason: `${axis}: did not survive the split-half check` });
        continue;
      }
      candidates.push({ key: k, r, xs });
      ps.push(p);
    }

    const survive = fdrKeep(ps, FDR);
    candidates.forEach((c, i) => {
      if (!survive.has(i)) {
        skipped.push({ param: c.key, reason: `${axis}: lost to the false-discovery correction` });
        return;
      }
      const spec = nextParams[c.key];
      const from = (spec.weights && spec.weights.length === BUCKETS)
        ? spec.weights.slice()
        : new Array(BUCKETS).fill(1);
      // Tilt the curve toward the end the ratings favour. A linear tilt is
      // enough: the loop runs many times, and a small nudge that can be
      // reversed beats a large one that cannot.
      const to = from.map((w, b) => {
        const t = (b / (BUCKETS - 1)) * 2 - 1;
        const factor = 1 + Math.sign(c.r) * t * MAX_WEIGHT_STEP * Math.min(1, Math.abs(c.r) / 0.5);
        return Math.max(WEIGHT_FLOOR, Number((w * factor).toFixed(4)));
      });
      spec.weights = to;
      moved.push({ param: c.key, from, to, axis, r: c.r, n: withAxis.length });
    });
  }
}

// --- U4: hard constraints reject automatically ------------------------------
//
// These are not preferences and no rating can override them. They are checked
// against the batch that produced these ratings, because that is the evidence
// available without rendering another one.

const failures: string[] = [];
const crestFails = index.records.filter((r) => r.crestDb < 6).length;
if (crestFails > index.records.length / 8) {
  failures.push(`crest below 6 dB on ${crestFails}/${index.records.length} seeds`);
}
const monoFails = index.records.filter((r) => (r.monoFlags ?? []).length > 0).length;
if (monoFails > 0) {
  failures.push(`${monoFails} track(s) lose more than 3 dB in a band in mono`);
}
const drives = index.records.map((r) => r.dropRmsDb).filter((v) => Number.isFinite(v));
if (drives.length > 1) {
  const spread = Math.max(...drives) - Math.min(...drives);
  if (spread > 1.5 + 6) {
    // the 6 dB allowance is the crest spread the F5 work established as
    // dynamics rather than a gain-staging fault
    failures.push(`drop level spreads ${spread.toFixed(2)} dB across seeds`);
  }
}

if (failures.length > 0) {
  console.log(`\nconstraint failures — weight update discarded:`);
  for (const f of failures) console.log(`  ${f}`);
}

// --- U8: should the loop stop? ---------------------------------------------

let stopped: string | undefined;
const cycleNo = tuning.cycles.length + 1;
if (cycleNo >= CYCLE_CAP) stopped = `cycle cap of ${CYCLE_CAP} reached`;
if (AXES.every((a) => meanScores[a] >= TARGET_MEAN)) stopped = `every axis is at or above ${TARGET_MEAN}`;
if (tuning.cycles.length >= FLAT_CYCLES) {
  const recent = tuning.cycles.slice(-FLAT_CYCLES);
  const flat = AXES.every((a) => {
    const vals = recent.map((c) => c.scores[a]).concat(meanScores[a]);
    return Math.max(...vals) - Math.min(...vals) < FLAT_DELTA;
  });
  if (flat) stopped = `scores flat across ${FLAT_CYCLES} cycles`;
}

const cycle: Cycle = {
  cycle: cycleNo,
  at: new Date().toISOString(),
  batchId: manifest.batchId,
  rated: rows.length,
  scores: meanScores,
  moved: failures.length > 0 ? [] : moved,
  skipped,
  discardedSessions: verdicts.filter((v) => !v.kept)
    .map((v) => ({ session: v.session, agreement: v.agreement, reason: v.reason })),
  selfAgreement,
  constraintFailures: failures.length > 0 ? failures : undefined,
  stopped,
};

// --- report and write -------------------------------------------------------

console.log(`\nCYCLE ${cycleNo} — ${rows.length} rated tracks from ${manifest.batchId}`);
console.log(`  ${AXES.map((a) => `${a} ${meanScores[a].toFixed(2)}`).join("   ")}`);
console.log(`  self-agreement ${(selfAgreement * 100).toFixed(0)}%, ${dropped.size} session(s) discarded`);
if (cycle.moved.length === 0) {
  console.log(`  no parameter cleared the confidence bar — nothing changed, which is the expected`);
  console.log(`  outcome for most cycles`);
} else {
  console.log(`  ${cycle.moved.length} parameter(s) reweighted:`);
  for (const m of cycle.moved) {
    console.log(`    ${m.param.padEnd(26)} ${m.axis} r=${m.r.toFixed(2)}  ` +
      `[${m.from.map((v) => v.toFixed(2)).join(" ")}] -> [${m.to.map((v) => v.toFixed(2)).join(" ")}]`);
  }
}
if (stopped) console.log(`\n  STOPPING: ${stopped}`);

if (dry) {
  console.log(`\n--dry: nothing written`);
} else {
  if (cycle.moved.length > 0) {
    const file = JSON.parse(readFileSync(rangesPath, "utf8"));
    file.params = nextParams;
    file.version = (file.version ?? 1) + 1;
    writeFileSync(rangesPath, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`\nwrote ${rangesPath} (v${file.version}) — ranges unchanged, weights only`);
  }
  tuning.cycles.push(cycle);
  if (stopped) tuning.stopped = stopped;
  writeFileSync(TUNING_PATH, `${JSON.stringify(tuning, null, 2)}\n`);
  console.log(`wrote ${TUNING_PATH}`);
}
