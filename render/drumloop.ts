/**
 * Drum loops, one-shots and MIDI from the same engine as the tracks.
 *
 * Not a second genre: a second surface onto the drums bus that already exists.
 * The kit is built by `sampleDrumKit`, the exact function the full tracks use,
 * so rating loops tunes the tracks' drums for free.
 *
 * Two independent axes, each with its own seed:
 *
 *   kit      what each voice sounds like
 *   pattern  where each voice plays
 *
 * and each of the four voice groups can keep its own kit seed. So the same
 * kick can be kept across a pattern reroll, or the pattern kept across a kit
 * reroll - the thing a sample library cannot do, because its files were
 * recorded once.
 *
 * SEAMLESS BY CONSTRUCTION. A loop's reverb and drive tails must arrive at the
 * top of the loop exactly as they would if it had just played. Summing a
 * truncated tail back onto the start does that for linear stages, but not for
 * the saturation after them. So the loop is rendered once as a warm-up and
 * again as the take: every stage's state at the start of the take is what the
 * end of the previous repetition left behind, which is the definition of a
 * seamless loop. Tails are shorter than one repetition, so one warm-up is
 * enough for the state to be periodic.
 */

import { renderClap, renderHat, renderKick, renderRim, renderSnare, renderTom } from "../core/drums.ts";
import { db2gain, dexp2 } from "../core/dmath.ts";
import { makeRng, normaliseSeed, type Rng } from "../core/rng.ts";
import { Reverb } from "../core/reverb.ts";
import { softClip } from "../core/shape.ts";
import type { Stereo } from "../core/buffer.ts";
import { createStereo } from "../core/buffer.ts";
import { STEPS_PER_BAR, humanise, pickPattern, toEvents, addRolls, type RollEvent } from "../compose/rhythm.ts";
import { ParamSampler } from "../presets/sampler.ts";
import type { Preset, RangesFile } from "../presets/types.ts";
import { sampleDrumKit, type DrumParams } from "./plan.ts";

/** Voice groups, which is what keep and solo act on. */
export const DRUM_GROUPS = ["kick", "snare", "hats", "perc"] as const;
export type DrumGroup = (typeof DRUM_GROUPS)[number];

/** The seven voices a loop is built from, and exported as one-shots. */
export const DRUM_VOICES = ["kick", "snare", "clap", "hatClosed", "hatOpen", "rim", "tom"] as const;
export type DrumVoice = (typeof DRUM_VOICES)[number];

const GROUP_OF: Record<DrumVoice, DrumGroup> = {
  kick: "kick",
  snare: "snare",
  clap: "snare",
  hatClosed: "hats",
  hatOpen: "hats",
  rim: "perc",
  tom: "perc",
};

/** General MIDI percussion, channel 10. */
export const GM_NOTE: Record<DrumVoice, number> = {
  kick: 36, snare: 38, clap: 39, hatClosed: 42, hatOpen: 46, rim: 37, tom: 45,
};

export interface DrumLoopOptions {
  seed: string;
  preset: Preset;
  ranges: RangesFile;
  bpm: number;
  bars: 4 | 8 | 16;
  sampleRate?: number;
  /** each 0..1: harder, busier, dirtier */
  words?: { harder?: number; busier?: number; dirtier?: number };
  /** a voice group's kit seed, kept across a reroll */
  keepKit?: Partial<Record<DrumGroup, string>>;
  /** the pattern seed, kept across a kit reroll */
  keepPattern?: string;
  /** audition one group on its own; never used by an export */
  only?: DrumGroup;
}

export interface DrumHit {
  voice: DrumVoice;
  /** position in steps from the start of the loop */
  step: number;
  velocity: number;
}

export interface DrumLoop {
  audio: Stereo;
  hits: DrumHit[];
  kit: DrumParams;
  tom: { startHz: number; endHz: number; pitchDecay: number; decay: number; noiseLevel: number };
  bpm: number;
  bars: number;
  samplesPerStep: number;
  seed: string;
  /** every drum parameter as drawn, for narrow and tune */
  params: Record<string, number>;
}

const clamp01 = (v: number | undefined) => (v === undefined ? 0 : v < 0 ? 0 : v > 1 ? 1 : v);

/** Sampled values, for the rating loop to correlate against. */
interface KitDraw { kit: DrumParams; values: Record<string, number>; choices: Record<string, string> }

/** A group's kit comes from its own seed, so keeping one group keeps only it. */
function kitFor(group: DrumGroup, opts: DrumLoopOptions, seed: string): KitDraw {
  const s = opts.keepKit?.[group] ?? seed;
  const sampler = new ParamSampler(
    makeRng(normaliseSeed(s)).child("drums").child("params"),
    opts.ranges,
    opts.preset.words,
    {},
  );
  const kit = sampleDrumKit(sampler);
  return { kit, values: sampler.values, choices: sampler.choices };
}

/**
 * Builds the loop's hits. Pure pattern: no audio, no kit.
 *
 * The same pattern repeats every bar-group of the loop so that it is a loop,
 * with a fill only in the last bar - which then leads back into bar one, the
 * way a drummer plays a looped phrase.
 */
function buildHits(opts: DrumLoopOptions, patternSeed: string, busier: number, harder: number): DrumHit[] {
  const rng = makeRng(normaliseSeed(patternSeed)).child("drumloop").child("pattern");
  const banks = opts.preset.drums;
  const intensity = 0.35 + 0.65 * busier;
  const humaniseAmount = 0.1 * (1 - harder);
  const hits: DrumHit[] = [];

  // one bar of each voice's pattern, fixed for the whole loop
  const bar: Record<string, Float32Array> = {
    kick: pickPattern(rng.child("kick"), banks.kick, intensity),
    snare: pickPattern(rng.child("snare"), banks.snare, intensity),
    clap: pickPattern(rng.child("clap"), banks.clap, intensity),
    hatClosed: pickPattern(rng.child("hatClosed"), banks.hatClosed, intensity),
    hatOpen: pickPattern(rng.child("hatOpen"), banks.hatOpen, intensity),
    rim: pickPattern(rng.child("rim"), banks.rim, intensity),
  };

  for (let b = 0; b < opts.bars; b++) {
    const barRng = rng.child(`bar${b}`);
    const lastBar = b === opts.bars - 1;
    for (const voice of ["kick", "snare", "clap", "hatClosed", "hatOpen", "rim"] as const) {
      const pattern = humanise(barRng.child(voice), bar[voice], humaniseAmount);
      let events: RollEvent[];
      if (voice === "hatClosed") {
        events = addRolls(barRng.child("roll"), pattern, {
          ...banks.rolls,
          chance: banks.rolls.chance * (0.3 + 1.2 * busier),
        });
      } else {
        events = toEvents(pattern);
      }
      for (const e of events) hits.push({ voice, step: b * STEPS_PER_BAR + e.step, velocity: e.velocity });
    }
    // a tom run through the last beat of the loop, walking back into bar one
    if (lastBar && barRng.child("tomfill").bool(0.35 + 0.5 * busier)) {
      const div = busier > 0.6 ? 2 : 1;
      for (let s = 12; s < STEPS_PER_BAR; s++) {
        for (let d = 0; d < div; d++) {
          const k = (s - 12) * div + d;
          hits.push({ voice: "tom", step: b * STEPS_PER_BAR + s + d / div, velocity: 0.65 + 0.08 * k });
        }
      }
    }
  }
  hits.sort((a, b) => a.step - b.step);
  return hits;
}

export function renderDrumLoop(opts: DrumLoopOptions): DrumLoop {
  const sr = opts.sampleRate ?? 44100;
  const seed = normaliseSeed(opts.seed);
  const harder = clamp01(opts.words?.harder);
  const busier = clamp01(opts.words?.busier);
  const dirtier = clamp01(opts.words?.dirtier);

  // --- kit: each group from its own (possibly kept) seed -------------------
  const draws: Record<DrumGroup, KitDraw> = {
    kick: kitFor("kick", opts, seed),
    snare: kitFor("snare", opts, seed),
    hats: kitFor("hats", opts, seed),
    perc: kitFor("perc", opts, seed),
  };
  const kits: Record<DrumGroup, DrumParams> = {
    kick: draws.kick.kit, snare: draws.snare.kit, hats: draws.hats.kit, perc: draws.perc.kit,
  };
  // Each group's parameters come from its own draw, so a kept kick reports
  // the kick values that were actually heard.
  const params: Record<string, number> = {};
  const pick = (g: DrumGroup, prefix: string[]) => {
    for (const [k, v] of Object.entries(draws[g].values)) if (prefix.some((p) => k.startsWith(p))) params[k] = v;
  };
  pick("kick", ["drums.kick."]);
  pick("snare", ["drums.snare.", "drums.clap."]);
  pick("hats", ["drums.hat."]);
  pick("perc", ["drums.rim."]);
  pick("kick", ["drums.busDrive", "drums.gainDb", "drums.humanise", "drums.rollChance"]);
  const kit: DrumParams = {
    ...kits.kick,
    kick: kits.kick.kick,
    snare: kits.snare.snare,
    clap: kits.snare.clap,
    hatClosed: kits.hats.hatClosed,
    hatOpen: kits.hats.hatOpen,
    hatPan: kits.hats.hatPan,
    rim: kits.perc.rim,
  };
  // "harder": more drive into each voice
  kit.kick = { ...kit.kick, drive: kit.kick.drive * (1 + 0.8 * harder) };
  kit.snare = { ...kit.snare, drive: kit.snare.drive * (1 + 0.8 * harder) };
  const tomRng = makeRng(normaliseSeed(opts.keepKit?.perc ?? seed)).child("drumloop").child("tom");
  const tom = {
    startHz: 150 + 90 * tomRng.float(),
    endHz: 70 + 40 * tomRng.float(),
    pitchDecay: 0.03 + 0.04 * tomRng.float(),
    decay: 0.22 + 0.18 * tomRng.float(),
    noiseLevel: 0.08 + 0.12 * tomRng.float(),
  };

  // --- pattern --------------------------------------------------------------
  const patternSeed = opts.keepPattern ?? seed;
  const hits = buildHits(opts, patternSeed, busier, harder);

  // --- one rendered buffer per voice, reused for every hit ------------------
  const voiceRng = (v: DrumVoice) =>
    makeRng(normaliseSeed(opts.keepKit?.[GROUP_OF[v]] ?? seed)).child("drumloop").child(`voice-${v}`);
  const buffers: Record<DrumVoice, Float32Array> = {
    kick: renderKick(sr, kit.kick, voiceRng("kick")),
    snare: renderSnare(sr, kit.snare, voiceRng("snare")),
    clap: renderClap(sr, kit.clap, voiceRng("clap")),
    hatClosed: renderHat(sr, kit.hatClosed, voiceRng("hatClosed")),
    hatOpen: renderHat(sr, kit.hatOpen, voiceRng("hatOpen")),
    rim: renderRim(sr, kit.rim, voiceRng("rim")),
    tom: renderTom(sr, tom, voiceRng("tom")),
  };
  const gains: Record<DrumVoice, number> = {
    kick: db2gain(kit.kick.gainDb),
    snare: db2gain(kit.snare.gainDb),
    clap: db2gain(kit.clap.gainDb),
    hatClosed: db2gain(kit.hatClosed.gainDb),
    hatOpen: db2gain(kit.hatOpen.gainDb),
    rim: db2gain(kit.rim.gainDb),
    tom: db2gain(-4),
  };

  // --- exact length: N bars at the stated tempo ---------------------------
  const samplesPerStep = (sr * 60) / opts.bpm / 4;
  const loopLen = Math.round(samplesPerStep * STEPS_PER_BAR * opts.bars);

  // Warm-up repetition, then the take: see the header for why.
  const total = loopLen * 2;
  const dryL = new Float32Array(total);
  const dryR = new Float32Array(total);
  const pan = kit.hatPan;
  for (let rep = 0; rep < 2; rep++) {
    for (const h of hits) {
      if (opts.only && GROUP_OF[h.voice] !== opts.only) continue;
      const at = rep * loopLen + Math.round(h.step * samplesPerStep);
      const buf = buffers[h.voice];
      const g = gains[h.voice] * h.velocity;
      const isHat = h.voice === "hatClosed" || h.voice === "hatOpen";
      const gl = isHat ? g * (1 - pan * 0.5) : g;
      const gr = isHat ? g * (1 + pan * 0.5) : g;
      // an open hat is choked by the next closed hat, as on the machine
      let len = buf.length;
      if (h.voice === "hatOpen") {
        const next = hits.find((x) => x.voice === "hatClosed" && x.step > h.step);
        if (next) len = Math.min(len, Math.round((next.step - h.step) * samplesPerStep));
      }
      for (let i = 0; i < len; i++) {
        // wrap past the end of the take back onto its start: a hit near the
        // end of the loop rings into bar one, exactly as it would on repeat
        const j = (at + i) % total;
        dryL[j] += buf[i] * gl;
        dryR[j] += buf[i] * gr;
      }
    }
  }

  // --- bus: drive, a room, and "dirtier" --------------------------------
  const reverb = new Reverb(sr, 0);
  reverb.decay = 0.9 + 0.8 * (1 - harder);
  reverb.size = 0.7;
  reverb.brightness = 0.55;
  reverb.preDelaySeconds = 0.012;
  const send = 0.12;
  const drive = kit.busDrive * (1 + 1.4 * dirtier);
  // `**` on a non-integer exponent is one of the implementation-approximated
  // operations; dexp2 is the exact-arithmetic one the engine uses everywhere
  const crushLevels = dirtier > 0.55 ? Math.round(dexp2(12 - 6 * dirtier)) : 0;
  const frame = new Float64Array(2);
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    reverb.process((dryL[i] + dryR[i]) * 0.5 * send, frame);
    let l = softClip((dryL[i] + frame[0]) * drive);
    let r = softClip((dryR[i] + frame[1]) * drive);
    if (crushLevels > 0) {
      l = Math.round(l * crushLevels) / crushLevels;
      r = Math.round(r * crushLevels) / crushLevels;
    }
    outL[i] = l;
    outR[i] = r;
  }

  // --- the take: the second repetition, then peak-normalise ---------------
  const audio = createStereo(loopLen, sr);
  let peak = 0;
  for (let i = 0; i < loopLen; i++) {
    const l = outL[loopLen + i];
    const r = outR[loopLen + i];
    audio.L[i] = l;
    audio.R[i] = r;
    const a = l < 0 ? -l : l;
    const b = r < 0 ? -r : r;
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  // -1 dBFS; a loop is an offline export, so normalising its own peak is fine
  const norm = peak > 1e-9 ? db2gain(-1) / peak : 1;
  for (let i = 0; i < loopLen; i++) {
    audio.L[i] *= norm;
    audio.R[i] *= norm;
  }

  return { audio, hits, kit, tom, bpm: opts.bpm, bars: opts.bars, samplesPerStep, seed, params };
}

/**
 * One-shots, each the exact buffer the loop used for that voice, so the kit
 * you download is the kit you heard. Peak-normalised to -1 dBFS.
 */
export function renderOneShots(opts: DrumLoopOptions): Record<DrumVoice, Stereo> {
  const loop = renderDrumLoop({ ...opts, only: undefined });
  const sr = opts.sampleRate ?? 44100;
  const seed = normaliseSeed(opts.seed);
  const voiceRng = (v: DrumVoice) =>
    makeRng(normaliseSeed(opts.keepKit?.[GROUP_OF[v]] ?? seed)).child("drumloop").child(`voice-${v}`);
  const raw: Record<DrumVoice, Float32Array> = {
    kick: renderKick(sr, loop.kit.kick, voiceRng("kick")),
    snare: renderSnare(sr, loop.kit.snare, voiceRng("snare")),
    clap: renderClap(sr, loop.kit.clap, voiceRng("clap")),
    hatClosed: renderHat(sr, loop.kit.hatClosed, voiceRng("hatClosed")),
    hatOpen: renderHat(sr, loop.kit.hatOpen, voiceRng("hatOpen")),
    rim: renderRim(sr, loop.kit.rim, voiceRng("rim")),
    tom: renderTom(sr, loop.tom, voiceRng("tom")),
  };
  const out = {} as Record<DrumVoice, Stereo>;
  for (const v of DRUM_VOICES) {
    const b = raw[v];
    let peak = 0;
    for (let i = 0; i < b.length; i++) {
      const a = b[i] < 0 ? -b[i] : b[i];
      if (a > peak) peak = a;
    }
    const g = peak > 1e-9 ? db2gain(-1) / peak : 1;
    const s = createStereo(b.length, sr);
    for (let i = 0; i < b.length; i++) {
      s.L[i] = b[i] * g;
      s.R[i] = b[i] * g;
    }
    out[v] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------

const PPQ = 480;

function vlq(n: number): number[] {
  let v = n >>> 0;
  const bytes = [v & 0x7f];
  v >>>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return bytes;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/**
 * A type-0 Standard MIDI File: tempo, 4/4, and every hit on channel 10 with
 * General MIDI drum numbers. Positions are the loop's own, rounded to a
 * 480-PPQ tick, so the MIDI and the audio land on the same beats.
 */
export function drumLoopToMidi(loop: DrumLoop): Uint8Array {
  const ticksPerStep = PPQ / 4;
  const loopTicks = Math.round(loop.bars * STEPS_PER_BAR * ticksPerStep);
  const noteLen = Math.round(ticksPerStep / 2);
  const tempoUs = Math.round(60_000_000 / loop.bpm);

  type Ev = { tick: number; bytes: number[]; order: number };
  const evs: Ev[] = [];
  evs.push({ tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (tempoUs >> 16) & 0xff, (tempoUs >> 8) & 0xff, tempoUs & 0xff] });
  evs.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] });
  evs.push({ tick: 0, order: 0, bytes: [0xff, 0x03, 9, ...Array.from("Nullsample").slice(0, 9).map((c) => c.charCodeAt(0))] });
  for (const h of loop.hits) {
    const tick = Math.min(loopTicks - 1, Math.max(0, Math.round(h.step * ticksPerStep)));
    const vel = Math.max(1, Math.min(127, Math.round(h.velocity * 127)));
    const note = GM_NOTE[h.voice];
    evs.push({ tick, order: 2, bytes: [0x99, note, vel] });
    evs.push({ tick: Math.min(loopTicks, tick + noteLen), order: 1, bytes: [0x89, note, 0] });
  }
  // note-offs before note-ons on the same tick, so repeated hits retrigger
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  let last = 0;
  for (const e of evs) {
    track.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  // end of track exactly at the loop length, so a DAW loops it at the bar line
  track.push(...vlq(loopTicks - last), 0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
  const chunk = [0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track];
  return Uint8Array.from([...header, ...chunk]);
}

export type { Rng };
