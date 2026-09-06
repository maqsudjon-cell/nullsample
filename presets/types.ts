/**
 * Preset format.
 *
 * A preset is data plus recipe logic. It knows nothing about DSP internals: it
 * declares tempo, key material, which buses exist and how they are gain
 * staged, per-bus parameters as ranges with distributions, a section template
 * and a master chain. The renderer knows how to realise it.
 *
 * Numeric ranges live in `<name>.ranges.json`, separate from this code,
 * because the narrow command in the quality loop rewrites that file.
 */

import type { ArrangementTemplate, BusName } from "../compose/arrange.ts";
import type { Contour } from "../compose/motif.ts";
import type { PatternBank, RollSpec } from "../compose/rhythm.ts";

export type Distribution = "uniform" | "log" | "gauss";

export interface RangeSpec {
  min: number;
  max: number;
  dist?: Distribution;
  /** round to this increment after sampling */
  step?: number;
  /**
   * Sampling weight curve across the range, as equal-width buckets from `min`
   * to `max`. Omitted means uniform.
   *
   * This is how tuning steers the engine without ever excluding anything: a
   * region that has rated badly becomes rare, not unreachable, so a wrong
   * verdict from a small sample can be recovered from later. Every weight is
   * floored above zero when it is written, and the sampler treats a
   * non-positive weight as the floor rather than as an exclusion.
   */
  weights?: number[];
}

export interface ChoiceSpec {
  /** weights parallel to the option list the preset passes in */
  weights?: number[];
}

export interface RangesFile {
  preset: string;
  version: number;
  /** free-text provenance, carried through so a tuned file stays attributable */
  note?: string;
  params: Record<string, RangeSpec>;
  choices?: Record<string, ChoiceSpec>;
}

/** One word slider: a plain adjective moving several parameters along a curve. */
export interface WordMapping {
  param: string;
  /** multiplier at slider -1 and at slider +1; 1 at centre */
  mul?: [number, number];
  /** offset at slider -1 and at slider +1; 0 at centre */
  add?: [number, number];
}

export interface WordSlider {
  name: string;
  label: string;
  /** what moving it right does, in one short phrase */
  hint: string;
  mappings: WordMapping[];
}

export interface HarmonyOptions {
  /** candidate tonics as MIDI note numbers */
  tonics: readonly number[];
  scales: readonly string[];
  /** candidate degree loops */
  degreeSets: readonly (readonly number[])[];
  voicings: readonly string[];
}

export interface MotifOptions {
  contours: readonly Contour[];
  allowedDegrees: readonly number[];
  stableDegrees: readonly number[];
}

export interface DrumBanks {
  kick: PatternBank;
  snare: PatternBank;
  clap: PatternBank;
  hatClosed: PatternBank;
  hatOpen: PatternBank;
  rim: PatternBank;
  rolls: RollSpec;
}

export interface Preset {
  name: string;
  title: string;
  description: string;
  /** buses this preset uses, in mix order */
  buses: readonly BusName[];
  harmony: HarmonyOptions;
  motif: MotifOptions;
  drums: DrumBanks;
  arrangements: readonly ArrangementTemplate[];
  words: readonly WordSlider[];
  /** hard ceiling on render length in bars */
  maxBars: number;
}
