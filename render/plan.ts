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
  buildArrangement, type Arrangement, type BusName, type Section,
} from "../compose/arrange.ts";
import {
  buildHarmony, chordAtBar, degreeSemitone, voiceChord, type Harmony,
} from "../compose/harmony.ts";
import { generateMotif, repeatWithVariation, type Contour, type MotifSpec } from "../compose/motif.ts";
import {
  addRolls, buildFill, humanise, pickPattern, STEPS_PER_BAR, toEvents, type RollEvent,
} from "../compose/rhythm.ts";
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

export type FxKind = "riser" | "impact" | "reverse";

export interface FxEvent {
  kind: FxKind;
  start: number;
  length: number;
  level: number;
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

export interface LeadParams {
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
    rim: {
      hz: sDrums.num("drums.rim.hz"),
      q: sDrums.num("drums.rim.q"),
      decay: sDrums.num("drums.rim.decay"),
      clickLevel: sDrums.num("drums.rim.clickLevel"),
      gainDb: sDrums.num("drums.rim.gainDb"),
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
  const { drumEvents, kickPositions } = buildDrums(
    drumRng, preset, arrangement, samplesPerBar, samplesPerStep,
    sDrums.num("drums.humanise"), sDrums.num("drums.rollChance"),
  );

  // --- 808 ----------------------------------------------------------------
  const bassNotes = buildBass(
    makeRng(busSeed("bass808")).child("bass808"),
    harmony, arrangement, samplesPerBar, samplesPerStep, kickPositions, bassOctave,
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
  const motif = generateMotif(leadRng.child("figure"), motifSpec);
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
    drumEvents, kickPositions, bassNotes, leadNotes, arpNotes, padChords, fxEvents,
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
): { drumEvents: DrumEvent[]; kickPositions: number[] } {
  const drumEvents: DrumEvent[] = [];
  const kickPositions: number[] = [];
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
    if (!s.buses.includes("drums")) continue;
    const patterns = perSection.get(s.index)!;
    for (let b = 0; b < s.bars; b++) {
      const bar = s.startBar + b;
      const barStart = bar * samplesPerBar;
      const barRng = rng.child(`bar${bar}`);
      const isFillBar = s.fillOut && b === s.bars - 1;

      for (const voice of DRUM_VOICES) {
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
  kickPositions.sort((a, b) => a - b);
  return { drumEvents, kickPositions };
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
  for (const s of arrangement.sections) {
    if (!s.buses.includes("bass808")) continue;
    for (let b = 0; b < s.bars; b++) {
      const bar = s.startBar + b;
      const barStart = bar * samplesPerBar;
      const barEnd = barStart + samplesPerBar;
      const chord = chordAtBar(harmony, bar);
      const barRng = rng.child(`bar${bar}`);

      // the 808 follows the kick, but not on every hit
      const inBar = kickPositions.filter((k) => k >= barStart && k < barEnd);
      const chosen: number[] = [barStart];
      for (const k of inBar) {
        if (k === barStart) continue;
        if (barRng.bool(0.55)) chosen.push(k);
      }
      chosen.sort((a, b2) => a - b2);

      for (let i = 0; i < chosen.length; i++) {
        const start = chosen[i];
        const end = i + 1 < chosen.length ? chosen[i + 1] : barEnd;
        // mostly the root; sometimes the fifth or the octave below
        let midi = chord.rootMidi + octave * 12;
        if (i > 0) {
          const move = barRng.float();
          if (move > 0.86) midi += 7;
          else if (move > 0.78) midi += 12;
        }
        while (midi > 45) midi -= 12;
        while (midi < 24) midi += 12;
        const velocity = (i === 0 ? 1 : 0.82 + 0.18 * barRng.float()) * noteEnergyTilt(midi);
        notes.push({
          start,
          length: Math.max(Math.round(samplesPerStep), end - start),
          midi,
          velocity,
          glide: i > 0 && barRng.bool(0.4),
        });
      }
    }
  }
  notes.sort((a, b) => a.start - b.start);
  return notes;
}

function placeMelody(
  rng: Rng,
  motif: ReturnType<typeof generateMotif>,
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
    const repeats = s.bars;
    const figure = repeatWithVariation(rng.child(`sec${s.index}`), motif, spec, repeats, 0.4);
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
      out.push({
        start: bar * samplesPerBar,
        length: len * samplesPerBar,
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
  for (const s of arrangement.sections) {
    const start = s.startBar * samplesPerBar;
    if (s.transitionIn === "riser" || s.transitionIn === "impact") {
      const len = riserBars * samplesPerBar;
      if (start - len >= 0) {
        out.push({ kind: "riser", start: start - len, length: len, level: 1 });
      }
    }
    if (s.transitionIn === "impact") {
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
