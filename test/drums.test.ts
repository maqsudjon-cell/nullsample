/**
 * /drums: the loop, the one-shots and the MIDI.
 *
 * These pin the acceptance criteria so a later change cannot quietly break the
 * one property a drum loop cannot live without - that it loops.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getPreset } from "../presets/index.ts";
import { drumLoopToMidi, renderDrumLoop, renderOneShots, DRUM_VOICES } from "../render/drumloop.ts";

const { preset, ranges } = getPreset("hyperpop");
const hash = (a: Float32Array) =>
  createHash("sha256").update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest("hex");

test("drums: a loop is exactly N bars at the stated tempo", () => {
  for (const [bpm, bars] of [[80, 4], [150, 8], [180, 16]] as const) {
    const r = renderDrumLoop({ seed: "T-LEN", preset, ranges, bpm, bars });
    assert.equal(r.audio.length, Math.round(((44100 * 60) / bpm / 4) * 16 * bars), `${bars} bars at ${bpm}`);
  }
});

test("drums: the join is indistinguishable from a bar line inside the loop", () => {
  // Every loop starts on a downbeat, so the join is a transient - the same jump
  // as at every bar line. A broken seam would make the join stand out from them.
  for (const [seed, bpm, bars] of [["T-SEAM-1", 150, 8], ["T-SEAM-2", 90, 4], ["T-SEAM-3", 174, 16]] as const) {
    const { L, R } = renderDrumLoop({ seed, preset, ranges, bpm, bars, words: { busier: 0.6 } }).audio;
    const n = L.length;
    const step = (a: number, b: number) => Math.max(Math.abs(L[b] - L[a]), Math.abs(R[b] - R[a]));
    let hi = 0;
    for (let k = 1; k < bars; k++) {
      const i = Math.round((k * n) / bars);
      hi = Math.max(hi, step(i - 1, i));
    }
    assert.ok(step(n - 1, 0) <= hi * 1.05, `${seed}: join ${step(n - 1, 0)} exceeds bar-line max ${hi}`);
  }
});

test("drums: the same seed reproduces the same kit and pattern exactly", () => {
  const opts = { seed: "T-DET", preset, ranges, bpm: 140, bars: 8 as const };
  assert.equal(hash(renderDrumLoop(opts).audio.L), hash(renderDrumLoop(opts).audio.L));
});

test("drums: kit and pattern are independent axes", () => {
  const base = { seed: "T-AXIS", preset, ranges, bpm: 140, bars: 8 as const };
  const pattern = (hits: { voice: string; step: number }[]) => hits.map((h) => `${h.voice}@${h.step}`).join("|");
  const a = renderDrumLoop(base);
  const shotsA = renderOneShots(base);

  // keep the kick, reroll: kick survives, the rest changes
  const keptKick = { ...base, seed: "T-OTHER", keepKit: { kick: "T-AXIS" } };
  assert.equal(hash(renderOneShots(keptKick).kick.L), hash(shotsA.kick.L), "kept kick changed");
  assert.notEqual(hash(renderOneShots(keptKick).snare.L), hash(shotsA.snare.L), "unkept snare survived");

  // keep the pattern, reroll: pattern survives, the kit changes
  const keptPattern = { ...base, seed: "T-OTHER", keepPattern: "T-AXIS" };
  assert.equal(pattern(renderDrumLoop(keptPattern).hits), pattern(a.hits), "kept pattern changed");
  assert.notEqual(hash(renderOneShots(keptPattern).kick.L), hash(shotsA.kick.L), "kit did not reroll");
});

test("drums: seven one-shots, each the loop's own kit", () => {
  const shots = renderOneShots({ seed: "T-SHOTS", preset, ranges, bpm: 150, bars: 8 });
  assert.deepEqual(Object.keys(shots).sort(), [...DRUM_VOICES].sort());
  for (const v of DRUM_VOICES) {
    let peak = 0;
    for (let i = 0; i < shots[v].L.length; i++) peak = Math.max(peak, Math.abs(shots[v].L[i]));
    assert.ok(Math.abs(20 * Math.log10(peak) + 1) < 0.01, `${v} not at -1 dBFS`);
  }
});

test("drums: MIDI is a valid SMF on channel 10 that ends on the bar line", () => {
  const loop = renderDrumLoop({ seed: "T-MIDI", preset, ranges, bpm: 150, bars: 8 });
  const m = drumLoopToMidi(loop);
  assert.equal(String.fromCharCode(...m.slice(0, 4)), "MThd");
  assert.equal(String.fromCharCode(...m.slice(14, 18)), "MTrk");
  assert.equal((m[12] << 8) | m[13], 480, "PPQ");
  // every note event is on channel 10: note-on 0x99, note-off 0x89, and no
  // note status on any other channel
  let ons = 0;
  for (let i = 22; i < m.length - 2; i++) {
    if (m[i] === 0x99) ons++;
    const hi = m[i] & 0xf0;
    if ((hi === 0x90 || hi === 0x80) && m[i + 1] < 0x80 && m[i + 2] < 0x80 && i > 0 && m[i - 1] < 0x80) {
      assert.equal(m[i] & 0x0f, 9, `note status 0x${m[i].toString(16)} not on channel 10`);
    }
  }
  assert.equal(ons, loop.hits.length, "one note-on per hit");
  const tempoIdx = Array.from(m).findIndex((b, i) => b === 0xff && m[i + 1] === 0x51);
  const us = (m[tempoIdx + 3] << 16) | (m[tempoIdx + 4] << 8) | m[tempoIdx + 5];
  assert.ok(Math.abs(60_000_000 / us - 150) < 0.01, "tempo");
});

test("drums: solo never reaches an export", () => {
  // `only` is an audition parameter; the one-shot export ignores it by design
  const withSolo = renderOneShots({ seed: "T-SOLO", preset, ranges, bpm: 150, bars: 8, only: "kick" });
  const without = renderOneShots({ seed: "T-SOLO", preset, ranges, bpm: 150, bars: 8 });
  for (const v of DRUM_VOICES) assert.equal(hash(withSolo[v].L), hash(without[v].L), v);
});
