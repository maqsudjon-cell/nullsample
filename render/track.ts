/**
 * Track rendering.
 *
 * The renderer is a streaming object. It produces one bar at a time and never
 * looks at a sample outside the chunk it is working on, which is what lets the
 * web app start playing after the first section while the rest renders ahead -
 * and, more importantly, what makes the audio a listener hears and the audio
 * in the downloaded file the same bytes, produced by the same code in the same
 * order.
 *
 * Only two buffers are alive at a time: the caller's output and a handful of
 * bar-sized scratch buffers. Six full-length stereo buses would be 254 MB.
 *
 * Stems are produced by re-rendering with a single bus enabled. Because the
 * engine is deterministic, a stem is bit-for-bit the contribution that bus
 * made to the mix.
 */

import { createStereo, peakDb, rmsDb, type Stereo } from "../core/buffer.ts";
import { clamp as clampNumber, db2gain, dsqrt, gain2db } from "../core/dmath.ts";
import { Bass808Voice } from "../core/bass808.ts";
import { Reverb } from "../core/reverb.ts";
import { StereoDelay } from "../core/delay.ts";
import type { BusName } from "../compose/arrange.ts";
import type { Preset, RangesFile } from "../presets/types.ts";
import type { WordValues } from "../presets/sampler.ts";
import { buildPlan, type TrackPlan } from "./plan.ts";
import { ArpBus, Bass808Bus, DrumsBus, FxBus, LeadBus, PadsBus } from "./voices.ts";
import { MasterChain, MASTER_FLUSH_SAMPLES } from "./master.ts";
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
  rmsDb: number;
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

/**
 * A track being rendered, one bar at a time.
 *
 * Call `next(L, R)` repeatedly until it returns 0. Each call fills the buffers
 * with the next chunk of finished, mastered audio.
 */
export class TrackRenderer {
  readonly plan: TrackPlan;
  readonly chunkSize: number;
  readonly totalSamples: number;
  readonly sampleRate: number;
  readonly busPeaks: Record<string, number> = {};

  private wiring: BusWiring[] = [];
  private reverb: Reverb;
  private reverbReturn: number;
  private reverbDuck: number;
  private delay: StereoDelay;
  private delayReturn: number;
  private master: MasterChain;
  private ducker: Ducker;

  private busL: Float32Array;
  private busR: Float32Array;
  private revSend: Float32Array;
  private dlySend: Float32Array;
  private duckBuf: Float32Array;
  private frame = new Float64Array(2);

  private cursor = 0;
  private nextSection = 0;
  /** gain applied to the pre-master sum, from the drive measurement */
  readonly autoGain: number;
  readonly measuredDriveDb: number;

  constructor(opts: RenderOptions) {
    const sampleRate = opts.sampleRate ?? 44100;
    this.sampleRate = sampleRate;
    this.plan = buildPlan({
      seed: opts.seed,
      preset: opts.preset,
      ranges: opts.ranges,
      sampleRate,
      locks: opts.locks,
      words: opts.words,
    });
    const plan = this.plan;
    // a short flush so the limiter's lookahead is emptied into the output
    this.totalSamples = plan.totalSamples + MASTER_FLUSH_SAMPLES;
    this.chunkSize = plan.samplesPerBar;
    const chunk = this.chunkSize;

    this.wiring = buildBuses(plan, sampleRate, chunk, opts.onlyBus);
    for (const w of this.wiring) this.busPeaks[w.name] = 0;

    const sends = buildSends(plan, sampleRate);
    this.reverb = sends.reverb;
    this.reverbReturn = sends.reverbReturn;
    this.reverbDuck = plan.sends.reverb.duckAmount;
    this.delay = sends.delay;
    this.delayReturn = sends.delayReturn;

    this.master = new MasterChain(sampleRate, plan.master);
    this.master.setTotalSamples(this.totalSamples);
    this.ducker = new Ducker(
      plan.kickPositions, sampleRate, plan.duck.depth, plan.duck.attack, plan.duck.release,
    );

    this.busL = new Float32Array(chunk);
    this.busR = new Float32Array(chunk);
    this.revSend = new Float32Array(chunk);
    this.dlySend = new Float32Array(chunk);
    this.duckBuf = new Float32Array(chunk);

    const measured = opts.onlyBus ? plan.master.driveTargetDb : measureDrive(plan, sampleRate);
    this.measuredDriveDb = measured;
    // Every seed gets the gain IT needs, not the same gain. A fixed makeup
    // cannot serve every arrangement: the pre-master level varies by about
    // five decibels across seeds, so one value leaves some tracks limp and
    // crushes others. This is what a mastering engineer does - you gain into
    // the limiter by the amount that track needs.
    const wanted = plan.master.driveTargetDb - measured;
    this.autoGain = db2gain(clampNumber(wanted, -18, 30));
  }

  get position(): number {
    return this.cursor;
  }

  get done(): boolean {
    return this.cursor >= this.totalSamples;
  }

  get progress(): number {
    return this.totalSamples === 0 ? 1 : this.cursor / this.totalSamples;
  }

  /** The section this chunk belongs to, for progress labelling. */
  get currentSection(): string {
    const secs = this.plan.sections;
    for (const s of secs) if (this.cursor >= s.startSample && this.cursor < s.endSample) return s.name;
    return this.cursor === 0 ? secs[0]?.name ?? "start" : "tail";
  }

  /**
   * Renders the next chunk into L and R, which must be at least `chunkSize`
   * long. Returns the number of frames written, or 0 when the track is done.
   */
  next(L: Float32Array, R: Float32Array): number {
    if (this.done) return 0;
    const start = this.cursor;
    const count = Math.min(this.chunkSize, this.totalSamples - start);
    const { busL, busR, revSend, dlySend, duckBuf, frame } = this;

    L.fill(0, 0, count);
    R.fill(0, 0, count);
    revSend.fill(0, 0, count);
    dlySend.fill(0, 0, count);
    for (let i = 0; i < count; i++) duckBuf[i] = this.ducker.step(start + i);

    for (const w of this.wiring) {
      busL.fill(0, 0, count);
      busR.fill(0, 0, count);
      w.render(busL, busR, start, count);

      let peak = this.busPeaks[w.name];
      const duckAmt = w.duckAmount;
      for (let i = 0; i < count; i++) {
        const g = duckAmt > 0 ? 1 - duckAmt * (1 - duckBuf[i]) : 1;
        const l = busL[i] * g;
        const r = busR[i] * g;
        const a = l < 0 ? -l : l;
        const b = r < 0 ? -r : r;
        if (a > peak) peak = a;
        if (b > peak) peak = b;
        L[i] += l;
        R[i] += r;
        if (w.reverbSend > 0) revSend[i] += (l + r) * 0.5 * w.reverbSend;
        if (w.delaySend > 0) dlySend[i] += (l + r) * 0.5 * w.delaySend;
      }
      this.busPeaks[w.name] = peak;
    }

    // reverb return, ducked with everything else
    for (let i = 0; i < count; i++) {
      this.reverb.process(revSend[i], frame);
      const g = this.reverbDuck > 0 ? 1 - this.reverbDuck * (1 - duckBuf[i]) : 1;
      L[i] += frame[0] * this.reverbReturn * g;
      R[i] += frame[1] * this.reverbReturn * g;
    }
    // delay return
    for (let i = 0; i < count; i++) {
      this.delay.process(dlySend[i], dlySend[i], frame);
      L[i] += frame[0] * this.delayReturn;
      R[i] += frame[1] * this.delayReturn;
    }

    // the pre-master sum, driven to the level the chain expects
    const ag = this.autoGain;
    if (ag !== 1) {
      for (let i = 0; i < count; i++) {
        L[i] *= ag;
        R[i] *= ag;
      }
    }

    this.master.process(L, R, count, start);
    this.cursor = start + count;
    return count;
  }
}

interface Sends {
  reverb: Reverb;
  reverbReturn: number;
  delay: StereoDelay;
  delayReturn: number;
}

/** Builds the bus set. Shared by the real render and the drive probe. */
function buildBuses(
  plan: TrackPlan,
  sampleRate: number,
  chunk: number,
  only: BusName | undefined,
): BusWiring[] {
  const wanted = (b: BusName) => !only || only === b;
  const out: BusWiring[] = [];
  if (wanted("drums")) {
    const bus = new DrumsBus(plan, chunk);
    out.push({ name: "drums", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: 0, delaySend: 0, duckAmount: 0 });
  }
  if (wanted("bass808")) {
    const voice = new Bass808Voice(sampleRate, plan.bassNotes, {
      dropSemitones: plan.bass.dropSemitones,
      dropTime: plan.bass.dropTime,
      decay: plan.bass.decay,
      attack: plan.bass.attack,
      drive: plan.bass.drive,
      subLevel: plan.bass.subLevel,
      portamento: plan.bass.portamento,
      toneHz: plan.bass.toneHz,
    });
    const bus = new Bass808Bus(plan, chunk, voice);
    out.push({ name: "bass808", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: 0, delaySend: 0, duckAmount: 0 });
  }
  if (wanted("lead")) {
    const bus = new LeadBus(plan, chunk);
    out.push({ name: "lead", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: plan.lead.reverbSend, delaySend: plan.lead.delaySend, duckAmount: plan.lead.duckAmount });
  }
  if (wanted("arp")) {
    const bus = new ArpBus(plan, chunk);
    out.push({ name: "arp", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: plan.arp.reverbSend, delaySend: plan.arp.delaySend, duckAmount: plan.arp.duckAmount });
  }
  if (wanted("pads")) {
    const bus = new PadsBus(plan, chunk);
    out.push({ name: "pads", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: plan.pads.reverbSend, delaySend: 0, duckAmount: plan.pads.duckAmount });
  }
  if (wanted("fx")) {
    const bus = new FxBus(plan, chunk);
    out.push({ name: "fx", render: (L, R, s, c) => bus.render(L, R, s, c), reverbSend: plan.fx.reverbSend, delaySend: 0, duckAmount: 0 });
  }
  return out;
}

function buildSends(plan: TrackPlan, sampleRate: number): Sends {
  const reverb = new Reverb(sampleRate, 0);
  reverb.decay = plan.sends.reverb.decay;
  reverb.brightness = plan.sends.reverb.brightness;
  reverb.size = plan.sends.reverb.size;
  reverb.preDelaySeconds = plan.sends.reverb.preDelay;
  reverb.update();
  const delay = new StereoDelay(sampleRate, 2);
  delay.timeL = plan.sends.delay.timeL;
  delay.timeR = plan.sends.delay.timeR;
  delay.feedback = plan.sends.delay.feedback;
  delay.damping = plan.sends.delay.damping;
  delay.pingPong = true;
  return {
    reverb,
    reverbReturn: db2gain(plan.sends.reverb.returnDb),
    delay,
    delayReturn: db2gain(plan.sends.delay.returnDb),
  };
}

/** Warm-up before the measured window, so filters and reverb have settled. */
const PROBE_WARMUP_SECONDS = 0.8;
/** Length of the measured window. Matches the short-term window in loudness.ts. */
const PROBE_WINDOW_SECONDS = 3;

/**
 * Measures the loudest section's short-term RMS on the pre-master sum.
 *
 * The loudest section is rendered FIRST, out of playback order, so the gain is
 * known before a single sample of the real render is mixed. Rendering it
 * properly would mean running the buses from sample zero to reach it, which
 * for a drop starting at bar sixteen is most of the track - and time to first
 * sound would go from about a second to about ten. So this renders a short
 * probe with a fresh set of buses started at the section, plus a warm-up.
 *
 * The probe's filter and reverb state is therefore approximate rather than
 * what a sequential render would have reached, and the buffer is discarded
 * rather than reused - splicing it in would show a seam. Measured against the
 * real render the two agree closely, and the OUTPUT is exact either way: the
 * gain is a single multiply, so it is deterministic whatever the probe saw.
 */
function measureDrive(plan: TrackPlan, sampleRate: number): number {
  const loud = plan.sections.filter((s) => s.intensity >= 0.9);
  const section = loud.length > 0 ? loud[0] : plan.sections[plan.sections.length - 1];
  if (!section) return -20;

  const warm = Math.round(PROBE_WARMUP_SECONDS * sampleRate);
  const window = Math.round(PROBE_WINDOW_SECONDS * sampleRate);
  // a second in, so the section's own transition has passed
  const measureFrom = Math.min(
    section.startSample + sampleRate,
    Math.max(section.startSample, section.endSample - window),
  );
  const start = Math.max(0, measureFrom - warm);
  const total = measureFrom - start + window;
  if (total <= 0) return -20;

  const buses = buildBuses(plan, sampleRate, total, undefined);
  const sends = buildSends(plan, sampleRate);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const busL = new Float32Array(total);
  const busR = new Float32Array(total);
  const revSend = new Float32Array(total);
  const dlySend = new Float32Array(total);
  const frame = new Float64Array(2);

  for (const w of buses) {
    busL.fill(0);
    busR.fill(0);
    w.render(busL, busR, start, total);
    // a fresh ducker per bus: it must be read from the same position each time
    const ducker = new Ducker(
      plan.kickPositions, sampleRate, plan.duck.depth, plan.duck.attack, plan.duck.release,
    );
    for (let i = 0; i < total; i++) {
      const duck = ducker.step(start + i);
      const g = w.duckAmount > 0 ? 1 - w.duckAmount * (1 - duck) : 1;
      const l = busL[i] * g;
      const r = busR[i] * g;
      L[i] += l;
      R[i] += r;
      if (w.reverbSend > 0) revSend[i] += (l + r) * 0.5 * w.reverbSend;
      if (w.delaySend > 0) dlySend[i] += (l + r) * 0.5 * w.delaySend;
    }
  }
  for (let i = 0; i < total; i++) {
    sends.reverb.process(revSend[i], frame);
    L[i] += frame[0] * sends.reverbReturn;
    R[i] += frame[1] * sends.reverbReturn;
    sends.delay.process(dlySend[i], dlySend[i], frame);
    L[i] += frame[0] * sends.delayReturn;
    R[i] += frame[1] * sends.delayReturn;
  }

  const from = measureFrom - start;
  let sum = 0;
  for (let i = from; i < total; i++) sum += L[i] * L[i] + R[i] * R[i];
  const n = (total - from) * 2;
  return gain2db(dsqrt(sum / (n > 0 ? n : 1)));
}

/** Drives a TrackRenderer to completion into one buffer. */
export function renderTrack(opts: RenderOptions): RenderResult {
  const renderer = new TrackRenderer(opts);
  const n = renderer.totalSamples;
  const out = createStereo(n, renderer.sampleRate);
  const chunk = renderer.chunkSize;
  const L = new Float32Array(chunk);
  const R = new Float32Array(chunk);
  const progress = opts.onProgress;
  let sectionIndex = 0;

  while (!renderer.done) {
    const start = renderer.position;
    const count = renderer.next(L, R);
    if (count === 0) break;
    out.L.set(L.subarray(0, count), start);
    out.R.set(R.subarray(0, count), start);
    if (progress) {
      const secs = renderer.plan.sections;
      while (sectionIndex < secs.length && start + count >= secs[sectionIndex].startSample) {
        progress(renderer.progress, secs[sectionIndex].name);
        sectionIndex++;
      }
    }
  }
  progress?.(1, "done");

  return {
    audio: out,
    plan: renderer.plan,
    stats: {
      peakDb: peakDb(out),
      rmsDb: rmsDb(out),
      durationSeconds: n / renderer.sampleRate,
      busPeaks: renderer.busPeaks,
    },
  };
}

/** Renders one bus in isolation, including the effects it sends to. */
export function renderStem(opts: RenderOptions, bus: BusName): RenderResult {
  return renderTrack({ ...opts, onlyBus: bus });
}
