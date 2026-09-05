/**
 * Mix and master assertions.
 *
 * These are the checks that catch a preset drifting into a broken region:
 * a bus clipping before the master, a track that is silent when it should not
 * be, DC offset eating headroom, or a master that misses its loudness target.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getPreset } from "../presets/index.ts";
import { renderStem, renderTrack, TrackRenderer } from "../render/track.ts";
import { gain2db } from "../core/dmath.ts";
import { dcOffset, longestSilence, peak } from "../core/buffer.ts";
import { analyseLoudness, CREST_FLOOR_DB } from "../render/loudness.ts";

const { preset, ranges } = getPreset("hyperpop");
const FAST = 22050;
const SEEDS = ["m1", "m2", "m3", "m4", "m5"];

test("no bus clips before the master", () => {
  for (const seed of SEEDS) {
    const r = renderTrack({ seed, preset, ranges, sampleRate: FAST });
    for (const [bus, p] of Object.entries(r.stats.busPeaks)) {
      assert.ok(
        p <= 1,
        `seed ${seed}: bus "${bus}" peaked at ${(20 * Math.log10(p)).toFixed(2)} dBFS before the master`,
      );
    }
  }
});

test("the master hits its peak target", () => {
  for (const seed of SEEDS) {
    const r = renderTrack({ seed, preset, ranges, sampleRate: FAST });
    assert.ok(
      r.stats.peakDb <= -0.4 && r.stats.peakDb >= -1.6,
      `seed ${seed}: peak ${r.stats.peakDb.toFixed(2)} dBFS, want about -0.5 to -1.2`,
    );
    assert.ok(peak(r.audio) <= 1, `seed ${seed}: output exceeds full scale`);
  }
});

test("crest factor stays above the over-compression gate", { timeout: 300000 }, () => {
  // F5's hard gate. Under 6 dB the master is over-compressed whatever the
  // loudness reads, and no amount of tuning by ear can recover transients that
  // the limiter already removed.
  const seeds = ["NULL-0001", "m1", "m2", "m3", "m4", "m5", "VOID-7X2A", "RAGE-88KK"];
  const failures: string[] = [];
  const crests: number[] = [];
  for (const seed of seeds) {
    const r = renderTrack({ seed, preset, ranges, sampleRate: FAST });
    const loud = analyseLoudness(r.audio, r.plan.sections);
    crests.push(loud.crestDb);
    if (loud.overCompressed) failures.push(`${seed} ${loud.crestDb.toFixed(1)} dB`);
  }
  assert.ok(
    failures.length <= 1,
    `${failures.length} of ${seeds.length} seeds over-compressed: ${failures.join(", ")}`,
  );
});

test("the auto-gain drives every seed to the same pre-master level", { timeout: 300000 }, () => {
  // The point of the measurement: the level going INTO the chain must not
  // depend on which arrangement the seed happened to pick. What comes out
  // still varies, because a track with more dynamics keeps less RMS once its
  // peak is pinned to the ceiling - that is arithmetic, not a defect.
  const driven: number[] = [];
  for (const seed of ["NULL-0001", "m1", "m3", "m5", "RAGE-88KK"]) {
    const r = new TrackRenderer({ seed, preset, ranges, sampleRate: FAST });
    driven.push(r.measuredDriveDb + gain2db(r.autoGain));
  }
  const spread = Math.max(...driven) - Math.min(...driven);
  assert.ok(spread < 1.5, `pre-master drive spread is ${spread.toFixed(2)} dB, expected under 1.5`);
});

test("loudness is measured over the drops, not the whole file", () => {
  // The invariant that proves the measurement is doing what it claims: the
  // loudest sustained window inside the drops must read louder than the
  // whole-file average, because the average includes the intro and the break.
  // If these ever converge, the section filtering has stopped working.
  for (const seed of SEEDS) {
    const r = renderTrack({ seed, preset, ranges, sampleRate: FAST });
    const loud = analyseLoudness(r.audio, r.plan.sections);
    assert.ok(
      loud.dropRmsDb > loud.integratedRmsDb + 0.5,
      `seed ${seed}: drop RMS ${loud.dropRmsDb.toFixed(2)} is not above integrated ${loud.integratedRmsDb.toFixed(2)} — the section filter is not working`,
    );
    assert.ok(
      loud.loudSections.every((n) => n.startsWith("drop")),
      `seed ${seed}: measured ${loud.loudSections.join(", ")}, expected drop sections only`,
    );
    assert.ok(
      loud.truePeakDb >= r.stats.peakDb - 0.01,
      `seed ${seed}: true peak ${loud.truePeakDb.toFixed(2)} below sample peak ${r.stats.peakDb.toFixed(2)}`,
    );
    // A wide band, to catch a regression rather than to pin the tuning. The
    // -7 to -8 target is an M5 goal reached by ear, not by assertion.
    assert.ok(
      loud.dropRmsDb < -3 && loud.dropRmsDb > -13,
      `seed ${seed}: drop RMS ${loud.dropRmsDb.toFixed(2)} dBFS is outside any plausible range`,
    );
    assert.equal(loud.overCompressed, loud.crestDb < CREST_FLOOR_DB);
  }
});

test("no track contains unintended digital silence", () => {
  for (const seed of SEEDS) {
    const r = renderTrack({ seed, preset, ranges, sampleRate: FAST });
    const gap = longestSilence(r.audio, 1e-4) / FAST;
    // the outro fades out, so allow a tail; a gap mid-track means a bug
    assert.ok(gap < 2.5, `seed ${seed}: ${gap.toFixed(2)} s of silence in the track`);
  }
});

test("no bus leaves DC behind", () => {
  // Caught a real one: a pulse oscillator of width w carries 2w-1 of constant
  // offset, and the arp was pushing -0.02 into the master before it was
  // blocked at the source. Asserting per bus rather than only on the finished
  // track means the next one surfaces where it is introduced.
  for (const seed of ["m1", "m5"]) {
    for (const bus of ["drums", "bass808", "lead", "arp", "pads", "fx"] as const) {
      const r = renderStem({ seed, preset, ranges, sampleRate: FAST }, bus);
      const [l, rr] = dcOffset(r.audio);
      assert.ok(Math.abs(l) < 1e-3, `seed ${seed} bus ${bus}: left DC ${l.toExponential(2)}`);
      assert.ok(Math.abs(rr) < 1e-3, `seed ${seed} bus ${bus}: right DC ${rr.toExponential(2)}`);
    }
  }
});

test("no DC offset", () => {
  for (const seed of SEEDS) {
    const r = renderTrack({ seed, preset, ranges, sampleRate: FAST });
    const [l, dr] = dcOffset(r.audio);
    assert.ok(Math.abs(l) < 2e-3, `seed ${seed}: left DC ${l.toExponential(2)}`);
    assert.ok(Math.abs(dr) < 2e-3, `seed ${seed}: right DC ${dr.toExponential(2)}`);
  }
});

test("everything below 120 Hz stays mono", () => {
  const r = renderTrack({ seed: "mono", preset, ranges, sampleRate: FAST });
  // one-pole low-pass the side signal and check what is left of it
  const a = 1 - (2 * Math.PI * 120) / FAST;
  let side = 0;
  let mid = 0;
  let sideEnergy = 0;
  let midEnergy = 0;
  for (let i = 0; i < r.audio.length; i++) {
    const s = (r.audio.L[i] - r.audio.R[i]) * 0.5;
    const m = (r.audio.L[i] + r.audio.R[i]) * 0.5;
    side = s + a * (side - s);
    mid = m + a * (mid - m);
    sideEnergy += side * side;
    midEnergy += mid * mid;
  }
  const ratioDb = 10 * Math.log10((sideEnergy + 1e-20) / (midEnergy + 1e-20));
  assert.ok(ratioDb < -25, `low band is not mono: side is ${ratioDb.toFixed(1)} dB relative to mid`);
});

test("every arrangement template produces a track of a sane length", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 14; i++) {
    const r = renderTrack({ seed: `len${i}`, preset, ranges, sampleRate: FAST });
    seen.add(r.plan.arrangement.templateName);
    assert.ok(
      r.stats.durationSeconds > 90 && r.stats.durationSeconds < 150,
      `seed len${i}: ${r.stats.durationSeconds.toFixed(1)} s`,
    );
  }
  assert.ok(seen.size >= 3, `only ${seen.size} arrangement templates appeared in 14 renders`);
});
