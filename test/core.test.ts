import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cents, clamp, cosTurns, db2gain, dexp, dexp2, dlog, dlog2, dpow, dsqrt, dtanh,
  gain2db, lerp, midiToHz, panGains, pow2i, semitones, sinTurns, tanTurns, timeCoef,
} from "../core/dmath.ts";
import { makeRng, normaliseSeed, Rng } from "../core/rng.ts";
import { Pulse, Saw, Sine, Supersaw, Triangle, WhiteNoise, PinkNoise, polyBlep } from "../core/osc.ts";
import { Adsr, ExpDecay, renderSegments } from "../core/env.ts";
import { Biquad, DcBlocker, OnePole, Svf } from "../core/filter.ts";
import { AdaaClipper, Bitcrush, DistortionChain, Oversampler4x, kaiserLowpass, softClip, waveshape, hardClip } from "../core/shape.ts";
import { Chorus, DelayLine, Haas, StereoDelay } from "../core/delay.ts";
import { Reverb } from "../core/reverb.ts";
import { buildDuckCurve, Compressor, EnvelopeFollower, Limiter, peakMono } from "../core/dynamics.ts";
import { renderClap, renderHat, renderKick, renderRim, renderSnare, renderTom } from "../core/drums.ts";
import { render808 } from "../core/bass808.ts";
import { FormantVoice, NEUTRAL_FORMANTS } from "../core/formant.ts";
import { createStereo, dcOffset, envelopePeaks, longestSilence, mixInto, peak, rms } from "../core/buffer.ts";
import { decodeWav, encodeWav, encodeWavMono } from "../render/wav.ts";
import { harmonicSnr } from "./spectrum.ts";

const SR = 44100;

const finite = (b: ArrayLike<number>, label: string) => {
  for (let i = 0; i < b.length; i++) {
    assert.ok(Number.isFinite(b[i]), `${label}: non-finite at ${i} (${b[i]})`);
  }
};

// ---------------------------------------------------------------- dmath ----

test("dmath: trigonometry matches the reference to double precision", () => {
  let worstSin = 0;
  let worstCos = 0;
  for (let i = 0; i < 100000; i++) {
    const t = i / 100000;
    worstSin = Math.max(worstSin, Math.abs(sinTurns(t) - Math.sin(2 * Math.PI * t)));
    worstCos = Math.max(worstCos, Math.abs(cosTurns(t) - Math.cos(2 * Math.PI * t)));
  }
  assert.ok(worstSin < 1e-14, `sin error ${worstSin}`);
  assert.ok(worstCos < 1e-14, `cos error ${worstCos}`);
});

test("dmath: sin and cos wrap over many turns without drift", () => {
  for (const t of [-3.25, -0.5, 0, 0.5, 7.25, 1e6 + 0.125]) {
    const wrapped = t - Math.floor(t);
    assert.ok(Math.abs(sinTurns(t) - sinTurns(wrapped)) < 1e-15);
  }
  assert.ok(Math.abs(sinTurns(0)) < 1e-16);
  assert.ok(Math.abs(sinTurns(0.5)) < 1e-15);
  assert.ok(Math.abs(cosTurns(0) - 1) < 1e-16);
  assert.ok(Math.abs(cosTurns(0.25)) < 1e-15);
});

test("dmath: tan is accurate away from its poles", () => {
  for (const t of [0.01, 0.1, 0.2, 0.24, -0.2]) {
    const want = Math.tan(2 * Math.PI * t);
    assert.ok(Math.abs(tanTurns(t) - want) / Math.abs(want) < 1e-13);
  }
});

test("dmath: exp, log, pow and sqrt match the reference", () => {
  for (let i = 0; i < 5000; i++) {
    const x = -50 + (100 * i) / 5000;
    assert.ok(Math.abs(dexp(x) - Math.exp(x)) / Math.exp(x) < 1e-14, `exp(${x})`);
  }
  for (let i = 1; i < 5000; i++) {
    const x = i * 0.37;
    assert.ok(Math.abs(dlog(x) - Math.log(x)) < 1e-13, `log(${x})`);
    assert.ok(Math.abs(dsqrt(x) - Math.sqrt(x)) / Math.sqrt(x) < 1e-15, `sqrt(${x})`);
  }
  assert.ok(Math.abs(dpow(2, 1 / 12) - Math.pow(2, 1 / 12)) < 1e-15);
  assert.ok(Math.abs(dtanh(1.7) - Math.tanh(1.7)) < 1e-15);
  assert.ok(Math.abs(dexp2(9.3) - Math.pow(2, 9.3)) / Math.pow(2, 9.3) < 1e-14);
  assert.ok(Math.abs(dlog2(1000) - Math.log2(1000)) < 1e-13);
});

test("dmath: edge cases are handled, not merely survived", () => {
  assert.equal(dlog(0), -Infinity);
  assert.ok(Number.isNaN(dlog(-1)));
  assert.equal(dexp(-1000), 0);
  assert.equal(dexp(1000), Infinity);
  assert.equal(dsqrt(0), 0);
  assert.ok(Number.isNaN(dsqrt(-1)));
  assert.equal(dtanh(50), 1);
  assert.equal(dtanh(-50), -1);
  assert.equal(pow2i(0), 1);
  assert.equal(pow2i(10), 1024);
  assert.equal(pow2i(-10), 1 / 1024);
  // subnormal input to log and sqrt
  assert.ok(Math.abs(dlog(5e-320) - Math.log(5e-320)) < 1e-10);
  assert.ok(Math.abs(dsqrt(5e-320) - Math.sqrt(5e-320)) / Math.sqrt(5e-320) < 1e-14);
});

test("dmath: audio conversions are exact at the anchor points", () => {
  assert.equal(midiToHz(69), 440);
  assert.ok(Math.abs(midiToHz(57) - 220) < 1e-12);
  assert.ok(Math.abs(db2gain(0) - 1) < 1e-15);
  assert.ok(Math.abs(db2gain(-6.020599913279624) - 0.5) < 1e-12);
  assert.ok(Math.abs(gain2db(0.5) + 6.020599913279624) < 1e-12);
  assert.ok(Math.abs(semitones(12) - 2) < 1e-14);
  assert.ok(Math.abs(cents(1200) - 2) < 1e-14);
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(lerp(0, 10, 0.25), 2.5);
  const [pl, pr] = panGains(0);
  assert.ok(Math.abs(pl * pl + pr * pr - 1) < 1e-14, "equal power at centre");
  assert.ok(Math.abs(panGains(-1)[0] - 1) < 1e-14);
  assert.ok(Math.abs(panGains(1)[1] - 1) < 1e-14);
  assert.ok(timeCoef(0.1, SR) > 0 && timeCoef(0.1, SR) < 1);
  assert.equal(timeCoef(0, SR), 0);
});

// ------------------------------------------------------------------ rng ----

test("rng: identical seeds give identical streams", () => {
  const a = makeRng(12345);
  const b = makeRng("12345");
  for (let i = 0; i < 10000; i++) assert.equal(a.u32(), b.u32());
});

test("rng: named children are independent of parent consumption", () => {
  const first = makeRng("root").child("drums").u32();
  const p = makeRng("root");
  for (let i = 0; i < 50000; i++) p.float();
  assert.equal(p.child("drums").u32(), first);
  assert.notEqual(makeRng("root").child("lead").u32(), first);
  // grandchildren are stable too
  assert.equal(
    makeRng("root").child("drums").child("kick").u32(),
    new Rng("root:drums:kick").u32(),
  );
});

test("rng: distribution is uniform and in range", () => {
  const r = makeRng("stat");
  const bins = new Array(20).fill(0);
  let min = 1;
  let max = 0;
  for (let i = 0; i < 400000; i++) {
    const v = r.float();
    assert.ok(v >= 0 && v < 1);
    min = Math.min(min, v);
    max = Math.max(max, v);
    bins[Math.floor(v * 20)]++;
  }
  for (const b of bins) assert.ok(Math.abs(b - 20000) < 20000 * 0.06, `bin skew ${b}`);
  assert.ok(min < 0.001 && max > 0.999);
});

test("rng: helpers respect their bounds", () => {
  const r = makeRng("helpers");
  for (let i = 0; i < 20000; i++) {
    const n = r.int(3, 7);
    assert.ok(n >= 3 && n <= 7 && Number.isInteger(n));
    const g = r.gaussIn(2, 5);
    assert.ok(g >= 2 && g <= 5, `gaussIn out of range: ${g}`);
    assert.ok(Math.abs(r.sign()) === 1);
  }
  const arr = [1, 2, 3, 4, 5];
  const shuffled = makeRng("s").shuffle([...arr]);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), arr);
  const picks = new Set();
  for (let i = 0; i < 200; i++) picks.add(r.weighted(["a", "b"], [1, 0]));
  assert.deepEqual([...picks], ["a"], "zero weight is never chosen");
  assert.equal(normaliseSeed("  42 "), "42");
  assert.equal(normaliseSeed(""), "0");
  assert.equal(normaliseSeed(7.9), "7");
});

// -------------------------------------------------------- oscillators ----

test("osc: waveforms stay in range and hold their shape", () => {
  const saw = new Saw(SR);
  saw.setFreq(220);
  const buf = new Float32Array(SR);
  for (let i = 0; i < SR; i++) buf[i] = saw.next();
  finite(buf, "saw");
  assert.ok(peakMono(buf) <= 1.05 && peakMono(buf) > 0.9);
  let sum = 0;
  for (const v of buf) sum += v;
  assert.ok(Math.abs(sum / SR) < 0.01, "saw is DC free");

  const pulse = new Pulse(SR);
  pulse.setFreq(220);
  pulse.width = 0.25;
  let dc = 0;
  for (let i = 0; i < SR; i++) dc += pulse.next();
  assert.ok(Math.abs(dc / SR - -0.5) < 0.01, "25 % pulse has the right duty");

  const tri = new Triangle(SR);
  tri.setFreq(220);
  let tpeak = 0;
  for (let i = 0; i < SR; i++) tpeak = Math.max(tpeak, Math.abs(tri.next()));
  assert.ok(tpeak > 0.95 && tpeak <= 1.05);

  const sine = new Sine(SR);
  sine.setFreq(1000);
  let speak = 0;
  for (let i = 0; i < SR; i++) speak = Math.max(speak, Math.abs(sine.next()));
  assert.ok(Math.abs(speak - 1) < 0.005);
});

test("osc: PolyBLEP keeps aliasing out of the audible band", () => {
  for (const f of [440, 2000]) {
    const o = new Saw(SR);
    o.setFreq(f);
    const buf = new Float32Array(1 << 15);
    for (let i = 0; i < buf.length; i++) buf[i] = o.next();
    const snr = harmonicSnr(buf, f, SR);
    assert.ok(snr > 22, `saw ${f} Hz alias SNR only ${snr.toFixed(1)} dB`);
  }
  assert.equal(polyBlep(0.5, 0.01), 0, "no correction away from the discontinuity");
});

test("osc: noise sources are bounded and have the right tilt", () => {
  const w = new WhiteNoise(makeRng("w"));
  const p = new PinkNoise(makeRng("p"));
  let wp = 0;
  let pp = 0;
  const pb = new Float32Array(1 << 15);
  for (let i = 0; i < 1 << 15; i++) {
    wp = Math.max(wp, Math.abs(w.next()));
    pb[i] = p.next();
    pp = Math.max(pp, Math.abs(pb[i]));
  }
  assert.ok(wp <= 1 && wp > 0.99);
  assert.ok(pp < 1 && pp > 0.05);
  finite(pb, "pink");
});

test("osc: supersaw spreads across the stereo field", () => {
  const s = new Supersaw(SR, makeRng("ss"), 7, 20, 0.8);
  const frame = new Float64Array(2);
  let sumDiff = 0;
  let pk = 0;
  for (let i = 0; i < SR; i++) {
    s.next(frame);
    sumDiff += Math.abs(frame[0] - frame[1]);
    pk = Math.max(pk, Math.abs(frame[0]), Math.abs(frame[1]));
  }
  assert.ok(sumDiff / SR > 0.05, "voices are actually spread");
  assert.ok(pk < 3, "supersaw is normalised to a sane level");
  assert.equal(s.count, 7);
});

// ------------------------------------------------------------ envelopes ----

test("env: ADSR reaches each stage on schedule", () => {
  const e = new Adsr(SR);
  e.set(0.01, 0.05, 0.5, 0.1);
  e.trigger();
  // the peak must land at the stated attack time, not merely somewhere
  let peakAt = -1;
  let v = 0;
  for (let i = 0; i < Math.floor(0.02 * SR); i++) {
    v = e.next();
    if (peakAt < 0 && v >= 0.9999) peakAt = i;
  }
  assert.ok(
    Math.abs(peakAt / SR - 0.01) < 0.0005,
    `attack peaked at ${(peakAt / SR) * 1000} ms, expected 10 ms`,
  );
  for (let i = 0; i < Math.floor(0.15 * SR); i++) v = e.next();
  assert.ok(Math.abs(v - 0.5) < 0.01, `sustain is ${v}`);
  e.release();
  for (let i = 0; i < Math.floor(0.4 * SR); i++) v = e.next();
  assert.equal(v, 0);
  assert.equal(e.active, false);
});

test("env: exponential decay hits -60 dB at its stated time", () => {
  const d = new ExpDecay(SR);
  d.set(0.25);
  d.trigger(1);
  for (let i = 0; i < Math.floor(0.25 * SR); i++) d.next();
  assert.ok(Math.abs(20 * Math.log10(d.value) + 60) < 0.05);
});

test("env: automation segments hit their targets", () => {
  const out = new Float32Array(SR);
  renderSegments(out, 0, [{ to: 1, time: 0.25 }, { to: 0.2, time: 0.25, curve: 3 }], SR);
  assert.ok(Math.abs(out[0]) < 0.01);
  assert.ok(Math.abs(out[Math.floor(0.25 * SR) - 1] - 1) < 0.01);
  assert.ok(Math.abs(out[SR - 1] - 0.2) < 1e-6, "holds the last value to the end");
  finite(out, "segments");
});

// -------------------------------------------------------------- filters ----

test("filter: SVF matches theory at the cutoff and in the stopband", () => {
  const measure = (fc: number, q: number, testHz: number, mode: "lp" | "hp" | "bp") => {
    const f = new Svf(SR);
    f.set(fc, q);
    let mx = 0;
    for (let i = 0; i < 20000; i++) {
      const x = Math.sin((2 * Math.PI * testHz * i) / SR);
      f.process(x);
      const y = mode === "lp" ? f.lp : mode === "hp" ? f.hp : f.bp;
      if (i > 12000) mx = Math.max(mx, Math.abs(y));
    }
    return 20 * Math.log10(mx + 1e-12);
  };
  assert.ok(Math.abs(measure(1000, 0.7071, 1000, "lp") + 3) < 0.15, "-3 dB at cutoff");
  assert.ok(measure(1000, 0.7071, 100, "lp") > -0.3, "passband is flat");
  assert.ok(measure(1000, 0.7071, 8000, "lp") < -30, "stopband rolls off");
  assert.ok(Math.abs(measure(1000, 0.7071, 1000, "hp") + 3) < 0.15);
  assert.ok(measure(1000, 0.7071, 100, "hp") < -30);
  assert.ok(measure(1000, 8, 1000, "lp") > 17, "resonance lifts the cutoff");
});

test("filter: SVF stays stable under per-sample cutoff modulation", () => {
  const f = new Svf(SR);
  const buf = new Float32Array(SR);
  const saw = new Saw(SR);
  saw.setFreq(110);
  for (let i = 0; i < SR; i++) {
    f.set(80 + 15000 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 30 * i) / SR)), 12);
    buf[i] = f.lowpass(saw.next());
  }
  finite(buf, "modulated svf");
  assert.ok(peakMono(buf) < 20, "high-Q sweep does not blow up");
});

test("filter: biquad shelves and peaks hit their stated gain", () => {
  const at = (kind: any, f: number, q: number, g: number, testHz: number) => {
    const b = new Biquad();
    b.set(kind, SR, f, q, g);
    let mx = 0;
    for (let i = 0; i < 20000; i++) {
      const y = b.process(Math.sin((2 * Math.PI * testHz * i) / SR));
      if (i > 12000) mx = Math.max(mx, Math.abs(y));
    }
    return 20 * Math.log10(mx);
  };
  assert.ok(Math.abs(at("peaking", 1000, 1, 6, 1000) - 6) < 0.05);
  assert.ok(Math.abs(at("peaking", 1000, 1, -6, 1000) + 6) < 0.05);
  assert.ok(Math.abs(at("highshelf", 4000, 0.707, 5, 15000) - 5) < 0.3);
  assert.ok(Math.abs(at("lowshelf", 200, 0.707, 5, 40) - 5) < 0.3);
  assert.ok(at("bandpass", 1000, 2, 0, 1000) > -0.2);
});

test("filter: DC blocker removes offset and keeps the signal", () => {
  const d = new DcBlocker(SR, 12);
  let sum = 0;
  let amp = 0;
  for (let i = 0; i < SR; i++) {
    const y = d.process(0.5 + 0.3 * Math.sin((2 * Math.PI * 500 * i) / SR));
    if (i > SR / 2) {
      sum += y;
      amp = Math.max(amp, Math.abs(y));
    }
  }
  assert.ok(Math.abs(sum / (SR / 2)) < 1e-3, "DC removed");
  assert.ok(Math.abs(amp - 0.3) < 0.01, "signal preserved");
  const op = new OnePole();
  op.setCoef(0.5);
  op.reset(0);
  assert.ok(op.process(1) > 0 && op.process(1) < 1);
});

// ------------------------------------------------------------- nonlinear ----

test("shape: saturators are bounded, odd and unity-slope at zero", () => {
  assert.equal(softClip(0), 0);
  assert.ok(Math.abs(softClip(1e-4) / 1e-4 - 1) < 1e-6);
  for (const x of [-1e6, -5, -1, 0, 1, 5, 1e6]) {
    assert.ok(Math.abs(softClip(x)) <= 1, `softClip(${x}) escaped`);
    assert.ok(Math.abs(softClip(x) + softClip(-x)) < 1e-12, "odd symmetry");
  }
  let prev = -Infinity;
  for (let x = -6; x < 6; x += 0.01) {
    const y = softClip(x);
    assert.ok(y >= prev - 1e-12, "monotonic");
    prev = y;
  }
  assert.equal(hardClip(2, 0.5), 0.5);
  assert.equal(hardClip(-2, 0.5), -0.5);
  assert.equal(hardClip(0.1, 0.5), 0.1);
  for (const x of [-3, -1, 0, 1, 3]) assert.ok(Number.isFinite(waveshape(x, 0.5, 0.1)));
});

test("shape: the ADAA clipper still clips", () => {
  const c = new AdaaClipper();
  c.ceiling = 0.5;
  let mx = 0;
  for (let i = 0; i < 10000; i++) {
    mx = Math.max(mx, Math.abs(c.process(2 * Math.sin((2 * Math.PI * 300 * i) / SR))));
  }
  assert.ok(mx <= 0.5 + 1e-9, `ADAA output reached ${mx}`);
});

test("shape: the oversampler round trip is flat across the audible band", () => {
  // Measured as a magnitude response: the round trip has a fractional group
  // delay, so a sample-by-sample comparison would be measuring the delay
  // rather than the filter.
  const amplitudeAt = (hz: number) => {
    const os = new Oversampler4x(512, 48);
    const n = 8192;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
    for (let i = 0; i < n; i += 512) {
      os.upsample(buf, i, 512);
      os.downsample(buf, i, 512);
    }
    let mx = 0;
    for (let i = 2000; i < n - 100; i++) mx = Math.max(mx, Math.abs(buf[i]));
    return 20 * Math.log10(mx / 0.5);
  };
  for (const hz of [100, 1000, 5000, 10000, 15000]) {
    const db = amplitudeAt(hz);
    assert.ok(Math.abs(db) < 0.35, `${hz} Hz round trip is ${db.toFixed(2)} dB`);
  }
  assert.ok(amplitudeAt(21000) < -3, "and it does roll off before Nyquist");
});

test("shape: FIR design is normalised and symmetric", () => {
  for (const taps of [32, 48, 64]) {
    const h = kaiserLowpass(taps, 0.125, 6);
    let sum = 0;
    for (const v of h) sum += v;
    assert.ok(Math.abs(sum - 1) < 1e-12, "unity DC gain");
    for (let i = 0; i < taps / 2; i++) {
      assert.ok(Math.abs(h[i] - h[taps - 1 - i]) < 1e-15, "linear phase");
    }
  }
});

test("shape: the distortion chain keeps aliasing 45 dB down when driven hard", () => {
  for (const f of [1000, 3000]) {
    const n = 1 << 15;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = 0.7 * Math.sin((2 * Math.PI * f * i) / SR);
    const d = new DistortionChain(512);
    d.params = { drive: 6, fold: 0.4, bias: 0.1, ceiling: 0.85, output: 1 };
    for (let i = 0; i < n; i += 512) d.process(buf, i, 512);
    const snr = harmonicSnr(buf.subarray(n / 2) as Float32Array, f, SR);
    assert.ok(snr > 45, `${f} Hz alias SNR only ${snr.toFixed(1)} dB`);
    let dc = 0;
    for (let i = n / 2; i < n; i++) dc += buf[i];
    assert.ok(Math.abs(dc / (n / 2)) < 2e-3, "chain leaves no DC behind");
  }
});

test("shape: bitcrush quantises to the stated depth", () => {
  const b = new Bitcrush();
  b.bits = 4;
  const step = 1 / 8;
  for (const x of [0.31, -0.72, 0.05]) {
    const y = b.process(x);
    assert.ok(Math.abs(y / step - Math.round(y / step)) < 1e-9, `${x} -> ${y}`);
  }
  b.bits = 24;
  b.hold = 4;
  b.reset();
  const seq = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => b.process(v));
  assert.deepEqual(seq, [1, 1, 1, 1, 5, 5, 5, 5]);
});

// ---------------------------------------------------------------- delay ----

test("delay: integer taps are exact and fractional taps interpolate", () => {
  const d = new DelayLine(1000);
  for (let i = 0; i < 500; i++) d.write(i);
  assert.equal(d.read(1), 498);
  assert.equal(d.read(10), 489);
  const half = d.read(10.5);
  assert.ok(half > 488.4 && half < 489.1, `fractional read ${half}`);
  const dl = new DelayLine(64);
  dl.reset();
  dl.write(1);
  for (let i = 0; i < 20; i++) dl.write(0);
  // read(0) is the most recently written sample, so an impulse written 20
  // writes ago is at tap 20
  assert.equal(dl.read(20), 1, "impulse arrives at the right tap");
  assert.equal(dl.read(19), 0);
});

test("delay: stereo delay decays and ping-pongs", () => {
  const sd = new StereoDelay(SR, 1);
  sd.timeL = 0.1;
  sd.timeR = 0.1;
  sd.feedback = 0.5;
  sd.pingPong = true;
  const out = new Float64Array(2);
  let firstLeftAt = -1;
  let firstRightAt = -1;
  let firstLeftAmp = 0;
  let firstRightAmp = 0;
  for (let i = 0; i < SR; i++) {
    sd.process(i === 0 ? 1 : 0, 0, out);
    if (firstLeftAt < 0 && Math.abs(out[0]) > 0.5) {
      firstLeftAt = i;
      firstLeftAmp = Math.abs(out[0]);
    }
    if (firstRightAt < 0 && Math.abs(out[1]) > 0.2) {
      firstRightAt = i;
      firstRightAmp = Math.abs(out[1]);
    }
  }
  const want = Math.round(0.1 * SR);
  assert.ok(
    Math.abs(firstLeftAt - want) <= 2,
    `first echo at ${firstLeftAt}, expected about ${want}`,
  );
  assert.ok(firstLeftAmp > 0.9, `first echo amplitude ${firstLeftAmp}`);
  assert.ok(
    Math.abs(firstRightAt - 2 * want) <= 4,
    `crossover echo at ${firstRightAt}, expected about ${2 * want}`,
  );
  assert.ok(firstRightAmp > 0.3 && firstRightAmp < 0.6, `crossover amplitude ${firstRightAmp}`);
  const ch = new Chorus(SR, 3);
  const h = new Haas(SR);
  for (let i = 0; i < 1000; i++) {
    ch.process(Math.sin(i * 0.1), out);
    assert.ok(Number.isFinite(out[0]) && Number.isFinite(out[1]));
    h.process(Math.sin(i * 0.1), out);
  }
});

// --------------------------------------------------------------- reverb ----

test("reverb: decays to -60 dB near its stated RT60 and never runs away", () => {
  const r = new Reverb(SR, 0);
  r.decay = 1.5;
  r.brightness = 0.5;
  r.update();
  const out = new Float64Array(2);
  const n = SR * 4;
  let peakEarly = 0;
  let atRt60 = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    r.process(i < 4 ? 1 : 0, out);
    const a = Math.max(Math.abs(out[0]), Math.abs(out[1]));
    assert.ok(Number.isFinite(a), `reverb blew up at ${i}`);
    if (i < SR * 0.1) peakEarly = Math.max(peakEarly, a);
    if (i > SR * 1.4 && i < SR * 1.6) atRt60 = Math.max(atRt60, a);
    if (i > SR * 3.5) tail = Math.max(tail, a);
  }
  const dropDb = 20 * Math.log10(atRt60 / peakEarly);
  assert.ok(dropDb < -40 && dropDb > -85, `RT60 drop measured ${dropDb.toFixed(1)} dB`);
  assert.ok(tail < peakEarly * 1e-3, "tail actually ends");
});

// ------------------------------------------------------------- dynamics ----

test("dynamics: compressor follows its ratio", () => {
  const c = new Compressor(SR, 0.001, 0.05);
  c.thresholdDb = -20;
  c.ratio = 4;
  c.kneeDb = 0;
  for (const inDb of [-30, -10, 0]) {
    c.reset();
    const amp = Math.pow(10, inDb / 20);
    let mx = 0;
    for (let i = 0; i < SR; i++) {
      const x = amp * Math.sin((2 * Math.PI * 200 * i) / SR);
      const y = c.process(x, x);
      if (i > SR * 0.6) mx = Math.max(mx, Math.abs(y));
    }
    const outDb = 20 * Math.log10(mx);
    const want = inDb <= -20 ? inDb : -20 + (inDb + 20) / 4;
    assert.ok(Math.abs(outDb - want) < 0.6, `in ${inDb} -> ${outDb.toFixed(2)}, want ${want}`);
  }
  const ef = new EnvelopeFollower(SR, 0.001, 0.1);
  for (let i = 0; i < 1000; i++) ef.process(1);
  assert.ok(ef.process(1) > 0.9);
});

test("dynamics: limiter never exceeds its ceiling", () => {
  for (const ceiling of [0.5, 0.9, 0.98]) {
    const lim = new Limiter(SR, 0.0025, 0.05);
    lim.ceiling = ceiling;
    const out = new Float64Array(2);
    let mx = 0;
    for (let i = 0; i < SR * 2; i++) {
      let x = 0.4 * Math.sin((2 * Math.PI * 100 * i) / SR);
      if (i % 11025 === 500) x = 4;
      if (i % 11025 === 503) x = 3;
      if (i > SR && i % 601 === 0) x = 1.8;
      lim.process(x, -x, out);
      mx = Math.max(mx, Math.abs(out[0]), Math.abs(out[1]));
    }
    assert.ok(mx <= ceiling + 1e-6, `ceiling ${ceiling} exceeded: ${mx}`);
  }
});

test("dynamics: limiter is transparent below the ceiling", () => {
  const lim = new Limiter(SR, 0.0025, 0.05);
  lim.ceiling = 0.98;
  const out = new Float64Array(2);
  const inp: number[] = [];
  const res: number[] = [];
  for (let i = 0; i < 4000; i++) {
    const x = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    inp.push(x);
    lim.process(x, x, out);
    res.push(out[0]);
  }
  const look = Math.floor(0.0025 * SR);
  let err = 0;
  for (let i = look; i < 4000; i++) err = Math.max(err, Math.abs(res[i] - inp[i - look]));
  assert.ok(err < 1e-6, `not transparent: ${err}`);
});

test("dynamics: duck curve is driven by the event list alone", () => {
  const events = [0, 11025, 22050, 33075];
  const g = buildDuckCurve(SR, SR, { events, depth: 0.5, attack: 0.003, release: 0.12 });
  assert.equal(g.length, SR);
  for (const v of g) assert.ok(v >= 0.5 - 1e-6 && v <= 1 + 1e-6);
  assert.ok(Math.abs(g[11025 + 140] - 0.5) < 0.02, "reaches full depth just after the event");
  assert.ok(g[11025 + Math.floor(0.11 * SR)] > 0.97, "recovers by the release time");
  // overlapping events take the deeper value, they do not stack
  const dense = buildDuckCurve(SR, SR, { events: [1000, 1100, 1200], depth: 0.5, attack: 0.003, release: 0.12 });
  let min = 1;
  for (const v of dense) min = Math.min(min, v);
  assert.ok(min >= 0.5 - 1e-6, `overlap stacked to ${min}`);
  const none = buildDuckCurve(100, SR, { events: [], depth: 0.5, attack: 0.003, release: 0.1 });
  for (const v of none) assert.equal(v, 1);
});

// ---------------------------------------------------------------- drums ----

test("drums: every voice is finite, bounded, DC-free and ends silent", () => {
  const rng = makeRng("drums");
  const hits: [string, Float32Array][] = [
    ["kick", renderKick(SR, { startHz: 180, endHz: 46, pitchDecay: 0.028, ampDecay: 0.45, clickLevel: 0.35, clickDecay: 0.006, drive: 1.8, bodyLevel: 1 }, rng)],
    ["snare", renderSnare(SR, { toneHz: 190, toneDecay: 0.09, noiseDecay: 0.16, noiseLowHz: 900, noiseHighHz: 7500, noiseLevel: 0.7, toneLevel: 0.5, drive: 1.5 }, rng)],
    ["clap", renderClap(SR, { bursts: 4, spacing: 0.011, spread: 0.18, bandLowHz: 1100, bandHighHz: 4200, burstDecay: 0.012, tailDecay: 0.14, tailLevel: 0.45 }, rng)],
    ["hat", renderHat(SR, { decay: 0.045, baseHz: 40, highpassHz: 7200, bandHz: 9500, bandQ: 1.6, noiseMix: 0.35 }, rng)],
    ["rim", renderRim(SR, { hz: 1700, q: 9, decay: 0.05, clickLevel: 0.6 }, rng)],
    ["tom", renderTom(SR, { startHz: 220, endHz: 95, pitchDecay: 0.05, decay: 0.35, noiseLevel: 0.15 }, rng)],
  ];
  for (const [name, h] of hits) {
    finite(h, name);
    assert.ok(h.length > 100, `${name} is too short`);
    const p = peakMono(h);
    assert.ok(p > 0.05 && p <= 1.2, `${name} peak ${p}`);
    let dc = 0;
    for (const v of h) dc += v;
    assert.ok(Math.abs(dc / h.length) < 5e-3, `${name} has DC ${dc / h.length}`);
    assert.ok(Math.abs(h[h.length - 1]) < 1e-12, `${name} does not end at zero and will click`);
  }
});

test("drums: the same seed gives the same hit", () => {
  const p = { startHz: 180, endHz: 46, pitchDecay: 0.028, ampDecay: 0.4, clickLevel: 0.3, clickDecay: 0.006, drive: 2, bodyLevel: 1 };
  const a = renderKick(SR, p, makeRng("k"));
  const b = renderKick(SR, p, makeRng("k"));
  assert.deepEqual([...a], [...b]);
});

// ------------------------------------------------------------------ 808 ----

test("808: tracks pitch, glides, and stays finite", () => {
  const notes = [
    { start: 0, length: Math.floor(SR * 0.5), midi: 33, velocity: 1, glide: false },
    { start: Math.floor(SR * 0.5), length: Math.floor(SR * 0.5), midi: 40, velocity: 0.9, glide: true },
  ];
  const out = new Float32Array(SR * 2);
  const pk = render808(out, SR, notes, {
    dropSemitones: 8, dropTime: 0.06, decay: 0.9, attack: 0.003,
    drive: 2.4, subLevel: 0.5, portamento: 0.03, toneHz: 2600,
  });
  finite(out, "808");
  assert.ok(pk > 0.3 && pk < 2, `808 peak ${pk}`);
  // measure the settled pitch of the first note by zero crossings
  let zc = 0;
  const from = Math.floor(SR * 0.2);
  const to = Math.floor(SR * 0.45);
  for (let i = from + 1; i < to; i++) if (out[i] >= 0 && out[i - 1] < 0) zc++;
  const hz = zc / ((to - from) / SR);
  assert.ok(Math.abs(hz - midiToHz(33)) < 4, `expected ${midiToHz(33).toFixed(1)} Hz, measured ${hz.toFixed(1)}`);
  const empty = new Float32Array(100);
  assert.equal(render808(empty, SR, [], { dropSemitones: 8, dropTime: 0.06, decay: 0.9, attack: 0.003, drive: 2, subLevel: 0.5, portamento: 0.03, toneHz: 2600 }), 0);
});

test("formant: peaks sit near the stated formant frequencies", () => {
  const v = new FormantVoice(SR, makeRng("fv"), NEUTRAL_FORMANTS);
  v.setFreq(100);
  const buf = new Float32Array(1 << 14);
  for (let i = 0; i < buf.length; i++) buf[i] = v.next();
  finite(buf, "formant");
  assert.ok(peakMono(buf) > 0.1);
});

// --------------------------------------------------------------- buffer ----

test("buffer: measurements are correct", () => {
  const b = createStereo(1000, SR);
  b.L.fill(0.5);
  b.R.fill(-0.25);
  assert.equal(peak(b), 0.5);
  assert.ok(Math.abs(rms(b) - Math.sqrt((0.25 + 0.0625) / 2)) < 1e-6);
  const [dl, dr] = dcOffset(b);
  assert.ok(Math.abs(dl - 0.5) < 1e-6 && Math.abs(dr + 0.25) < 1e-6);
  const src = createStereo(1000, SR);
  src.L.fill(0.1);
  src.R.fill(0.1);
  mixInto(b, src, 2);
  assert.ok(Math.abs(b.L[0] - 0.7) < 1e-6);
  const silent = createStereo(1000, SR);
  assert.equal(longestSilence(silent), 1000);
  assert.equal(longestSilence(b), 0);
  const env = envelopePeaks(b, 10);
  assert.equal(env.length, 10);
});

// ------------------------------------------------------------------ wav ----

test("wav: header is canonical and samples round trip", () => {
  const b = createStereo(1000, SR);
  for (let i = 0; i < 1000; i++) {
    b.L[i] = Math.sin(i * 0.1) * 0.9;
    b.R[i] = Math.cos(i * 0.1) * 0.9;
  }
  for (const depth of [16, 24] as const) {
    const bytes = encodeWav(b, depth);
    assert.equal(bytes.length, 44 + 1000 * 2 * (depth / 8));
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
    assert.equal(String.fromCharCode(...bytes.slice(8, 12)), "WAVE");
    assert.equal(String.fromCharCode(...bytes.slice(12, 16)), "fmt ");
    assert.equal(String.fromCharCode(...bytes.slice(36, 40)), "data");
    const back = decodeWav(bytes);
    assert.equal(back.sampleRate, SR);
    assert.equal(back.length, 1000);
    const tol = depth === 16 ? 1 / 32767 : 1 / 8388607;
    for (let i = 0; i < 1000; i++) {
      assert.ok(Math.abs(back.L[i] - b.L[i]) <= tol, `L[${i}]`);
      assert.ok(Math.abs(back.R[i] - b.R[i]) <= tol, `R[${i}]`);
    }
  }
});

test("wav: clipping input is clamped, not wrapped", () => {
  const b = createStereo(4, SR);
  b.L.set([2, -2, 1, -1]);
  b.R.set([2, -2, 1, -1]);
  const back = decodeWav(encodeWav(b, 16));
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(back.L[i]) <= 1.0001, `wrapped at ${i}`);
  const mono = encodeWavMono(new Float32Array([0.5, -0.5]), SR, 16);
  assert.equal(mono.length, 44 + 4);
});
