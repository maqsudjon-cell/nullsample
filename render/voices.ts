/**
 * Bus renderers.
 *
 * Each bus is a streaming object: `render(L, R, start, count)` fills a chunk
 * and carries its own state across chunk boundaries. Nothing holds a
 * full-length buffer, which is what keeps a two-minute render inside a phone's
 * memory budget rather than needing six float buffers plus oversampled
 * scratch.
 */

import { cents, clamp, db2gain, dsqrt, midiToHz, panGains } from "../core/dmath.ts";
import { makeRng, type Rng } from "../core/rng.ts";
import { Adsr, ExpDecay } from "../core/env.ts";
import { DcBlocker, Svf } from "../core/filter.ts";
import {
  FmPair, Pulse, PulseStack, Saw, Sine, Supersaw, SyncSaw, WhiteNoise,
  type LeadVoice,
} from "../core/osc.ts";
import { DistortionChain, softClip } from "../core/shape.ts";
import { Chorus } from "../core/delay.ts";
import { FormantVoice, NEUTRAL_FORMANTS } from "../core/formant.ts";
import { renderClap, renderHat, renderKick, renderRim, renderSnare } from "../core/drums.ts";
import type { Bass808Voice } from "../core/bass808.ts";
import type { DrumEvent, DrumVoice, NoteEvent, ChordEvent, FxEvent, TrackPlan } from "./plan.ts";

const BLOCK = 512;

/**
 * How often a modulated filter recomputes its coefficients.
 *
 * Section automation moves a cutoff by a few hertz per sample at most, and
 * recomputing a state-variable filter's coefficients needs a tangent, which
 * measured as one of the hottest functions in the whole engine. Sixteen
 * samples is 0.36 ms at 44.1 kHz - far faster than any audible sweep - and the
 * interval is fixed, so the result stays bit-identical everywhere.
 */
const COEF_INTERVAL = 16;

/** Per-bar section automation, sampled once per bar and smoothed per sample. */
export class Automation {
  private filterOpen: Float32Array;
  private gain: Float32Array;
  private samplesPerBar: number;
  private bars: number;
  private smoothFilter = 1;
  private smoothGain = 1;
  private k = 0.9994;

  constructor(plan: TrackPlan) {
    this.samplesPerBar = plan.samplesPerBar;
    this.bars = plan.bars;
    this.filterOpen = new Float32Array(plan.bars + 1);
    this.gain = new Float32Array(plan.bars + 1);
    this.filterOpen.fill(1);
    this.gain.fill(1);
    for (const s of plan.arrangement.sections) {
      for (let b = 0; b < s.bars; b++) {
        const bar = s.startBar + b;
        if (bar >= this.filterOpen.length) break;
        // sections rise slightly across their length, which is what gives a
        // build its shape without any explicit automation curve
        const t = s.bars <= 1 ? 1 : b / (s.bars - 1);
        this.filterOpen[bar] = s.filterOpen + (1 - s.filterOpen) * 0.35 * t;
        this.gain[bar] = db2gain(s.gainDb);
      }
    }
    this.smoothFilter = this.filterOpen[0];
    this.smoothGain = this.gain[0];
  }

  private targetF = 1;
  private targetG = 1;

  /**
   * Chunks are exactly one bar long, so the section targets are constant
   * across a chunk. Resolving them once here removes a division and an array
   * read from the per-sample path of every bus.
   */
  beginChunk(startSample: number): void {
    let bar = Math.floor(startSample / this.samplesPerBar);
    if (bar >= this.bars) bar = this.bars - 1;
    if (bar < 0) bar = 0;
    this.targetF = this.filterOpen[bar];
    this.targetG = this.gain[bar];
  }

  /** Advances one sample and returns the smoothed pair. */
  step(out: Float64Array): void {
    const tf = this.targetF;
    const tg = this.targetG;
    this.smoothFilter = tf + (this.smoothFilter - tf) * this.k;
    this.smoothGain = tg + (this.smoothGain - tg) * this.k;
    out[0] = this.smoothFilter;
    out[1] = this.smoothGain;
  }
}

// ---------------------------------------------------------------------------
// drums
// ---------------------------------------------------------------------------

interface ActiveHit {
  buf: Float32Array;
  pos: number;
  gainL: number;
  gainR: number;
}

/**
 * Pre-renders a small bank of timbre variants per voice, then mixes them.
 * Synthesising every hit from scratch would cost as much as the rest of the
 * track put together and would not sound meaningfully different.
 */
export class DrumsBus {
  private plan: TrackPlan;
  private hits: Record<DrumVoice, Float32Array[]>;
  private active: ActiveHit[] = [];
  private cursor = 0;
  private dist: DistortionChain;
  private gain: number;
  private auto: Automation;
  private tmp = new Float64Array(2);
  private scratchL: Float32Array;
  private scratchR: Float32Array;

  constructor(plan: TrackPlan, chunkSize: number) {
    this.plan = plan;
    this.auto = new Automation(plan);
    const sr = plan.sampleRate;
    const p = plan.drum;
    // The kit must follow the DRUMS bus seed, not the track seed, or locking
    // the drums and rerolling still changes every drum's timbre.
    const rng = makeRng(plan.locks["drums"] ?? plan.seed).child("drumkit");
    const jitter = (r: Rng, v: number, amount: number) => v * (1 + r.range(-amount, amount));

    const variants = 4;
    const build = <T>(voice: DrumVoice, make: (r: Rng, v: number) => Float32Array) => {
      const arr: Float32Array[] = [];
      for (let v = 0; v < variants; v++) arr.push(make(rng.child(`${voice}${v}`), v));
      return arr;
    };

    this.hits = {
      kick: build("kick", (r) =>
        renderKick(sr, {
          startHz: jitter(r, p.kick.startHz, 0.05),
          endHz: jitter(r, p.kick.endHz, 0.02),
          pitchDecay: jitter(r, p.kick.pitchDecay, 0.08),
          ampDecay: jitter(r, p.kick.ampDecay, 0.06),
          clickLevel: jitter(r, p.kick.clickLevel, 0.15),
          clickDecay: p.kick.clickDecay,
          drive: p.kick.drive,
          bodyLevel: p.kick.bodyLevel,
        }, r)),
      snare: build("snare", (r) =>
        renderSnare(sr, {
          toneHz: jitter(r, p.snare.toneHz, 0.03),
          toneDecay: jitter(r, p.snare.toneDecay, 0.1),
          noiseDecay: jitter(r, p.snare.noiseDecay, 0.1),
          noiseLowHz: p.snare.noiseLowHz,
          noiseHighHz: p.snare.noiseHighHz,
          noiseLevel: p.snare.noiseLevel,
          toneLevel: p.snare.toneLevel,
          drive: p.snare.drive,
        }, r)),
      clap: build("clap", (r) =>
        renderClap(sr, {
          bursts: p.clap.bursts,
          spacing: jitter(r, p.clap.spacing, 0.12),
          spread: p.clap.spread,
          bandLowHz: p.clap.bandLowHz,
          bandHighHz: p.clap.bandHighHz,
          burstDecay: p.clap.burstDecay,
          tailDecay: p.clap.tailDecay,
          tailLevel: p.clap.tailLevel,
        }, r)),
      hatClosed: build("hatClosed", (r) =>
        renderHat(sr, {
          decay: jitter(r, p.hatClosed.decay, 0.18),
          baseHz: jitter(r, p.hatClosed.baseHz, 0.04),
          highpassHz: p.hatClosed.highpassHz,
          bandHz: p.hatClosed.bandHz,
          bandQ: p.hatClosed.bandQ,
          noiseMix: p.hatClosed.noiseMix,
        }, r)),
      hatOpen: build("hatOpen", (r) =>
        renderHat(sr, {
          decay: jitter(r, p.hatOpen.decay, 0.12),
          baseHz: p.hatOpen.baseHz,
          highpassHz: p.hatOpen.highpassHz,
          bandHz: p.hatOpen.bandHz,
          bandQ: p.hatOpen.bandQ,
          noiseMix: p.hatOpen.noiseMix,
        }, r)),
      rim: build("rim", (r) =>
        renderRim(sr, {
          hz: jitter(r, p.rim.hz, 0.05),
          q: p.rim.q,
          decay: p.rim.decay,
          clickLevel: p.rim.clickLevel,
        }, r)),
    };

    this.dist = new DistortionChain(BLOCK, sr);
    this.dist.params = {
      drive: p.busDrive,
      fold: 0,
      bias: 0,
      ceiling: 0.95,
      output: 1 / (1 + (p.busDrive - 1) * 0.7),
    };
    this.dist.paramsChanged();
    this.gain = db2gain(p.gainDb);
    this.scratchL = new Float32Array(chunkSize);
    this.scratchR = new Float32Array(chunkSize);
  }

  private voiceGain(voice: DrumVoice): number {
    const p = this.plan.drum;
    switch (voice) {
      case "kick": return db2gain(p.kick.gainDb);
      case "snare": return db2gain(p.snare.gainDb);
      case "clap": return db2gain(p.clap.gainDb);
      case "hatClosed": return db2gain(p.hatClosed.gainDb);
      case "hatOpen": return db2gain(p.hatOpen.gainDb);
      default: return db2gain(p.rim.gainDb);
    }
  }

  private voicePan(voice: DrumVoice, index: number): number {
    const spread = this.plan.drum.hatPan;
    if (voice === "hatClosed" || voice === "hatOpen") return (index % 2 === 0 ? -1 : 1) * spread;
    if (voice === "rim") return spread * 0.8;
    return 0;
  }

  render(L: Float32Array, R: Float32Array, start: number, count: number): void {
    this.auto.beginChunk(start);
    const sl = this.scratchL;
    const sr = this.scratchR;
    sl.fill(0, 0, count);
    sr.fill(0, 0, count);
    const events = this.plan.drumEvents;
    const end = start + count;

    // spawn hits that begin in this chunk
    while (this.cursor < events.length && events[this.cursor].at < end) {
      const e = events[this.cursor];
      if (e.at >= start) {
        const bank = this.hits[e.voice];
        const buf = bank[e.variant % bank.length];
        const g = this.voiceGain(e.voice) * e.velocity;
        const [pl, pr] = panGains(this.voicePan(e.voice, this.cursor));
        this.active.push({ buf, pos: -(e.at - start), gainL: g * pl, gainR: g * pr });
      }
      this.cursor++;
    }

    // mix every hit still sounding
    for (let a = this.active.length - 1; a >= 0; a--) {
      const hit = this.active[a];
      const buf = hit.buf;
      const n = buf.length;
      let pos = hit.pos;
      let i = 0;
      // a hit that starts partway into this chunk carries a negative position:
      // skip forward in the output, and start reading the hit at its own start
      if (pos < 0) {
        i = -pos;
        pos = 0;
      }
      for (; i < count && pos < n; i++, pos++) {
        const v = buf[pos];
        sl[i] += v * hit.gainL;
        sr[i] += v * hit.gainR;
      }
      hit.pos = pos;
      if (pos >= n) this.active.splice(a, 1);
    }

    // bus saturation, oversampled, then gain and section automation
    for (let i = 0; i < count; i += BLOCK) {
      const n = Math.min(BLOCK, count - i);
      this.dist.process(sl, i, n);
    }
    const distR = this.distR();
    for (let i = 0; i < count; i += BLOCK) {
      const n = Math.min(BLOCK, count - i);
      distR.process(sr, i, n);
    }

    const auto = this.tmp;
    for (let i = 0; i < count; i++) {
      this.auto.step(auto);
      // no DC blocker here: DistortionChain already removes its own DC, and
      // blocking one channel only would skew the stereo image
      const g = this.gain * auto[1];
      L[i] += sl[i] * g;
      R[i] += sr[i] * g;
    }
  }

  private _distR: DistortionChain | undefined;
  private distR(): DistortionChain {
    if (!this._distR) {
      this._distR = new DistortionChain(BLOCK, this.plan.sampleRate);
      this._distR.params = { ...this.dist.params };
      this._distR.paramsChanged();
    }
    return this._distR;
  }
}

// ---------------------------------------------------------------------------
// 808
// ---------------------------------------------------------------------------

/**
 * The 808 bus: a streaming sub voice into the distortion chain.
 *
 * Everything below 120 Hz stays mono, so this bus is written to both channels
 * at identical level and is never widened.
 */
export class Bass808Bus {
  private voice: Bass808Voice;
  private dist: DistortionChain;
  private gain: number;
  private auto: Automation;
  private tmp = new Float64Array(2);
  private scratch: Float32Array;

  constructor(plan: TrackPlan, chunkSize: number, voice: Bass808Voice) {
    this.voice = voice;
    this.auto = new Automation(plan);
    const p = plan.bass;
    this.dist = new DistortionChain(BLOCK, plan.sampleRate);
    this.dist.params = {
      drive: p.distDrive,
      fold: p.fold,
      bias: p.bias,
      ceiling: p.ceiling,
      output: 1 / (1 + (p.distDrive - 1) * 0.6),
    };
    this.dist.paramsChanged();
    this.gain = db2gain(p.gainDb);
    this.scratch = new Float32Array(chunkSize);
  }

  render(L: Float32Array, R: Float32Array, start: number, count: number): void {
    this.auto.beginChunk(start);
    const s = this.scratch;
    this.voice.render(s, start, count);
    for (let i = 0; i < count; i += BLOCK) {
      this.dist.process(s, i, Math.min(BLOCK, count - i));
    }
    const auto = this.tmp;
    for (let i = 0; i < count; i++) {
      this.auto.step(auto);
      // everything below 120 Hz stays mono, so the 808 is written to both
      // channels at identical level and never widened
      const v = s[i] * this.gain * auto[1];
      L[i] += v;
      R[i] += v;
    }
  }
}

// ---------------------------------------------------------------------------
// lead
// ---------------------------------------------------------------------------

/**
 * Builds the lead's oscillator from the architecture the seed drew.
 *
 * All four feed the same filter, distortion and effects chain, so what changes
 * is the instrument rather than the treatment.
 */
function buildLeadVoice(plan: TrackPlan, rng: Rng): LeadVoice {
  const p = plan.lead;
  switch (p.architecture) {
    case "pulseStack":
      return new PulseStack(
        plan.sampleRate, rng, p.voices, p.detuneCents, p.spread,
        p.pulseWidthCentre, p.pulseWidthDepth,
      );
    case "syncSaw":
      return new SyncSaw(plan.sampleRate, rng, p.voices, p.detuneCents, p.spread, p.syncRatio);
    case "fmPair":
      return new FmPair(
        plan.sampleRate, rng, p.voices, p.detuneCents, p.spread, p.fmRatio, p.fmIndex,
      );
    default:
      return new Supersaw(plan.sampleRate, rng, p.voices, p.detuneCents, p.spread);
  }
}

export class LeadBus {
  private plan: TrackPlan;
  private saw: LeadVoice;
  private env: Adsr;
  private filt: Svf;
  private filtRight: Svf;
  private distL: DistortionChain;
  private distR: DistortionChain;
  private chorus: Chorus;
  private gain: number;
  private cursor = 0;
  private noteEnd = -1;
  private auto: Automation;
  private frame = new Float64Array(2);
  private autoTmp = new Float64Array(2);
  private chorusOut = new Float64Array(2);
  private scratchL: Float32Array;
  private scratchR: Float32Array;
  private silenced = false;
  private coefCounter = 0;

  constructor(plan: TrackPlan, chunkSize: number) {
    this.plan = plan;
    const p = plan.lead;
    const rng = makeRng(plan.locks["lead"] ?? plan.seed).child("lead").child("voice");
    this.saw = buildLeadVoice(plan, rng);
    this.env = new Adsr(plan.sampleRate);
    this.env.set(p.attack, p.decay, p.sustain, p.release);
    this.filt = new Svf(plan.sampleRate);
    this.filtRight = new Svf(plan.sampleRate);
    this.distL = new DistortionChain(BLOCK, plan.sampleRate);
    this.distR = new DistortionChain(BLOCK, plan.sampleRate);
    const params = {
      drive: p.distDrive,
      fold: p.fold,
      bias: p.bias,
      ceiling: p.ceiling,
      output: 1 / (1 + (p.distDrive - 1) * 0.55),
    };
    this.distL.params = { ...params };
    this.distR.params = { ...params };
    this.distL.paramsChanged();
    this.distR.paramsChanged();
    this.chorus = new Chorus(plan.sampleRate, 3);
    this.chorus.depth = p.chorusDepth;
    this.chorus.rate = 0.32;
    this.gain = db2gain(p.gainDb);
    this.auto = new Automation(plan);
    this.scratchL = new Float32Array(chunkSize);
    this.scratchR = new Float32Array(chunkSize);
  }

  render(L: Float32Array, R: Float32Array, start: number, count: number): void {
    this.auto.beginChunk(start);
    const p = this.plan.lead;
    const notes = this.plan.leadNotes;
    const sl = this.scratchL;
    const sr = this.scratchR;
    const frame = this.frame;
    const auto = this.autoTmp;
    const useChorus = p.chorusDepth > 1e-5;

    for (let i = 0; i < count; i++) {
      const abs = start + i;
      while (this.cursor < notes.length && notes[this.cursor].start <= abs) {
        const n = notes[this.cursor];
        this.saw.setFreq(midiToHz(n.midi), cents);
        this.env.trigger();
        this.noteEnd = n.start + n.length;
        this.cursor++;
      }
      if (this.noteEnd >= 0 && abs === this.noteEnd) this.env.release();

      this.auto.step(auto);
      if (!this.env.active) {
        // The lead only plays in the drops. Resetting the filters once on the
        // way down makes skipping exact: zero state and zero input give zero
        // output, so nothing is lost by not running the supersaw at all.
        if (!this.silenced) {
          this.filt.reset();
          this.filtRight.reset();
          this.silenced = true;
        }
        sl[i] = 0;
        sr[i] = 0;
        continue;
      }
      this.silenced = false;
      const e = this.env.next();
      this.coefCounter--;
      if (this.coefCounter <= 0) {
        const cutoff = clamp(
          p.filterHz * (1 + p.envAmount * e * 3) * (0.25 + 0.75 * auto[0]),
          60,
          this.plan.sampleRate * 0.48,
        );
        this.filt.set(cutoff, p.filterQ);
        // The right channel needs its own filter STATE to preserve the stereo
        // detune, but it must use the same cutoff, or the two channels drift
        // apart tonally and the image smears.
        this.filtRight.set(cutoff, p.filterQ);
        this.coefCounter = COEF_INTERVAL;
      }
      this.saw.next(frame);
      const l = this.filt.lowpass(frame[0]) * e;
      const r = this.filtRight.lowpass(frame[1]) * e;
      sl[i] = l * auto[1];
      sr[i] = r * auto[1];
    }

    for (let i = 0; i < count; i += BLOCK) {
      const n = Math.min(BLOCK, count - i);
      this.distL.process(sl, i, n);
      this.distR.process(sr, i, n);
    }

    if (useChorus) {
      const co = this.chorusOut;
      for (let i = 0; i < count; i++) {
        this.chorus.process((sl[i] + sr[i]) * 0.5, co);
        sl[i] = sl[i] * 0.72 + co[0] * 0.45;
        sr[i] = sr[i] * 0.72 + co[1] * 0.45;
      }
    }

    for (let i = 0; i < count; i++) {
      L[i] += sl[i] * this.gain;
      R[i] += sr[i] * this.gain;
    }
  }

}

// ---------------------------------------------------------------------------
// arp
// ---------------------------------------------------------------------------

export class ArpBus {
  private plan: TrackPlan;
  private osc: Pulse;
  private dc: DcBlocker;
  private env: ExpDecay;
  private filt: Svf;
  private gain: number;
  private cursor = 0;
  private auto: Automation;
  private autoTmp = new Float64Array(2);
  private panL = 0.7;
  private panR = 0.7;
  private index = 0;
  private coefCounter = 0;

  constructor(plan: TrackPlan, _chunkSize: number) {
    this.plan = plan;
    const p = plan.arp;
    const rng = makeRng(plan.locks["arp"] ?? plan.seed).child("arp").child("voice");
    this.osc = new Pulse(plan.sampleRate, rng.float());
    this.osc.width = p.pulseWidth;
    this.env = new ExpDecay(plan.sampleRate);
    this.env.set(p.decay);
    this.filt = new Svf(plan.sampleRate);
    this.gain = db2gain(p.gainDb);
    this.auto = new Automation(plan);
    // A pulse wave of width w carries a constant offset of 2w-1 by
    // construction. At width 0.25 that is -0.5 of pure DC, which costs real
    // headroom on the master and is not part of the sound.
    this.dc = new DcBlocker(plan.sampleRate, 18);
  }

  render(L: Float32Array, R: Float32Array, start: number, count: number): void {
    this.auto.beginChunk(start);
    const p = this.plan.arp;
    const notes = this.plan.arpNotes;
    const auto = this.autoTmp;
    for (let i = 0; i < count; i++) {
      const abs = start + i;
      while (this.cursor < notes.length && notes[this.cursor].start <= abs) {
        const n = notes[this.cursor];
        this.osc.setFreq(midiToHz(n.midi));
        this.env.trigger(n.velocity);
        // alternate sides so a fast arp opens the stereo field
        const pan = (this.index % 2 === 0 ? -1 : 1) * p.spread;
        const g = panGains(pan);
        this.panL = g[0];
        this.panR = g[1];
        this.index++;
        this.cursor++;
      }
      this.auto.step(auto);
      const e = this.env.next();
      let raw = 0;
      if (e >= 1e-5) {
        if (--this.coefCounter <= 0) {
          this.filt.set(
            clamp(p.filterHz * (0.3 + 0.7 * auto[0]), 60, this.plan.sampleRate * 0.48),
            p.filterQ,
          );
          this.coefCounter = COEF_INTERVAL;
        }
        raw = softClip(this.filt.lowpass(this.osc.next()) * e * 1.4);
      }
      // The blocker runs on every sample, including the gaps between notes:
      // a one-pole that only ran during notes would never settle.
      const v = this.dc.process(raw) * this.gain * auto[1];
      L[i] += v * this.panL;
      R[i] += v * this.panR;
    }
  }
}

// ---------------------------------------------------------------------------
// pads
// ---------------------------------------------------------------------------

interface PadVoice {
  a: Saw;
  b: Saw;
  formant: FormantVoice;
  env: Adsr;
  midi: number;
  panL: number;
  panR: number;
  active: boolean;
}

export class PadsBus {
  private plan: TrackPlan;
  private voices: PadVoice[] = [];
  private filtL: Svf;
  private filtR: Svf;
  private gain: number;
  private cursor = 0;
  private currentEnd = -1;
  private auto: Automation;
  private autoTmp = new Float64Array(2);
  private silenced = false;
  private coefCounter = 0;
  /** 1/sqrt(active voices): the pad voices are detuned and so incoherent */
  private voiceNorm = 1;

  constructor(plan: TrackPlan, _chunkSize: number) {
    this.plan = plan;
    const p = plan.pads;
    const rng = makeRng(plan.locks["pads"] ?? plan.seed).child("pads").child("voice");
    for (let i = 0; i < 4; i++) {
      const spread = ((i / 3) * 2 - 1) * p.spread;
      const g = panGains(spread);
      this.voices.push({
        a: new Saw(plan.sampleRate, rng.float()),
        b: new Saw(plan.sampleRate, rng.float()),
        formant: new FormantVoice(plan.sampleRate, rng.child(`f${i}`), NEUTRAL_FORMANTS),
        env: new Adsr(plan.sampleRate),
        midi: 0,
        panL: g[0],
        panR: g[1],
        active: false,
      });
      this.voices[i].env.set(p.attack, 0.4, 0.85, p.release);
    }
    this.filtL = new Svf(plan.sampleRate);
    this.filtR = new Svf(plan.sampleRate);
    this.gain = db2gain(p.gainDb);
    this.auto = new Automation(plan);
  }

  render(L: Float32Array, R: Float32Array, start: number, count: number): void {
    this.auto.beginChunk(start);
    const p = this.plan.pads;
    const chords = this.plan.padChords;
    const auto = this.autoTmp;
    const detune = cents(p.detuneCents);
    const useFormant = p.formantMix > 0.02;

    for (let i = 0; i < count; i++) {
      const abs = start + i;
      while (this.cursor < chords.length && chords[this.cursor].start <= abs) {
        const c: ChordEvent = chords[this.cursor];
        for (let v = 0; v < this.voices.length; v++) {
          const voice = this.voices[v];
          if (v < c.notes.length) {
            voice.midi = c.notes[v];
            const hz = midiToHz(voice.midi);
            voice.a.setFreq(hz * detune);
            voice.b.setFreq(hz / detune);
            voice.formant.setFreq(hz);
            voice.env.trigger();
            voice.active = true;
          } else if (voice.active) {
            voice.env.release();
          }
        }
        // Voice-count compensation, same reasoning as the supersaw: a
        // four-note chord must not be louder than a two-note one.
        const sounding = Math.min(this.voices.length, Math.max(1, c.notes.length));
        this.voiceNorm = 1 / dsqrt(sounding);
        this.currentEnd = c.start + c.length;
        this.cursor++;
      }
      if (this.currentEnd >= 0 && abs === this.currentEnd) {
        for (const v of this.voices) if (v.active) v.env.release();
      }

      this.auto.step(auto);
      let anyActive = false;
      for (const v of this.voices) if (v.active) { anyActive = true; break; }
      if (!anyActive) {
        if (!this.silenced) {
          this.filtL.reset();
          this.filtR.reset();
          this.silenced = true;
        }
        continue;
      }
      this.silenced = false;

      let l = 0;
      let r = 0;
      for (const v of this.voices) {
        if (!v.active) continue;
        const e = v.env.next();
        if (e < 1e-5) {
          v.active = false;
          continue;
        }
        // two detuned saws are incoherent too, so root-two rather than a half
        let s = (v.a.next() + v.b.next()) * 0.7071067811865476;
        if (useFormant) s = s * (1 - p.formantMix) + v.formant.next() * p.formantMix * 0.6;
        const y = s * e;
        l += y * v.panL;
        r += y * v.panR;
      }

      if (--this.coefCounter <= 0) {
        const cutoff = clamp(p.filterHz * (0.3 + 0.7 * auto[0]), 60, this.plan.sampleRate * 0.48);
        this.filtL.set(cutoff, p.filterQ);
        this.filtR.set(cutoff, p.filterQ);
        this.coefCounter = COEF_INTERVAL;
      }
      const g = this.gain * auto[1] * this.voiceNorm * 0.5;
      L[i] += this.filtL.lowpass(l) * g;
      R[i] += this.filtR.lowpass(r) * g;
    }
  }
}

// ---------------------------------------------------------------------------
// fx
// ---------------------------------------------------------------------------

export class FxBus {
  private plan: TrackPlan;
  private noise: WhiteNoise;
  private band: Svf;
  private bandR: Svf;
  private boom: Sine;
  private boomEnv: ExpDecay;
  private gain: number;
  private auto: Automation;
  private autoTmp = new Float64Array(2);

  constructor(plan: TrackPlan, _chunkSize: number) {
    this.plan = plan;
    const rng = makeRng(plan.locks["fx"] ?? plan.seed).child("fx").child("voice");
    this.noise = new WhiteNoise(rng);
    this.band = new Svf(plan.sampleRate);
    this.bandR = new Svf(plan.sampleRate);
    this.boom = new Sine(plan.sampleRate);
    this.boomEnv = new ExpDecay(plan.sampleRate);
    this.boomEnv.set(plan.fx.impactDecay);
    this.gain = db2gain(plan.fx.gainDb);
    this.auto = new Automation(plan);
  }

  render(L: Float32Array, R: Float32Array, start: number, count: number): void {
    this.auto.beginChunk(start);
    const p = this.plan.fx;
    const events = this.plan.fxEvents;
    const auto = this.autoTmp;
    const end = start + count;

    // impacts are triggered, sweeps are evaluated positionally
    for (const e of events) {
      if (e.kind === "impact" && e.start >= start && e.start < end) {
        this.boom.setFreq(70);
        this.boomEnv.trigger(e.level);
      }
    }

    // resolve which sweeps overlap this chunk once, rather than scanning the
    // whole event list for every sample
    const overlapping: FxEvent[] = [];
    for (const e of events) {
      if (e.kind !== "impact" && e.start < end && e.start + e.length > start) overlapping.push(e);
    }

    for (let i = 0; i < count; i++) {
      const abs = start + i;
      let sweep = 0;
      let sweepHz = 0;
      let q = 3.2;
      for (const e of overlapping) {
        if (abs < e.start || abs >= e.start + e.length) continue;
        const t = (abs - e.start) / e.length;
        if (e.kind === "riser") {
          sweep = t * t * e.level;
          sweepHz = p.riserStartHz + (p.riserEndHz - p.riserStartHz) * (t * t);
          q = 3.2;
        } else if (e.kind === "downlifter") {
          // the riser run backwards: loudest at the moment the drop ends, then
          // falling in pitch and level through the section it opens
          const u = 1 - t;
          sweep = u * u * e.level;
          sweepHz = p.riserEndHz * u * u + 70;
          q = 2.4;
        } else {
          sweep = t * t * t * e.level;
          sweepHz = p.riserEndHz * 0.5;
          q = 1.2;
        }
      }

      let l = 0;
      let r = 0;
      if (sweep > 1e-4) {
        // a bandpass has roughly Q times the gain at its centre, so the
        // resonance has to be divided back out or the sweep clips the bus
        const norm = 0.85 / q;
        this.band.set(clamp(sweepHz, 60, this.plan.sampleRate * 0.45), q);
        this.bandR.set(clamp(sweepHz * 1.03, 60, this.plan.sampleRate * 0.45), q);
        const n = this.noise.next();
        l += this.band.bandpass(n) * sweep * norm;
        r += this.bandR.bandpass(n) * sweep * norm;
      }
      const be = this.boomEnv.next();
      if (be > 1e-4) {
        const b = this.boom.next() * be;
        l += b;
        r += b;
      }

      this.auto.step(auto);
      const g = this.gain * auto[1];
      L[i] += l * g;
      R[i] += r * g;
    }
  }
}
