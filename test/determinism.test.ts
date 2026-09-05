/**
 * The determinism contract.
 *
 * Non-negotiable #1: the same seed produces a bit-identical output file, on
 * any machine, in any browser, forever. These tests cover the Node half. The
 * browser half is test/browser-determinism.mjs, which renders the same seeds
 * in headless Chrome and compares the hashes to the same golden file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { getPreset } from "../presets/index.ts";
import { renderTrack, renderStem } from "../render/track.ts";
import { buildPlan } from "../render/plan.ts";
import { encodeWav } from "../render/wav.ts";

const { preset, ranges } = getPreset("hyperpop");
/** Half rate keeps these fast; the code path is identical. */
const FAST = 22050;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("determinism: the same seed renders byte-identically, twice in a row", () => {
  const a = renderTrack({ seed: "12345", preset, ranges, sampleRate: FAST });
  const b = renderTrack({ seed: "12345", preset, ranges, sampleRate: FAST });
  const ha = sha(encodeWav(a.audio, 16));
  const hb = sha(encodeWav(b.audio, 16));
  assert.equal(ha, hb, "two renders of one seed differ");
  assert.equal(a.plan.tempo, b.plan.tempo);
  assert.equal(a.plan.bars, b.plan.bars);
});

test("determinism: a numeric seed and its string form are the same track", () => {
  const a = renderTrack({ seed: 777, preset, ranges, sampleRate: FAST });
  const b = renderTrack({ seed: "777", preset, ranges, sampleRate: FAST });
  assert.equal(sha(encodeWav(a.audio, 16)), sha(encodeWav(b.audio, 16)));
});

test("determinism: different seeds give genuinely different tracks", () => {
  const seen = new Set<string>();
  for (const seed of ["1", "2", "3", "4"]) {
    const r = renderTrack({ seed, preset, ranges, sampleRate: FAST });
    const h = sha(encodeWav(r.audio, 16));
    assert.ok(!seen.has(h), `seed ${seed} collided with an earlier render`);
    seen.add(h);
  }
});

test("determinism: rendering is free of hidden global state", () => {
  // interleave two seeds; if anything is cached across renders this diverges
  const a1 = renderTrack({ seed: "alpha", preset, ranges, sampleRate: FAST });
  renderTrack({ seed: "beta", preset, ranges, sampleRate: FAST });
  const a2 = renderTrack({ seed: "alpha", preset, ranges, sampleRate: FAST });
  assert.equal(sha(encodeWav(a1.audio, 16)), sha(encodeWav(a2.audio, 16)));
});

test("lock and reroll: EVERY bus is bit-identical when it and the drums are locked", () => {
  const base = "lock-test-1";
  const other = "lock-test-2";
  // The drums are the rhythmic foundation: the sidechain pump is driven by the
  // kick event list, and the 808 places its notes against the kick. So a
  // locked bus is bit-identical once the drums are locked too. Locking a bus
  // alone keeps its timbre and its own musical choices, but it will still pump
  // with whatever drums it now sits under - which is the musically correct
  // behaviour, not a leak.
  for (const bus of ["drums", "bass808", "lead", "arp", "pads", "fx"] as const) {
    const a = renderStem({ seed: base, preset, ranges, sampleRate: FAST }, bus);
    const b = renderStem(
      { seed: other, preset, ranges, sampleRate: FAST, locks: { [bus]: base, drums: base } },
      bus,
    );
    assert.equal(
      sha(encodeWav(a.audio, 16)),
      sha(encodeWav(b.audio, 16)),
      `the locked "${bus}" bus changed when the other buses were rerolled`,
    );
  }
});

test("lock and reroll: a locked bus keeps its timbre and its own part", () => {
  const base = "lock-test-1";
  const other = "lock-test-2";
  const a = buildPlan({ seed: base, preset, ranges, sampleRate: FAST });
  const b = buildPlan({
    seed: other, preset, ranges, sampleRate: FAST, locks: { lead: base },
  });
  assert.deepEqual(b.lead, a.lead, "the locked lead's parameters moved");
  assert.deepEqual(b.leadNotes, a.leadNotes, "the locked lead's part moved");
  // and the buses that were not locked really did change
  assert.notDeepEqual(b.drum, a.drum, "rerolling left the drums identical");
});

test("lock and reroll: locking one bus does not freeze the others", () => {
  const base = "lock-test-1";
  const other = "lock-test-2";
  const leadA = renderStem({ seed: base, preset, ranges, sampleRate: FAST }, "lead");
  const leadB = renderStem(
    { seed: other, preset, ranges, sampleRate: FAST, locks: { drums: base } },
    "lead",
  );
  assert.notEqual(
    sha(encodeWav(leadA.audio, 16)),
    sha(encodeWav(leadB.audio, 16)),
    "rerolling with the drums locked left the lead identical too",
  );
});

test("lock and reroll: locking any bus pins tempo, key and chord loop", () => {
  const a = buildPlan({ seed: "s1", preset, ranges, sampleRate: FAST });
  const b = buildPlan({ seed: "s2", preset, ranges, sampleRate: FAST, locks: { drums: "s1" } });
  assert.equal(a.tempo, b.tempo, "tempo moved under a locked bus");
  assert.equal(a.harmony.tonicMidi, b.harmony.tonicMidi, "key moved under a locked bus");
  assert.equal(a.harmony.scaleName, b.harmony.scaleName);
  assert.deepEqual(
    a.harmony.chords.map((c) => c.rootMidi),
    b.harmony.chords.map((c) => c.rootMidi),
    "chord loop moved under a locked bus",
  );
});

test("word sliders change the render without changing the structure", () => {
  const plain = renderTrack({ seed: "words", preset, ranges, sampleRate: FAST });
  const dark = renderTrack({
    seed: "words", preset, ranges, sampleRate: FAST, words: { darker: 1 },
  });
  assert.notEqual(sha(encodeWav(plain.audio, 16)), sha(encodeWav(dark.audio, 16)));
  assert.equal(plain.plan.tempo, dark.plan.tempo, "a word slider moved the tempo");
  assert.equal(plain.plan.bars, dark.plan.bars, "a word slider moved the arrangement");
  // and the same slider setting is itself reproducible
  const dark2 = renderTrack({
    seed: "words", preset, ranges, sampleRate: FAST, words: { darker: 1 },
  });
  assert.equal(sha(encodeWav(dark.audio, 16)), sha(encodeWav(dark2.audio, 16)));
});

test("golden: reference renders still hash to their committed values", { timeout: 300000 }, () => {
  const golden = JSON.parse(
    readFileSync(new URL("./golden/hashes.json", import.meta.url), "utf8"),
  );
  assert.equal(golden.rangesVersion, ranges.version,
    "ranges changed since the golden file was made - if that was intentional, run tools/make-golden.mjs and say so in the commit");
  for (const seed of Object.keys(golden.tracks)) {
    const want = golden.tracks[seed];
    const r = renderTrack({ seed, preset, ranges, sampleRate: golden.sampleRate });
    const bytes = encodeWav(r.audio, 16);
    assert.equal(bytes.length, want.bytes, `seed ${seed}: length changed`);
    assert.equal(sha(bytes), want.sha256, `seed ${seed}: audio changed`);
  }
});
