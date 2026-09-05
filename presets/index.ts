/**
 * Preset registry.
 *
 * One preset. Section 19 is explicit: do not add a second genre, not even a
 * quick one to test the architecture. The registry exists so that adding one
 * later is a data change rather than a refactor.
 */

import hyperpopRanges from "./hyperpop.ranges.json" with { type: "json" };
import { hyperpop } from "./hyperpop.ts";
import type { Preset, RangesFile } from "./types.ts";

export interface PresetEntry {
  preset: Preset;
  ranges: RangesFile;
}

const REGISTRY: Record<string, PresetEntry> = {
  hyperpop: { preset: hyperpop, ranges: hyperpopRanges as unknown as RangesFile },
};

export const PRESET_NAMES: readonly string[] = ["hyperpop"];

export function getPreset(name: string): PresetEntry {
  const entry = REGISTRY[name];
  if (!entry) {
    throw new Error(`unknown preset "${name}" (available: ${PRESET_NAMES.join(", ")})`);
  }
  return entry;
}

/** Replaces the ranges for a preset, so the CLI can render with a proposal. */
export function withRanges(name: string, ranges: RangesFile): PresetEntry {
  return { preset: getPreset(name).preset, ranges };
}

export { hyperpop };
export * from "./types.ts";
export * from "./sampler.ts";
