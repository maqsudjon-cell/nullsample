/**
 * Arrangement.
 *
 * Variation happens here first. Two renders that differ only in melody notes
 * sound like the same track; two renders that differ in which sections exist,
 * how long they are and which buses play sound like two tracks. So the
 * arrangement is chosen before anything else and everything downstream reads
 * from it.
 */

import type { Rng } from "../core/rng.ts";

export type BusName = "drums" | "bass808" | "lead" | "arp" | "pads" | "fx";

export const BUS_NAMES: readonly BusName[] = ["drums", "bass808", "lead", "arp", "pads", "fx"];

/**
 * Intensity at or above which a section counts as a drop.
 *
 * Everything that keys off "this is a drop" reads this: the loudness
 * measurement, the auto-gain probe, drum silence, the 808 fill, the stutter.
 * It sits at 0.75 rather than 0.9 so the `sustained` template - which
 * deliberately never fully releases - still has a loudest section to gain
 * into and still gets its transitions. No other template has a section
 * between 0.62 and 1.0, so nothing else changed when it moved.
 */
export const DROP_INTENSITY = 0.75;

export type TransitionKind = "none" | "riser" | "reverse" | "impact" | "silence";

export interface SectionTemplate {
  name: string;
  /** allowed lengths in bars; one is chosen per render */
  bars: readonly number[];
  buses: readonly BusName[];
  /** 0..1, drives pattern density and drum energy */
  intensity: number;
  /** 0..1, how far the section's low-pass is open */
  filterOpen: number;
  gainDb: number;
  /** effect placed at the start of this section */
  transitionIn: TransitionKind;
  /** true if the last bar gets a drum fill */
  fillOut: boolean;
}

export interface ArrangementTemplate {
  name: string;
  sections: readonly SectionTemplate[];
}

export interface Section {
  name: string;
  startBar: number;
  bars: number;
  buses: readonly BusName[];
  intensity: number;
  filterOpen: number;
  gainDb: number;
  transitionIn: TransitionKind;
  fillOut: boolean;
  /** unique index, used to derive per-section variation */
  index: number;
}

export interface Arrangement {
  templateName: string;
  sections: Section[];
  totalBars: number;
}

export function buildArrangement(
  rng: Rng,
  templates: readonly ArrangementTemplate[],
  maxBars: number,
): Arrangement {
  const template = rng.pick(templates);
  const sections: Section[] = [];
  let bar = 0;
  let index = 0;
  for (const t of template.sections) {
    const bars = rng.pick(t.bars);
    if (bar + bars > maxBars && sections.length > 0) break;
    sections.push({
      name: t.name,
      startBar: bar,
      bars,
      buses: t.buses,
      intensity: t.intensity,
      filterOpen: t.filterOpen,
      gainDb: t.gainDb,
      transitionIn: t.transitionIn,
      fillOut: t.fillOut,
      index: index++,
    });
    bar += bars;
  }
  return { templateName: template.name, sections, totalBars: bar };
}

export function sectionAtBar(a: Arrangement, bar: number): Section | undefined {
  for (const s of a.sections) if (bar >= s.startBar && bar < s.startBar + s.bars) return s;
  return undefined;
}

export function busActiveAtBar(a: Arrangement, bus: BusName, bar: number): boolean {
  const s = sectionAtBar(a, bar);
  return s ? s.buses.includes(bus) : false;
}
