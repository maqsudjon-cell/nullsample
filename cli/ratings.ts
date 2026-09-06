/**
 * Rating collection and statistics, shared by `narrow` and `tune`.
 *
 * Ratings arrive from the Worker the phone syncs to, or from a local file when
 * the Worker is not reachable. Everything downstream reads this module, so the
 * two tools cannot disagree about what a rating is or which sessions count.
 */

import { existsSync, readFileSync } from "node:fs";

export const AXES = ["hook", "punch", "space", "interest"] as const;
export type Axis = (typeof AXES)[number];

export interface Rating {
  batchId: string;
  trackId: string;
  pass: number;
  scores: Partial<Record<Axis, number>>;
  skipped: boolean;
  session: string;
  at?: string;
}

/**
 * Self-agreement below this and a session is discarded whole.
 *
 * The repeat tracks are the measurement. A session that scores the same track
 * 2 and then 5 is not a weak signal, it is noise, and learning from it
 * optimises toward a tired ear in a noisy room. Expressed as mean absolute
 * difference on a 1-5 scale: 1.0 means the two ratings of the same track were
 * on average a whole point apart.
 */
export const MAX_REPEAT_DISAGREEMENT = 1.0;

export async function fetchRatings(
  workerUrl: string,
  batchId: string,
  key: string,
): Promise<Rating[]> {
  const res = await fetch(`${workerUrl}/r?batch=${encodeURIComponent(batchId)}`, {
    headers: { "x-rate-key": key },
  });
  if (!res.ok) throw new Error(`worker returned ${res.status}`);
  const body = (await res.json()) as { ratings: Rating[] };
  return body.ratings ?? [];
}

export function loadLocalRatings(path: string): Rating[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw)) return raw as Rating[];
  if (Array.isArray(raw.ratings)) return raw.ratings as Rating[];
  // the old shape: { ratings: { seed: number } }, one score per track
  return Object.entries(raw.ratings ?? {}).map(([trackId, v]) => ({
    batchId: raw.batchId ?? "legacy",
    trackId,
    pass: 1,
    scores: { hook: v as number, punch: v as number, space: v as number, interest: v as number },
    skipped: false,
    session: "legacy",
  }));
}

/** Merges two rating sets, later entries winning on the same key. */
export function merge(a: readonly Rating[], b: readonly Rating[]): Rating[] {
  const out = new Map<string, Rating>();
  for (const r of [...a, ...b]) out.set(`${r.trackId}:${r.pass}`, r);
  return [...out.values()];
}

export interface SessionVerdict {
  session: string;
  agreement: number;
  kept: boolean;
  reason: string;
  repeats: number;
}

/**
 * Judges each session by how consistently it rated the silent repeats.
 *
 * `repeatOf` maps a repeat entry back to the track it duplicates. A session
 * with no repeats in it is kept — there is nothing to judge it on, and
 * discarding for lack of evidence would throw away most short sessions.
 */
export function judgeSessions(
  ratings: readonly Rating[],
  repeatOf: ReadonlyMap<string, string>,
): SessionVerdict[] {
  const bySession = new Map<string, Rating[]>();
  for (const r of ratings) {
    const list = bySession.get(r.session) ?? [];
    list.push(r);
    bySession.set(r.session, list);
  }
  const out: SessionVerdict[] = [];
  for (const [session, list] of bySession) {
    const byTrack = new Map<string, Rating>();
    for (const r of list) byTrack.set(`${r.trackId}:${r.pass}`, r);
    let diffs = 0;
    let pairs = 0;
    for (const r of list) {
      const original = repeatOf.get(r.trackId);
      if (!original) continue;
      const other = byTrack.get(`${original}:${r.pass}`);
      if (!other || r.skipped || other.skipped) continue;
      for (const a of AXES) {
        const x = r.scores[a];
        const y = other.scores[a];
        if (typeof x === "number" && typeof y === "number") {
          diffs += Math.abs(x - y);
          pairs++;
        }
      }
    }
    if (pairs === 0) {
      out.push({ session, agreement: 1, kept: true, reason: "no repeats in this session", repeats: 0 });
      continue;
    }
    const mad = diffs / pairs;
    const kept = mad <= MAX_REPEAT_DISAGREEMENT;
    out.push({
      session,
      agreement: Math.max(0, 1 - mad / 4),
      kept,
      reason: kept ? "ok" : `repeats disagreed by ${mad.toFixed(2)} points on average`,
      repeats: pairs,
    });
  }
  return out;
}

/** Mean score per axis for one track, across every kept rating of it. */
export function scoresByTrack(ratings: readonly Rating[]): Map<string, Partial<Record<Axis, number>>> {
  const sums = new Map<string, Partial<Record<Axis, { s: number; n: number }>>>();
  for (const r of ratings) {
    if (r.skipped) continue;
    const e = sums.get(r.trackId) ?? {};
    for (const a of AXES) {
      const v = r.scores[a];
      if (typeof v !== "number") continue;
      const cur = e[a] ?? { s: 0, n: 0 };
      cur.s += v;
      cur.n++;
      e[a] = cur;
    }
    sums.set(r.trackId, e);
  }
  const out = new Map<string, Partial<Record<Axis, number>>>();
  for (const [id, e] of sums) {
    const m: Partial<Record<Axis, number>> = {};
    for (const a of AXES) if (e[a]) m[a] = e[a]!.s / e[a]!.n;
    out.set(id, m);
  }
  return out;
}

// --- statistics -------------------------------------------------------------

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
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
 * Permutation test with a fixed seed, so the same data always gives the same
 * answer. A p-value from 2000 shuffles is granular enough for the thresholds
 * used here and costs nothing at this data size.
 */
export function permutationP(xs: readonly number[], ys: readonly number[], observed: number): number {
  let state = 0x2f6e2b1 >>> 0;
  const rnd = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
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

/** Benjamini-Hochberg. Returns the indices that survive at the given FDR. */
export function fdrKeep(ps: readonly number[], fdr: number): Set<number> {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = order.length;
  let cut = -1;
  for (let k = 0; k < m; k++) {
    if (order[k].p <= ((k + 1) / m) * fdr) cut = k;
  }
  const keep = new Set<number>();
  for (let k = 0; k <= cut; k++) keep.add(order[k].i);
  return keep;
}

/**
 * Split-half check: does the effect survive when the sample is cut in two?
 *
 * An effect that appears in one half and reverses in the other is a pattern in
 * noise, and it is the single cheapest way to catch one.
 */
export function survivesSplit(xs: readonly number[], ys: readonly number[]): boolean {
  const n = xs.length;
  if (n < 12) return false;
  const half = Math.floor(n / 2);
  const a = pearson(xs.slice(0, half), ys.slice(0, half));
  const b = pearson(xs.slice(half), ys.slice(half));
  if (a === 0 || b === 0) return false;
  return Math.sign(a) === Math.sign(b) && Math.min(Math.abs(a), Math.abs(b)) >= 0.12;
}
