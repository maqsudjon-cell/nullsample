/**
 * The master chain.
 *
 * Order is fixed: bass-mono fold, glue compression, then a 4x oversampled
 * nonlinear region containing the saturation and the clipper, then the
 * high-shelf lift, then the limiter. Normalisation happens once at the end of
 * the render, when the true peak of the whole track is known.
 *
 * Everything below 120 Hz is folded to mono before anything else touches it.
 * Width comes from the detuned lead, the chorus, and a light Haas applied to
 * mids and highs only - never to the bass, which has to survive a phone
 * speaker and a club rig alike.
 */

import { clamp, db2gain } from "../core/dmath.ts";
import { Biquad, DcBlocker, Svf } from "../core/filter.ts";
import { DelayLine } from "../core/delay.ts";
import { Compressor, Limiter } from "../core/dynamics.ts";
import { AdaaClipper, Oversampler4x, softClip } from "../core/shape.ts";
import type { MasterParams } from "./plan.ts";

const BLOCK = 512;

export class MasterChain {
  private sr: number;
  private p: MasterParams;
  private sideHp: Svf;
  private midHp: Svf;
  private haas: DelayLine;
  private haasSamples: number;
  private compL: Compressor;
  private compR: Compressor;
  private osL: Oversampler4x;
  private osR: Oversampler4x;
  private clipL = new AdaaClipper();
  private clipR = new AdaaClipper();
  private shelfL = new Biquad();
  private shelfR = new Biquad();
  private dcL: DcBlocker;
  private dcR: DcBlocker;
  private limiter: Limiter;
  private frame = new Float64Array(2);
  private satComp: number;
  private inputGain: number;

  constructor(sampleRate: number, p: MasterParams) {
    this.sr = sampleRate;
    this.p = p;
    this.sideHp = new Svf(sampleRate);
    this.sideHp.set(120, 0.707);
    this.midHp = new Svf(sampleRate);
    this.midHp.set(400, 0.707);
    this.haas = new DelayLine(Math.ceil(0.05 * sampleRate));
    this.haasSamples = Math.max(1, Math.round(p.widthMid * sampleRate));

    this.compL = new Compressor(sampleRate, p.glueAttack, p.glueRelease);
    this.compR = new Compressor(sampleRate, p.glueAttack, p.glueRelease);
    for (const c of [this.compL, this.compR]) {
      c.thresholdDb = -18; // replaced by setGlueThresholdDb once the mix is measured
      c.ratio = p.glueRatio;
      c.kneeDb = 6;
      c.makeupDb = 0;
    }

    this.osL = new Oversampler4x(BLOCK);
    this.osR = new Oversampler4x(BLOCK);
    this.clipL.ceiling = p.clipCeiling;
    this.clipR.ceiling = p.clipCeiling;
    this.satComp = 1 / (1 + (p.satDrive - 1) * 0.8);

    // the shelf sits between the saturator and the clipper, so it runs at the
    // oversampled rate and its coefficients are designed for that rate
    this.shelfL.set("highshelf", sampleRate * 4, p.shelfHz, 0.707, p.shelfDb);
    this.shelfR.set("highshelf", sampleRate * 4, p.shelfHz, 0.707, p.shelfDb);

    // Clipping and limiting a gated, slightly asymmetric mix leaves a small
    // residual offset that no single stage is responsible for. It is about
    // -58 dBFS, which is not audible but is headroom the limiter would
    // otherwise spend on nothing. Removed before the limiter, so the ceiling
    // applies to the signal rather than to the signal plus an offset.
    this.dcL = new DcBlocker(sampleRate, 12);
    this.dcR = new DcBlocker(sampleRate, 12);
    this.limiter = new Limiter(sampleRate, 0.0025, 0.06);
    this.limiter.ceiling = db2gain(-0.6);
    // Set by the renderer once the mix level is known. See setInputGain.
    this.inputGain = 1;
  }

  /**
   * Processes a chunk in place.
   *
   * Order, and why the trim sits where it does: the glue compressor works on
   * the mix at its natural level, because a compressor with an absolute
   * threshold that is fed an already-boosted signal stops being glue and
   * becomes a brick wall - one seed measured 15 dB of gain reduction and came
   * out six decibels quieter than every other. The loudness trim therefore
   * goes after the compressor and before the saturation, which is where a
   * mastering engineer would put it.
   */
  process(L: Float32Array, R: Float32Array, count: number): void {
    const p = this.p;
    const frame = this.frame;

    // --- bass mono fold and Haas width ------------------------------------
    const widen = p.widthMid > 1e-5;
    for (let i = 0; i < count; i++) {
      const l = L[i];
      const r = R[i];
      const mid = (l + r) * 0.5;
      let side = (l - r) * 0.5;
      side = this.sideHp.highpass(side);
      if (widen) {
        const highs = this.midHp.highpass(mid);
        this.haas.write(highs);
        side += this.haas.read(this.haasSamples) * 0.45;
      }
      L[i] = mid + side;
      R[i] = mid - side;
    }

    // --- glue compression at the mix's own level, shared detector so the
    //     stereo image cannot shift, then the loudness trim ----------------
    const ig = this.inputGain;
    for (let i = 0; i < count; i++) {
      const l = L[i];
      const r = R[i];
      const det = (l < 0 ? -l : l) > (r < 0 ? -r : r) ? (l < 0 ? -l : l) : (r < 0 ? -r : r);
      L[i] = this.compL.process(l, det) * ig;
      R[i] = this.compR.process(r, det) * ig;
    }

    // --- saturation, shelf lift and clipper, in one 4x oversampled region -
    for (let i = 0; i < count; i += BLOCK) {
      const n = Math.min(BLOCK, count - i);
      this.nonlinear(L, i, n, this.osL, this.clipL, this.shelfL);
      this.nonlinear(R, i, n, this.osR, this.clipR, this.shelfR);
    }

    // --- DC removal then limiter ------------------------------------------
    for (let i = 0; i < count; i++) {
      this.limiter.process(this.dcL.process(L[i]), this.dcR.process(R[i]), frame);
      L[i] = frame[0];
      R[i] = frame[1];
    }
  }

  private nonlinear(
    buf: Float32Array,
    start: number,
    n: number,
    os: Oversampler4x,
    clip: AdaaClipper,
    shelf: Biquad,
  ): void {
    const drive = this.p.satDrive;
    const comp = this.satComp;
    os.upsample(buf, start, n);
    const s = os.scratch;
    const m = n * 4;
    for (let i = 0; i < m; i++) {
      // partial gain compensation: unity for quiet material, a little louder
      // where the saturation is actually working
      const sat = softClip(s[i] * drive) * comp;
      s[i] = clip.process(shelf.process(sat));
    }
    os.downsample(buf, start, n);
  }

  /**
   * The trim into the chain IS the loudness control: it decides how hard the
   * glue compressor, the saturator and the clipper are worked.
   *
   * It cannot be a fixed number of decibels. How loud the mix arrives depends
   * on which buses the arrangement happens to use and where their gains
   * landed, and that varied by six decibels across seeds - so a fixed trim
   * made some tracks crushed and others limp. The renderer measures the mix
   * and passes the trim that puts it at the preset's target RMS, so the chain
   * does the same amount of work on every seed.
   */
  setInputGain(gain: number): void {
    this.inputGain = gain;
  }

  /**
   * The glue threshold is relative to the mix's own RMS, so the compressor
   * does the same amount of work whatever level the arrangement happened to
   * arrive at.
   */
  setGlueThresholdDb(db: number): void {
    this.compL.thresholdDb = db;
    this.compR.thresholdDb = db;
  }

  /** Latency introduced by the limiter's lookahead, in samples. */
  get latency(): number {
    return Math.floor(0.0025 * this.sr);
  }
}

/**
 * Scales the finished track to the target peak and applies short fades.
 * Done as a separate pass because the true peak is only known once the whole
 * track exists.
 */
export function normaliseAndFade(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  targetPeakDb: number,
  fadeInSeconds = 0.006,
  fadeOutSeconds = 0.35,
): { gain: number; peakBefore: number } {
  // Fades first, then measure, then scale. The other order lets a peak that
  // happens to sit inside the fade-out get attenuated after it was measured,
  // so the finished track lands short of its target by however much the fade
  // took off.
  const fin = Math.min(L.length, Math.round(fadeInSeconds * sampleRate));
  for (let i = 0; i < fin; i++) {
    const g = i / fin;
    L[i] *= g;
    R[i] *= g;
  }
  const fout = Math.min(L.length, Math.round(fadeOutSeconds * sampleRate));
  for (let i = 0; i < fout; i++) {
    const g = i / fout;
    const j = L.length - 1 - i;
    L[j] *= g;
    R[j] *= g;
  }

  let peak = 0;
  for (let i = 0; i < L.length; i++) {
    const a = L[i] < 0 ? -L[i] : L[i];
    const b = R[i] < 0 ? -R[i] : R[i];
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const target = db2gain(targetPeakDb);
  const gain = peak > 1e-9 ? target / peak : 1;
  for (let i = 0; i < L.length; i++) {
    L[i] *= gain;
    R[i] *= gain;
  }
  return { gain, peakBefore: peak };
}

export { clamp };
