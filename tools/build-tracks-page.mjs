#!/usr/bin/env node
/**
 * Generates /tracks, the demo track index.
 *
 * The listed facts come from the engine's own plan for each seed, not from a
 * hand-written table, so the page cannot drift away from what the seeds
 * actually produce. Only the plan is built - no audio is rendered - which is
 * why this takes a second rather than ten minutes.
 */

import { writeFileSync } from "node:fs";
import { getPreset } from "../presets/index.ts";
import { buildPlan } from "../render/plan.ts";

const SEEDS = [
  "NULL-0001", "VOID-7X2A", "RAGE-88KK", "K7M2-QX4B", "SUB-DROP01",
  "PHRY-GIAN9", "GLASS-EDGE", "HARD-CODE1", "SINE-WAVE7", "ZERO-SAMPL",
  "FOLD-BACK3", "CLIP-N0ISE", "SAW-STACK5", "DUCK-UNDER", "TAPE-NULL2",
  "GRID-LOCK4", "OSC-ILLATE", "PRIME-DLAY", "SEED-4242X", "LAST-CALL9",
];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const { preset, ranges } = getPreset("hyperpop");

const rows = SEEDS.map((seed) => {
  const p = buildPlan({ seed, preset, ranges, sampleRate: 44100 });
  const seconds = p.totalSamples / 44100;
  return {
    seed,
    tempo: p.tempo.toFixed(1),
    key: `${NOTE_NAMES[p.harmony.tonicMidi % 12]} ${p.harmony.scaleName.replace(/([A-Z])/g, " $1").toLowerCase().trim()}`,
    form: p.arrangement.templateName,
    bars: p.bars,
    length: `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`,
    sections: p.arrangement.sections.map((s) => s.name).join(" "),
  };
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const head = (title, desc, path) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://nullsample.maqsudjon.com${path}">
<meta name="theme-color" content="#08090C">
<meta name="color-scheme" content="dark">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://nullsample.maqsudjon.com/og-default.png">
<meta property="og:url" content="https://nullsample.maqsudjon.com${path}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Nullsample">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="https://nullsample.maqsudjon.com/og-default.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/fonts/jetbrains-mono-regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="wrap">
<header>
  <svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M3 16 L14 16" stroke="#7A8391" stroke-width="2.6" fill="none"/>
    <path d="M17 25 L17 7 L29 25" stroke="#FF6A1A" stroke-width="2.6" fill="none" stroke-linejoin="miter"/>
  </svg>
  <a class="wordmark" href="/" style="text-decoration:none;color:inherit">NULLSAMPLE</a>
  <span class="tag">music generated from code. zero samples.</span>
  <nav>
    <a href="/">generator</a>
    <a href="/about/">how it works</a>
    <a href="/tracks/" aria-current="page">tracks</a>
  </nav>
</header>
<main class="prose">`;

const html = `${head(
  "Nullsample tracks — 20 demo seeds",
  "Twenty demo tracks with their seeds. Each seed reproduces its track exactly, on any machine, in any browser.",
  "/tracks/",
)}
<h1 style="font-size:21px;font-weight:500;margin:26px 0 6px">Twenty tracks</h1>
<p>Each of these is a seed, not a recording. Open one and the generator will synthesise that exact
track on your device — same tempo, same key, same arrangement, same audio, every time and
everywhere. That is what a seed is for.</p>
<p>Nothing is stored on a server; the table below is just twenty strings.</p>
</main>
<div style="max-width:100%;overflow-x:auto">
<table class="tracks">
  <caption class="sr">Twenty demo seeds with their tempo, key, arrangement and length</caption>
  <thead>
    <tr><th scope="col">seed</th><th scope="col">tempo</th><th scope="col">key</th>
        <th scope="col">form</th><th scope="col">bars</th><th scope="col">length</th></tr>
  </thead>
  <tbody>
${rows
  .map(
    (r) => `    <tr>
      <td><a href="/#s=${encodeURIComponent(r.seed)}">${esc(r.seed)}</a></td>
      <td>${esc(r.tempo)}</td><td>${esc(r.key)}</td><td>${esc(r.form)}</td>
      <td>${r.bars}</td><td>${esc(r.length)}</td>
    </tr>`,
  )
  .join("\n")}
  </tbody>
</table>
</div>
<div class="wrap" style="padding-left:0;padding-right:0">
<footer>
  <p>Audio is synthesised on your device and never uploaded. Analytics are cookieless and count
  page views only. <a href="https://github.com/maqsudjon-cell/nullsample">Source</a></p>
</footer>
</div>
</div>
<script data-goatcounter="https://nullsample.goatcounter.com/count" async defer src="//gc.zgo.at/count.js"></script>
</body>
</html>
`;

writeFileSync(new URL("../web/tracks/index.html", import.meta.url).pathname, html);
console.log(`wrote web/tracks/index.html  (${rows.length} seeds)`);
for (const r of rows.slice(0, 4)) {
  console.log(`  ${r.seed.padEnd(11)} ${r.tempo} BPM  ${r.key.padEnd(20)} ${r.form.padEnd(12)} ${r.length}`);
}
