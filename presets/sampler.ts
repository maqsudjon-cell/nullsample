/**
 * Parameter sampling.
 *
 * Every value the preset draws is recorded, because the whole quality loop
 * depends on being able to correlate "this render was rated 2" with "these
 * were its parameter values". A parameter that is sampled without being
 * recorded is invisible to narrowing and therefore cannot be tuned.
 */

import { dexp, dlog } from "../core/dmath.ts";
import type { Rng } from "../core/rng.ts";
import type { RangesFile, RangeSpec, WordSlider } from "./types.ts";

export interface WordValues {
  [name: string]: number;
}

export class ParamSampler {
  private rng: Rng;
  private file: RangesFile;
  private words: WordValues;
  private sliders: readonly WordSlider[];
  /** every numeric value sampled, keyed by parameter name */
  readonly values: Record<string, number> = {};
  /** every categorical choice made, keyed by parameter name */
  readonly choices: Record<string, string> = {};
  private missing: string[] = [];

  constructor(rng: Rng, file: RangesFile, sliders: readonly WordSlider[] = [], words: WordValues = {}) {
    this.rng = rng;
    this.file = file;
    this.sliders = sliders;
    this.words = words;
  }

  /** Word-slider adjustment for one parameter, applied after sampling. */
  private applyWords(key: string, value: number): number {
    let v = value;
    for (const slider of this.sliders) {
      const s = this.words[slider.name];
      if (s === undefined || s === 0) continue;
      const t = s < -1 ? -1 : s > 1 ? 1 : s;
      for (const m of slider.mappings) {
        if (m.param !== key) continue;
        if (m.mul) {
          // interpolate in log space so a "half as bright" feels the same
          // distance from centre as "twice as bright"
          const end = t < 0 ? m.mul[0] : m.mul[1];
          v = v * dexp(dlog(end) * (t < 0 ? -t : t));
        }
        if (m.add) {
          const end = t < 0 ? m.add[0] : m.add[1];
          v = v + end * (t < 0 ? -t : t);
        }
      }
    }
    return v;
  }

  /** Smallest weight the sampler will honour, so no region is ever unreachable. */
  static readonly WEIGHT_FLOOR = 0.02;

  /**
   * Picks a sub-range by weight, then samples inside it.
   *
   * The buckets are equal-width across [min,max]; the weight curve says how
   * often each is drawn. A zero or missing weight is treated as the floor, not
   * as an exclusion - see RangeSpec.weights.
   */
  private weightedBounds(spec: RangeSpec, weights: readonly number[]): { lo: number; hi: number } {
    const n = weights.length;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const w = weights[i];
      total += w > ParamSampler.WEIGHT_FLOOR ? w : ParamSampler.WEIGHT_FLOOR;
    }
    let r = this.rng.float() * total;
    let idx = n - 1;
    for (let i = 0; i < n; i++) {
      const w = weights[i] > ParamSampler.WEIGHT_FLOOR ? weights[i] : ParamSampler.WEIGHT_FLOOR;
      r -= w;
      if (r < 0) {
        idx = i;
        break;
      }
    }
    const width = (spec.max - spec.min) / n;
    return { lo: spec.min + idx * width, hi: spec.min + (idx + 1) * width };
  }

  private sampleRange(spec: RangeSpec): number {
    const dist = spec.dist ?? "uniform";
    if (spec.weights && spec.weights.length > 1) {
      const { lo, hi } = this.weightedBounds(spec, spec.weights);
      let v = this.rng.range(lo, hi);
      if (spec.step && spec.step > 0) v = Math.round(v / spec.step) * spec.step;
      return v;
    }
    let v: number;
    if (dist === "log") {
      const lo = dlog(spec.min <= 0 ? 1e-6 : spec.min);
      const hi = dlog(spec.max <= 0 ? 1e-6 : spec.max);
      v = dexp(lo + (hi - lo) * this.rng.float());
    } else if (dist === "gauss") {
      v = this.rng.gaussIn(spec.min, spec.max);
    } else {
      v = this.rng.range(spec.min, spec.max);
    }
    if (spec.step && spec.step > 0) v = Math.round(v / spec.step) * spec.step;
    return v;
  }

  /** Samples a numeric parameter, applies word sliders, and records it. */
  num(key: string): number {
    const spec = this.file.params[key];
    if (!spec) {
      this.missing.push(key);
      throw new Error(`preset range missing for "${key}" in ${this.file.preset}.ranges.json`);
    }
    const raw = this.sampleRange(spec);
    this.values[key] = raw;
    return this.applyWords(key, raw);
  }

  /** Samples and rounds to an integer. */
  int(key: string): number {
    return Math.round(this.num(key));
  }

  /** A fixed value that still passes through the word sliders. */
  fixed(key: string, value: number): number {
    this.values[key] = value;
    return this.applyWords(key, value);
  }

  /** Picks from a list, honouring any weights declared in the ranges file. */
  choice<T>(key: string, options: readonly T[]): T {
    const spec = this.file.choices?.[key];
    let chosen: T;
    if (spec?.weights && spec.weights.length === options.length) {
      chosen = this.rng.weighted(options, spec.weights);
    } else {
      chosen = this.rng.pick(options);
    }
    this.choices[key] = String(
      typeof chosen === "object" ? JSON.stringify(chosen) : chosen,
    );
    return chosen;
  }

  /** Index-returning variant, for when the caller needs the position. */
  choiceIndex(key: string, count: number): number {
    const idx = this.choice(key, Array.from({ length: count }, (_, i) => i));
    return idx;
  }
}
