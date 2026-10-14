/**
 * The dataset card for Hugging Face, from what `npm run dataset` wrote.
 *
 *   node cli/dataset-card.ts ./dataset      → ./dataset/README.md
 *
 * Every number in it is counted from the annotation files, so the card cannot drift from the data.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "./dataset";
type Ann = {
  seed: string; tempo_bpm: number; duration: number; bars: number; form: string; engine_commit: string;
  key: { tonic: string; scale: string }; sections: { name: string }[]; chords: { chord: string }[];
  drums: Record<string, unknown[]>; notes: Record<string, unknown[]>;
};
const anns: Ann[] = readdirSync(join(dir, "annotations")).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(dir, "annotations", f), "utf8")));
if (!anns.length) throw new Error(`no annotations in ${dir}`);

const minutes = anns.reduce((t, a) => t + a.duration, 0) / 60;
const hits = anns.reduce((t, a) => t + Object.values(a.drums).reduce((u, l) => u + l.length, 0), 0);
const notes = anns.reduce((t, a) => t + Object.values(a.notes).reduce((u, l) => u + l.length, 0), 0);
const tempos = anns.map((a) => a.tempo_bpm);
const scales = [...new Set(anns.map((a) => a.key.scale))];
const fmt = (n: number) => n.toLocaleString("en-US");
const len = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const commit = anns[0].engine_commit;
// the checkout the card tells people to use: this one has the dataset script (run the card after committing it)
const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
const table = anns.map((a) => `| \`${a.seed}\` | ${a.tempo_bpm} | ${a.key.tonic} ${a.key.scale} | ${a.form} | ${len(a.duration)} | ${a.sections.map((s) => s.name).join(" ")} |`).join("\n");

// the example in the card is the first track's own values, abbreviated
function example(): string {
  const a = JSON.parse(readFileSync(join(dir, "annotations", `${anns[0].seed}.json`), "utf8"));
  const j = (v: unknown) => JSON.stringify(v).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, "{ ").replace(/\}$/, " }");
  const first = (o: Record<string, unknown[]>) => Object.entries(o).map(([k, l]) => `"${k}": [${j(l[0])}, ...]`).join(",\n            ");
  return `{
 "seed": "${a.seed}", "tempo_bpm": ${a.tempo_bpm}, "time_signature": "4/4", "bars": ${a.bars}, "duration": ${a.duration},
 "downbeats": [${a.downbeats.slice(0, 3).join(", ")}, ...],
 "key": ${j(a.key)},
 "form": "${a.form}",
 "sections": [${j(a.sections[0])}, ...],
 "chords": [${j(a.chords[0])}, ...],
 "drums": { ${first(a.drums)} },
 "notes": { ${first(a.notes)} },
 "fx": [${j(a.fx[0])}, ...],
 "regenerate": "${a.regenerate}",
 "engine_commit": "${a.engine_commit}"
}`;
}

writeFileSync(join(dir, "README.md"), `---
license: cc-by-4.0
pretty_name: Nullsample Multitrack
task_categories:
- audio-classification
- audio-to-audio
tags:
- music
- synthetic
- procedural-audio
- multitrack
- stems
- source-separation
- music-transcription
- drum-transcription
- beat-tracking
- chord-recognition
- key-detection
- midi
- mir
size_categories:
- n<1K
configs:
- config_name: default
  data_files:
  - split: train
    path: "mix/*"
---

# Nullsample Multitrack

**${anns.length} complete tracks generated from code, with zero samples. Each comes with its mix, six
stems, a MIDI file and exact annotations**: tempo, downbeats, key, the chord in every bar, the sections,
every drum hit by instrument and every note of every part. That is ${fmt(hits)} drum hits and ${fmt(notes)}
notes over ${minutes.toFixed(0)} minutes of music.

The labels are not estimated and not hand-annotated. They are the score the audio was synthesised from,
so they are exact by construction. No recordings, samples or trained models were used. Every sound is
computed from oscillators, noise, envelopes and filters by
[Nullsample](https://nullsample.maqsudjon.com) ([source](https://github.com/maqsudjon-cell/nullsample),
AGPL-3.0). Nothing in the audio came from anyone else's recording.

**Every track can be reproduced bit for bit from its seed**, on any machine. The engine avoids the
platform-dependent \`Math.sin\`/\`exp\`/\`pow\` and is tested byte-identical across Node and browsers. You can
listen to any seed at \`https://nullsample.maqsudjon.com/generate/#s=<seed>\`, or render the lossless WAV
yourself:

\`\`\`bash
git clone https://github.com/maqsudjon-cell/nullsample && cd nullsample && git checkout ${head.slice(0, 7)}
npm install && npm run render -- --seed NULL-0001 --out NULL-0001.wav
npm run dataset -- --out ./dataset        # this whole dataset
\`\`\`

The audio came from engine commit \`${commit.slice(0, 7)}\` (\`engine_commit\` in every annotation file). The
checkout above has the same engine plus the script that wrote this dataset.

## What it is good for

- **Source separation:** six stems per track (drums, 808 bass, lead, arp, pads, fx).
- **Drum and note transcription:** onsets and notes that are exact to the sample.
- **Beat, downbeat and tempo tracking.**
- **Key and chord recognition, and structure segmentation.**
- **Testing an MIR tool against ground truth** before trusting it on real recordings.

## Files

| Path | What |
|---|---|
| \`mix/<seed>.mp3\` | the track, MP3 192 kbps, 44.1 kHz stereo |
| \`mix/metadata.csv\` | one row per track: tempo, key, scale, bars, length, form, sections, chords. The viewer reads it. |
| \`stems/{drums,bass808,lead,arp,pads,fx}/<seed>.mp3\` | each part rendered on its own, MP3 128 kbps |
| \`annotations/<seed>.json\` | the labels, times in seconds |
| \`midi/<seed>.mid\` | the same notes as a Standard MIDI File |

### \`annotations/<seed>.json\`

\`\`\`json
${example()}
\`\`\`

The MIDI files have 480 ticks per beat and the track's tempo. They have a tempo track with the sections
as markers, the drums on channel 10 (General MIDI: kick 36, rim 37, snare 38, clap 39, closed hat 42,
open hat 46), and one track each for \`bass808\`, \`lead\`, \`arp\` and \`pads\`. Velocities in the JSON are
0–1. The pads are chords with no velocity of their own, written at 0.8. Chord names: \`5\` is a power chord, \`m\` minor, \`m7\`, \`sus2\`, \`sus4\`, \`add9\`, \`m(add9)\`.

## The tracks

Tempo ${Math.min(...tempos)}–${Math.max(...tempos)} BPM. Scales: ${scales.join(", ")}.

| Seed | BPM | Key | Form | Length | Sections |
|---|---|---|---|---|---|
${table}

## Limits

- **One style.** All tracks come from one preset (energetic electronic, hyperpop-like), so this is
  not a sample of music in general. It is small: use it to test and probe models, or as a clean
  supplement, not as a training corpus on its own.
- **Stems do not sum exactly to the mix.** Each stem is its bus rendered alone through the master
  chain at a fixed drive. The mix also has mix-wide effects (tape stops, stutters) and a limiter
  that reacts to everything at once.
- **MP3, to keep it small.** Annotation times come from the engine's sample positions. Decoders
  that honour the LAME gapless header, such as ffmpeg and most libraries, line up within a few
  milliseconds. For lossless audio, render the seed.
- The synthesis parameters behind each sound are not included.

## Licence

The audio, MIDI and annotations: **CC BY 4.0**. Please credit "Nullsample (nullsample.maqsudjon.com)".
The engine that made them: [AGPL-3.0](https://github.com/maqsudjon-cell/nullsample). Audio you render
yourself with it is yours.

\`\`\`bibtex
@misc{nullsample_multitrack,
  title  = {Nullsample Multitrack: synthetic music with exact annotations},
  author = {Polatov, Maqsudjon},
  year   = {2026},
  url    = {https://nullsample.maqsudjon.com}
}
\`\`\`
`);
console.log(`README.md: ${anns.length} tracks, ${minutes.toFixed(1)} min, ${fmt(hits)} hits, ${fmt(notes)} notes`);
