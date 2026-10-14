/**
 * The open dataset: tracks with their stems and exact annotations.
 *
 *   npm run dataset -- --out ./dataset          (the twenty demo seeds)
 *   npm run dataset -- --seeds A,B,C --out ./dataset
 *
 * The engine decides every note, so the labels are the score that made the audio, not a guess
 * about it: tempo, key, chords, sections, every drum hit by instrument, every note of every bus.
 * Writes, per seed:
 *   mix/<seed>.mp3              the track (MP3 192k; the lossless WAV is `npm run render -- --seed`)
 *   stems/<seed>/<bus>.mp3      each bus rendered on its own (MP3 128k)
 *   annotations/<seed>.json     the labels, in seconds
 *   midi/<seed>.mid             the same notes as a Standard MIDI File, drums on channel 10
 * and mix/metadata.csv, which Hugging Face's audio viewer reads.
 *
 * Only musical labels are written. The sampled synthesis parameters (plan.params, plan.choices)
 * are left out: they would trace the tuned preset ranges, which are licensed separately.
 * Needs ffmpeg with libmp3lame on the PATH.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUS_NAMES } from "../compose/arrange.ts";
import { chordAtBar } from "../compose/harmony.ts";
import { getPreset } from "../presets/index.ts";
import type { TrackPlan } from "../render/plan.ts";
import { renderStem, renderTrack } from "../render/track.ts";
import { encodeWav } from "../render/wav.ts";
import { parseArgs, str } from "./args.ts";

// the demo seeds of /tracks/ (tools/build-tracks-page.mjs), the ones already listened to
const DEMO_SEEDS = [
  "NULL-0001", "VOID-7X2A", "RAGE-88KK", "K7M2-QX4B", "SUB-DROP01",
  "PHRY-GIAN9", "GLASS-EDGE", "HARD-CODE1", "SINE-WAVE7", "ZERO-SAMPL",
  "FOLD-BACK3", "CLIP-N0ISE", "SAW-STACK5", "DUCK-UNDER", "TAPE-NULL2",
  "GRID-LOCK4", "OSC-ILLATE", "PRIME-DLAY", "SEED-4242X", "LAST-CALL9",
];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHORD_SUFFIX: Record<string, string> = {
  power: "5", powerOct: "5", sus2: "sus2", sus4: "sus4", minor: "m", major: "",
  minAdd9: "m(add9)", majAdd9: "add9", minor7: "m7",
};
// General MIDI percussion
const GM_DRUM: Record<string, number> = { kick: 36, rim: 37, snare: 38, clap: 39, hatClosed: 42, hatOpen: 46 };
const SITE = "https://nullsample.maqsudjon.com";

const args = parseArgs(process.argv.slice(2));
const presetName = str(args, "preset", "hyperpop");
const out = str(args, "out", "./dataset");
const seeds = str(args, "seeds", "") ? str(args, "seeds", "").split(",").map((s) => s.trim()).filter(Boolean) : DEMO_SEEDS;
const sampleRate = 44100;
const { preset, ranges } = getPreset(presetName);
const commit = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(); } catch { return "unknown"; } })();

for (const d of ["mix", "stems", "annotations", "midi"]) mkdirSync(join(out, d), { recursive: true });

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const vel = (v: number) => Math.max(1, Math.min(127, Math.round(Math.min(1, v) * 127)));

function mp3(wav: Uint8Array, file: string, kbps: number, title: string, seed: string): void {
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y", "-f", "wav", "-i", "pipe:0", "-codec:a", "libmp3lame", "-b:a", `${kbps}k`,
    "-metadata", `title=${title}`, "-metadata", "artist=Nullsample", "-metadata", `comment=Generated from code, zero samples. Seed ${seed}. ${SITE}`,
    file,
  ], { input: wav, maxBuffer: 1 << 30 });
}

function chordName(midi: number, voicing: string): string {
  return NOTE_NAMES[midi % 12] + (CHORD_SUFFIX[voicing] ?? `(${voicing})`);
}

/** The labels, in seconds. */
function annotate(p: TrackPlan) {
  const s = (samples: number) => round(samples / p.sampleRate);
  const chords: { start: number; end: number; chord: string; root: string; voicing: string; notes: number[] }[] = [];
  for (let bar = 0; bar < p.bars; bar++) {
    const c = chordAtBar(p.harmony, bar);
    const name = chordName(c.rootMidi, c.voicing);
    const last = chords[chords.length - 1];
    if (last && last.chord === name) { last.end = s((bar + 1) * p.samplesPerBar); continue; }
    chords.push({ start: s(bar * p.samplesPerBar), end: s((bar + 1) * p.samplesPerBar), chord: name, root: NOTE_NAMES[c.rootMidi % 12],
      voicing: c.voicing, notes: c.intervals.map((i) => c.rootMidi + i) });
  }
  const drums: Record<string, { time: number; velocity: number }[]> = {};
  for (const e of p.drumEvents) (drums[e.voice] ??= []).push({ time: s(e.at), velocity: round(Math.min(1, e.velocity), 3) });
  const notes = (list: { start: number; length: number; midi: number; velocity: number }[]) =>
    list.map((n) => ({ start: s(n.start), end: s(n.start + n.length), midi: n.midi, velocity: round(Math.min(1, n.velocity), 3) }));
  const pads = p.padChords.flatMap((c) => c.notes.map((midi) => ({ start: s(c.start), end: s(c.start + c.length), midi, velocity: 0.8 })));
  return {
    seed: p.seed,
    preset: p.presetName,
    engine_commit: commit,
    regenerate: `${SITE}/generate/#s=${encodeURIComponent(p.seed)}`,
    sample_rate: p.sampleRate,
    duration: s(p.totalSamples),
    tempo_bpm: round(p.tempo, 3),
    time_signature: "4/4",
    bars: p.bars,
    downbeats: Array.from({ length: p.bars }, (_, b) => s(b * p.samplesPerBar)),
    key: { tonic: NOTE_NAMES[p.harmony.tonicMidi % 12], scale: p.harmony.scaleName, scale_intervals: [...p.harmony.scale] },
    form: p.arrangement.templateName,
    sections: p.sections.map((x) => ({ name: x.name, start: s(x.startSample), end: s(x.endSample), intensity: round(x.intensity, 3) })),
    chords,
    drums,
    notes: { bass808: notes(p.bassNotes), lead: notes(p.leadNotes), arp: notes(p.arpNotes), pads },
    fx: p.fxEvents.map((f) => ({ kind: f.kind, start: s(f.start), end: s(f.start + f.length) })),
  };
}

/** A Standard MIDI File, format 1, 480 ticks a beat: a tempo track, the drums on channel 10, a track per bus. */
function midiFile(p: TrackPlan): Uint8Array {
  const PPQ = 480;
  const tick = (samples: number) => Math.round((samples / p.sampleRate) * (p.tempo / 60) * PPQ);
  const vlq = (n: number) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
  const text = (type: number, t: string) => { const d = [...Buffer.from(t, "utf8")]; return [0xff, type, ...vlq(d.length), ...d]; };
  const track = (events: { at: number; data: number[] }[]) => {
    // at the same tick: meta events and the program first, then note-offs, then note-ons
    const rank = (d: number[]) => (d[0] === 0xff ? 0 : (d[0] & 0xf0) === 0xc0 ? 1 : (d[0] & 0xf0) === 0x80 ? 2 : 3);
    events.sort((a, b) => a.at - b.at || rank(a.data) - rank(b.data));
    const bytes: number[] = []; let now = 0;
    for (const e of events) { bytes.push(...vlq(e.at - now), ...e.data); now = e.at; }
    bytes.push(0, 0xff, 0x2f, 0);
    return [0x4d, 0x54, 0x72, 0x6b, (bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255, ...bytes];
  };
  const notesTrack = (name: string, ch: number, program: number, list: { start: number; length: number; midi: number; velocity: number }[]) => {
    const ev: { at: number; data: number[] }[] = [{ at: 0, data: text(0x03, name) }, { at: 0, data: [0xc0 | ch, program] }];
    for (const n of list) {
      ev.push({ at: tick(n.start), data: [0x90 | ch, n.midi, vel(n.velocity)] });
      ev.push({ at: Math.max(tick(n.start) + 1, tick(n.start + n.length)), data: [0x80 | ch, n.midi, 0] });
    }
    return track(ev);
  };
  const usPerBeat = Math.round(60_000_000 / p.tempo);
  const tempo = track([
    { at: 0, data: text(0x03, `Nullsample ${p.seed}`) },
    { at: 0, data: [0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255] },
    { at: 0, data: [0xff, 0x58, 4, 4, 2, 24, 8] },
    ...p.sections.map((x) => ({ at: tick(x.startSample), data: text(0x06, x.name) })),
  ]);
  const drumEv: { at: number; data: number[] }[] = [{ at: 0, data: text(0x03, "drums") }];
  for (const e of p.drumEvents) {
    const note = GM_DRUM[e.voice]; if (note === undefined) continue;
    drumEv.push({ at: tick(e.at), data: [0x99, note, vel(e.velocity)] }, { at: tick(e.at) + 60, data: [0x89, note, 0] });
  }
  const pads = p.padChords.flatMap((c) => c.notes.map((midi) => ({ start: c.start, length: c.length, midi, velocity: 0.8 })));
  const tracks = [tempo, track(drumEv),
    notesTrack("bass808", 0, 38, p.bassNotes), notesTrack("lead", 1, 81, p.leadNotes), notesTrack("arp", 2, 80, p.arpNotes), notesTrack("pads", 3, 89, pads)];
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
  return Uint8Array.from([...head, ...tracks.flat()]);
}

const csv = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const rows: string[] = ["file_name,seed,tempo_bpm,key,scale,bars,duration,form,sections,chords,regenerate"];
for (const [i, seed] of seeds.entries()) {
  const t0 = Date.now();
  const mix = renderTrack({ seed, preset, ranges, sampleRate });
  const p = mix.plan;
  mp3(encodeWav(mix.audio, 16), join(out, "mix", `${seed}.mp3`), 192, `Nullsample ${seed}`, seed);
  mkdirSync(join(out, "stems", seed), { recursive: true });
  for (const bus of BUS_NAMES) {
    const r = renderStem({ seed, preset, ranges, sampleRate }, bus);
    mp3(encodeWav(r.audio, 16), join(out, "stems", seed, `${bus}.mp3`), 128, `Nullsample ${seed} — ${bus}`, seed);
  }
  const a = annotate(p);
  writeFileSync(join(out, "annotations", `${seed}.json`), JSON.stringify(a, null, 1));
  writeFileSync(join(out, "midi", `${seed}.mid`), midiFile(p));
  rows.push([`${seed}.mp3`, seed, a.tempo_bpm, a.key.tonic, a.key.scale, a.bars, a.duration, a.form,
    a.sections.map((x) => x.name).join(" "), [...new Set(a.chords.map((c) => c.chord))].join(" "), a.regenerate].map(csv).join(","));
  console.log(`${i + 1}/${seeds.length}  ${seed}  ${a.tempo_bpm} bpm  ${a.key.tonic} ${a.key.scale}  ${a.duration}s  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
writeFileSync(join(out, "mix", "metadata.csv"), rows.join("\n") + "\n");
