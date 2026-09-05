#!/usr/bin/env node
/**
 * Generates the whole brand asset set into brand/out/.
 *
 * Everything derives from one definition of the mark, so a change to the
 * geometry regenerates every icon rather than leaving fifteen files to update
 * by hand.
 *
 * The OG image is rendered BY the engine: it draws the real waveform of a real
 * seed. The card is literally a product of the product.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { Canvas, drawText, textWidth, HEX } from "./raster.mjs";
import { GRID, STROKES, STROKE_WIDTH, markSvg, strokePolygons } from "./mark.mjs";
import { makeIco } from "./ico.mjs";
import { getPreset } from "../presets/index.ts";
import { renderTrack } from "../render/track.ts";
import { envelopePeaks } from "../core/buffer.ts";

const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const VOID = "#08090C";
const PANEL = "#101317";
const LINE = "#1E232B";
const DIM = "#7A8391";
const TEXT = "#E4E7EB";
const FLARE = "#FF6A1A";

/** The OG card's seed. Fixed, so the card is stable between builds. */
const OG_SEED = "NULL-0001";

// --------------------------------------------------------------------- svg -

writeFileSync(`${OUT}mark.svg`, markSvg({ accent: FLARE, base: DIM, size: 32 }));
writeFileSync(`${OUT}mark-mono.svg`, markSvg({ accent: TEXT, base: TEXT, size: 32 }));

function logoSvg(accent, base, text) {
  // wordmark as real outlines, so the logo does not depend on the viewer
  // having the typeface installed
  const size = 40;
  const markW = 46;
  const gap = 18;
  const width = markW + gap + Math.ceil(textWidth("NULLSAMPLE", size, "bold") + 9 * 2.5);
  const inner = markSvg({ accent, base, size: 46 })
    .replace(/^<svg[^>]*>\n/, "")
    .replace(/<\/svg>\n?$/, "")
    .split("\n")
    .map((l) => l.replace('<path d="', '<path transform="scale(1.4375)" d="'))
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 46" width="${width}" height="46" role="img" aria-label="Nullsample">
  <g>
${inner}
  </g>
  <text x="${markW + gap}" y="33" font-family="JetBrains Mono, ui-monospace, monospace" font-size="${size}" font-weight="700" letter-spacing="2.5" fill="${text}">NULLSAMPLE</text>
</svg>
`;
}
writeFileSync(`${OUT}logo.svg`, logoSvg(FLARE, DIM, TEXT));
writeFileSync(`${OUT}logo-mono.svg`, logoSvg(TEXT, TEXT, TEXT));

// favicon.svg follows the viewer's theme
writeFileSync(
  `${OUT}favicon.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" role="img" aria-label="Nullsample">
  <style>
    .base { stroke: #7A8391; }
    @media (prefers-color-scheme: light) { .base { stroke: #4A5260; } }
  </style>
  <path d="M3 16 L14 16" class="base" stroke-width="${STROKE_WIDTH}" fill="none"/>
  <path d="M17 25 L17 7 L29 25" stroke="#FF6A1A" stroke-width="${STROKE_WIDTH}" fill="none" stroke-linejoin="miter"/>
</svg>
`,
);

// ------------------------------------------------------------------ icons -

/** Draws the mark into a square canvas at a given padding fraction. */
function drawMark(canvas, size, padFraction, opaque) {
  const pad = size * padFraction;
  const inner = size - pad * 2;
  const scale = inner / GRID;
  for (const s of STROKES) {
    const polys = strokePolygons(s.points, STROKE_WIDTH, scale, pad, pad);
    canvas.fillPolygons(polys, HEX(s.accent ? FLARE : opaque ? DIM : DIM), 1);
  }
}

function iconPng(size, { padFraction = 0.18, bg = VOID, transparent = false } = {}) {
  const c = new Canvas(size, size, transparent ? [0, 0, 0, 0] : [...HEX(bg), 255]);
  drawMark(c, size, padFraction, !transparent);
  return c;
}

for (const size of [192, 512]) {
  writeFileSync(`${OUT}icon-${size}.png`, iconPng(size).toPng());
}
// maskable needs its content inside the safe area, which is the middle 80 %
writeFileSync(`${OUT}icon-512-maskable.png`, iconPng(512, { padFraction: 0.28 }).toPng());
// apple-touch-icon must be opaque, no transparency
writeFileSync(`${OUT}apple-touch-icon.png`, iconPng(180, { padFraction: 0.16 }).toPng());

// multi-resolution ico. Small sizes get less padding or the mark disappears.
const ico = makeIco(
  [16, 32, 48].map((size) => ({
    size,
    rgba: iconPng(size, { padFraction: size <= 16 ? 0.06 : 0.12 }).data,
  })),
);
writeFileSync(`${OUT}favicon.ico`, ico);

// --------------------------------------------------------------------- og -

console.log(`rendering ${OG_SEED} for the OG card...`);
const { preset, ranges } = getPreset("hyperpop");
const track = renderTrack({ seed: OG_SEED, preset, ranges, sampleRate: 44100 });

function ogCard(width, height) {
  const c = new Canvas(width, height, [...HEX(VOID), 255]);
  const edge = Math.round(width * 0.058);

  // dot matrix, the brand texture
  const dot = HEX(LINE);
  for (let y = edge; y < height - edge; y += 14) {
    for (let x = edge; x < width - edge; x += 14) c.rect(x, y, 1, 1, dot, 1);
  }

  // the waveform: the real envelope of the real track
  const waveTop = Math.round(height * 0.42);
  const waveH = Math.round(height * 0.3);
  const mid = waveTop + waveH / 2;
  const buckets = Math.floor((width - edge * 2) / 3);
  const peaks = envelopePeaks(track.audio, buckets);
  c.rect(edge, Math.round(mid), width - edge * 2, 1, HEX(LINE), 1);
  for (let i = 0; i < buckets; i++) {
    const x = edge + i * 3;
    const amp = Math.max(1, peaks[i] * (waveH / 2));
    c.rect(x, mid - amp, 2, amp * 2, HEX(TEXT), 1);
  }
  // section boundaries, as they are in the app
  for (const s of track.plan.sections) {
    const x = edge + Math.round((s.startSample / track.plan.totalSamples) * (width - edge * 2));
    c.rect(x, waveTop - 10, 1, waveH + 20, HEX(FLARE), 0.55);
  }

  // Mark and wordmark, optically aligned: the mark's centre sits on the
  // wordmark's cap-height centre, not on its baseline or its box.
  const wordSize = Math.round(height * 0.105);
  const baseline = Math.round(height * 0.19);
  const capCentre = baseline - wordSize * 0.365;
  const markSize = Math.round(height * 0.15);
  const markScale = markSize / GRID;
  const markTop = Math.round(capCentre - markSize / 2);
  for (const s of STROKES) {
    c.fillPolygons(
      strokePolygons(s.points, STROKE_WIDTH, markScale, edge, markTop),
      HEX(s.accent ? FLARE : DIM),
      1,
    );
  }
  drawText(c, "NULLSAMPLE", edge + markSize + Math.round(markSize * 0.28),
    baseline, wordSize, HEX(TEXT), "bold", wordSize * 0.06);

  // the line
  const lineSize = Math.round(height * 0.052);
  drawText(c, "Music generated from code. Zero samples.", edge,
    Math.round(height * 0.315), lineSize, HEX(DIM), "regular", lineSize * 0.02);

  // readout along the bottom, in the app's own language
  const p = track.plan;
  const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const metaSize = Math.round(height * 0.034);
  const domain = "nullsample.maqsudjon.com";
  const dw = textWidth(domain, metaSize, "regular");
  const metaY = height - edge - Math.round(metaSize * 0.2);
  // Trim the readout until it cannot collide with the domain. Measuring beats
  // hoping: the seed and the key both vary in length.
  const scale2 = p.harmony.scaleName.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  const candidates = [
    `${OG_SEED}   ${p.tempo.toFixed(0)} BPM   ${NOTE[p.harmony.tonicMidi % 12]} ${scale2}   ${p.bars} bars`,
    `${OG_SEED}   ${p.tempo.toFixed(0)} BPM   ${NOTE[p.harmony.tonicMidi % 12]} ${scale2}`,
    `${OG_SEED}   ${p.tempo.toFixed(0)} BPM`,
    OG_SEED,
  ];
  const room = width - edge * 2 - dw - metaSize * 2;
  const meta = candidates.find((t) => textWidth(t, metaSize, "regular") <= room) ?? OG_SEED;
  drawText(c, meta, edge, metaY, metaSize, HEX(DIM), "regular", 0);
  drawText(c, domain, width - edge - dw, metaY, metaSize, HEX(FLARE), "regular", 0);
  return c;
}

writeFileSync(`${OUT}og-default.png`, ogCard(1200, 630).toPng());
writeFileSync(`${OUT}og-square.png`, ogCard(1200, 1200).toPng());

// -------------------------------------------------------------- manifest --

writeFileSync(
  `${OUT}site.webmanifest`,
  JSON.stringify(
    {
      name: "Nullsample",
      short_name: "Nullsample",
      description: "A procedural music generator. Original tracks synthesised entirely from code — no samples, no loops, no models.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: VOID,
      theme_color: VOID,
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    null,
    2,
  ) + "\n",
);

console.log("brand/out/:");
for (const f of [
  "logo.svg", "logo-mono.svg", "mark.svg", "mark-mono.svg", "favicon.svg",
  "favicon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png",
  "icon-512-maskable.png", "og-default.png", "og-square.png", "site.webmanifest",
]) {
  const { statSync } = await import("node:fs");
  console.log(`  ${(statSync(OUT + f).size / 1024).toFixed(1).padStart(7)} KB  ${f}`);
}
