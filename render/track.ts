/**
 * Track rendering.
 *
 * Buses are rendered one bar at a time and summed as they go, so the only
 * full-length buffers alive are the stereo output and the mono 808 source.
 * Six full-length stereo buses would be 254 MB; this is under 70.
 *
 * Stems are produced by re-rendering with a single bus enabled. Because the
 * engine is deterministic, a stem is bit-for-bit the contribution that bus
 * made to the mix, and re-rendering costs far less memory than keeping six
 * buffers alive on the chance the user wants them.
 */

import { createStereo, peakDb, rmsDb, type Stereo } from "../core/buffer.ts";
import { clamp as clampNumber, db2gain, dsqrt, gain2db } from "../core/dmath.ts";
import { render808 } from "../core/bass808.ts";
import { Reverb } from "../core/reverb.ts";
import { StereoDelay } from "../core/delay.ts";
import type { BusName } from "../compose/arrange.ts";
import type { Preset, RangesFile } from "../presets/types.ts";
import type { WordValues } from "../presets/sampler.ts";
import { buildPlan, type TrackPlan } from "./plan.ts";
import { ArpBus, Bass808Bus, DrumsBus, FxBus, LeadBus, PadsBus } from "./voices.ts";
import { MasterChain, normaliseAndFade } from "./master.ts";
import { Ducker } from "./duck.ts";

export interface RenderOptions {
  seed: string | number;
  preset: Preset;
  ranges: RangesFile;
  sampleRate?: number;
  locks?: Partial<Record<BusName | "structure", string>>;
  words?: WordValues;
  /** render only this bus, for stem export */
  onlyBus?: BusName;
  /** called at section boundaries with progress in [0,1] */
  onProgress?: (fraction: number, label: string) => void;
}

export interface RenderStats {
  peakDb: number;
  /** RMS of the mix before the master chain, and the trim applied to it */
  mixRmsDb: number;
  trimDb: number;
  rmsDb: number;
  normaliseGainDb: number;
  durationSeconds: number;
  /** peak of each bus before the master, for the gain-staging assertion */
  busPeaks: Record<string, number>;
}

export interface RenderResult {
  audio: Stereo;
  plan: TrackPlan;
  stats: RenderStats;
}

interface BusWiring {
  name: BusName;
  render: (L: Float32Array, R: Float32Array, start: number, count: number) => void;
  reverbSend: number;
  delaySend: number;
  duckAmount: number;
}

export function renderTrack(opts: RenderOptions): RenderResult {
  const sampleRate = opts.sampleRate ?? 44100;
  const plan = buildPlan({
    seed: opts.seed,
    preset: opts.preset,
    ranges: opts.ranges,
    sampleRate,
    locks: opts.locks,
    words: opts.words,
  });

  const n = plan.totalSamples;
  const out = createStereo(n, sampleRate);
  const chunk = plan.samplesPerBar;
  const progress = opts.onProgress;

  // --- the 808 is the one part that is pre-rendered whole -----------------
  const only = opts.onlyBus;
  const needBass = !only || only === "bass808";
  const bassSource = new Float32Array(needBass ? n : 0);
  if (needBass) {
    render808(bassSource, sampleRate, plan.bassNotes, {
      dropSemitones: plan.bass.dropSemitones,
      dropTime: plan.bass.dropTime,
      decay: plan.bass.decay,
      attack: plan.bass.attack,
      drive: plan.bass.drive,
      subLevel: plan.bass.subLevel,
      portamento: plan.bass.portamento,
      toneHz: plan.bass.toneHz,
    });
  }
  progress?.(0.08, "bass");

  // --- buses --------------------------------------------------------------
  const wanted = (b: BusName) => !only || only === b;
  const wiring: BusWiring[] = [];
  if (wanted("drums")) {
    const bus = new DrumsBus(plan, chunk);
    wiring.push({ name: "drums", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: 0, delaySend: 0, duckAmount: 0 });
  }
  if (wanted("bass808")) {
    const bus = new Bass808Bus(plan, chunk, bassSource);
    wiring.push({ name: "bass808", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: 0, delaySend: 0, duckAmount: 0 });
  }
  if (wanted("lead")) {
    const bus = new LeadBus(plan, chunk);
    wiring.push({ name: "lead", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: plan.lead.reverbSend, delaySend: plan.lead.delaySend, duckAmount: plan.lead.duckAmount });
  }
  if (wanted("arp")) {
    const bus = new ArpBus(plan, chunk);
    wiring.push({ name: "arp", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: plan.arp.reverbSend, delaySend: plan.arp.delaySend, duckAmount: plan.arp.duckAmount });
  }
  if (wanted("pads")) {
    const bus = new PadsBus(plan, chunk);
    wiring.push({ name: "pads", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: plan.pads.reverbSend, delaySend: 0, duckAmount: plan.pads.duckAmount });
  }
  if (wanted("fx")) {
    const bus = new FxBus(plan, chunk);
    wiring.push({ name: "fx", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: plan.fx.reverbSend, delaySend: 0, duckAmount: 0 });
  }

  // --- sends --------------------------------------------------------------
  const reverb = new Reverb(sampleRate, 0);
  reverb.decay = plan.sends.reverb.decay;
  reverb.brightness = plan.sends.reverb.brightness;
  reverb.size = plan.sends.reverb.size;
  reverb.preDelaySeconds = plan.sends.reverb.preDelay;
  reverb.update();
  const reverbReturn = db2gain(plan.sends.reverb.returnDb);
  const reverbDuck = plan.sends.reverb.duckAmount;

  const delay = new StereoDelay(sampleRate, 2);
  delay.timeL = plan.sends.delay.timeL;
  delay.timeR = plan.sends.delay.timeR;
  delay.feedback = plan.sends.delay.feedback;
  delay.damping = plan.sends.delay.damping;
  delay.pingPong = true;
  const delayReturn = db2gain(plan.sends.delay.returnDb);

  const master = new MasterChain(sampleRate, plan.master);
  const ducker = new Ducker(
    plan.kickPositions, sampleRate, plan.duck.depth, plan.duck.attack, plan.duck.release,
  );

  // --- chunk buffers ------------------------------------------------------
  const mixL = new Float32Array(chunk);
  const mixR = new Float32Array(chunk);
  const busL = new Float32Array(chunk);
  const busR = new Float32Array(chunk);
  const revSend = new Float32Array(chunk);
  const dlySend = new Float32Array(chunk);
  const duckBuf = new Float32Array(chunk);
  const frame = new Float64Array(2);

  const busPeaks: Record<string, number> = {};
  for (const w of wiring) busPeaks[w.name] = 0;

  // --- pass 1: buses, sends, and the mix ---------------------------------
  //
  // The master chain runs in a second pass rather than inline, because the
  // trim into it has to be derived from the finished mix's level. Both passes
  // work on the same output buffer, so this costs no extra memory.
  // Per-chunk energy, so the drive anchor can be measured over the loud
  // sections rather than the whole track. Whole-track RMS is dominated by how
  // many quiet bars an arrangement happens to have, which is not what decides
  // how hard the master chain should work.
  const chunkEnergy: number[] = [];
  let nextSection = 0;
  for (let start = 0; start < n; start += chunk) {
    const count = Math.min(chunk, n - start);
    mixL.fill(0, 0, count);
    mixR.fill(0, 0, count);
    revSend.fill(0, 0, count);
    dlySend.fill(0, 0, count);
    for (let i = 0; i < count; i++) duckBuf[i] = ducker.step(start + i);

    for (const w of wiring) {
      busL.fill(0, 0, count);
      busR.fill(0, 0, count);
      w.render(busL, busR, start, count);

      let peak = busPeaks[w.name];
      const duckAmt = w.duckAmount;
      for (let i = 0; i < count; i++) {
        const g = duckAmt > 0 ? 1 - duckAmt * (1 - duckBuf[i]) : 1;
        const l = busL[i] * g;
        const r = busR[i] * g;
        const a = l < 0 ? -l : l;
        const b = r < 0 ? -r : r;
        if (a > peak) peak = a;
        if (b > peak) peak = b;
        mixL[i] += l;
        mixR[i] += r;
        if (w.reverbSend > 0) revSend[i] += (l + r) * 0.5 * w.reverbSend;
        if (w.delaySend > 0) dlySend[i] += (l + r) * 0.5 * w.delaySend;
      }
      busPeaks[w.name] = peak;
    }

    // reverb return, ducked with the rest
    for (let i = 0; i < count; i++) {
      reverb.process(revSend[i], frame);
      const g = reverbDuck > 0 ? 1 - reverbDuck * (1 - duckBuf[i]) : 1;
      mixL[i] += frame[0] * reverbReturn * g;
      mixR[i] += frame[1] * reverbReturn * g;
    }
    // delay return
    for (let i = 0; i < count; i++) {
      delay.process(dlySend[i], dlySend[i], frame);
      mixL[i] += frame[0] * delayReturn;
      mixR[i] += frame[1] * delayReturn;
    }

    let energy = 0;
    for (let i = 0; i < count; i++) {
      energy += mixL[i] * mixL[i] + mixR[i] * mixR[i];
    }
    chunkEnergy.push(energy / (count * 2));
    out.L.set(mixL.subarray(0, count), start);
    out.R.set(mixR.subarray(0, count), start);

    if (progress && nextSection < plan.sections.length) {
      const sec = plan.sections[nextSection];
      if (start + count >= sec.startSample) {
        progress(0.08 + 0.8 * ((start + count) / n), sec.name);
        nextSection++;
      }
    }
  }

  // --- pass 2: the master chain, driven to a consistent level -------------
  //
  // The anchor is the mean energy of the loudest third of the bars: the drops.
  // That is what the chain is actually working on, and it is stable across
  // arrangements in a way whole-track RMS is not.
  const sortedEnergy = [...chunkEnergy].sort((a, b) => b - a);
  const loudCount = Math.max(1, Math.round(sortedEnergy.length / 3));
  let loudSum = 0;
  for (let i = 0; i < loudCount; i++) loudSum += sortedEnergy[i];
  const mixRms = dsqrt(loudSum / loudCount);
  const mixRmsDb = gain2db(mixRms);
  const trimDb = clampNumber(plan.master.driveRmsDb - mixRmsDb, -12, 30);
  master.setInputGain(db2gain(trimDb));
  master.setGlueThresholdDb(mixRmsDb + plan.master.glueThresholdRelDb);
  progress?.(0.9, "master");

  for (let start = 0; start < n; start += chunk) {
    const count = Math.min(chunk, n - start);
    mixL.set(out.L.subarray(start, start + count));
    mixR.set(out.R.subarray(start, start + count));
    master.process(mixL, mixR, count);
    out.L.set(mixL.subarray(0, count), start);
    out.R.set(mixR.subarray(0, count), start);
  }

  const { gain } = normaliseAndFade(out.L, out.R, sampleRate, plan.master.targetPeakDb);
  progress?.(1, "done");

  return {
    audio: out,
    plan,
    stats: {
      peakDb: peakDb(out),
      mixRmsDb,
      trimDb,
      rmsDb: rmsDb(out),
      normaliseGainDb: gain2db(gain),
      durationSeconds: n / sampleRate,
      busPeaks,
    },
  };
}

/** Renders one bus in isolation, including the effects it sends to. */
export function renderStem(opts: RenderOptions, bus: BusName): RenderResult {
  return renderTrack({ ...opts, onlyBus: bus });
}
