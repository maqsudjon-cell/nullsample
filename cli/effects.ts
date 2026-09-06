/**
 * Arrangement-effect inventory.
 *
 *   npm run effects -- --preset hyperpop --seeds 20
 *
 * Answers three questions for every effect the main spec listed: is it
 * implemented, does it fire in a normal render, and how often across N seeds.
 *
 * It reads the plan only — no audio is rendered — because every arrangement
 * effect is placed at plan time. Twenty seeds take well under a second, so this
 * is cheap enough to run on every change.
 *
 * An effect that is implemented but never fires is a trigger bug. An effect
 * that is not implemented is a gap: it is listed here with its status, and it
 * is not silently added.
 */

import { DROP_INTENSITY } from "../compose/arrange.ts";
import { buildPlan } from "../render/plan.ts";
import { getPreset } from "../presets/index.ts";
import { num, parseArgs, str } from "./args.ts";

/**
 * The FX set named in the main spec, in the order it was named there. `kind`
 * matches EffectEvent.kind when implemented; a null kind means the effect does
 * not exist in the engine yet.
 */
const SPEC_EFFECTS: { label: string; kind: string | null; note: string }[] = [
  { label: "filtered-noise riser into each drop", kind: "noise riser into drop", note: "" },
  { label: "downlifter after a drop", kind: "downlifter after drop", note: "" },
  { label: "reverse-reverb swell before section change", kind: "reverse swell before section", note: "" },
  { label: "tape stop (one per track)", kind: "tape stop", note: "" },
  { label: "dub delay throw", kind: "dub delay throw", note: "" },
  { label: "glitch / stutter repeat before a drop", kind: "glitch stutter before drop", note: "" },
  { label: "bitcrushed transition (one per track)", kind: "bitcrushed transition", note: "" },
  { label: "808-tuned fill into a drop", kind: "808-tuned fill into drop", note: "" },
  { label: "total drum silence before a drop", kind: "drum silence before drop", note: "" },
];

/** Implemented and firing, but not on the spec's list. Reported for completeness. */
const EXTRA_KINDS = ["impact on drop", "drum fill"];

const args = parseArgs(process.argv.slice(2));
const presetName = str(args, "preset", "hyperpop");
const seedCount = Math.max(1, Math.round(num(args, "seeds", 20)));
const base = str(args, "base", "e");
const sampleRate = num(args, "rate", 44100);

const { preset, ranges } = getPreset(presetName);

const totals = new Map<string, number>();
const seedsWith = new Map<string, number>();
const perSeed: { seed: string; counts: Map<string, number> }[] = [];
/** template -> [tracks, drops, silences placed] */
const byTemplate = new Map<string, [number, number, number]>();

for (let i = 0; i < seedCount; i++) {
  const seed = `${base}${String(i + 1).padStart(4, "0")}`;
  const plan = buildPlan({ seed, preset, ranges, sampleRate });
  const counts = new Map<string, number>();
  for (const e of plan.effects) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  for (const [kind, n] of counts) {
    totals.set(kind, (totals.get(kind) ?? 0) + n);
    seedsWith.set(kind, (seedsWith.get(kind) ?? 0) + 1);
  }
  perSeed.push({ seed, counts });

  const t = plan.arrangement.templateName;
  const drops = plan.arrangement.sections.filter((x) => x.intensity >= DROP_INTENSITY).length;
  const prev = byTemplate.get(t) ?? [0, 0, 0];
  byTemplate.set(t, [
    prev[0] + 1,
    prev[1] + drops,
    prev[2] + (counts.get("drum silence before drop") ?? 0),
  ]);
}

const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);
const padL = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;

console.log(`\nARRANGEMENT EFFECT INVENTORY — ${presetName}, ${seedCount} seeds (${base}0001..)\n`);
console.log(
  pad("effect", 50) + pad("implemented", 13) + padL("seeds", 7) + padL("total", 7) +
  padL("per track", 11) + "  status",
);
console.log("-".repeat(104));

const row = (label: string, kind: string | null, note: string) => {
  if (kind === null) {
    console.log(pad(label, 50) + pad("no", 13) + padL("-", 7) + padL("-", 7) + padL("-", 11) + "  GAP");
    return;
  }
  const seeds = seedsWith.get(kind) ?? 0;
  const total = totals.get(kind) ?? 0;
  const per = seeds === 0 ? 0 : total / seedCount;
  const status = total === 0 ? "TRIGGER BUG — never fires"
    : seeds < seedCount ? `fires in ${seeds}/${seedCount}`
    : "fires every track";
  console.log(
    pad(label, 50) + pad("yes", 13) + padL(`${seeds}/${seedCount}`, 7) + padL(String(total), 7) +
    padL(per.toFixed(2), 11) + "  " + status,
  );
};

for (const e of SPEC_EFFECTS) row(e.label, e.kind, e.note);
console.log("");
for (const kind of EXTRA_KINDS) row(kind + "  (not on spec list)", kind, "");

const gaps = SPEC_EFFECTS.filter((e) => e.kind === null);
if (gaps.length > 0) {
  console.log(`\nGAPS — listed, not added:\n`);
  for (const g of gaps) console.log(`  ${pad(g.label, 50)} ${g.note}`);
}

const bugs = SPEC_EFFECTS.filter((e) => e.kind !== null && (totals.get(e.kind) ?? 0) === 0);
if (bugs.length > 0) {
  console.log(`\nTRIGGER BUGS — implemented but never fired in ${seedCount} seeds:\n`);
  for (const b of bugs) console.log(`  ${b.label}`);
}

console.log(`\nDrum silence by arrangement template — the ceiling is structural:\n`);
console.log(pad("template", 16) + padL("tracks", 8) + padL("drops", 8) + padL("silences", 10) + padL("per drop", 10));
for (const [t, [tracks, drops, sil]] of [...byTemplate].sort()) {
  console.log(pad(t, 16) + padL(String(tracks), 8) + padL(String(drops), 8) + padL(String(sil), 10) +
    padL((sil / drops).toFixed(2), 10));
}
console.log(
  "\nA drop can only have its drums cut if drums are playing into it. Templates whose\n" +
  "drops are all preceded by a drumless break offer no candidate at all.",
);

console.log(`\nPer-seed detail:\n`);
const kinds = [...new Set([...SPEC_EFFECTS.map((e) => e.kind), ...EXTRA_KINDS])].filter((k): k is string => k !== null);
const short = (k: string) => k === "noise riser into drop" ? "riser"
  : k === "reverse swell before section" ? "reverse"
  : k === "drum silence before drop" ? "silence"
  : k === "impact on drop" ? "impact" : k === "drum fill" ? "fill"
  : k === "downlifter after drop" ? "downlift" : k === "tape stop" ? "tapestop"
  : k === "dub delay throw" ? "throw" : k === "glitch stutter before drop" ? "stutter"
  : k === "bitcrushed transition" ? "crush" : k === "808-tuned fill into drop" ? "808fill"
  : k.slice(0, 9);
console.log(pad("seed", 10) + kinds.map((k) => padL(short(k), 10)).join(""));
for (const s of perSeed) {
  console.log(pad(s.seed, 10) + kinds.map((k) => padL(String(s.counts.get(k) ?? 0), 10)).join(""));
}
console.log("");
