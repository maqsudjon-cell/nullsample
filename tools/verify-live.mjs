#!/usr/bin/env node
/**
 * Confirms the deployed site, not localhost.
 *
 * Earlier in this project /rate was verified on the local server, never
 * shipped, and the gap went unreported for days. This is the check that would
 * have caught it: it drives the live site, downloads the loop, the one-shot
 * zip and the MIDI through the page's own buttons, decodes what comes back,
 * and compares the bytes against what this machine renders from the same seed.
 *
 *   npm run verify:live [-- --site https://...]
 */
import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { getPreset } from "../presets/index.ts";
import { renderDrumLoop, drumLoopToMidi } from "../render/drumloop.ts";
import { encodeWav } from "../render/wav.ts";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SITE = arg("site", "https://nullsample.maqsudjon.com").replace(/\/$/, "");
const SEED = "LIVE-CHEK";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (u8) => createHash("sha256").update(Buffer.from(u8)).digest("hex");

// what this machine says the same seed should produce
const { preset, ranges } = getPreset("hyperpop");
// the same words the page sends, or the comparison is not like for like
const WORDS = { harder: 0.3, busier: 0.5, dirtier: 0.2 };
const loop = renderDrumLoop({ seed: SEED, preset, ranges, bpm: 150, bars: 8, words: WORDS, keepKit: {} });
const localWav = sha(encodeWav(loop.audio, 16));
const localMid = sha(drumLoopToMidi(loop));
console.log(`node says  wav ${localWav.slice(0, 16)}  mid ${localMid.slice(0, 16)}  hits ${loop.hits.length}`);

const CHROME = process.env.CHROME_PATH ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => existsSync(p));
if (!CHROME) {
  console.error("no Chrome found; set CHROME_PATH");
  process.exit(1);
}
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true, args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));

console.log("\nroutes");
for (const p of ["/", "/generate/", "/rate/", "/drums/", "/drums", "/drums/drums-worker.js"]) {
  const r = await page.goto(SITE + p, { waitUntil: "domcontentloaded" });
  console.log(`  ${String(r.status()).padEnd(4)} ${p}  -> ${r.url().replace(SITE, "")}`);
}

console.log("\n/rate batch");
await page.goto(`${SITE}/rate/`, { waitUntil: "load" });
await sleep(2500);
console.log(" ", await page.evaluate(`(async () => {
  const m = await fetch('/rate/batch/manifest.json').then(r => r.json());
  const first = m.tracks[0];
  const buf = await fetch('/rate/batch/' + first.excerpt).then(r => r.arrayBuffer());
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await ac.decodeAudioData(buf.slice(0));
  const d = audio.getChannelData(0);
  let sum = 0, peak = 0;
  for (let i = 0; i < d.length; i += 7) { sum += d[i] * d[i]; if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]); }
  const rms = Math.sqrt(sum / (d.length / 7));
  return { batchId: m.batchId, kind: m.kind, entries: m.tracks.length, bytes: buf.byteLength,
           seconds: +audio.duration.toFixed(2), rmsDb: +(20 * Math.log10(rms)).toFixed(1), peak: +peak.toFixed(3) };
})()`));
console.log("  plays:", await page.evaluate(`(async () => {
  const a = document.querySelector('audio') || new Audio('/rate/batch/' + (await fetch('/rate/batch/manifest.json').then(r=>r.json())).tracks[0].excerpt);
  a.muted = true;
  await a.play().catch(e => 'blocked: ' + e.message);
  const t0 = a.currentTime;
  await new Promise(r => setTimeout(r, 700));
  return { from: +t0.toFixed(2), to: +a.currentTime.toFixed(2), advanced: a.currentTime > t0 };
})()`));

console.log("\n/drums downloads");
await page.goto(`${SITE}/drums/#s=${SEED}&bpm=150&bars=8`, { waitUntil: "load" });
await page.evaluate(`(() => {
  window.__caught = [];
  const real = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__caught.push(b); return real(b); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { window.__names = window.__names || []; window.__names.push(this.download); };
})()`);
await page.click("#generate");
await page.waitForFunction(() => document.getElementById("generate").textContent === "REROLL", { timeout: 90000 });
await sleep(600);
for (const id of ["dl-wav", "dl-kit", "dl-midi"]) {
  await page.evaluate(`document.getElementById('${id}').click()`);
  await page.waitForFunction(`window.__caught.length >= ${["dl-wav","dl-kit","dl-midi"].indexOf(id) + 1}`, { timeout: 120000 });
}
const files = await page.evaluate(`(async () => {
  const out = [];
  for (let i = 0; i < window.__caught.length; i++) {
    const b = window.__caught[i];
    const u8 = new Uint8Array(await b.arrayBuffer());
    const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map(x => x.toString(16).padStart(2, '0')).join('');
    out.push({ name: window.__names[i], type: b.type, bytes: u8.length, magic: String.fromCharCode(...u8.slice(0, 4)), sha: hex });
  }
  return out;
})()`);
for (const f of files) console.log(`  ${f.name}  ${f.bytes} bytes  "${f.magic}"  ${f.sha.slice(0, 16)}`);
console.log(`  wav matches this machine: ${files[0].sha === localWav}`);
console.log(`  mid matches this machine: ${files[2].sha === localMid}`);

// the zip: does it really carry seven one-shots with audio in them?
console.log(" ", await page.evaluate(`(async () => {
  const u8 = new Uint8Array(await window.__caught[1].arrayBuffer());
  const dv = new DataView(u8.buffer);
  const names = [];
  for (let i = 0; i < u8.length - 4; i++) {
    if (dv.getUint32(i, true) === 0x04034b50) {
      const n = dv.getUint16(i + 26, true);
      const size = dv.getUint32(i + 18, true);
      names.push(String.fromCharCode(...u8.slice(i + 30, i + 30 + n)).split('/').pop() + ':' + size);
    }
  }
  return { entries: names.length, files: names };
})()`));

// one-shots as audio, not just as bytes
console.log(" ", await page.evaluate(`(async () => {
  const u8 = new Uint8Array(await window.__caught[1].arrayBuffer());
  const dv = new DataView(u8.buffer);
  // 44100 exactly: a context at 48k resamples, and interpolation overshoot
  // moves the peak of a transient by more than a dB
  const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
  const out = {};
  for (let i = 0; i < u8.length - 4; i++) {
    if (dv.getUint32(i, true) !== 0x04034b50) continue;
    const n = dv.getUint16(i + 26, true), extra = dv.getUint16(i + 28, true);
    const size = dv.getUint32(i + 18, true), method = dv.getUint16(i + 8, true);
    const name = String.fromCharCode(...u8.slice(i + 30, i + 30 + n));
    if (method !== 0 || !name.endsWith('.wav')) continue;
    const body = u8.slice(i + 30 + n + extra, i + 30 + n + extra + size);
    const buf = await ac.decodeAudioData(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    let peak = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const c = buf.getChannelData(ch);
      for (let k = 0; k < c.length; k++) if (Math.abs(c[k]) > peak) peak = Math.abs(c[k]);
    }
    out[name.split('/').pop()] = { ms: Math.round(buf.duration * 1000), peakDb: +(20 * Math.log10(peak)).toFixed(2) };
  }
  return out;
})()`));

console.log("\ndeterminism on the deployed build");
const twice = await page.evaluate(`(async () => {
  const before = window.__caught.length;
  document.getElementById('dl-wav').click();
  while (window.__caught.length === before) await new Promise(r => setTimeout(r, 50));
  const u8 = new Uint8Array(await window.__caught[window.__caught.length - 1].arrayBuffer());
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map(x => x.toString(16).padStart(2, '0')).join('');
})()`);
console.log(`  same seed, second render: ${twice === files[0].sha ? "identical" : "DIFFERENT " + twice.slice(0, 16)}`);
await browser.close();
