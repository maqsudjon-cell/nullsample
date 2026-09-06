/**
 * The musical plan.
 *
 * Everything a render needs is decided here, before a single sample is
 * computed: tempo, key, chord loop, arrangement, every note and every drum
 * hit, and every sampled parameter value.
 *
 * Per-bus seeding lives here too. Each bus draws from a named child stream of
 * its own effective seed, so locking a bus and rerolling the rest cannot
 * disturb it. Locking any bus also pins the structure - tempo, key and chord
 * loop - because a locked bass line over a new key is not a feature.
 */

import { clamp, db2gain, dlog2, midiToHz } from "../core/dmath.ts";
import { makeRng, normaliseSeed, type Rng } from "../core/rng.ts";
import type { Note808 } from "../core/bass808.ts";
import {
  buildArrangement, DROP_INTENSITY, type Arrangement, type BusName, type Section,
} from "../compose/arrange.ts";
import {
  buildHarmony, chordAtBar, degreeSemitone, voiceChord, type Harmony,
} from "../compose/harmony.ts";
import { buildFourBarHook, repeatHook, type Contour, type MotifNote, type MotifSpec } from "../compose/motif.ts";
import {
  addRolls, buildFill, humanise, pickPattern, STEPS_PER_BAR, toEvents, type RollEvent,
} from "../compose/rhythm.ts";
import type { MixEffect, MixThrow } from "./transitions.ts";
import { ParamSampler, type WordValues } from "../presets/sampler.ts";
import type { Preset, RangesFile } from "../presets/types.ts";

export type DrumVoice = "kick" | "snare" | "clap" | "hatClosed" | "hatOpen" | "rim";

export interface DrumEvent {
  voice: DrumVoice;
  /** absolute sample position */
  at: number;
  velocity: number;
  /** which cached timbre variant to use */
  variant: number;
}

export interface NoteEvent {
  start: number;
  length: number;
  midi: number;
  velocity: number;
}

export interface ChordEvent {
  start: number;
  length: number;
  notes: number[];
}

export type FxKind = "riser" | "impact" | "reverse" | "downlifter";

export interface FxEvent {
  kind: FxKind;
  start: number;
  length: number;
  level: number;
}

/** One arrangement effect that was actually placed, for the inventory. */
export interface EffectEvent {
  kind: string;
  /** absolute sample position */
  at: number;
  /** length in samples, 0 for a point event */
  length: number;
  /** the section it leads into or belongs to */
  section: string;
}

export interface SectionMark {
  name: string;
  startSample: number;
  endSample: number;
  intensity: number;
  filterOpen: number;
  gainDb: number;
}

export interface DrumParams {
  kick: { startHz: number; endHz: number; pitchDecay: number; ampDecay: number; clickLevel: number; clickDecay: number; drive: number; bodyLevel: number; gainDb: number };
  snare: { toneHz: number; toneDecay: number; noiseDecay: number; noiseLowHz: number; noiseHighHz: number; noiseLevel: number; toneLevel: number; drive: number; gainDb: number };
  clap: { bursts: number; spacing: number; spread: number; bandLowHz: number; bandHighHz: number; burstDecay: number; tailDecay: number; tailLevel: number; gainDb: number };
  hatClosed: { decay: number; baseHz: number; highpassHz: number; bandHz: number; bandQ: number; noiseMix: number; gainDb: number };
  hatOpen: { decay: number; baseHz: number; highpassHz: number; bandHz: number; bandQ: number; noiseMix: number; gainDb: number };
  rim: { hz: number; q: number; decay: number; clickLevel: number; gainDb: number };
  hatPan: number;
  busDrive: number;
  gainDb: number;
}

export interface BassParams {
  dropSemitones: number; dropTime: number; decay: number; attack: number;
  drive: number; subLevel: number; toneHz: number; portamento: number;
  distDrive: number; fold: number; bias: number; ceiling: number; gainDb: number;
}

export type KickVariant = "balanced" | "sub" | "click";
export type SnareVariant = "balanced" | "noise" | "tonal";

export const KICK_VARIANTS: readonly KickVariant[] = ["balanced", "sub", "click"];
export const SNARE_VARIANTS: readonly SnareVariant[] = ["balanced", "noise", "tonal"];

export type LeadArchitecture = "supersaw" | "pulseStack" | "syncSaw" | "fmPair";

export const LEAD_ARCHITECTURES: readonly LeadArchitecture[] = [
  "supersaw", "pulseStack", "syncSaw", "fmPair",
];

export interface LeadParams {
  /** which oscillator architecture builds this track's lead */
  architecture: LeadArchitecture;
  /** pulseStack */
  pulseWidthCentre: number; pulseWidthDepth: number;
  /** syncSaw */
  syncRatio: number;
  /** fmPair */
  fmRatio: number; fmIndex: number;
  voices: number; detuneCents: number; spread: number;
  attack: number; decay: number; sustain: number; release: number;
  filterHz: number; filterQ: number; envAmount: number;
  distDrive: number; fold: number; bias: number; ceiling: number;
  chorusDepth: number; delaySend: number; reverbSend: number;
  duckAmount: number; gainDb: number;
}

export interface ArpParams {
  pulseWidth: number; filterHz: number; filterQ: number; decay: number;
  spread: number; reverbSend: number; delaySend: number; duckAmount: number; gainDb: number;
}

export interface PadParams {
  attack: number; release: number; filterHz: number; filterQ: number;
  formantMix: number; detuneCents: number; spread: number;
  reverbSend: number; duckAmount: number; gainDb: number;
}

export interface FxParams {
  riserStartHz: number; riserEndHz: number;
  impactLevel: number; impactDecay: number;
  reverbSend: number; gainDb: number;
}

export interface MasterParams {
  /** short-term RMS the loudest section is driven to before the chain */
  driveTargetDb: number;
  glueThresholdDb: number; glueRatio: number; glueAttack: number; glueRelease: number;
  satDrive: number; shelfHz: number; shelfDb: number;
  clipCeiling: number; targetPeakDb: number; widthMid: number;
}

export interface SendParams {
  reverb: { decay: number; brightness: number; size: number; preDelay: number; duckAmount: number; returnDb: number };
  delay: { feedback: number; damping: number; returnDb: number; timeL: number; timeR: number };
}

export interface DuckParams {
  depth: number;
  attack: number;
  release: number;
}

export interface TrackPlan {
  seed: string;
  presetName: string;
  sampleRate: number;
  tempo: number;
  bars: number;
  totalSamples: number;
  samplesPerBar: number;
  samplesPerStep: number;
  harmony: Harmony;
  arrangement: Arrangement;
  sections: SectionMark[];

  drumEvents: DrumEvent[];
  kickPositions: number[];
  bassNotes: Note808[];
  leadNotes: NoteEvent[];
  arpNotes: NoteEvent[];
  padChords: ChordEvent[];
  fxEvents: FxEvent[];
  /** every arrangement effect placed, for `npm run effects` */
  effects: EffectEvent[];
  /** effects applied to the finished mix: tape stop, stutter, bitcrush */
  mixEffects: MixEffect[];
  /** momentary delay-send openings on the lead */
  delayThrows: MixThrow[];

  drum: DrumParams;
  bass: BassParams;
  lead: LeadParams;
  arp: ArpParams;
  pads: PadParams;
  fx: FxParams;
  master: MasterParams;
  sends: SendParams;
  duck: DuckParams;

  /** every numeric parameter value sampled, for the batch record */
  params: Record<string, number>;
  /** every categorical choice made */
  choices: Record<string, string>;
  /** which buses were locked, and to what seed */
  locks: Record<string, string>;
}

export interface PlanOptions {
  seed: string | number;
  preset: Preset;
  ranges: RangesFile;
  sampleRate: number;
  /** bus name -> seed to pin that bus to */
  locks?: Partial<Record<BusName | "structure", string>>;
  words?: WordValues;
}

const DRUM_VOICES: readonly DrumVoice[] = ["kick", "snare", "clap", "hatClosed", "hatOpen", "rim"];

/** Length of one hook unit: bars 1 and 3 identical, 2 an answer, 4 the variation. */
const HOOK_BARS = 4;

/** The 808's register at `bass.octave` 0, in MIDI notes. C1 to A2. */
const BASS_REGISTER_LO = 24;
const BASS_REGISTER_HI = 45;

export function buildPlan(opts: PlanOptions): TrackPlan {
  const seed = normaliseSeed(opts.seed);
  const { preset, ranges, sampleRate } = opts;
  const locks = opts.locks ?? {};
  const words = opts.words ?? {};

  // Locking any bus pins the structure: a locked bass line makes no sense over
  // a key it was not written for.
  const anyBusLocked = (Object.keys(locks) as (BusName | "structure")[]).some(
    (k) => k !== "structure" && locks[k] !== undefined,
  );
  const structureSeed = locks.structure ?? (anyBusLocked ? (firstLock(locks) ?? seed) : seed);
  const busSeed = (bus: BusName): string => locks[bus] ?? seed;

  const structRng = makeRng(structureSeed).child("structure");
  const sampler = new ParamSampler(structRng.child("params"), ranges, preset.words, words);

  // --- tempo, key, chord loop --------------------------------------------
  const tempo = sampler.num("tempo");
  const samplesPerBar = Math.round((sampleRate * 4 * 60) / tempo);
  const samplesPerStep = samplesPerBar / STEPS_PER_BAR;

  const harmonyRng = structRng.child("harmony");
  const tonicMidi = sampler.choice("key", preset.harmony.tonics);
  const scaleName = sampler.choice("scale", preset.harmony.scales);
  const degrees = sampler.choice("chords", preset.harmony.degreeSets);
  const barsPerChord = sampler.int("barsPerChord");
  const harmony = buildHarmony(harmonyRng, {
    tonicMidi,
    scaleName,
    degrees,
    voicings: preset.harmony.voicings,
    barsPerChord,
  });

  // --- arrangement --------------------------------------------------------
  const arrangement = buildArrangement(
    structRng.child("arrangement"),
    preset.arrangements,
    preset.maxBars,
  );
  sampler.choices["arrangement"] = arrangement.templateName;

  const bars = arrangement.totalBars;
  // room for the last reverb tail and the release of the final notes
  const tailSamples = Math.round(sampleRate * 2.5);
  const totalSamples = bars * samplesPerBar + tailSamples;

  const sections: SectionMark[] = arrangement.sections.map((s) => ({
    name: s.name,
    startSample: s.startBar * samplesPerBar,
    endSample: (s.startBar + s.bars) * samplesPerBar,
    intensity: s.intensity,
    filterOpen: s.filterOpen,
    gainDb: s.gainDb,
  }));

  // --- per-bus samplers ---------------------------------------------------
  const mk = (bus: BusName) =>
    new ParamSampler(makeRng(busSeed(bus)).child(bus).child("params"), ranges, preset.words, words);
  const sDrums = mk("drums");
  const sBass = mk("bass808");
  const sLead = mk("lead");
  const sArp = mk("arp");
  const sPads = mk("pads");
  const sFx = mk("fx");

  const drum: DrumParams = {
    kick: {
      startHz: sDrums.num("drums.kick.startHz"),
      endHz: sDrums.num("drums.kick.endHz"),
      pitchDecay: sDrums.num("drums.kick.pitchDecay"),
      ampDecay: sDrums.num("drums.kick.ampDecay"),
      clickLevel: sDrums.num("drums.kick.clickLevel"),
      clickDecay: sDrums.num("drums.kick.clickDecay"),
      drive: sDrums.num("drums.kick.drive"),
      bodyLevel: 1,
      gainDb: sDrums.num("drums.kick.gainDb"),
    },
    snare: {
      toneHz: sDrums.num("drums.snare.toneHz"),
      toneDecay: sDrums.num("drums.snare.toneDecay"),
      noiseDecay: sDrums.num("drums.snare.noiseDecay"),
      noiseLowHz: sDrums.num("drums.snare.noiseLowHz"),
      noiseHighHz: sDrums.num("drums.snare.noiseHighHz"),
      noiseLevel: sDrums.num("drums.snare.noiseLevel"),
      toneLevel: sDrums.num("drums.snare.toneLevel"),
      drive: sDrums.num("drums.snare.drive"),
      gainDb: sDrums.num("drums.snare.gainDb"),
    },
    clap: {
      bursts: sDrums.int("drums.clap.bursts"),
      spacing: sDrums.num("drums.clap.spacing"),
      spread: sDrums.num("drums.clap.spread"),
      bandLowHz: sDrums.num("drums.clap.bandLowHz"),
      bandHighHz: sDrums.num("drums.clap.bandHighHz"),
      burstDecay: sDrums.num("drums.clap.burstDecay"),
      tailDecay: sDrums.num("drums.clap.tailDecay"),
      tailLevel: sDrums.num("drums.clap.tailLevel"),
      gainDb: sDrums.num("drums.clap.gainDb"),
    },
    hatClosed: {
      decay: sDrums.num("drums.hat.closedDecay"),
      baseHz: sDrums.num("drums.hat.baseHz"),
      highpassHz: sDrums.num("drums.hat.highpassHz"),
      bandHz: sDrums.num("drums.hat.bandHz"),
      bandQ: sDrums.num("drums.hat.bandQ"),
      noiseMix: sDrums.num("drums.hat.noiseMix"),
      gainDb: sDrums.num("drums.hat.gainDb"),
    },
    hatOpen: {
      decay: sDrums.num("drums.hat.openDecay"),
      baseHz: 0,
      highpassHz: 0,
      bandHz: 0,
      bandQ: 0,
      noiseMix: 0,
      gainDb: 0,
    },
    // The rim is a ghost layer, not a tunable voice. Even with its buffer
    // normalised it sits about 27 dB under the mix peak, and 16 dB of gain
    // swing moves the mix by 0.016 dB - five parameters of tuning attention
    // for nothing. Fixed rather than sampled, and dropped from the ranges
    // file, but kept: 128 quiet clicks a track are motion the mix would miss.
    rim: {
      hz: sDrums.fixed("drums.rim.hz", 1700),
      q: sDrums.fixed("drums.rim.q", 10),
      decay: sDrums.fixed("drums.rim.decay", 0.05),
      clickLevel: sDrums.fixed("drums.rim.clickLevel", 0.55),
      gainDb: sDrums.fixed("drums.rim.gainDb", -16),
    },
    hatPan: sDrums.num("drums.hat.pan"),
    busDrive: sDrums.num("drums.busDrive"),
    gainDb: sDrums.num("drums.gainDb"),
  };
  // the open hat shares the closed hat's voice, only longer and slightly darker
  drum.hatOpen.baseHz = drum.hatClosed.baseHz;
  drum.hatOpen.highpassHz = drum.hatClosed.highpassHz * 0.92;
  drum.hatOpen.bandHz = drum.hatClosed.bandHz * 0.95;
  drum.hatOpen.bandQ = drum.hatClosed.bandQ * 0.9;
  drum.hatOpen.noiseMix = drum.hatClosed.noiseMix;
  drum.hatOpen.gainDb = drum.hatClosed.gainDb - 1.5;

  // --- drum voice variants -------------------------------------------------
  //
  // The kick and snare renderers already span these timbres; what was missing
  // was anything choosing between them. A seed drew a point in the middle of
  // every range and every track got the same balanced kick. These profiles
  // push the balance to one end or the other, so a listener hears a different
  // drum rather than the same drum retuned. The renderers are untouched.
  const kickVariant = sDrums.choice("drums.kick.variant", KICK_VARIANTS);
  if (kickVariant === "sub") {
    drum.kick.endHz *= 0.86;
    drum.kick.ampDecay *= 1.45;
    drum.kick.clickLevel *= 0.35;
    drum.kick.bodyLevel *= 1.15;
    drum.kick.pitchDecay *= 1.3;
  } else if (kickVariant === "click") {
    drum.kick.endHz *= 1.12;
    drum.kick.ampDecay *= 0.62;
    drum.kick.clickLevel = Math.min(1.6, drum.kick.clickLevel * 2.6 + 0.25);
    drum.kick.clickDecay *= 1.5;
    drum.kick.startHz *= 1.25;
  }

  const snareVariant = sDrums.choice("drums.snare.variant", SNARE_VARIANTS);
  if (snareVariant === "noise") {
    drum.snare.noiseLevel = Math.min(1, drum.snare.noiseLevel * 1.45);
    drum.snare.toneLevel *= 0.4;
    drum.snare.noiseDecay *= 1.35;
    drum.snare.noiseHighHz *= 1.15;
  } else if (snareVariant === "tonal") {
    drum.snare.toneLevel = Math.min(1, drum.snare.toneLevel * 1.9);
    drum.snare.noiseLevel *= 0.55;
    drum.snare.toneDecay *= 1.6;
    drum.snare.noiseLowHz *= 1.4;
  }

  const bassOctave = sBass.int("bass.octave");
  const bass: BassParams = {
    dropSemitones: sBass.num("bass.dropSemitones"),
    dropTime: sBass.num("bass.dropTime"),
    decay: sBass.num("bass.decay"),
    attack: sBass.num("bass.attack"),
    drive: sBass.num("bass.drive"),
    subLevel: sBass.num("bass.subLevel"),
    toneHz: sBass.num("bass.toneHz"),
    portamento: sBass.num("bass.portamento"),
    distDrive: sBass.num("bass.distDrive"),
    fold: sBass.num("bass.fold"),
    bias: sBass.num("bass.bias"),
    ceiling: sBass.num("bass.ceiling"),
    gainDb: sBass.num("bass.gainDb"),
  };

  const leadOctave = sLead.int("lead.octave");
  const lead: LeadParams = {
    architecture: sLead.choice("lead.architecture", LEAD_ARCHITECTURES),
    pulseWidthCentre: sLead.num("lead.pulseWidthCentre"),
    pulseWidthDepth: sLead.num("lead.pulseWidthDepth"),
    syncRatio: sLead.num("lead.syncRatio"),
    fmRatio: sLead.num("lead.fmRatio"),
    fmIndex: sLead.num("lead.fmIndex"),
    voices: sLead.int("lead.voices"),
    detuneCents: sLead.num("lead.detuneCents"),
    spread: Math.min(1, sLead.num("lead.spread")),
    attack: sLead.num("lead.attack"),
    decay: sLead.num("lead.decay"),
    sustain: sLead.num("lead.sustain"),
    release: sLead.num("lead.release"),
    filterHz: sLead.num("lead.filterHz"),
    filterQ: sLead.num("lead.filterQ"),
    envAmount: sLead.num("lead.envAmount"),
    distDrive: sLead.num("lead.distDrive"),
    fold: sLead.num("lead.fold"),
    bias: sLead.num("lead.bias"),
    ceiling: Math.min(0.98, sLead.num("lead.ceiling")),
    chorusDepth: sLead.num("lead.chorusDepth"),
    delaySend: sLead.num("lead.delaySend"),
    reverbSend: sLead.num("lead.reverbSend"),
    duckAmount: Math.min(1, sLead.num("lead.duckAmount")),
    gainDb: sLead.num("lead.gainDb"),
  };

  const arpOctave = sArp.int("arp.octave");
  const arp: ArpParams = {
    pulseWidth: sArp.num("arp.pulseWidth"),
    filterHz: sArp.num("arp.filterHz"),
    filterQ: sArp.num("arp.filterQ"),
    decay: sArp.num("arp.decay"),
    spread: Math.min(1, sArp.num("arp.spread")),
    reverbSend: sArp.num("arp.reverbSend"),
    delaySend: sArp.num("arp.delaySend"),
    duckAmount: Math.min(1, sArp.num("arp.duckAmount")),
    gainDb: sArp.num("arp.gainDb"),
  };

  const pads: PadParams = {
    attack: sPads.num("pads.attack"),
    release: sPads.num("pads.release"),
    filterHz: sPads.num("pads.filterHz"),
    filterQ: sPads.num("pads.filterQ"),
    formantMix: sPads.num("pads.formantMix"),
    detuneCents: sPads.num("pads.detuneCents"),
    spread: Math.min(1, sPads.num("pads.spread")),
    reverbSend: sPads.num("pads.reverbSend"),
    duckAmount: Math.min(1, sPads.num("pads.duckAmount")),
    gainDb: sPads.num("pads.gainDb"),
  };

  const fxRiserBars = sFx.int("fx.riserLength");
  const fx: FxParams = {
    riserStartHz: sFx.num("fx.riserStartHz"),
    riserEndHz: sFx.num("fx.riserEndHz"),
    impactLevel: sFx.num("fx.impactLevel"),
    impactDecay: sFx.num("fx.impactDecay"),
    reverbSend: sFx.num("fx.reverbSend"),
    gainDb: sFx.num("fx.gainDb"),
  };

  const master: MasterParams = {
    driveTargetDb: sampler.num("master.driveTargetDb"),
    glueThresholdDb: sampler.num("master.glueThresholdDb"),
    glueRatio: sampler.num("master.glueRatio"),
    glueAttack: sampler.num("master.glueAttack"),
    glueRelease: sampler.num("master.glueRelease"),
    satDrive: sampler.num("master.satDrive"),
    shelfHz: sampler.num("master.shelfHz"),
    shelfDb: sampler.num("master.shelfDb"),
    clipCeiling: Math.min(0.995, sampler.num("master.clipCeiling")),
    targetPeakDb: sampler.num("master.targetPeakDb"),
    widthMid: Math.max(0, sampler.num("master.widthMid")),
  };

  const beat = 60 / tempo;
  const sends: SendParams = {
    reverb: {
      decay: sampler.num("reverb.decay"),
      brightness: Math.min(1, Math.max(0, sampler.num("reverb.brightness"))),
      size: sampler.num("reverb.size"),
      preDelay: sampler.num("reverb.preDelay"),
      duckAmount: Math.min(1, sampler.num("reverb.duckAmount")),
      returnDb: sampler.num("reverb.returnDb"),
    },
    delay: {
      feedback: sampler.num("delay.feedback"),
      damping: sampler.num("delay.damping"),
      returnDb: sampler.num("delay.returnDb"),
      // tempo-locked: a dotted eighth on one side, a straight eighth on the other
      timeL: beat * 0.75,
      timeR: beat * 0.5,
    },
  };

  const duck: DuckParams = {
    depth: Math.min(0.9, Math.max(0, sampler.num("duck.depth"))),
    attack: sampler.num("duck.attack"),
    release: sampler.num("duck.release"),
  };

  // --- drums --------------------------------------------------------------
  const drumRng = makeRng(busSeed("drums")).child("drums");
  const { drumEvents, kickPositions, effects: drumEffects } = buildDrums(
    drumRng, preset, arrangement, samplesPerBar, samplesPerStep,
    sDrums.num("drums.humanise"), sDrums.num("drums.rollChance"),
  );

  // --- 808 ----------------------------------------------------------------
  const bassRng = makeRng(busSeed("bass808")).child("bass808");
  const bassNotes = buildBass(
    bassRng, harmony, arrangement, samplesPerBar, samplesPerStep, kickPositions, bassOctave,
  );
  const bassFill = add808Fill(
    bassRng.child("fill808"), bassNotes, harmony, arrangement,
    samplesPerBar, samplesPerStep, bassOctave,
  );

  // --- lead ---------------------------------------------------------------
  const leadRng = makeRng(busSeed("lead")).child("lead");
  const contour = pickContour(leadRng, preset, ranges);
  sLead.choices["motif.contour"] = contour;
  const motifSpec: MotifSpec = {
    steps: STEPS_PER_BAR,
    minNotes: 4,
    maxNotes: 8,
    allowedDegrees: preset.motif.allowedDegrees,
    maxJump: 3,
    contour,
    density: 0.45 + 0.4 * leadRng.float(),
    stableDegrees: preset.motif.stableDegrees,
    legato: 0.35,
  };
  const motif = buildFourBarHook(leadRng.child("figure"), motifSpec);
  const leadNotes = placeMelody(
    leadRng.child("place"), motif, motifSpec, harmony, arrangement, "lead",
    samplesPerBar, samplesPerStep, 24 + leadOctave * 12,
  );

  // --- arp ----------------------------------------------------------------
  const arpNotes = buildArp(
    makeRng(busSeed("arp")).child("arp"), harmony, arrangement,
    samplesPerBar, samplesPerStep, 24 + arpOctave * 12,
  );

  // --- pads ---------------------------------------------------------------
  const padChords = buildPads(harmony, arrangement, samplesPerBar);

  // --- fx -----------------------------------------------------------------
  const fxEvents = buildFx(arrangement, samplesPerBar, fxRiserBars, fx.impactLevel);

  const silencedSections = new Set(
    drumEffects.filter((e) => e.kind === "drum silence before drop").map((e) => e.section),
  );
  const mixPlan = buildMixEffects(
    makeRng(structureSeed).child("mixfx"), arrangement,
    samplesPerBar, samplesPerStep, sampleRate, silencedSections,
  );

  const effects: EffectEvent[] = [...drumEffects, ...mixPlan.effects];
  if (bassFill) effects.push(bassFill);
  for (const e of fxEvents) {
    const sec = arrangement.sections.find(
      (s) => e.start + e.length <= (s.startBar + s.bars) * samplesPerBar &&
             e.start + e.length > s.startBar * samplesPerBar,
    );
    const target = arrangement.sections.find((s) => s.startBar * samplesPerBar === e.start + e.length);
    effects.push({
      kind: e.kind === "riser" ? "noise riser into drop"
        : e.kind === "reverse" ? "reverse swell before section"
        : e.kind === "downlifter" ? "downlifter after drop"
        : "impact on drop",
      at: e.start,
      length: e.length,
      section: (target ?? sec)?.name ?? "-",
    });
  }
  effects.sort((a, b) => a.at - b.at);

  // --- merge the parameter record ----------------------------------------
  const params: Record<string, number> = {};
  const choices: Record<string, string> = {};
  for (const s of [sampler, sDrums, sBass, sLead, sArp, sPads, sFx]) {
    for (const k of Object.keys(s.values)) params[k] = s.values[k];
    for (const k of Object.keys(s.choices)) choices[k] = s.choices[k];
  }

  const lockRecord: Record<string, string> = {};
  for (const k of Object.keys(locks)) {
    const v = locks[k as BusName | "structure"];
    if (v !== undefined) lockRecord[k] = v;
  }

  return {
    seed, presetName: preset.name, sampleRate, tempo, bars, totalSamples,
    samplesPerBar, samplesPerStep, harmony, arrangement, sections,
    drumEvents, kickPositions, bassNotes, leadNotes, arpNotes, padChords, fxEvents, effects,
    mixEffects: mixPlan.mix, delayThrows: mixPlan.throws,
    drum, bass, lead, arp, pads, fx, master, sends, duck,
    params, choices, locks: lockRecord,
  };
}

function firstLock(locks: Partial<Record<BusName | "structure", string>>): string | undefined {
  for (const k of ["drums", "bass808", "lead", "arp", "pads", "fx"] as BusName[]) {
    const v = locks[k];
    if (v !== undefined) return v;
  }
  return undefined;
}

function pickContour(rng: Rng, preset: Preset, ranges: RangesFile): Contour {
  const spec = ranges.choices?.["motif.contour"];
  const options = preset.motif.contours;
  if (spec?.weights && spec.weights.length === options.length) {
    return rng.weighted(options, spec.weights);
  }
  return rng.pick(options);
}

// ---------------------------------------------------------------------------
// part builders
// ---------------------------------------------------------------------------

function buildDrums(
  rng: Rng,
  preset: Preset,
  arrangement: Arrangement,
  samplesPerBar: number,
  samplesPerStep: number,
  humaniseAmount: number,
  rollChance: number,
): { drumEvents: DrumEvent[]; kickPositions: number[]; effects: EffectEvent[] } {
  const drumEvents: DrumEvent[] = [];
  const kickPositions: number[] = [];
  const effects: EffectEvent[] = [];
  const fills: EffectEvent[] = [];
  const banks = preset.drums;

  // one pattern set per section, so a section has an identity
  const perSection = new Map<number, Record<DrumVoice, Float32Array>>();
  for (const s of arrangement.sections) {
    const r = rng.child(`section${s.index}`);
    perSection.set(s.index, {
      kick: pickPattern(r, banks.kick, s.intensity),
      snare: pickPattern(r, banks.snare, s.intensity),
      clap: pickPattern(r, banks.clap, s.intensity),
      hatClosed: pickPattern(r, banks.hatClosed, s.intensity),
      hatOpen: pickPattern(r, banks.hatOpen, s.intensity),
      rim: pickPattern(r, banks.rim, s.intensity),
    });
  }

  for (const s of arrangement.sections) {
    // A section without the drums bus still gets its fill: `fillOut` is the
    // arranger asking for a fill out of this section, and a break that fills
    // into a drop is the standard construction. Only the fill sounds — the
    // section stays drumless for its other fifteen bars.
    const hasDrums = s.buses.includes("drums");
    if (!hasDrums && !s.fillOut) continue;
    const patterns = perSection.get(s.index)!;
    for (let b = 0; b < s.bars; b++) {
      const bar = s.startBar + b;
      const barStart = bar * samplesPerBar;
      const barRng = rng.child(`bar${bar}`);
      const isFillBar = s.fillOut && b === s.bars - 1;
      if (!hasDrums && !isFillBar) continue;

      for (const voice of DRUM_VOICES) {
        if (!hasDrums && voice !== "snare" && voice !== "clap") continue;
        const base = patterns[voice];
        if (!base) continue;
        const pattern = humanise(barRng.child(voice), base, humaniseAmount);
        let events: RollEvent[];
        if (voice === "hatClosed") {
          events = addRolls(barRng.child("roll"), pattern, {
            ...banks.rolls,
            chance: rollChance * (0.4 + 0.6 * s.intensity),
          });
        } else if (isFillBar && (voice === "snare" || voice === "clap")) {
          events = buildFill(barRng.child("fill"), 4, s.intensity);
          if (voice === "snare") {
            fills.push({
              kind: "drum fill",
              at: Math.round(barStart + 12 * samplesPerStep),
              length: Math.round(4 * samplesPerStep),
              section: s.name,
            });
          }
        } else {
          events = toEvents(pattern);
        }
        for (const e of events) {
          const at = Math.round(barStart + e.step * samplesPerStep);
          drumEvents.push({
            voice,
            at,
            velocity: e.velocity,
            variant: Math.floor(e.velocity * 3.999),
          });
          if (voice === "kick") kickPositions.push(at);
        }
      }
    }
  }
  drumEvents.sort((a, b) => a.at - b.at);

  // --- total drum silence before a drop ---------------------------------
  //
  // The single most effective tension device in this genre, and the easiest to
  // skip because it looks like an absence rather than a feature. One or two per
  // track: the drums stop dead for the last beat or two before the drop lands.
  //
  // Candidacy is decided from the events that exist, not from the section's bus
  // list — a break that fills out into a drop has drums in that bar even though
  // the drums bus is not listed for the section, and that bar is a candidate.
  //
  // The kick list is cut with everything else, so the sidechain pump stops too.
  // Pads and lead swelling un-ducked into the gap is most of the effect.
  const candidates: { from: number; to: number; section: string; forced: boolean }[] = [];
  for (let i = 1; i < arrangement.sections.length; i++) {
    const sec = arrangement.sections[i];
    if (sec.intensity < DROP_INTENSITY) continue;
    const dropAt = sec.startBar * samplesPerBar;
    const steps = rng.child(`silence${sec.index}`).pick([4, 4, 8, 8, 16]);
    const from = Math.round(dropAt - steps * samplesPerStep);
    const forced = sec.transitionIn === "silence";
    // Drums must still be playing on the near side of the cut, in the bar
    // running up to it. A bar whose only drums are the fill the cut would erase
    // is already silent there, and logging a silence over silence is worse than
    // not placing one.
    if (!drumEvents.some((e) => e.at >= from - samplesPerBar && e.at < from)) continue;
    candidates.push({ from, to: dropAt, section: sec.name, forced });
  }

  // A section declaring `transitionIn: "silence"` always gets its cut. The rest
  // are drawn, so a track lands on one or two rather than every drop.
  const silences: { from: number; to: number; section: string }[] = [];
  if (candidates.length > 0) {
    const pickRng = rng.child("silences");
    const forcedIdx = candidates.map((c, i) => (c.forced ? i : -1)).filter((i) => i >= 0);
    const freeIdx = candidates.map((c, i) => (c.forced ? -1 : i)).filter((i) => i >= 0);
    const want = pickRng.int(1, 2);
    const extra = Math.max(0, Math.min(freeIdx.length, want - forcedIdx.length));
    const chosen = forcedIdx.concat(pickRng.shuffle(freeIdx).slice(0, extra)).sort((a, b) => a - b);
    for (const i of chosen) silences.push(candidates[i]);
  }

  const silenced = (at: number) => silences.some((s) => at >= s.from && at < s.to);
  const keptEvents = drumEvents.filter((e) => !silenced(e.at));
  const keptKicks = kickPositions.filter((k) => !silenced(k));
  for (const s of silences) {
    effects.push({
      kind: "drum silence before drop",
      at: s.from,
      length: s.to - s.from,
      section: s.section,
    });
  }
  // A silence covering a fill bar replaces that fill; a cut and a fill are
  // alternatives, not a stack. Only fills that survived are reported.
  for (const f of fills) if (!silenced(f.at)) effects.push(f);
  effects.sort((a, b) => a.at - b.at);

  keptKicks.sort((a, b) => a - b);
  return { drumEvents: keptEvents, kickPositions: keptKicks, effects };
}

/**
 * Note-energy tilt for the 808.
 *
 * Measured across 21 semitones: full-band RMS falls 1.71 dB as the root rises,
 * and sub-band energy below 120 Hz falls 4.48 dB. Fitted, that is about
 * -0.92 dB per octave, so the root note the seed happened to pick shifts the
 * whole bass bus by up to 1.7 dB before anything else has had a say.
 *
 * A straight line through that measurement is enough. This is not a loudness
 * model and should not become one.
 */
const TILT_DB_PER_OCTAVE = 0.92;
const TILT_REFERENCE_HZ = 45;

function noteEnergyTilt(midi: number): number {
  const octaves = dlog2(midiToHz(midi) / TILT_REFERENCE_HZ);
  const db = clamp(TILT_DB_PER_OCTAVE * octaves, -3, 3);
  return db2gain(db);
}

/**
 * Maps a MIDI note into the 808's register by whole octaves.
 *
 * The window follows `bass.octave`; the note does not. A transposition applied
 * to the note is exactly what this folding removes - shift by an octave, fold
 * by an octave, and you are back where you started, which is why `bass.octave`
 * measured bit-identical in the audit. Moving the window is the only place the
 * parameter can survive, and it leaves the fold doing only the job it was
 * written for: keeping the 808 in a register a speaker can reproduce.
 */
function toRegister(midi: number, lo: number, hi: number): number {
  let m = midi;
  while (m > hi) m -= 12;
  while (m < lo) m += 12;
  return m;
}

function buildBass(
  rng: Rng,
  harmony: Harmony,
  arrangement: Arrangement,
  samplesPerBar: number,
  samplesPerStep: number,
  kickPositions: readonly number[],
  octave: number,
): Note808[] {
  const notes: Note808[] = [];
  const loMidi = BASS_REGISTER_LO + octave * 12;
  const hiMidi = BASS_REGISTER_HI + octave * 12;

  for (const s of arrangement.sections) {
    if (!s.buses.includes("bass808")) continue;
    for (let b = 0; b < s.bars; b++) {
      const bar = s.startBar + b;
      const barStart = bar * samplesPerBar;
      const barEnd = barStart + samplesPerBar;
      const chord = chordAtBar(harmony, bar);
      const nextChord = chordAtBar(harmony, bar + 1);
      const barRng = rng.child(`bar${bar}`);

      // Pitch choices come from the harmony the composer already produced: the
      // chord's own tones, the scale step below its root, and the root of the
      // chord this bar is heading into. An 808 that repeats one note is a
      // pedal tone, and this genre uses it as a melodic instrument.
      const tones: number[] = [];
      for (const iv of chord.intervals) if (iv > 0 && iv < 12) tones.push(iv);
      const approach =
        degreeSemitone(harmony.scale, chord.degreeIndex - 1) -
        degreeSemitone(harmony.scale, chord.degreeIndex);

      // the 808 follows the kick, but not on every hit
      const inBar = kickPositions.filter((k) => k >= barStart && k < barEnd);
      const chosen: number[] = [barStart];
      for (const k of inBar) {
        if (k === barStart) continue;
        if (barRng.bool(0.55)) chosen.push(k);
      }
      chosen.sort((a, b2) => a - b2);

      let prevMidi = -1;
      for (let i = 0; i < chosen.length; i++) {
        const start = chosen[i];
        const end = i + 1 < chosen.length ? chosen[i + 1] : barEnd;

        let midi = chord.rootMidi;
        if (i > 0) {
          const isLast = i === chosen.length - 1;
          if (isLast && nextChord.rootMidi !== chord.rootMidi && barRng.bool(0.45)) {
            midi = nextChord.rootMidi;
          } else {
            const r = barRng.float();
            if (r > 0.62 && tones.length > 0) {
              midi = chord.rootMidi + tones[barRng.int(0, tones.length - 1)];
            } else if (r > 0.44) {
              midi = chord.rootMidi + approach;
            }
          }
        }
        midi = toRegister(midi, loMidi, hiMidi);

        // Portamento is only audible between two different pitches, so the
        // glide flag follows the pitch rather than being drawn independently.
        // Drawn independently it landed on repeated notes, which is why
        // `bass.portamento` measured dead.
        const moves = prevMidi >= 0 && midi !== prevMidi;
        const glide = i > 0 && (moves ? barRng.bool(0.7) : barRng.bool(0.12));

        const velocity = (i === 0 ? 1 : 0.82 + 0.18 * barRng.float()) * noteEnergyTilt(midi);
        notes.push({
          start,
          length: Math.max(Math.round(samplesPerStep), end - start),
          midi,
          velocity,
          glide,
        });
        prevMidi = midi;
      }
    }
  }
  notes.sort((a, b) => a.start - b.start);
  return notes;
}

/**
 * One 808-tuned fill per track: a run of 16ths through the last beat before a
 * drop, walking up to the note the drop lands on.
 *
 * The spec asked for "tom or 808-tuned fills into drops". There is no tom
 * voice, and building one would be a new instrument; the 808 is already here
 * and a pitched run into a drop is the more common form in this genre anyway.
 */
function add808Fill(
  rng: Rng,
  notes: Note808[],
  harmony: Harmony,
  arrangement: Arrangement,
  samplesPerBar: number,
  samplesPerStep: number,
  octave: number,
): EffectEvent | undefined {
  const loMidi = BASS_REGISTER_LO + octave * 12;
  const hiMidi = BASS_REGISTER_HI + octave * 12;
  const drops: Section[] = [];
  for (let i = 1; i < arrangement.sections.length; i++) {
    const sec = arrangement.sections[i];
    if (sec.intensity >= DROP_INTENSITY && sec.buses.includes("bass808")) drops.push(sec);
  }
  if (drops.length === 0) return undefined;
  const target = rng.pick(drops);
  const dropAt = target.startBar * samplesPerBar;
  const from = Math.round(dropAt - 4 * samplesPerStep);
  const root = toRegister(chordAtBar(harmony, target.startBar).rootMidi, loMidi, hiMidi);

  // clear whatever the bassline had in that beat, then walk into the drop
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i].start >= from && notes[i].start < dropAt) notes.splice(i, 1);
  }
  const steps = [0, 1, 2, 3];
  for (const k of steps) {
    const degree = harmony.scale.length - steps.length + k;
    const midi = toRegister(
      root + degreeSemitone(harmony.scale, degree) - 12, loMidi, hiMidi,
    );
    notes.push({
      start: Math.round(from + k * samplesPerStep),
      length: Math.round(samplesPerStep),
      midi,
      velocity: (0.72 + 0.09 * k) * noteEnergyTilt(midi),
      glide: k > 0,
    });
  }
  notes.sort((a, b) => a.start - b.start);
  return {
    kind: "808-tuned fill into drop",
    at: from,
    length: dropAt - from,
    section: target.name,
  };
}

/**
 * Places the effects that act on the whole mix, plus the delay throws.
 *
 * One tape stop and one bitcrushed transition per track, as the spec asks, at
 * two different section boundaries. Stutters go on the last beat before a drop
 * that did not already get a drum cut: a cut and a stutter are alternatives -
 * both are the last beat, and stacking them would erase one.
 */
function buildMixEffects(
  rng: Rng,
  arrangement: Arrangement,
  samplesPerBar: number,
  samplesPerStep: number,
  sampleRate: number,
  silenced: ReadonlySet<string>,
): { mix: MixEffect[]; throws: MixThrow[]; effects: EffectEvent[] } {
  const mix: MixEffect[] = [];
  const throws: MixThrow[] = [];
  const effects: EffectEvent[] = [];

  const boundaries: Section[] = [];
  for (let i = 1; i < arrangement.sections.length; i++) boundaries.push(arrangement.sections[i]);
  if (boundaries.length === 0) return { mix, throws, effects };

  const used = new Set<number>();
  const pickBoundary = (r: Rng, want: (s: Section) => boolean): Section | undefined => {
    const free = boundaries.filter((s, i) => !used.has(i) && want(s));
    if (free.length === 0) return undefined;
    const chosen = r.pick(free);
    used.add(boundaries.indexOf(chosen));
    return chosen;
  };

  // Tape stop: into a section that drops in energy, where a machine winding
  // down is a release rather than an interruption.
  const stopAt = pickBoundary(rng.child("tapeStop"), (s) => s.intensity < DROP_INTENSITY);
  if (stopAt) {
    const length = Math.round(0.42 * sampleRate);
    const at = stopAt.startBar * samplesPerBar - length;
    if (at > 0) {
      mix.push({ kind: "tapeStop", at, length, slice: 0, section: stopAt.name });
      effects.push({ kind: "tape stop", at, length, section: stopAt.name });
    }
  }

  // Bitcrushed transition: the half bar before a section change.
  const crushAt = pickBoundary(rng.child("bitcrush"), () => true);
  if (crushAt) {
    const length = Math.round(samplesPerBar * 0.5);
    const at = crushAt.startBar * samplesPerBar - length;
    if (at > 0) {
      mix.push({ kind: "bitcrush", at, length, slice: 0, section: crushAt.name });
      effects.push({ kind: "bitcrushed transition", at, length, section: crushAt.name });
    }
  }

  // Stutter: the last beat before a drop that has no drum cut.
  for (const sec of arrangement.sections) {
    if (sec.intensity < DROP_INTENSITY) continue;
    if (silenced.has(sec.name)) continue;
    // A tape stop or a crush already owns that boundary; two mix effects on
    // the same beat fight each other, and the second one wins meaninglessly.
    const bi = boundaries.indexOf(sec);
    if (bi >= 0 && used.has(bi)) continue;
    if (!rng.child(`stutter${sec.index}`).bool(0.55)) continue;
    if (bi >= 0) used.add(bi);
    const length = Math.round(4 * samplesPerStep);
    const at = sec.startBar * samplesPerBar - length;
    if (at <= 0) continue;
    mix.push({
      kind: "stutter", at, length,
      slice: Math.max(64, Math.round(samplesPerStep)),
      section: sec.name,
    });
    effects.push({ kind: "glitch stutter before drop", at, length, section: sec.name });
  }

  // Dub delay throw: the last hit of a section, thrown into the delay so its
  // repeats carry across the boundary.
  for (const sec of arrangement.sections) {
    if (!sec.buses.includes("lead")) continue;
    const endBar = sec.startBar + sec.bars;
    if (endBar >= arrangement.totalBars) continue;
    if (!rng.child(`throw${sec.index}`).bool(0.5)) continue;
    const length = Math.round(2 * samplesPerStep);
    const at = endBar * samplesPerBar - length;
    if (at <= 0) continue;
    // The send has to be well above the bus's own 0..0.35 to read as a throw:
    // the delay return sits around -11 dB, so a send of 0.5 adds about -22 dB
    // to the mix, which measures as a 0.03 dB change and is not an effect.
    throws.push({ at, length, amount: 2.2, section: sec.name });
    effects.push({ kind: "dub delay throw", at, length, section: sec.name });
  }

  mix.sort((a, b) => a.at - b.at);
  throws.sort((a, b) => a.at - b.at);
  return { mix, throws, effects };
}

function placeMelody(
  rng: Rng,
  motif: readonly MotifNote[],
  spec: MotifSpec,
  harmony: Harmony,
  arrangement: Arrangement,
  bus: BusName,
  samplesPerBar: number,
  samplesPerStep: number,
  semitoneOffset: number,
): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const s of arrangement.sections) {
    if (!s.buses.includes(bus)) continue;
    const figure = repeatHook(motif, HOOK_BARS * spec.steps, s.bars, spec.steps);
    for (const n of figure) {
      const start = s.startBar * samplesPerBar + n.step * samplesPerStep;
      const midi =
        harmony.tonicMidi + degreeSemitone(harmony.scale, n.degree) + semitoneOffset;
      out.push({
        start: Math.round(start),
        length: Math.max(Math.round(samplesPerStep * 0.5), Math.round(n.length * samplesPerStep)),
        midi,
        velocity: n.velocity,
      });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function buildArp(
  rng: Rng,
  harmony: Harmony,
  arrangement: Arrangement,
  samplesPerBar: number,
  samplesPerStep: number,
  semitoneOffset: number,
): NoteEvent[] {
  const out: NoteEvent[] = [];
  const direction = rng.pick(["up", "down", "updown", "upoct"] as const);
  const rate = rng.pick([1, 1, 0.5]); // 16ths, or 32nds
  for (const s of arrangement.sections) {
    if (!s.buses.includes("arp")) continue;
    for (let b = 0; b < s.bars; b++) {
      const bar = s.startBar + b;
      const chord = chordAtBar(harmony, bar);
      const notes = voiceChord(chord, harmony.tonicMidi + semitoneOffset, harmony.tonicMidi + semitoneOffset + 24);
      if (notes.length === 0) continue;
      const seq: number[] = [];
      if (direction === "up") seq.push(...notes);
      else if (direction === "down") seq.push(...[...notes].reverse());
      else if (direction === "updown") seq.push(...notes, ...[...notes].reverse().slice(1, -1));
      else seq.push(...notes, ...notes.map((n) => n + 12));
      const stepsInBar = Math.round(STEPS_PER_BAR / rate);
      for (let i = 0; i < stepsInBar; i++) {
        const midi = seq[i % seq.length];
        const start = bar * samplesPerBar + i * samplesPerStep * rate;
        out.push({
          start: Math.round(start),
          length: Math.round(samplesPerStep * rate * 0.9),
          midi,
          velocity: i % 4 === 0 ? 0.95 : 0.6 + 0.25 * ((i % 2) === 0 ? 1 : 0),
        });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function buildPads(
  harmony: Harmony,
  arrangement: Arrangement,
  samplesPerBar: number,
): ChordEvent[] {
  const out: ChordEvent[] = [];
  for (const s of arrangement.sections) {
    if (!s.buses.includes("pads")) continue;
    let bar = s.startBar;
    while (bar < s.startBar + s.bars) {
      const chord = chordAtBar(harmony, bar);
      // hold for the rest of this chord, but never past the section
      let len = chord.bars - ((bar - 0) % chord.bars);
      if (bar + len > s.startBar + s.bars) len = s.startBar + s.bars - bar;
      // Chords used to run exactly into each other, so the next one retriggered
      // before the previous one could release and `pads.release` measured dead.
      // Ending a little early gives the release something to do and lets the
      // pad breathe between changes.
      out.push({
        start: bar * samplesPerBar,
        length: Math.round(len * samplesPerBar * 0.88),
        notes: voiceChord(chord, harmony.tonicMidi + 12, harmony.tonicMidi + 36),
      });
      bar += len;
    }
  }
  return out;
}

function buildFx(
  arrangement: Arrangement,
  samplesPerBar: number,
  riserBars: number,
  impactLevel: number,
): FxEvent[] {
  const out: FxEvent[] = [];
  for (let i = 0; i < arrangement.sections.length; i++) {
    const s = arrangement.sections[i];
    const start = s.startBar * samplesPerBar;

    // A downlifter is the riser's mirror: it belongs to the section that comes
    // *after* a drop, falling as the energy falls. Placed at that section's
    // start rather than before it, because it is a release, not a build.
    const prev = i > 0 ? arrangement.sections[i - 1] : undefined;
    if (prev && prev.intensity >= DROP_INTENSITY && s.intensity < prev.intensity - 0.18) {
      out.push({ kind: "downlifter", start, length: samplesPerBar, level: 0.9 });
    }

    if (s.transitionIn === "riser" || s.transitionIn === "impact" || s.transitionIn === "silence") {
      const len = riserBars * samplesPerBar;
      if (start - len >= 0) {
        out.push({ kind: "riser", start: start - len, length: len, level: 1 });
      }
    }
    // "silence" enters from a drum cut and still lands on an impact - the hit
    // that brings the drums back is the point of the gap.
    if (s.transitionIn === "impact" || s.transitionIn === "silence") {
      out.push({ kind: "impact", start, length: Math.round(samplesPerBar * 1.5), level: impactLevel });
    }
    if (s.transitionIn === "reverse") {
      const len = samplesPerBar;
      if (start - len >= 0) {
        out.push({ kind: "reverse", start: start - len, length: len, level: 0.8 });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export { midiToHz };
